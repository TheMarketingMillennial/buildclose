/**
 * Retention purge tests (task 3).
 *
 * Split deliberately in two:
 *
 *   POLICY   — pure functions, no emulator. The clamp on retentionDays and the
 *              admin/tenant authorization matrix are decisions, and decisions
 *              should be provable on every commit without standing up Firestore.
 *   BEHAVIOUR — against the emulator. Proves what is actually deleted, what
 *              survives, that a second run is a no-op, and that a dry run writes
 *              nothing.
 *
 * The most important assertions here are the NEGATIVE ones. It is easy to write a
 * purge that deletes old conversations; the hard part is proving it does not
 * delete signed acceptances, does not falsify engagement counts, and does not
 * let one tenant reach another tenant's data.
 *
 * Prerequisites: emulator running (firestore at least).
 * Run: node --test tests/retention.test.mjs
 */
// MUST be the first import: it sets the emulator env vars before any module that
// reads them at import time. See the file's header for why import order matters.
import './support/emulator-env.mjs';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

import {
  resolveRetentionDays,
  authorizePurge,
  purgeExpiredConversations,
  DEFAULT_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
} from '../functions/lib/lib/retention.js';

if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'buildclose-dev' });
const db = getFirestore();

// Namespaced so a real seed is never touched, and so cleanup is one prefix match.
const TEST_COMPANY = 'zz-retention-a';
const OTHER_COMPANY = 'zz-retention-b';
const TEST_PROPOSAL = 'zz-retention-proposal';

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/** Remove everything this suite created. */
async function cleanup() {
  for (const c of [TEST_COMPANY, OTHER_COMPANY]) {
    const convs = await db.collection('conversations').where('companyId', '==', c).get();
    for (const d of convs.docs) {
      const msgs = await d.ref.collection('messages').get();
      await Promise.all(msgs.docs.map((m) => m.ref.delete()));
      await d.ref.delete();
    }
    for (const coll of ['insights', 'events', 'acceptances']) {
      const snap = await db.collection(coll).where('companyId', '==', c).get();
      await Promise.all(snap.docs.map((d) => d.ref.delete()));
    }
    await db.collection('companies').doc(c).delete();
  }
  const audit = await db.collection('auditLog').where('companyId', '==', TEST_COMPANY).get();
  await Promise.all(audit.docs.map((d) => d.ref.delete()));
}

/**
 * Build one conversation with content, N days old, plus the artefacts that must
 * SURVIVE a purge: an acceptance, a behavioural event.
 */
async function seedConversation({ companyId, id, ageDays, messages = 2 }) {
  const convRef = db.collection('conversations').doc(id);
  await convRef.set({
    companyId,
    proposalId: TEST_PROPOSAL,
    tokenId: `tok-${id}`,
    status: 'open',
    messageCount: messages,
    startedAt: daysAgo(ageDays),
    lastMessageAt: daysAgo(ageDays),
  });

  for (let i = 0; i < messages; i += 1) {
    await convRef.collection('messages').add({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `test message ${i} containing private prospect text`,
      meta: {},
      createdAt: daysAgo(ageDays),
    });
  }

  await db.collection('insights').add({
    companyId,
    proposalId: TEST_PROPOSAL,
    conversationId: id,
    kind: 'objection',
    value: 'price',
    confidence: 0.9,
    createdAt: daysAgo(ageDays),
  });

  // Content-free observed event — must survive, it drives conversion reporting.
  await db.collection('events').add({
    companyId,
    proposalId: TEST_PROPOSAL,
    conversationId: id,
    type: 'proposal_view',
    createdAt: daysAgo(ageDays),
  });

  return convRef;
}

async function countMessages(convRef) {
  return (await convRef.collection('messages').get()).size;
}

async function countInsights(conversationId) {
  return (await db.collection('insights').where('conversationId', '==', conversationId).get()).size;
}

// ───────────────────────────────────────────────────────────── policy (pure)

describe('retention policy', () => {
  it('defaults when the setting is missing or unusable', () => {
    for (const raw of [undefined, null, '', 'abc', 0, -5, NaN]) {
      const r = resolveRetentionDays(raw);
      assert.equal(r.days, DEFAULT_RETENTION_DAYS, `raw=${String(raw)} should fall back`);
      assert.ok(r.warning, 'a fallback must be reported, not silent');
    }
  });

  it('clamps a below-floor setting instead of honouring it', () => {
    // The dangerous case: a company document that says 0 or 1 would otherwise
    // delete every conversation on the next run. Misconfiguration must fail
    // toward keeping data.
    const r = resolveRetentionDays(1);
    assert.equal(r.days, MIN_RETENTION_DAYS);
    assert.match(String(r.warning), /floor/);
  });

  it('honours a valid setting', () => {
    const r = resolveRetentionDays(90);
    assert.equal(r.days, 90);
    assert.equal(r.warning, undefined);
  });
});

describe('purge authorization', () => {
  it('refuses non-admin roles', () => {
    for (const role of ['sales_rep', 'sales_manager', 'nonsense']) {
      const a = authorizePurge({ role, callerCompanyId: 'c1' });
      assert.equal(a.allowed, false);
      assert.equal(a.reason, 'insufficient_role');
    }
  });

  it('confines a company admin to its own tenant', () => {
    const own = authorizePurge({ role: 'company_admin', callerCompanyId: 'c1' });
    assert.deepEqual(own, { allowed: true, targetCompanyId: 'c1' });

    const other = authorizePurge({ role: 'company_admin', callerCompanyId: 'c1', requestedCompanyId: 'c2' });
    assert.equal(other.allowed, false);
    assert.equal(other.reason, 'cross_tenant');
  });

  it('lets a platform admin target any tenant or all of them', () => {
    assert.deepEqual(authorizePurge({ role: 'platform_admin', callerCompanyId: 'c1' }), {
      allowed: true,
    });
    assert.deepEqual(
      authorizePurge({ role: 'platform_admin', callerCompanyId: 'c1', requestedCompanyId: 'c2' }),
      { allowed: true, targetCompanyId: 'c2' },
    );
  });
});

