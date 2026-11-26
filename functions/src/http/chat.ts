/**
 * POST /api/chat
 *
 * The prospect conversation endpoint. Every requirement that matters converges
 * here, so the order of operations is deliberate and must not be rearranged:
 *
 *   1. Rate limit BEFORE any database or model work (cost protection).
 *   2. Resolve context — signature, token state, tenancy, published, origin.
 *   3. Record the injection heuristic observation (never blocking on its own).
 *   4. Check the per-company AI budget.
 *   5. Fetch windowed history, build the prompt, call the model.
 *   6. VALIDATE the commercial content (requirement 5). A reply that asserts an
 *      unauthorised figure is replaced with a safe fallback and escalated; it is
 *      never shown to the prospect.
 *   7. Meter usage (requirement: cost per company).
 *   8. Persist messages, insights and events, then respond with a DTO whose
 *      links were resolved server-side.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getConfig } from '../lib/config.js';
import { AppError, badRequest } from '../lib/errors.js';
import { consume } from '../lib/ratelimit.js';
import { hashIp } from '../lib/tokens.js';
import { db, COLLECTIONS, FieldValue } from '../lib/firebase.js';
import { audit } from '../lib/audit.js';
import { generateReply, AiError } from '../lib/ai.js';
import { buildSystemPrompt, buildUserTurn } from '../lib/prompt.js';
import { validateCommercial, looksLikeInjection, safeFallbackReply } from '../lib/commercial.js';
import { computeCost } from '../lib/pricing.js';
import { resolveCompanyEntitlements } from '../lib/entitlementStore.js';
import { effectiveAiBudgetUsd } from '../lib/entitlements.js';
import { reserveAiBudget } from '../lib/usage.js';
import { resolveProspectContext, resolveCta } from '../lib/context.js';
import {
  ensureConversation,
  appendMessage,
  recentHistory,
  recordEvent,
  recordInsights,
  insightsFromReply,
} from '../lib/store.js';
import { bearerToken, clientIp } from './helpers.js';
import type { AiReply } from '../lib/domain.js';

const Body = z.object({
  message: z.string().min(1).max(2000),
});

/** Per-company monthly AI ceiling, in micro-dollars. */
const DEFAULT_BUDGET_USD = 25;

