/**
 * Engagement and conversation persistence.
 *
 * Requirement: observed behaviour and AI-inferred intent must be clearly
 * distinguishable. That is enforced structurally — they live in different
 * collections with different write paths:
 *
 *   `events`   — observed: what actually happened (view, click, accept).
 *   `insights` — inferred: what the model believes (intent, objection class).
 *
 * Nothing in the dashboard should ever combine them into a single "score"
 * without labelling which half is measured and which is estimated.
 */
import { db, COLLECTIONS, FieldValue } from './firebase.js';
import type { AiReply } from './domain.js';
import { createHash } from 'node:crypto';

export type EventType =
  | 'proposal_view'
  | 'unique_visit'
  | 'chat_opened'
  | 'message_sent'
  | 'cta_clicked'
  | 'acceptance_started'
  | 'proposal_accepted'
  | 'proposal_declined'
  | 'injection_attempt'
  | 'assistant_fallback';

export interface EventInput {
  companyId: string;
  proposalId: string;
  conversationId?: string;
  type: EventType;
  meta?: Record<string, unknown>;
}

export async function recordEvent(e: EventInput): Promise<void> {
  try {
    await db.collection(COLLECTIONS.events).add({
      ...e,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[event] write failed', { type: e.type, err: (err as Error).message });
  }
}

export type InsightKind =
  | 'objection'
  | 'competitor_mention'
  | 'interest_signal'
  | 'pricing_concern'
  | 'unanswered_question'
  | 'faq';

export interface InsightInput {
  companyId: string;
  proposalId: string;
  conversationId: string;
  kind: InsightKind;
  value: string;
  /** 0..1 — model-reported or heuristic; surfaced in the UI as an estimate. */
  confidence: number;
}

export async function recordInsights(inputs: InsightInput[]): Promise<void> {
  if (inputs.length === 0) return;
  try {
    const batch = db.batch();
    for (const i of inputs) {
      batch.set(db.collection(COLLECTIONS.insights).doc(), {
        ...i,
        inferred: true,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  } catch (err) {
    console.error('[insight] write failed', { err: (err as Error).message });
  }
}

/** Translate one AI reply into structured insights, skipped when there is nothing to say. */
export function insightsFromReply(reply: AiReply): Array<Omit<InsightInput, 'companyId' | 'proposalId' | 'conversationId'>> {
  const out: Array<Omit<InsightInput, 'companyId' | 'proposalId' | 'conversationId'>> = [];

  if (reply.objection_type) {
    out.push({ kind: 'objection', value: reply.objection_type, confidence: 0.75 });
    if (reply.objection_type.toLowerCase().includes('price')) {
      out.push({ kind: 'pricing_concern', value: reply.objection_type, confidence: 0.7 });
    }
  }
  if (reply.competitor_mention) {
    out.push({ kind: 'competitor_mention', value: reply.competitor_mention, confidence: 0.8 });
  }
  if (reply.interest_signal !== 'none') {
    const map = { low: 0.4, medium: 0.6, high: 0.8 } as const;
    out.push({ kind: 'interest_signal', value: reply.interest_signal, confidence: map[reply.interest_signal] });
  }
  if (reply.unanswered_question) {
    out.push({ kind: 'unanswered_question', value: reply.unanswered_question, confidence: 0.9 });
  }
  return out;
}

/**
 * Find or create the conversation for a prospect access token.
 *
 * The document id is derived deterministically from (proposalId, tokenId) rather
 * than queried per session. Two reasons:
 *   - one `get()` instead of a compound query, so no composite index is needed
 *     and no query ever has to scan;
 *   - a prospect who closes the widget and reopens it later resumes the same
 *     conversation, because the key is the token, not the transient session.
 */
export async function ensureConversation(input: {
  companyId: string;
  proposalId: string;
  tokenId: string;
}): Promise<string> {
  const id = createHash('sha256').update(`${input.proposalId}:${input.tokenId}`).digest('hex').slice(0, 40);
  const ref = db.collection(COLLECTIONS.conversations).doc(id);
  const snap = await ref.get();

  if (snap.exists) return id;

  await ref.set({
    companyId: input.companyId,
    proposalId: input.proposalId,
    tokenId: input.tokenId,
    status: 'open',
    messageCount: 0,
    startedAt: FieldValue.serverTimestamp(),
    lastMessageAt: FieldValue.serverTimestamp(),
  });
  return id;
}

/** Persist one message turn. Bodies are prunable by retention job. */
export async function appendMessage(input: {
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const convRef = db.collection(COLLECTIONS.conversations).doc(input.conversationId);
  await convRef.collection(COLLECTIONS.messages).add({
    role: input.role,
    content: input.content.slice(0, 8000),
    meta: input.meta ?? {},
    createdAt: FieldValue.serverTimestamp(),
  });
  await convRef.update({
    lastMessageAt: FieldValue.serverTimestamp(),
    messageCount: FieldValue.increment(1),
  });
}

/** Last N turns for prompt context. */
export async function recentHistory(
  conversationId: string,
  limit = 8,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const snap = await db
    .collection(COLLECTIONS.conversations)
    .doc(conversationId)
    .collection(COLLECTIONS.messages)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();

  return snap.docs
    .map((d) => d.data() as { role?: string; content?: string })
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: String(m.content ?? '') }))
    .reverse();
}
