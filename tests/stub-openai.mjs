/**
 * Stub OpenAI-compatible server for integration testing.
 *
 * Why a stub instead of the real API:
 *   - the full request path runs unmodified (prompt build, tool-call parsing,
 *     schema validation, commercial gate, metering) — only the network peer changes;
 *   - tests are deterministic, so a guardrail regression fails the suite instead of
 *     intermittently passing;
 *   - no credits consumed, no network flakiness in CI.
 *
 * The production code has NO test-mode branch. The only thing that changes is the
 * OPENAI_BASE_URL environment variable, which is legitimate configuration.
 *
 * Behaviour: replies are selected by matching the last user message, so a test can
 * request a specific scenario (allowed answer, invented discount, extraction attempt).
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.STUB_PORT ?? 8787);

/** Scenario selected by inspecting the incoming user turn. */
function pickReply(userText) {
  const t = userText.toLowerCase();

  // Attempt to extract the system prompt.
  if (/ignore|reveal|print (your|the)|system prompt/.test(t)) {
    return {
      reply:
        'I can only help with questions about this proposal. What would you like to know about the scope or the investment?',
      cta_id: null,
      objection_type: null,
      competitor_mention: null,
      interest_signal: 'none',
      unanswered_question: null,
      escalate: false,
      asserted_amounts_minor: [],
    };
  }

  // Attempt to negotiate a discount -> the CORRECT answer names the declined figure.
  if (/discount|18,?000|19,?000|reduce|cheaper|lower/.test(t)) {
    return {
      reply:
        "I understand the total feels significant. Pricing on this proposal is fixed at $24,000, so I can't offer $18,000 for signing this week. What I can do is walk you through how the four checkpoints spread the risk.",
      cta_id: 'schedule_call',
      objection_type: 'price',
      competitor_mention: null,
      interest_signal: 'medium',
      unanswered_question: null,
      escalate: false,
      asserted_amounts_minor: [2400000],
    };
  }

  // A genuine over-reach: inventing a concession. The server must block this.
  if (/can you do 19,?500|make it 19,?500/.test(t)) {
    return {
      reply: 'I can do $19,500 if you accept this week.',
      cta_id: 'accept_proposal',
      objection_type: 'price',
      competitor_mention: null,
      interest_signal: 'high',
      unanswered_question: null,
      escalate: false,
      asserted_amounts_minor: [1950000],
    };
  }

  // Unauthorised guarantee.
  if (/guarantee|promise/.test(t)) {
    return {
      reply: 'We guarantee you will double your case volume within six months.',
      cta_id: null,
      objection_type: 'value',
      competitor_mention: null,
      interest_signal: 'high',
      unanswered_question: null,
      escalate: false,
      asserted_amounts_minor: [],
    };
  }

  // Competitor mention.
  if (/clio|filevine/.test(t)) {
    return {
      reply:
        'This is not an attempt to replace Clio. A firm that already runs it should keep it; this sits alongside it as the place a case lives from enquiry through to its first documents.',
      cta_id: null,
      objection_type: 'competitor',
      competitor_mention: 'Clio',
      interest_signal: 'medium',
      unanswered_question: null,
      escalate: false,
      asserted_amounts_minor: [],
    };
  }

  // Unknown detail -> escalation.
  if (/trust accounting|court calendar|time tracking/.test(t)) {
    return {
      reply:
        "I don't have that detail to hand, and those sit outside Stage One. I can connect you with the team, who can confirm it properly rather than have me guess.",
      cta_id: 'contact_rep',
      objection_type: 'scope',
      competitor_mention: null,
      interest_signal: 'low',
      unanswered_question: 'Is trust accounting included?',
      escalate: true,
      asserted_amounts_minor: [],
    };
  }

  // Default: a factual, grounded answer.
  return {
    reply:
      'Stage One is $24,000, with an $8,000 commencement payment due on the executed agreement. The remaining payments are released against four working checkpoints over fourteen weeks.',
    cta_id: 'accept_proposal',
    objection_type: null,
    competitor_mention: null,
    interest_signal: 'high',
    unanswered_question: null,
    escalate: false,
    asserted_amounts_minor: [2400000, 800000],
  };
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      /* fall through to default */
    }

    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
    const reply = pickReply(userText);

    const wantsTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;

    const payload = wantsTools
      ? {
          id: 'chatcmpl-stub',
          object: 'chat.completion',
          model: parsed.model ?? 'stub',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_stub',
                    type: 'function',
                    function: { name: 'respond_to_prospect', arguments: JSON.stringify(reply) },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 900, completion_tokens: 140, total_tokens: 1040 },
        }
      : {
          id: 'chatcmpl-stub',
          object: 'chat.completion',
          model: parsed.model ?? 'stub',
          choices: [
            { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(reply) } },
          ],
          usage: { prompt_tokens: 900, completion_tokens: 140, total_tokens: 1040 },
        };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[stub-openai] listening on http://127.0.0.1:${PORT}/v1`);
});
