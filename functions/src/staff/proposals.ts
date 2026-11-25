/**
 * Staff proposal management (callable functions).
 *
 * Sensitive commercial internals are stored in a SEPARATE document
 * (`proposalInternal/{proposalId}`) and are only ever returned to roles that are
 * allowed to see them. Requirement 4 is satisfied by document separation rather
 * than field filtering: a rep's proposal read never touches the internal
 * document at all, so there is no field to leak and no filter to regress.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db, COLLECTIONS, FieldValue, type Role } from '../lib/firebase.js';
import { requireStaff, requireRole, assertProposalAccess, identifyTenantMismatch, PROPOSAL_ROLES, CONFIG_ROLES } from './auth.js';
import { ProposalInput, ProposalInternalInput, AgentConfigInput } from '../lib/domain.js';
import { mintProposalToken } from '../lib/tokens.js';
import { hashProposalDocument } from '../lib/context.js';
import { audit } from '../lib/audit.js';
import { getConfig } from '../lib/config.js';

const REGION = 'us-central1';

/** Roles allowed to read the internal record. */
const INTERNAL_READ_ROLES: Role[] = ['platform_admin', 'company_admin', 'sales_manager'];

// ------------------------------------------------------------------ create
const CreateInput = z.object({
  proposal: ProposalInput,
  internal: ProposalInternalInput.optional(),
  agent: AgentConfigInput.partial().optional(),
});

export const createProposal = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  requireRole(identity, PROPOSAL_ROLES);

  const parsed = CreateInput.safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', parsed.error.issues[0]?.message ?? 'Invalid proposal');
  const { proposal, internal, agent } = parsed.data;

  /**
   * Commercial authority and assistant configuration are CONFIG_ROLES concerns on
   * create, exactly as they are on update.
   *
   * Without this, updateProposal's gate was trivially bypassable: a sales_rep has
   * PROPOSAL_ROLES, so they could simply create the proposal with
   * `internal: { maxDiscountPercent: 100, priceFloorMinor: 0 }` and hand
   * themselves the discount authority the update path refuses them. The same
   * applied to `agent`, which controls what the assistant may claim to a
   * prospect. Requiring the role here keeps one rule for the whole lifecycle.
   */
  const wantsConfig = (internal && Object.keys(internal).length > 0) || (agent && Object.keys(agent).length > 0);
  if (wantsConfig) requireRole(identity, CONFIG_ROLES);

  const ref = db.collection(COLLECTIONS.proposals).doc();
  const now = FieldValue.serverTimestamp();

  const record = {
    companyId: identity.companyId,
    ownerUid: identity.uid,
    ...proposal,
    status: 'draft' as const,
    acceptanceStatus: 'none' as const,
    documentVersion: 1,
    documentHash: '',
    createdAt: now,
    updatedAt: now,
  };
  // Hash is computed from the canonical projection so it matches what the
  // prospect's browser will compare against at acceptance time.
  record.documentHash = hashProposalDocument({
    ...proposal,
    companyId: identity.companyId,
    ownerUid: identity.uid,
    status: 'draft',
    documentVersion: 1,
    documentHash: '',
  } as never);

  const batch = db.batch();
  batch.set(ref, record);

  // Defaults: agent config must exist so the prospect chat always has something
  // valid to load; internal record defaults to "no discount authority".
  batch.set(
    db.collection(COLLECTIONS.agentConfigs).doc(ref.id),
    AgentConfigInput.parse({ ...(agent ?? {}), ctaLinks: agent?.ctaLinks ?? [] }),
  );
    batch.set(
      db.collection(COLLECTIONS.proposalInternal).doc(ref.id),
      /**
       * companyId is applied AFTER parsing, never before.
       *
       * ProposalInternalInput does not declare a companyId field, so Zod strips
       * it. Passing it into parse() therefore produced an internal record with no
       * tenant, which broke two things at once:
       *   - getProposal's identifyTenantMismatch() saw companyId undefined and
       *     withheld the record from the admins entitled to read it;
       *   - resolveProspectContext() compares the internal record's companyId to
       *     the session tenant and throws not_found on mismatch, so EVERY proposal
       *     created through the dashboard would have 404'd for the prospect.
       * Keeping the server-assigned value outside the parsed object also means a
       * caller cannot smuggle a companyId in through the `internal` payload.
       */
      {
        ...ProposalInternalInput.parse(internal ?? {}),
        companyId: identity.companyId,
      },
    );
  await batch.commit();

  await audit({
    companyId: identity.companyId,
    action: 'proposal.created',
    actorType: 'staff',
    actorId: identity.uid,
    proposalId: ref.id,
  });

  return { id: ref.id };
});

