/**
 * Staff intelligence and reporting.
 *
 * Core reporting principle: observed and inferred signals are returned in
 * separate, clearly-named fields. The dashboard cannot accidentally present an
 * AI estimate as a measurement because they never share a field.
 *
 *   observed  — counted from `events` (views, visits, messages, CTA clicks,
 *               acceptances). These are facts.
 *   inferred  — aggregated from `insights` (objections, competitor mentions,
 *               interest signals). These are model estimates with confidence.
 *
 * Conversion rate is computed only from observed events.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db, COLLECTIONS } from '../lib/firebase.js';
import { requireStaff, requireRole, assertProposalAccess, identifyTenantMismatch, type StaffIdentity } from './auth.js';
import { microUsdToUsd } from '../lib/pricing.js';

const REGION = 'us-central1';

function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

interface ProposalLite {
  id: string;
  title: string;
  prospectName: string;
  status: string;
  acceptanceStatus: string;
  totalValueMinor: number;
  commencementMinor: number;
}

/** Load proposals visible to this identity (reps see only their own). */
async function scopedProposals(identity: StaffIdentity): Promise<ProposalLite[]> {
  let q = db.collection(COLLECTIONS.proposals).where('companyId', '==', identity.companyId);
  if (identity.role === 'sales_rep') q = q.where('ownerUid', '==', identity.uid);
  const snap = await q.limit(500).get();
  return snap.docs.map((d) => {
    const v = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      title: String(v.title ?? ''),
      prospectName: String(v.prospectName ?? ''),
      status: String(v.status ?? 'draft'),
      acceptanceStatus: String(v.acceptanceStatus ?? 'none'),
      totalValueMinor: Number(v.totalValueMinor ?? 0),
      commencementMinor: Number(v.commencementMinor ?? 0),
    };
  });
}

/** Company-wide dashboard aggregate. */
export const getCompanyDashboard = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);

  const proposals = await scopedProposals(identity);
  const visibleIds = new Set(proposals.map((p) => p.id));

  const eventsSnap = await db
    .collection(COLLECTIONS.events)
    .where('companyId', '==', identity.companyId)
    .limit(5000)
    .get();

  // Count observed events, scoped to proposals this identity may see.
  const observed = {
    proposal_view: 0,
    unique_visit: 0,
    chat_opened: 0,
    message_sent: 0,
    cta_clicked: 0,
    proposal_accepted: 0,
    proposal_declined: 0,
    injection_attempt: 0,
  };
  for (const doc of eventsSnap.docs) {
    const e = doc.data() as { type?: string; proposalId?: string };
    if (e.proposalId && !visibleIds.has(e.proposalId)) continue;
    if (e.type && e.type in observed) observed[e.type as keyof typeof observed] += 1;
  }

  // Inferred signals, aggregated with their confidence preserved.
  const insightsSnap = await db
    .collection(COLLECTIONS.insights)
    .where('companyId', '==', identity.companyId)
    .limit(5000)
    .get();

  const objectionCounts = new Map<string, { count: number; confidenceSum: number }>();
  const competitorCounts = new Map<string, number>();
  const interestCounts = new Map<string, number>();
  const unanswered: string[] = [];

  for (const doc of insightsSnap.docs) {
    const i = doc.data() as { kind?: string; value?: string; proposalId?: string; confidence?: number };
    if (i.proposalId && !visibleIds.has(i.proposalId)) continue;
    const conf = Number(i.confidence ?? 0.5);
    const value = String(i.value ?? '');
    if (!value) continue;

    if (i.kind === 'objection' || i.kind === 'pricing_concern') {
      const cur = objectionCounts.get(value) ?? { count: 0, confidenceSum: 0 };
      cur.count += 1;
      cur.confidenceSum += conf;
      objectionCounts.set(value, cur);
    } else if (i.kind === 'competitor_mention') {
      competitorCounts.set(value, (competitorCounts.get(value) ?? 0) + 1);
    } else if (i.kind === 'interest_signal') {
      interestCounts.set(value, (interestCounts.get(value) ?? 0) + 1);
    } else if (i.kind === 'unanswered_question' && unanswered.length < 20) {
      unanswered.push(value);
    }
  }

  // Pipeline maths uses observed state only.
  const activeProposals = proposals.filter((p) => p.status === 'published');
  const closedProposals = proposals.filter((p) => p.acceptanceStatus === 'accepted');
  const pipelineValueMinor = activeProposals.reduce((s, p) => s + p.totalValueMinor, 0);
  const closedValueMinor = closedProposals.reduce((s, p) => s + p.totalValueMinor, 0);
  const revenueRecognisedMinor = closedProposals.reduce((s, p) => s + p.commencementMinor, 0);

  // Conversion = accepted / (distinct proposals that were viewed at least once).
  const viewedProposalIds = new Set<string>();
  for (const doc of eventsSnap.docs) {
    const e = doc.data() as { type?: string; proposalId?: string };
    if ((e.type === 'proposal_view' || e.type === 'unique_visit') && e.proposalId && visibleIds.has(e.proposalId)) {
      viewedProposalIds.add(e.proposalId);
    }
  }
  const conversionRate = viewedProposalIds.size > 0 ? closedProposals.length / viewedProposalIds.size : 0;

  const mk = monthKey();
  const usageSnap = await db
    .collection(COLLECTIONS.aiUsage)
    .where('companyId', '==', identity.companyId)
    .where('monthKey', '==', mk)
    .limit(2000)
    .get();
  const aiSpentMicro = usageSnap.docs.reduce((s, d) => s + Number((d.data() as { costMicroUsd?: number }).costMicroUsd ?? 0), 0);
  const aiTokens = usageSnap.docs.reduce((s, d) => s + Number((d.data() as { totalTokens?: number }).totalTokens ?? 0), 0);

  // Recommended follow-ups derive from inferred signals but are labelled as such.
  const followUps: Array<{ proposalId: string; reason: string; basis: 'observed' | 'inferred' }> = [];
  for (const p of activeProposals) {
    if (observed.chat_opened === 0) continue;
  }
  for (const p of proposals) {
    if (p.status === 'published' && p.acceptanceStatus === 'none') {
      const pEvents = eventsSnap.docs.filter((d) => (d.data() as { proposalId?: string }).proposalId === p.id);
      const viewed = pEvents.some((d) => (d.data() as { type?: string }).type === 'proposal_view');
      const chatted = pEvents.some((d) => (d.data() as { type?: string }).type === 'message_sent');
      if (chatted && !viewed) {
        followUps.push({ proposalId: p.id, reason: 'Conversation started without a tracked page view', basis: 'observed' });
      } else if (chatted) {
        followUps.push({ proposalId: p.id, reason: 'Prospect has an open conversation — reply while it is active', basis: 'observed' });
      } else if (viewed) {
        followUps.push({ proposalId: p.id, reason: 'Proposal viewed but no conversation started', basis: 'observed' });
      }
    }
  }

  return {
    observed: {
      ...observed,
      proposalsViewed: viewedProposalIds.size,
      activeProposals: activeProposals.length,
      pipelineValueMinor,
      closedSales: closedProposals.length,
      closedValueMinor,
      revenueRecognisedMinor,
      conversionRate: Math.round(conversionRate * 1000) / 1000,
    },
    inferred: {
      disclaimer: 'Estimated by the AI from conversation content. Not measured behaviour.',
      topObjections: [...objectionCounts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 8)
        .map(([type, v]) => ({ type, count: v.count, avgConfidence: Math.round((v.confidenceSum / v.count) * 100) / 100 })),
      competitorsMentioned: [...competitorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count })),
      interestDistribution: [...interestCounts.entries()].map(([level, count]) => ({ level, count })),
      unansweredQuestions: unanswered,
    },
    aiUsage: {
      monthKey: mk,
      tokens: aiTokens,
      costUsd: Math.round(microUsdToUsd(aiSpentMicro) * 100) / 100,
      calls: usageSnap.size,
    },
    followUps: followUps.slice(0, 20),
    proposalCount: proposals.length,
  };
});

