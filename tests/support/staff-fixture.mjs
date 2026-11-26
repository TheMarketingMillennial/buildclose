/**
 * Staff fixture for authenticated dashboard testing.
 *
 * Creates real Firebase Auth users with real custom claims, then obtains real ID
 * tokens through the Identity Toolkit REST endpoint — the same path the dashboard
 * uses. Nothing is mocked, so the callables see exactly the token shape they will
 * see in production.
 *
 * Why Admin SDK for creation and REST for sign-in:
 *   - Admin SDK can set custom claims, which is the only way to establish
 *     {companyId, role}. Claims cannot be set from a client by design.
 *   - Signing in over REST yields a genuine ID token carrying those claims, so
 *     requireStaff/requireRole are exercised rather than bypassed. Forging a token
 *     would test nothing.
 *
 * Emulator-only, enforced by assertEmulatorOnly() at import time.
 */
import './emulator-env.mjs';
import { assertEmulatorOnly } from './emulator-guard.mjs';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

assertEmulatorOnly('staff-fixture');

const PROJECT = process.env.GCLOUD_PROJECT;
export const AUTH_BASE = `http://127.0.0.1:9099/identitytoolkit.googleapis.com`;
export const FUNCTIONS_BASE = `http://127.0.0.1:${process.env.FUNCTIONS_EMULATOR_PORT || 5001}/${PROJECT}/us-central1`;

if (!getApps().length) initializeApp({ projectId: PROJECT });
export const db = getFirestore();
const auth = getAuth();

/** Every fixture user shares this password; these accounts exist only locally. */
export const FIXTURE_PASSWORD = 'fixture-password-123';

/**
 * Create (or recreate) a staff user with the given tenancy and role.
 * Returns the uid. Idempotent: a rerun of the suite does not accumulate users.
 */