// -------------------------------------------------------------------- read
export const getProposal = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  const id = z.string().min(1).max(200).safeParse(request.data?.id);
  if (!id.success) throw new HttpsError('invalid-argument', 'Missing proposal id');

  const snap = await db.collection(COLLECTIONS.proposals).doc(id.data).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Proposal not found');
  const data = snap.data() as Record<string, unknown>;

  assertProposalAccess(identity, data as { companyId?: string; ownerUid?: string });

  const agentSnap = await db.collection(COLLECTIONS.agentConfigs).doc(id.data).get();

  let internal: Record<string, unknown> | null = null;
  if (INTERNAL_READ_ROLES.includes(identity.role)) {
    const internalSnap = await db.collection(COLLECTIONS.proposalInternal).doc(id.data).get();
    if (internalSnap.exists) {
      const d = internalSnap.data() as Record<string, unknown>;
      if (!identifyTenantMismatch(identity, d as { companyId?: string })) {
        internal = d;
      }
    }
  }

  return {
    proposal: { id: snap.id, ...data },
    agent: agentSnap.exists ? agentSnap.data() : null,
    internal,
    /** Whether the caller may edit pricing internals — drives the UI. */
    canEditInternal: INTERNAL_READ_ROLES.includes(identity.role),
  };
});

// ------------------------------------------------------------------- list
export const listProposals = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  const statusFilter = request.data?.status;

  let q = db.collection(COLLECTIONS.proposals).where('companyId', '==', identity.companyId);
  if (identity.role === 'sales_rep') {
    q = q.where('ownerUid', '==', identity.uid);
  }
  if (statusFilter && ['draft', 'published', 'archived'].includes(statusFilter)) {
    q = q.where('status', '==', statusFilter);
  }
  const snap = await q.orderBy('updatedAt', 'desc').limit(200).get();

  return {
    proposals: snap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      // Deliberately excludes the internal record entirely.
      return {
        id: d.id,
        title: data.title,
        prospectName: data.prospectName,
        prospectCompany: data.prospectCompany,
        totalValueMinor: data.totalValueMinor,
        commencementMinor: data.commencementMinor,
        status: data.status,
        acceptanceStatus: data.acceptanceStatus ?? 'none',
        updatedAt: data.updatedAt ?? null,
        ownerUid: data.ownerUid,
      };
    }),
  };
});

// ----------------------------------------------------------------- update
const UpdateInput = z.object({
  id: z.string().min(1),
  /**
   * `proposal` is OPTIONAL, and must be.
   *
   * The dashboard's assistant tab calls updateProposal with `{ id, agent }` only —
   * it is editing the assistant, not the commercial terms. Because `proposal` was
   * required, that call was rejected with "Invalid update payload" and saving
   * assistant configuration from the dashboard could never work. Only `id` is
   * genuinely required; every other block is an independent, partial update.
   */
  proposal: ProposalInput.partial().optional(),
  internal: ProposalInternalInput.partial().optional(),
  agent: AgentConfigInput.partial().optional(),
});

