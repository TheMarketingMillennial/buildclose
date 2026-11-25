/**
 * Team management and role assignment.
 *
 * Custom claims are the single source of truth for tenancy and role. Only a
 * company_admin may change roles within their own company, and no one may grant
 * a role they do not themselves hold (a manager cannot mint an admin).
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { auth, db, COLLECTIONS, FieldValue, type Role } from '../lib/firebase.js';
import { requireStaff, requireRole } from './auth.js';
import { audit } from '../lib/audit.js';

const REGION = 'us-central1';

const AssignableRole = z.enum(['company_admin', 'sales_manager', 'sales_rep']);

/** Rank used to prevent privilege escalation via role assignment. */
const RANK: Record<Role, number> = {
  platform_admin: 4,
  company_admin: 3,
  sales_manager: 2,
  sales_rep: 1,
};

/**
 * Invite (or attach) a staff member to the caller's company.
 * Creates the Firebase Auth user if absent, sets claims, and records membership.
 */
export const inviteStaff = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  requireRole(identity, ['company_admin']);

  const parsed = z
    .object({
      email: z.string().email().max(320),
      role: AssignableRole,
      displayName: z.string().max(120).optional(),
    })
    .safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Invalid invite payload');

  const { email, role, displayName } = parsed.data;

  if (RANK[role] >= RANK[identity.role] && identity.role !== 'platform_admin') {
    throw new HttpsError('permission-denied', 'You cannot assign a role at or above your own');
  }

  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch {
    user = await auth.createUser({ email, displayName, emailVerified: false });
  }

  // Refuse to move a user who already belongs to a different tenant.
  const existing = await db.collection(COLLECTIONS.users).doc(user.uid).get();
  if (existing.exists) {
    const data = existing.data() as { companyId?: string };
    if (data.companyId && data.companyId !== identity.companyId) {
      throw new HttpsError('failed-precondition', 'This account belongs to another organisation');
    }
  }

  await auth.setCustomUserClaims(user.uid, { companyId: identity.companyId, role });

  await db.collection(COLLECTIONS.users).doc(user.uid).set(
    {
      uid: user.uid,
      email,
      displayName: displayName ?? user.displayName ?? null,
      companyId: identity.companyId,
      role,
      status: 'active',
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await audit({
    companyId: identity.companyId,
    action: 'staff.invited',
    actorType: 'staff',
    actorId: identity.uid,
    detail: { email, role },
  });

  return { uid: user.uid, email, role };
});

/** Change an existing member's role. */
export const setStaffRole = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  requireRole(identity, ['company_admin']);

  const parsed = z
    .object({ uid: z.string().min(1), role: AssignableRole })
    .safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Invalid role payload');

  if (RANK[parsed.data.role] >= RANK[identity.role] && identity.role !== 'platform_admin') {
    throw new HttpsError('permission-denied', 'You cannot assign a role at or above your own');
  }

  const userSnap = await db.collection(COLLECTIONS.users).doc(parsed.data.uid).get();
  if (!userSnap.exists) throw new HttpsError('not-found', 'User not found');
  const data = userSnap.data() as { companyId?: string; role?: Role };
  if (data.companyId !== identity.companyId && identity.role !== 'platform_admin') {
    throw new HttpsError('not-found', 'User not found');
  }

  // Prevent demoting the last remaining company admin.
  if (data.role === 'company_admin' && parsed.data.role !== 'company_admin') {
    const admins = await db
      .collection(COLLECTIONS.users)
      .where('companyId', '==', identity.companyId)
      .where('role', '==', 'company_admin')
      .get();
    if (admins.size <= 1) throw new HttpsError('failed-precondition', 'A company must retain at least one admin');
  }

  await auth.setCustomUserClaims(parsed.data.uid, { companyId: data.companyId, role: parsed.data.role });
  await db.collection(COLLECTIONS.users).doc(parsed.data.uid).update({
    role: parsed.data.role,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await audit({
    companyId: identity.companyId,
    action: 'role.changed',
    actorType: 'staff',
    actorId: identity.uid,
    detail: { uid: parsed.data.uid, from: data.role, to: parsed.data.role },
  });

  return { ok: true };
});

/** List staff in the caller's company. */
export const listStaff = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  requireRole(identity, ['company_admin', 'sales_manager']);

  const snap = await db.collection(COLLECTIONS.users).where('companyId', '==', identity.companyId).limit(200).get();
  return {
    staff: snap.docs.map((d) => {
      const u = d.data() as Record<string, unknown>;
      return {
        uid: d.id,
        email: u.email,
        displayName: u.displayName ?? null,
        role: u.role,
        status: u.status ?? 'active',
      };
    }),
  };
});

/**
 * Bootstrap the very first company and its admin.
 * Deliberately requires a one-time setup code from the environment so this
 * cannot be called by an attacker before the tenant exists, and refuses to run
 * once any company is present.
 */
export const bootstrapCompany = onCall(
  { region: REGION, secrets: ['SETUP_CODE'] },
  async (request) => {
  const setupCode = process.env.SETUP_CODE;
  if (!setupCode) throw new HttpsError('failed-precondition', 'Setup is not enabled');

  const parsed = z
    .object({
      code: z.string().min(8).max(200),
      companyName: z.string().min(1).max(200),
      adminEmail: z.string().email().max(320),
      adminName: z.string().max(120).optional(),
    })
    .safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Invalid setup payload');

  // Constant-time-ish comparison; the code is high entropy so length check first.
  if (parsed.data.code.length !== setupCode.length || parsed.data.code !== setupCode) {
    throw new HttpsError('permission-denied', 'Invalid setup code');
  }

  const existing = await db.collection(COLLECTIONS.companies).limit(1).get();
  if (!existing.empty) throw new HttpsError('failed-precondition', 'A company already exists');

  const companyRef = db.collection(COLLECTIONS.companies).doc();
  await companyRef.set({
    name: parsed.data.companyName,
    createdBy: parsed.data.adminEmail,
    settings: { retentionDays: 365, aiBudgetUsd: 25 },
    createdAt: FieldValue.serverTimestamp(),
  });

  let user;
  try {
    user = await auth.getUserByEmail(parsed.data.adminEmail);
  } catch {
    user = await auth.createUser({ email: parsed.data.adminEmail, displayName: parsed.data.adminName });
  }
  await auth.setCustomUserClaims(user.uid, { companyId: companyRef.id, role: 'company_admin' });
  await db.collection(COLLECTIONS.users).doc(user.uid).set(
    {
      uid: user.uid,
      email: parsed.data.adminEmail,
      displayName: parsed.data.adminName ?? null,
      companyId: companyRef.id,
      role: 'company_admin',
      status: 'active',
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await audit({
    companyId: companyRef.id,
    action: 'staff.invited',
    actorType: 'system',
    detail: { bootstrap: true, adminEmail: parsed.data.adminEmail },
  });

  return { companyId: companyRef.id, adminUid: user.uid };
});
