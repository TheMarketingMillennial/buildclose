/**
 * Firebase Admin singletons.
 *
 * All data access in BuildClose happens through the Admin SDK, which bypasses
 * Firestore Security Rules. That is intentional: the security boundary is
 * enforced in these functions, not in client-side rules. See firestore.rules
 * for why direct client access is denied outright.
 */
import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';

if (getApps().length === 0) {
  // In the emulator there are no Google credentials, and applicationDefault()
  // throws. Detect the emulator and initialise without a credential; the Admin
  // SDK then talks to FIRESTORE_EMULATOR_HOST directly.
  const usingEmulator =
    Boolean(process.env.FIRESTORE_EMULATOR_HOST) ||
    Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST) ||
    process.env.FUNCTIONS_EMULATOR === 'true';

  initializeApp({
    ...(usingEmulator ? {} : { credential: applicationDefault() }),
    projectId: process.env.GCLOUD_PROJECT ?? 'buildclose-dev',
    storageBucket: process.env.STORAGE_BUCKET ?? `${process.env.GCLOUD_PROJECT ?? 'buildclose-dev'}.appspot.com`,
  });
}

export const db = getFirestore();
export const auth = getAuth();
export const bucket = getStorage().bucket();

export { FieldValue, Timestamp };

/** Collection names in one place so tenant scoping is auditable. */
export const COLLECTIONS = {
  companies: 'companies',
  users: 'users',
  proposals: 'proposals',
  proposalInternal: 'proposalInternal', // sensitive: floors, playbooks, guardrails
  agentConfigs: 'agentConfigs',
  /** Company-level knowledge, configured once and reused by every proposal. */
  companyIntelligence: 'companyIntelligence',
  /** Company-level commercial authority — floors, ceilings, permissions. */
  companyAuthority: 'companyAuthority',
  accessTokens: 'accessTokens',
  conversations: 'conversations',
  messages: 'messages', // subcollection of conversations
  events: 'events', // observed behaviour
  insights: 'insights', // AI-inferred intent — deliberately separate
  aiUsage: 'aiUsage',
  auditLog: 'auditLog',
  acceptances: 'acceptances',
  documents: 'documents',
  rateLimits: 'rateLimits',
  subscriptions: 'subscriptions',
  /**
   * Purchasable plans. Company-wide, not tenant-scoped: one operator defines the
   * catalogue. Holds limits and Stripe price ids, never an amount — Stripe owns
   * every price.
   */
  plans: 'plans',
  /**
   * Sanctioned pilot grants, keyed by companyId. Separate from `subscriptions`
   * on purpose: a pilot is an administrative decision about a tenant, not a
   * billing state reported by Stripe, and conflating the two would let a webhook
   * overwrite a grant (or a grant mask a real payment failure).
   */
  entitlementOverrides: 'entitlementOverrides',
  /**
   * Per-company usage counters, maintained transactionally.
   *
   * These exist because a count-then-write guard is racy: five parallel
   * createProposal calls each read "0 active proposals" against a limit of 1 and
   * all five succeed. The counter is the authority for limit decisions, and the
   * source collections are only ever used to seed or reconcile it.
   */
  usageCounters: 'usageCounters',
} as const;

export type Role = 'platform_admin' | 'company_admin' | 'sales_manager' | 'sales_rep';

export interface StaffClaims {
  companyId: string;
  role: Role;
}

/**
 * Assert a document belongs to the expected tenant before returning it.
 * Defends against a mis-keyed read crossing tenant lines.
 */
export function assertTenant(docCompanyId: string | undefined, expectedCompanyId: string): void {
  if (!docCompanyId || docCompanyId !== expectedCompanyId) {
    // Deliberately indistinguishable from "not found" to avoid tenant probing.
    throw Object.assign(new Error('Not found'), { status: 404, code: 'not_found' });
  }
}

/** Role gate evaluated server-side; never trust a role sent by the client. */
export function hasRole(role: Role, allowed: Role[]): boolean {
  return allowed.includes(role);
}

/**
 * Drop `undefined` values before a Firestore write.
 *
 * The Admin SDK throws on `undefined` ("Cannot use undefined as a Firestore
 * value"), and Zod optional fields are routinely undefined, so every write of
 * partially-populated input goes through this. `FieldValue.delete()` sentinels
 * are preserved — they are objects, not undefined.
 */
export function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}