export async function chatHandler(req: Request, res: Response): Promise<void> {
  const cfg = getConfig();
  const ip = clientIp(req);
  const ipHash = hashIp(ip, cfg.ipSalt);

  // ---- 1. rate limit first: cheapest possible rejection ----
  const sessionToken = bearerToken(req);
  const limits = [
    { key: `chat:ip:${ipHash}`, limit: 40, windowSec: 60 },
  ];
  if (sessionToken) {
    const short = hashIp(sessionToken, cfg.ipSalt);
    limits.push({ key: `chat:session:${short}`, limit: 20, windowSec: 60 });
  }
  const pre = await consume(limits);
  if (!pre.allowed) {
    throw new AppError(429, 'rate_limited', 'Too many messages', pre.retryAfter);
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) throw badRequest('Invalid request body');
  const userMessage = parsed.data.message.trim();
  if (!userMessage) throw badRequest('Empty message');

  // ---- 2. resolve context (signature, token state, tenancy, published) ----
  const ctx = await resolveProspectContext(sessionToken, req.headers.origin as string | undefined, cfg);

  // Per-proposal throttle so one hot proposal cannot exhaust a tenant's budget.
  const proposalLimit = await consume([
    { key: `chat:proposal:${ctx.proposalId}`, limit: 240, windowSec: 3600 },
  ]);
  if (!proposalLimit.allowed) {
    throw new AppError(429, 'rate_limited', 'Too many messages for this proposal', proposalLimit.retryAfter);
  }

  const conversationId = await ensureConversation({
    companyId: ctx.companyId,
    proposalId: ctx.proposalId,
    tokenId: ctx.session.tid,
  });

  // ---- 3. injection observation ----
  const injectionSuspected = looksLikeInjection(userMessage);
  if (injectionSuspected) {
    await recordEvent({
      companyId: ctx.companyId,
      proposalId: ctx.proposalId,
      conversationId,
      type: 'injection_attempt',
      meta: { length: userMessage.length },
    });
    await audit({
      companyId: ctx.companyId,
      action: 'prompt.injection_blocked',
      actorType: 'prospect',
      proposalId: ctx.proposalId,
      detail: { conversationId },
      ipHash,
    });
  }

  // ---- 4. budget reservation ----
  /**
   * The allowance is the TIGHTER of the company's own setting and whatever the
   * tenant's plan includes — the same "tighter of two" rule as commercial
   * authority, applied to spend.
   *
   * Why this does not read `companyData.aiBudgetUsd` alone: that field is writable
   * by the tenant, so a company on a plan including $30 could have set it to
   * $10,000 and spent against the platform's margin. The plan cap now bounds it,
   * and an account with no entitlement resolves to a zero cap and cannot spend at
   * all.
   *
   * CONCURRENCY: this RESERVES the worst-case cost of the call rather than merely
   * checking what has been spent. Twenty simultaneous prospect messages would
   * otherwise each read the same "spent so far", each conclude there was room, and
   * all twenty would spend. Reserving first means each message must own budget it
   * might use; the unused remainder is returned when the actual cost is known.
   */
  const companySnap = await db.collection(COLLECTIONS.companies).doc(ctx.companyId).get();
  const companyData = companySnap.data() as { aiBudgetUsd?: number } | undefined;
  const companyBudgetUsd = Number(companyData?.aiBudgetUsd ?? DEFAULT_BUDGET_USD);

  const ent = await resolveCompanyEntitlements(ctx.companyId);
  const effectiveBudgetUsd = effectiveAiBudgetUsd(ent, companyBudgetUsd);

  const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM

  // Baseline only matters the first time the counter is initialised for this
  // month; afterwards the counter is authoritative.
  const usageSnap = await db
    .collection(COLLECTIONS.aiUsage)
    .where('companyId', '==', ctx.companyId)
    .where('monthKey', '==', monthKey)
    .limit(500)
    .get();
  const baselineMicro = usageSnap.docs.reduce(
    (sum, d) => sum + Number((d.data() as { costMicroUsd?: number }).costMicroUsd ?? 0),
    0,
  );

  const history = await recentHistory(conversationId, 8);
  const systemPrompt = buildSystemPrompt({ facts: ctx.facts, agent: ctx.agent, authority: ctx.authority });
  const userTurn = buildUserTurn(userMessage, history);

  /**
   * Worst-case reservation, sized from the prompt actually being sent.
   *
   * ~4 characters per token is the standard approximation. The output bound is the
   * model call's own `max_tokens` (700), so the reservation cannot be exceeded by
   * a long completion. Over-reserving only causes a brief, self-correcting
   * refusal near the ceiling; under-reserving would let a burst overrun the budget.
   */
  const estimatedPromptTokens = Math.ceil((systemPrompt.length + userTurn.length) / 4);
  const reservation = computeCost(cfg.openaiModel, estimatedPromptTokens, 700);

  const aiReservation = await reserveAiBudget(
    ctx.companyId,
    monthKey,
    effectiveBudgetUsd,
    reservation.costMicroUsd,
    baselineMicro,
  );

  if (!aiReservation.outcome.allowed) {
    await audit({
      companyId: ctx.companyId,
      action: 'budget.exceeded',
      actorType: 'system',
      proposalId: ctx.proposalId,
      detail: {
        monthKey,
        budgetUsd: effectiveBudgetUsd,
        planState: ent.state,
        committedMicro: aiReservation.outcome.committedMicro,
      },
    });
    throw new AppError(503, 'budget_exceeded', 'AI budget exhausted for this month');
  }

  // ---- 5. call the model (prompt was built in step 4) ----
  let aiReply: AiReply;
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let latencyMs = 0;
  let aiFailed = false;

  try {
    const result = await generateReply(cfg, systemPrompt, userTurn);
    aiReply = result.reply;
    usage = result.usage;
    latencyMs = result.latencyMs;
  } catch (err) {
    aiFailed = true;
    const kind = err instanceof AiError ? err.kind : 'transport';
    console.error('[chat] AI failure', { kind, message: (err as Error).message });
    // The call produced nothing billable, so give the whole reservation back.
    // Without this a wave of provider failures would silently consume the
    // tenant's monthly allowance and eventually lock out a paying customer.
    await aiReservation.reservation.release();
    await recordEvent({
      companyId: ctx.companyId,
      proposalId: ctx.proposalId,
      conversationId,
      type: 'assistant_fallback',
      meta: { kind },
    });
    if (kind === 'invalid_shape') {
      throw new AppError(502, 'ai_invalid_response', 'AI returned an unusable response');
    }
    throw new AppError(503, 'ai_unavailable', 'AI temporarily unavailable');
  }

  // ---- 6. commercial validation (requirement 5) ----
  /**
   * The validator is fed EFFECTIVE authority, not the proposal's own internals.
   *
   * This is the second of the two enforcement points. The prompt asks the model
   * to respect company policy; this decides whether the reply is actually shown.
   * If it read `ctx.internal` instead, a proposal document claiming a 50%
   * ceiling would pass validation even when the company permits 10% — the prompt
   * would say one thing and the gate would agree with the wrong number.
   */
  const policy = {
    totalValueMinor: ctx.proposal.totalValueMinor,
    commencementMinor: ctx.proposal.commencementMinor,
    approvedAmountsMinor: ctx.authority.approvedDiscounts.map((d) => d.amountMinor),
    quotableAmountsMinor: ctx.authority.quotableAmountsMinor,
    currency: 'USD' as const,
  };

  const verdict = validateCommercial(aiReply.reply, policy);

  // Cross-check the model's declared amounts against its prose: a figure it
  // claims to have stated but did not is harmless, but a figure in prose that it
  // did NOT declare is a sign the structured channel is unreliable, so treat the
  // stricter of the two.
  const declaredViolations = aiReply.asserted_amounts_minor.filter(
    (a) =>
      a !== policy.totalValueMinor &&
      a !== policy.commencementMinor &&
      !policy.approvedAmountsMinor.includes(a) &&
      !policy.quotableAmountsMinor.includes(a),
  );

  let finalReply = aiReply.reply;
  let escalated = aiReply.escalate;

  if (!verdict.ok || declaredViolations.length > 0) {
    await audit({
      companyId: ctx.companyId,
      action: 'commercial.violation_blocked',
      actorType: 'system',
      proposalId: ctx.proposalId,
      detail: {
        conversationId,
        reason: verdict.reason ?? 'declared_amount_mismatch',
        violations: verdict.violations.length > 0 ? verdict.violations : declaredViolations,
      },
      ipHash,
    });
    // Replace, never reveal. The prospect sees a hand-off, not a correction.
    finalReply = safeFallbackReply();
    escalated = true;
    aiReply = { ...aiReply, cta_id: 'contact_rep', objection_type: aiReply.objection_type, escalate: true };
  }

  // ---- 7. meter usage whether or not the reply survived validation ----
  /**
   * Settling the reservation is part of metering, not an afterthought.
   *
   * The reservation charged the worst case before the call; this charges what the
   * tokens actually cost and returns the difference. It runs even when the reply
   * was replaced by the safety fallback, because the provider still billed for the
   * generation. Failing to settle would permanently hold budget that was never
   * spent, so a tenant would be refused service while `aiUsage` showed headroom.
   */
  const cost = computeCost(cfg.openaiModel, usage.promptTokens, usage.completionTokens);
  await aiReservation.reservation.commit(cost.costMicroUsd);
  try {
    await db.collection(COLLECTIONS.aiUsage).add({
      companyId: ctx.companyId,
      proposalId: ctx.proposalId,
      conversationId,
      model: cfg.openaiModel,
      monthKey,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      costMicroUsd: cost.costMicroUsd,
      pricingVersion: cost.pricingVersion,
      latencyMs,
      blocked: !verdict.ok,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[chat] metering write failed', (err as Error).message);
  }

  // ---- 8. persist and respond ----
  await appendMessage({ conversationId, role: 'user', content: userMessage });
  await appendMessage({
    conversationId,
    role: 'assistant',
    content: finalReply,
    meta: { path: 'grounded', blocked: !verdict.ok, escalated },
  });

  await recordEvent({
    companyId: ctx.companyId,
    proposalId: ctx.proposalId,
    conversationId,
    type: 'message_sent',
    meta: { blocked: !verdict.ok },
  });

  if (!aiFailed) {
    await recordInsights(
      insightsFromReply(aiReply).map((i) => ({
        ...i,
        companyId: ctx.companyId,
        proposalId: ctx.proposalId,
        conversationId,
      })),
    );
  }

  const cta = resolveCta(ctx, aiReply.cta_id);

  res.status(200).json({
    reply: finalReply,
    // Only a resolved, approved link is ever returned. The model never emits URLs.
    cta: cta ? { id: cta.id, label: cta.label, url: cta.url } : null,
    escalate: escalated,
    conversationId,
  });
}