export async function createStaffUser({ email, companyId, role, displayName }) {
  let user;
  try {
    user = await auth.getUserByEmail(email);
    // Reset so a prior run cannot leave stale claims behind.
    await auth.updateUser(user.uid, { password: FIXTURE_PASSWORD, displayName: displayName ?? email });
  } catch {
    user = await auth.createUser({ email, password: FIXTURE_PASSWORD, displayName: displayName ?? email });
  }

  await auth.setCustomUserClaims(user.uid, { companyId, role });
  await db.collection('users').doc(user.uid).set(
    {
      uid: user.uid,
      email,
      displayName: displayName ?? email,
      companyId,
      role,
      status: 'active',
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return user.uid;
}

/**
 * Sign in and return an ID token plus the decoded claims.
 *
 * Claims are decoded from the JWT payload locally (base64) purely so a test can
 * assert what the server will see. Verification is the server's job, not ours.
 */
export async function signIn(email, password = FIXTURE_PASSWORD) {
  const res = await fetch(`${AUTH_BASE}/v1/accounts:signInWithPassword?key=emulator`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`signIn failed for ${email}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  }
  return {
    idToken: body.idToken,
    uid: body.localId,
    claims: decodeJwt(body.idToken),
  };
}

/** Decode a JWT payload without verifying it (test-only convenience). */
function decodeJwt(token) {
  const part = token.split('.')[1];
  const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json);
}

/**
 * Invoke a callable the way the dashboard does.
 *
 * Returns the unwrapped result, or throws an Error carrying `.code` (the
 * HttpsError code mapped from the wire `status`) so tests can assert on the
 * failure without parsing status strings.
 */
export async function call(name, data, idToken) {
  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    body: JSON.stringify({ data: data ?? {} }),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${name}: non-JSON response ${res.status}: ${text.slice(0, 200)}`);
  }

  if (!res.ok || json.error) {
    const err = json?.error ?? {};
    const e = new Error(`${name}: ${err.message ?? res.status}`);
    // The callable protocol reports HttpsError code as a status string, e.g.
    // PERMISSION_DENIED -> 'permission-denied'.
    e.code = String(err.status ?? err.code ?? '')
      .toLowerCase()
      .replace(/_/g, '-');
    e.httpStatus = res.status;
    e.details = err;
    throw e;
  }
  return json.result;
}

/** Expect a callable to fail with a specific HttpsError code. */
export async function expectFailure(promise, expectedCode, label = '') {
  try {
    await promise;
  } catch (err) {
    if (expectedCode && err.code !== expectedCode) {
      throw new Error(`${label || 'call'}: expected code "${expectedCode}", got "${err.code}" (${err.message})`);
    }
    return err;
  }
  throw new Error(`${label || 'call'}: expected failure "${expectedCode}", but it succeeded`);
}

/** Valid payload for createProposal / updateProposal.proposal. */
export function proposalPayload(overrides = {}) {
  return {
    title: 'Acme Legal Intake Platform',
    prospectName: 'Dana Whitfield',
    prospectEmail: 'dana@acme.example',
    prospectCompany: 'Acme Legal',
    summary: 'Intake and case workspace for a mid-size litigation practice.',
    totalValueMinor: 1_800_000,
    commencementMinor: 600_000,
    currency: 'USD',
    termsNote: 'Pricing is fixed for the scope described.',
    validUntil: '2027-01-31',
    ...overrides,
  };
}

/**
 * Remove everything a fixture company owns.
 *
 * Order matters: documents that reference the company are removed before the
 * company itself, so a partially-failed cleanup is at worst incomplete rather
 * than orphaned.
 */
export async function cleanupCompany(companyId) {
  const collections = [
    'proposals',
    'proposalInternal',
    'agentConfigs',
    'accessTokens',
    'events',
    'insights',
    'acceptances',
    'auditLog',
    'aiUsage',
    'users',
    'companyIntelligence',
    'companyAuthority',
    'documents',
  ];

  for (const name of collections) {
    const snap = await db.collection(name).where('companyId', '==', companyId).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }

  // Entitlement rows are keyed BY company id, not by a companyId field.
  for (const name of ['subscriptions', 'entitlementOverrides']) {
    await db.collection(name).doc(companyId).delete().catch(() => {});
  }

  /**
   * Usage counters are keyed by company id (seats/proposals) and by
   * `ai__<company>__<month>` (AI budget). A fixture company that left a counter
   * behind would poison the next run of the same derived id, so both shapes go.
   * AI counters are matched by id prefix; Firestore `!=` on a null is invalid, so
   * the document id is filtered in code rather than by a query operator.
   */
  const counters = await db.collection('usageCounters').where('companyId', '==', companyId).get();
  await Promise.all(counters.docs.map((d) => d.ref.delete()));
  await db.collection('usageCounters').doc(companyId).delete().catch(() => {});
  const allCounters = await db.collection('usageCounters').get().catch(() => ({ docs: [] }));
  await Promise.all(
    allCounters.docs
      .filter((d) => d.id.startsWith(`ai__${companyId}__`))
      .map((d) => d.ref.delete()),
  );

  // Conversations and their message subcollections.
  const convs = await db.collection('conversations').where('companyId', '==', companyId).get();
  for (const c of convs.docs) {
    const msgs = await c.ref.collection('messages').get();
    await Promise.all(msgs.docs.map((m) => m.ref.delete()));
    await c.ref.delete();
  }

  await db.collection('companies').doc(companyId).delete();
}

/**
 * Grant a fixture company an explicit internal entitlement.
 *
 * With deny-by-default entitlement, a company created by a test has no
 * subscription and therefore a zero AI allowance. A suite that exercises chat or
 * proposal creation must grant entitlement the same way the product does for a
 * development tenant: explicitly, with `kind: 'internal'` and a bounded budget.
 */
export async function grantInternal(companyId, { aiMonthlyBudgetUsd = 25 } = {}) {
  await db
    .collection('entitlementOverrides')
    .doc(companyId)
    .set(
      {
        enabled: true,
        kind: 'internal',
        planId: null,
        limits: {
          maxUsers: null,
          maxActiveProposals: null,
          maxDocumentStorageMb: null,
          aiMonthlyBudgetUsd,
        },
        expiresAt: null,
        note: 'Test fixture internal entitlement',
        updatedAt: new Date(),
      },
      { merge: true },
    );
}

/** Delete the Firebase Auth users a suite created. */
export async function cleanupUsers(emails) {  for (const email of emails) {
    try {
      const user = await auth.getUserByEmail(email);
      await auth.deleteUser(user.uid);
    } catch {
      /* already gone */
    }
  }
}