export const updateProposal = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  const parsed = UpdateInput.safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Invalid update payload');
  const { id, proposal, internal, agent } = parsed.data;

  const ref = db.collection(COLLECTIONS.proposals).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Proposal not found');
  const current = snap.data() as Record<string, unknown>;
  assertProposalAccess(identity, current as { companyId?: string; ownerUid?: string });

  const batch = db.batch();
  let versionBumped = false;

  if (proposal && Object.keys(proposal).length > 0) {
    // Any change to commercial terms invalidates prior acceptance evidence, so a
    // new document version and hash are issued and acceptance resets.
    const commercialFields = ['totalValueMinor', 'commencementMinor', 'termsNote', 'validUntil', 'title', 'hostedProposalUrl'];
    const touchesCommercial = Object.keys(proposal).some((k) => commercialFields.includes(k));
    const nextVersion = touchesCommercial ? Number(current.documentVersion ?? 1) + 1 : Number(current.documentVersion ?? 1);
    versionBumped = touchesCommercial;

    const merged = { ...current, ...proposal, documentVersion: nextVersion } as Record<string, unknown>;
    merged.documentHash = hashProposalDocument(merged as never);
    merged.updatedAt = FieldValue.serverTimestamp();
    if (touchesCommercial && current.acceptanceStatus === 'accepted') {
      merged.acceptanceStatus = 'superseded';
    }
    batch.update(ref, merged);
  }

  if (internal && Object.keys(internal).length > 0) {
    requireRole(identity, CONFIG_ROLES);
    batch.set(
      db.collection(COLLECTIONS.proposalInternal).doc(id),
      { ...internal, companyId: identity.companyId, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }

  if (agent && Object.keys(agent).length > 0) {
    requireRole(identity, CONFIG_ROLES);
    batch.set(
      db.collection(COLLECTIONS.agentConfigs).doc(id),
      { ...agent, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }

  await batch.commit();

  await audit({
    companyId: identity.companyId,
    action: 'proposal.updated',
    actorType: 'staff',
    actorId: identity.uid,
    proposalId: id,
    detail: { versionBumped, fields: Object.keys(proposal ?? {}) },
  });

  return { ok: true, versionBumped };
});

// ---------------------------------------------------------------- lifecycle
const LifecycleInput = z.object({ id: z.string().min(1) });

export const publishProposal = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  requireRole(identity, PROPOSAL_ROLES);
  const parsed = LifecycleInput.safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Missing id');

  const ref = db.collection(COLLECTIONS.proposals).doc(parsed.data.id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Proposal not found');
  const current = snap.data() as Record<string, unknown>;
  assertProposalAccess(identity, current as { companyId?: string; ownerUid?: string });

  // Annotated as a loose record so derived fields (documentHash) can be added
  // after the spread, which would otherwise narrow to the explicit keys only.
  const merged: Record<string, unknown> = { ...current, status: 'published', updatedAt: FieldValue.serverTimestamp() };
  merged.documentHash = hashProposalDocument(merged as never);

  await ref.update({ status: 'published', documentHash: merged.documentHash, updatedAt: FieldValue.serverTimestamp() });
  await audit({
    companyId: identity.companyId,
    action: 'proposal.published',
    actorType: 'staff',
    actorId: identity.uid,
    proposalId: parsed.data.id,
  });

  return { ok: true };
});

export const unpublishProposal = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  requireRole(identity, PROPOSAL_ROLES);
  const parsed = LifecycleInput.safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Missing id');

  const ref = db.collection(COLLECTIONS.proposals).doc(parsed.data.id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Proposal not found');
  assertProposalAccess(identity, snap.data() as { companyId?: string; ownerUid?: string });

  await ref.update({ status: 'draft', updatedAt: FieldValue.serverTimestamp() });
  await audit({
    companyId: identity.companyId,
    action: 'proposal.unpublished',
    actorType: 'staff',
    actorId: identity.uid,
    proposalId: parsed.data.id,
  });
  return { ok: true };
});

export const archiveProposal = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  requireRole(identity, CONFIG_ROLES);
  const parsed = LifecycleInput.safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Missing id');

  const ref = db.collection(COLLECTIONS.proposals).doc(parsed.data.id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Proposal not found');
  assertProposalAccess(identity, snap.data() as { companyId?: string; ownerUid?: string });

  // Archiving revokes every live access token: an archived proposal must not
  // remain reachable through a previously shared link.
  const tokens = await db
    .collection(COLLECTIONS.accessTokens)
    .where('proposalId', '==', parsed.data.id)
    .get();
  const batch = db.batch();
  batch.update(ref, { status: 'archived', updatedAt: FieldValue.serverTimestamp() });
  for (const t of tokens.docs) {
    if (!(t.data() as { revokedAt?: unknown }).revokedAt) {
      batch.update(t.ref, { revokedAt: FieldValue.serverTimestamp() });
    }
  }
  await batch.commit();

  await audit({
    companyId: identity.companyId,
    action: 'proposal.archived',
    actorType: 'staff',
    actorId: identity.uid,
    proposalId: parsed.data.id,
    detail: { tokensRevoked: tokens.size },
  });
  return { ok: true, tokensRevoked: tokens.size };
});

export const duplicateProposal = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  requireRole(identity, PROPOSAL_ROLES);
  const parsed = LifecycleInput.safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Missing id');

  const srcRef = db.collection(COLLECTIONS.proposals).doc(parsed.data.id);
  const srcSnap = await srcRef.get();
  if (!srcSnap.exists) throw new HttpsError('not-found', 'Proposal not found');
  const src = srcSnap.data() as Record<string, unknown>;
  assertProposalAccess(identity, src as { companyId?: string; ownerUid?: string });

  const [agentSnap, internalSnap] = await Promise.all([
    db.collection(COLLECTIONS.agentConfigs).doc(parsed.data.id).get(),
    db.collection(COLLECTIONS.proposalInternal).doc(parsed.data.id).get(),
  ]);

  const newRef = db.collection(COLLECTIONS.proposals).doc();
  const copy: Record<string, unknown> = {
    ...src,
    title: `${String(src.title ?? 'Proposal')} (copy)`,
    status: 'draft',
    acceptanceStatus: 'none',
    acceptedAt: FieldValue.delete(),
    ownerUid: identity.uid,
    documentVersion: 1,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  copy.documentHash = hashProposalDocument({ ...copy, companyId: identity.companyId } as never);

  const batch = db.batch();
  batch.set(newRef, copy);
  // Agent knowledge is copied; the access token is NOT — a duplicate must never
  // inherit a live link from the original.
  if (agentSnap.exists) batch.set(db.collection(COLLECTIONS.agentConfigs).doc(newRef.id), agentSnap.data() as object);
  if (internalSnap.exists) {
    batch.set(db.collection(COLLECTIONS.proposalInternal).doc(newRef.id), {
      ...(internalSnap.data() as object),
      companyId: identity.companyId,
    });
  }
  await batch.commit();

  await audit({
    companyId: identity.companyId,
    action: 'proposal.duplicated',
    actorType: 'staff',
    actorId: identity.uid,
    proposalId: newRef.id,
    detail: { from: parsed.data.id },
  });

  return { id: newRef.id };
});

