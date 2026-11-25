/**
 * OpenAI client for prospect conversations.
 *
 * Verified behaviour on the available endpoint (see docs/VERIFICATION.md):
 *   - `response_format: json_schema` (strict) was ACCEPTED but NOT honoured —
 *     the model returned a different object shape. So it is not used.
 *   - Tool calling with `strict: true` returned correct keys and valid JSON.
 *   - `json_object` plus explicit shape instructions parsed correctly 4/4.
 *
 * Strategy: tool-calling first, `json_object` as fallback, and a hard schema
 * validation on every response. Any reply that fails validation is rejected
 * rather than shown to the prospect.
 */
import { AiReplySchema, type AiReply } from './domain.js';
import type { RuntimeConfig } from './config.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiCallResult {
  reply: AiReply;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  model: string;
  latencyMs: number;
  /** Which decoding path produced the reply — recorded for diagnostics. */
  path: 'tools' | 'json_object';
}

export class AiError extends Error {
  constructor(
    public readonly kind: 'transport' | 'http' | 'invalid_shape' | 'credit_wall',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/** JSON Schema for tool-calling. Mirrors AiReplySchema exactly. */
const REPLY_TOOL = {
  type: 'function' as const,
  function: {
    name: 'respond_to_prospect',
    description: 'Return the reply to show the prospect plus structured sales intelligence.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        reply: { type: 'string' },
        cta_id: {
          type: ['string', 'null'],
          enum: ['schedule_call', 'accept_proposal', 'sign_agreement', 'pay_commencement', 'contact_rep', null],
        },
        objection_type: { type: ['string', 'null'] },
        competitor_mention: { type: ['string', 'null'] },
        interest_signal: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
        unanswered_question: { type: ['string', 'null'] },
        escalate: { type: 'boolean' },
        asserted_amounts_minor: { type: 'array', items: { type: 'integer' } },
      },
      required: [
        'reply',
        'cta_id',
        'objection_type',
        'competitor_mention',
        'interest_signal',
        'unanswered_question',
        'escalate',
        'asserted_amounts_minor',
      ],
      additionalProperties: false,
    },
  },
};

/** Pull a JSON object out of text that may be fenced or padded. */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const candidates: string[] = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Normalise loose model output into the canonical shape before validation. */
function coerce(candidate: unknown): unknown {
  if (!candidate || typeof candidate !== 'object') return candidate;
  const o = candidate as Record<string, unknown>;
  const out: Record<string, unknown> = { ...o };

  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const bool = (v: unknown): boolean => v === true || v === 'true';

  out.reply = typeof o.reply === 'string' ? o.reply : '';
  out.cta_id = str(o.cta_id);
  out.objection_type = str(o.objection_type);
  out.competitor_mention = str(o.competitor_mention);
  out.unanswered_question = str(o.unanswered_question);
  out.escalate = bool(o.escalate);

  const signal = typeof o.interest_signal === 'string' ? o.interest_signal.toLowerCase() : 'none';
  out.interest_signal = ['none', 'low', 'medium', 'high'].includes(signal) ? signal : 'none';

  const amounts = Array.isArray(o.asserted_amounts_minor) ? o.asserted_amounts_minor : [];
  out.asserted_amounts_minor = amounts
    .map((a) => (typeof a === 'number' ? Math.round(a) : typeof a === 'string' ? Math.round(Number(a)) : NaN))
    .filter((a): a is number => Number.isFinite(a) && a >= 0);

  return out;
}

interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface RawCall {
  content: string;
  usage: Usage;
  path: 'tools' | 'json_object';
}

async function post(
  cfg: RuntimeConfig,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ json: Record<string, unknown>; headers: Headers }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.openaiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    // Some gateways signal policy blocks with a 200 + header. Treat as failure.
    if (res.headers.get('X-Genspark-Credit-Wall') === 'vendor_blocked') {
      throw new AiError('credit_wall', 'Provider blocked the model for this account', res.status);
    }

    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new AiError('http', `AI provider returned ${res.status}`, res.status);
    }
    return { json, headers: res.headers };
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AiError('transport', 'AI request timed out');
    }
    throw new AiError('transport', `AI request failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

function readUsage(json: Record<string, unknown>): Usage {
  const u = (json.usage ?? {}) as Record<string, number>;
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
  };
}

export async function generateReply(
  cfg: RuntimeConfig,
  systemPrompt: string,
  userMessage: string,
  timeoutMs = 30_000,
): Promise<AiCallResult> {
  const started = Date.now();
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  let raw: RawCall;
  try {
    const { json } = await post(
      cfg,
      {
        model: cfg.openaiModel,
        messages,
        tools: [REPLY_TOOL],
        tool_choice: { type: 'function', function: { name: 'respond_to_prospect' } },
        temperature: 0.3,
        max_tokens: 700,
      },
      timeoutMs,
    );
    const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0];
    const msg = choice?.message as Record<string, unknown> | undefined;
    const toolCalls = msg?.tool_calls as Array<{ function?: { arguments?: string } }> | undefined;
    const args = toolCalls?.[0]?.function?.arguments;
    if (!args) throw new AiError('invalid_shape', 'Tool call returned no arguments');
    raw = { content: args, usage: readUsage(json), path: 'tools' };
  } catch (primary) {
    // Fallback path: json_object with an explicit shape reminder.
    try {
      const { json } = await post(
        cfg,
        {
          model: cfg.openaiModel,
          messages: [
            ...messages,
            {
              role: 'system',
              content:
                'Respond with a single JSON object only, keys: reply, cta_id, objection_type, competitor_mention, interest_signal, unanswered_question, escalate, asserted_amounts_minor.',
            },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.3,
          max_tokens: 700,
        },
        timeoutMs,
      );
      const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const msg = choice?.message as Record<string, unknown> | undefined;
      const content = typeof msg?.content === 'string' ? msg.content : '';
      if (!content) throw primary;
      raw = { content, usage: readUsage(json), path: 'json_object' };
    } catch {
      throw primary instanceof AiError ? primary : new AiError('transport', 'AI request failed');
    }
  }

  const parsed = extractJson(raw.content);
  const coerced = coerce(parsed);
  const validated = AiReplySchema.safeParse(coerced);
  if (!validated.success) {
    throw new AiError('invalid_shape', `AI response failed schema validation: ${validated.error.issues[0]?.path.join('.')}`);
  }

  return {
    reply: validated.data,
    usage: raw.usage,
    model: cfg.openaiModel,
    latencyMs: Date.now() - started,
    path: raw.path,
  };
}