/** Per-proposal analytics. */
export const getProposalAnalytics = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  const parsed = z.object({ proposalId: z.string().min(1) }).safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Missing proposal id');

  const propSnap = await db.collection(COLLECTIONS.proposals).doc(parsed.data.proposalId).get();
  if (!propSnap.exists) throw new HttpsError('not-found', 'Proposal not found');
  const prop = propSnap.data() as Record<string, unknown>;
  assertProposalAccess(identity, prop as { companyId?: string; ownerUid?: string });

  const [eventsSnap, insightsSnap, convsSnap, acceptSnap] = await Promise.all([
    db.collection(COLLECTIONS.events).where('proposalId', '==', parsed.data.proposalId).limit(2000).get(),
    db.collection(COLLECTIONS.insights).where('proposalId', '==', parsed.data.proposalId).limit(2000).get(),
    db.collection(COLLECTIONS.conversations).where('proposalId', '==', parsed.data.proposalId).limit(200).get(),
    db.collection(COLLECTIONS.acceptances).where('proposalId', '==', parsed.data.proposalId).limit(10).get(),
  ]);

  const counts: Record<string, number> = {};
  for (const d of eventsSnap.docs) {
    const t = String((d.data() as { type?: string }).type ?? 'unknown');
    counts[t] = (counts[t] ?? 0) + 1;
  }

  const objections = new Map<string, number>();
  const questions: string[] = [];
  for (const d of insightsSnap.docs) {
    const i = d.data() as { kind?: string; value?: string };
    if (i.kind === 'objection' && i.value) objections.set(i.value, (objections.get(i.value) ?? 0) + 1);
    if (i.kind === 'unanswered_question' && i.value && questions.length < 10) questions.push(i.value);
  }

  const acceptance = acceptSnap.docs[0]?.data() as
    | { acceptedAt?: { toMillis(): number }; fullName?: string; documentVersion?: number; documentHash?: string; signature?: { provider?: string } }
    | undefined;

  return {
    proposal: {
      id: parsed.data.proposalId,
      title: String(prop.title ?? ''),
      status: String(prop.status ?? ''),
      acceptanceStatus: String(prop.acceptanceStatus ?? 'none'),
      totalValueMinor: Number(prop.totalValueMinor ?? 0),
    },
    // observed
    events: counts,
    conversations: convsSnap.size,
    acceptance: acceptance
      ? {
          acceptedAt: acceptance.acceptedAt?.toMillis() ?? null,
          fullName: acceptance.fullName ?? null,
          documentVersion: acceptance.documentVersion ?? null,
          documentHash: acceptance.documentHash ?? null,
          signatureProvider: acceptance.signature?.provider ?? null,
        }
      : null,
    // inferred
    inferred: {
      disclaimer: 'Estimated by the AI. Not measured behaviour.',
      objections: [...objections.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count })),
      unansweredQuestions: questions,
    },
  };
});