// -------------------------------------------------------------- access tokens
/**
 * Mint a prospect access token. The plaintext is returned exactly once and never
 * stored — only its hash. This is what makes the link both deliverable and
 * un-recoverable from the database.
 */
export const mintAccessToken = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  requireRole(identity, PROPOSAL_ROLES);
  const parsed = z
    .object({
      proposalId: z.string().min(1),
      label: z.string().max(80).optional(),
      expiresInDays: z.number().int().min(1).max(365).default(30),
      allowedOrigins: z.array(z.string().max(300)).max(20).optional(),
    })
    .safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Invalid token request');

  const propRef = db.collection(COLLECTIONS.proposals).doc(parsed.data.proposalId);
  const propSnap = await propRef.get();
  if (!propSnap.exists) throw new HttpsError('not-found', 'Proposal not found');
  assertProposalAccess(identity, propSnap.data() as { companyId?: string; ownerUid?: string });

  const minted = mintProposalToken();
  const expiresAt = new Date(Date.now() + parsed.data.expiresInDays * 86_400_000);

  await db.collection(COLLECTIONS.accessTokens).doc(minted.hash).set({
    companyId: identity.companyId,
    proposalId: parsed.data.proposalId,
    label: parsed.data.label ?? null,
    allowedOrigins: parsed.data.allowedOrigins ?? [],
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
    revokedAt: null,
    createdBy: identity.uid,
    useCount: 0,
  });

  await audit({
    companyId: identity.companyId,
    action: 'token.minted',
    actorType: 'staff',
    actorId: identity.uid,
    proposalId: parsed.data.proposalId,
    detail: { label: parsed.data.label ?? null, expiresAt: expiresAt.toISOString() },
  });

  const cfg = getConfig();
  // The link points at the CHAT origin, not the dashboard origin.
  const link = `${cfg.chatOrigin}/p/${minted.plaintext}`;

  return { token: minted.plaintext, link, expiresAt: expiresAt.toISOString() };
});

export const revokeAccessToken = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  requireRole(identity, PROPOSAL_ROLES);
  const parsed = z.object({ tokenHash: z.string().min(16).max(128) }).safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Invalid token reference');

  const ref = db.collection(COLLECTIONS.accessTokens).doc(parsed.data.tokenHash);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Token not found');
  const data = snap.data() as { companyId?: string; proposalId?: string };
  if (identifyTenantMismatch(identity, data)) throw new HttpsError('not-found', 'Token not found');

  await ref.update({ revokedAt: FieldValue.serverTimestamp() });

  await audit({
    companyId: identity.companyId,
    action: 'token.revoked',
    actorType: 'staff',
    actorId: identity.uid,
    proposalId: data.proposalId,
  });

  return { ok: true };
});

export const listAccessTokens = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  const parsed = z.object({ proposalId: z.string().min(1) }).safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Missing proposal id');

  const propSnap = await db.collection(COLLECTIONS.proposals).doc(parsed.data.proposalId).get();
  if (!propSnap.exists) throw new HttpsError('not-found', 'Proposal not found');
  assertProposalAccess(identity, propSnap.data() as { companyId?: string; ownerUid?: string });

  const snap = await db
    .collection(COLLECTIONS.accessTokens)
    .where('proposalId', '==', parsed.data.proposalId)
    .limit(100)
    .get();

  return {
    tokens: snap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        tokenHash: d.id,
        label: data.label ?? null,
        createdAt: data.createdAt ?? null,
        expiresAt: data.expiresAt ?? null,
        revokedAt: data.revokedAt ?? null,
        useCount: data.useCount ?? 0,
        lastExchangedAt: data.lastExchangedAt ?? null,
      };
    }),
  };
});