// ──────────────────────────────────────────────────────── behaviour (emulator)

describe('retention purge behaviour', () => {
  before(async () => {
    await cleanup();

    await db.collection('companies').doc(TEST_COMPANY).set({
      name: 'Retention Test A',
      settings: { retentionDays: 90 },
    });
    await db.collection('companies').doc(OTHER_COMPANY).set({
      name: 'Retention Test B',
      settings: { retentionDays: 90 },
    });

    // Inside the window: must live.
    await seedConversation({ companyId: TEST_COMPANY, id: 'zz-fresh', ageDays: 10 });
    // Outside the window: must be purged.
    await seedConversation({ companyId: TEST_COMPANY, id: 'zz-stale', ageDays: 120 });
    // A signed acceptance, standalone (acceptances are not under a conversation).
    await db.collection('acceptances').doc('zz-retention-acceptance').set({
      companyId: TEST_COMPANY,
      proposalId: TEST_PROPOSAL,
      fullName: 'Hector Abrica',
      acceptedAt: daysAgo(400),
      acceptedAtMs: daysAgo(400).getTime(),
      documentVersion: 1,
      documentHash: 'a'.repeat(64),
    });
  });

  after(cleanup);

  it('dry run reports what would go and writes nothing', async () => {
    const res = await purgeExpiredConversations({ companyId: TEST_COMPANY, dryRun: true });

    assert.equal(res.dryRun, true);
    assert.ok(res.conversationsPurged >= 1, 'should find the stale conversation');
    assert.ok(res.messagesDeleted >= 2, 'should count the stale messages');

    // Nothing written.
    const stale = db.collection('conversations').doc('zz-stale');
    assert.equal((await stale.get()).data().status, 'open');
    assert.ok((await countMessages(stale)) >= 2);
    assert.ok((await countInsights('zz-stale')) >= 1);
  });

  it('deletes content, tombstones the conversation, and preserves evidence', async () => {
    const res = await purgeExpiredConversations({ companyId: TEST_COMPANY });
    assert.equal(res.dryRun, false);
    assert.equal(res.conversationsPurged, 1, 'exactly the stale conversation');

    const stale = db.collection('conversations').doc('zz-stale');
    const staleSnap = await stale.get();

    // Conversation survives as a tombstone so counts and engagement history hold.
    assert.equal(staleSnap.exists, true, 'conversation record should survive as a tombstone');
    assert.equal(staleSnap.data().status, 'purged');
    assert.equal(staleSnap.data().messageCount, 0);
    assert.ok(staleSnap.data().purgedAt, 'tombstone should record when it was purged');

    // Content is gone.
    assert.equal(await countMessages(stale), 0, 'message bodies must be deleted');
    assert.equal(await countInsights('zz-stale'), 0, 'inferred insights must be deleted');

    // Evidence survives.
    const acc = await db.collection('acceptances').doc('zz-retention-acceptance').get();
    assert.equal(acc.exists, true, 'a signed acceptance is contract evidence and must never be purged');
    assert.equal(acc.data().fullName, 'Hector Abrica');

    // Behavioural events survive: they carry no content and drive reporting.
    const events = await db.collection('events').where('conversationId', '==', 'zz-stale').get();
    assert.ok(events.size >= 1, 'content-free behavioural events must survive');

    // The in-window conversation is untouched.
    const fresh = db.collection('conversations').doc('zz-fresh');
    assert.equal((await fresh.get()).data().status, 'open');
    assert.ok((await countMessages(fresh)) >= 2);
  });

  it('is idempotent: a second run purges nothing and does not re-audit', async () => {
    const before = await db.collection('auditLog').where('companyId', '==', TEST_COMPANY).get();

    const res = await purgeExpiredConversations({ companyId: TEST_COMPANY });
    assert.equal(res.conversationsPurged, 0, 'tombstones must not be purged again');
    assert.equal(res.messagesDeleted, 0);

    const after = await db.collection('auditLog').where('companyId', '==', TEST_COMPANY).get();
    assert.equal(after.size, before.size, 'an empty run must not write audit noise');
  });

  it('never reaches across tenants', async () => {
    // Plant a stale conversation for a DIFFERENT company.
    await seedConversation({ companyId: OTHER_COMPANY, id: 'zz-other-stale', ageDays: 200 });

    await purgeExpiredConversations({ companyId: TEST_COMPANY });

    const other = db.collection('conversations').doc('zz-other-stale');
    assert.equal((await other.get()).data().status, 'open', "another tenant's data must be untouched");
    assert.ok((await countMessages(other)) >= 2);
  });

  it('records an audit entry naming the policy and the counts', async () => {
    const snap = await db.collection('auditLog').where('companyId', '==', TEST_COMPANY).get();
    const entries = snap.docs.map((d) => d.data()).filter((d) => d.action === 'retention.purged');
    assert.ok(entries.length >= 1, 'purging must leave an audit trail');

    const e = entries[0];
    assert.equal(e.actorType, 'system');
    assert.equal(e.detail.retentionDays, 90, 'audit must record the window that justified deletion');
    assert.ok(e.detail.cutoff, 'audit must record the cut-off actually applied');
    assert.ok(!JSON.stringify(e).includes('private prospect text'), 'audit must never contain content');
  });
});