/**
 * List the conversations on one proposal.
 *
 * `getProposalAnalytics` deliberately returns only a COUNT of conversations, so
 * without this callable the dashboard would know a prospect had chatted but
 * would have no id to open. The transcript body is not included here — only
 * metadata — so opening a thread remains an explicit second call that re-checks
 * access, and listing many conversations stays cheap.
 *
 * Scoping mirrors getConversation exactly: tenant mismatch is a 404 (not 403), so
 * the response never confirms the existence of another tenant's data, and a
 * sales_rep only ever sees conversations on proposals they own.
 */
export const listConversations = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  const parsed = z.object({ proposalId: z.string().min(1) }).safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Missing proposal id');

  const propSnap = await db.collection(COLLECTIONS.proposals).doc(parsed.data.proposalId).get();
  if (!propSnap.exists) throw new HttpsError('not-found', 'Proposal not found');
  assertProposalAccess(identity, propSnap.data() as { companyId?: string; ownerUid?: string });

  const snap = await db
    .collection(COLLECTIONS.conversations)
    .where('proposalId', '==', parsed.data.proposalId)
    .limit(100)
    .get();

  const rows = snap.docs
    .filter((d) => !identifyTenantMismatch(identity, d.data() as { companyId?: string }))
    .map((d) => {
      const c = d.data() as {
        status?: string;
        messageCount?: number;
        startedAt?: { toMillis?: () => number };
        lastMessageAt?: { toMillis?: () => number };
      };
      return {
        id: d.id,
        status: c.status ?? 'open',
        messageCount: Number(c.messageCount ?? 0),
        startedAt: c.startedAt?.toMillis?.() ?? null,
        lastMessageAt: c.lastMessageAt?.toMillis?.() ?? null,
      };
    })
    // Newest activity first; conversations with no timestamp sort last.
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));

  return { conversations: rows };
});

/**
 * Conversation transcript for staff review.
 * Reps may only read conversations on their own proposals.
 */
export const getConversation = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  const parsed = z.object({ conversationId: z.string().min(1) }).safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Missing conversation id');

  const convSnap = await db.collection(COLLECTIONS.conversations).doc(parsed.data.conversationId).get();
  if (!convSnap.exists) throw new HttpsError('not-found', 'Conversation not found');
  const conv = convSnap.data() as { companyId?: string; proposalId?: string };
  if (identifyTenantMismatch(identity, conv)) throw new HttpsError('not-found', 'Conversation not found');

  if (identity.role === 'sales_rep') {
    const propSnap = conv.proposalId
      ? await db.collection(COLLECTIONS.proposals).doc(conv.proposalId).get()
      : null;
    const owner = propSnap?.exists ? (propSnap.data() as { ownerUid?: string }).ownerUid : undefined;
    if (owner !== identity.uid) throw new HttpsError('permission-denied', 'Not your proposal');
  }

  const msgs = await db
    .collection(COLLECTIONS.conversations)
    .doc(parsed.data.conversationId)
    .collection(COLLECTIONS.messages)
    .orderBy('createdAt', 'asc')
    .limit(500)
    .get();

  return {
    conversation: { id: convSnap.id, ...conv },
    messages: msgs.docs.map((d) => {
      const m = d.data() as { role?: string; content?: string; createdAt?: { toMillis(): number }; meta?: unknown };
      return {
        role: m.role ?? 'assistant',
        content: m.content ?? '',
        createdAt: m.createdAt?.toMillis() ?? null,
        meta: m.meta ?? {},
      };
    }),
  };
});

/** Audit trail reader, restricted to managers and above. */
export const getAuditLog = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  requireRole(identity, ['company_admin', 'sales_manager']);

  const snap = await db
    .collection(COLLECTIONS.auditLog)
    .where('companyId', '==', identity.companyId)
    .limit(200)
    .get();

  const rows = snap.docs.map((d) => {
    const a = d.data() as Record<string, unknown>;
    const created = a.createdAt as { toMillis?: () => number } | undefined;
    return {
      id: d.id,
      action: a.action,
      actorType: a.actorType,
      actorId: a.actorId ?? null,
      proposalId: a.proposalId ?? null,
      detail: a.detail ?? {},
      createdAt: created?.toMillis?.() ?? null,
    };
  });

  rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return { entries: rows.slice(0, 200) };
});
