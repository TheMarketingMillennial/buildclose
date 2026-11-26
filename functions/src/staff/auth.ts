/**
 * Staff authentication and authorisation.
 *
 * Roles and tenancy come from Firebase Auth custom claims set by a privileged
 * process — never from the request body. A staff member cannot name their own
 * companyId or escalate their own role; both are read from the verified token.
 */
import type { CallableRequest } from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Role } from '../lib/firebase.js';

export interface StaffIdentity {
  uid: string;
  email: string;
  companyId: string;
  role: Role;
}

const VALID_ROLES: Role[] = ['platform_admin', 'company_admin', 'sales_manager', 'sales_rep'];

export function requireStaff(request: CallableRequest): StaffIdentity {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');

  const token = request.auth?.token as Record<string, unknown> | undefined;
  const companyId = typeof token?.companyId === 'string' ? token.companyId : '';
  const role = typeof token?.role === 'string' ? (token.role as Role) : undefined;
  const email = typeof token?.email === 'string' ? token.email : '';

  if (!companyId) throw new HttpsError('permission-denied', 'No company associated with this account');
  if (!role || !VALID_ROLES.includes(role)) {
    throw new HttpsError('permission-denied', 'No valid role assigned');
  }
  return { uid, email, companyId, role };
}

/**
 * Authorise an action. `platform_admin` is cross-tenant by design, but every
 * other role is confined to the company in its claim — so a manager at one
 * tenant cannot touch another tenant even by guessing ids.
 */
export function requireRole(identity: StaffIdentity, allowed: Role[]): void {
  if (identity.role === 'platform_admin') return;
  if (!allowed.includes(identity.role)) {
    throw new HttpsError('permission-denied', 'Insufficient role for this action');
  }
}

/** Roles permitted to change commercially sensitive configuration. */
export const CONFIG_ROLES: Role[] = ['company_admin', 'sales_manager'];

/**
 * Authorise a cross-tenant, platform-level action (the plan catalogue, pilot
 * grants).
 *
 * Separate from `requireStaff` because that helper REFUSES a token that carries
 * no `companyId`, and a platform operator legitimately belongs to no tenant. It
 * still requires a verified uid and the `platform_admin` claim, so nothing here
 * is reachable anonymously or by a tenant role.
 */
export function requirePlatformAdmin(request: CallableRequest): StaffIdentity & { companyId: string } {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');

  const token = request.auth?.token as Record<string, unknown> | undefined;
  const role = typeof token?.role === 'string' ? (token.role as Role) : undefined;
  if (role !== 'platform_admin') {
    throw new HttpsError('permission-denied', 'Platform administrator access required');
  }

  return {
    uid,
    email: typeof token?.email === 'string' ? token.email : '',
    // May be empty: a platform operator need not belong to a tenant.
    companyId: typeof token?.companyId === 'string' ? token.companyId : '',
    role,
  };
}
/** Roles permitted to create/edit proposals they own. */
export const PROPOSAL_ROLES: Role[] = ['company_admin', 'sales_manager', 'sales_rep'];

/**
 * A sales_rep may only act on proposals they own; managers and admins may act on
 * any proposal within their own company.
 */
export function assertProposalAccess(
  identity: StaffIdentity,
  proposal: { companyId?: string; ownerUid?: string },
): void {
  if (identifyTenantMismatch(identity, proposal)) {
    // Indistinguishable from missing, to prevent cross-tenant probing.
    throw new HttpsError('not-found', 'Proposal not found');
  }
  if (identity.role === 'sales_rep' && proposal.ownerUid !== identity.uid) {
    throw new HttpsError('permission-denied', 'You can only access proposals you own');
  }
}

/**
 * True when the document does not belong to the caller's tenant.
 * platform_admin is exempt so support staff can work across tenants.
 */
export function identifyTenantMismatch(
  identity: StaffIdentity,
  doc: { companyId?: string },
): boolean {
  if (identity.role === 'platform_admin') return false;
  return doc.companyId !== identity.companyId;
}
