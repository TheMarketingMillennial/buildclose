/**
 * Append-only audit trail for privileged and commercially significant actions.
 *
 * Requirement 6 needs an audit trail for acceptance; requirement 5 and the
 * broader security posture need one for configuration changes. Every write here
 * is service-role only — no client can create or alter an audit record.
 */
import { db, COLLECTIONS, FieldValue } from './firebase.js';

export type AuditAction =
  | 'proposal.created'
  | 'proposal.updated'
  | 'proposal.published'
  | 'proposal.unpublished'
  | 'proposal.duplicated'
  | 'proposal.archived'
  | 'agent.updated'
  | 'company.intelligence_updated'
  | 'company.authority_updated'
  | 'token.minted'
  | 'token.revoked'
  | 'session.minted'
  | 'prospect.accepted'
  | 'prospect.declined'
  | 'commercial.violation_blocked'
  | 'prompt.injection_blocked'
  | 'budget.exceeded'
  | 'document.uploaded'
  | 'staff.invited'
  | 'role.changed'
  | 'subscription.updated'
  /**
   * Retention purge. Recorded as a system actor with the counts and the policy
   * that justified the deletion, so the trail can answer "what was destroyed,
   * for which company, under which retention window" long after it happened.
   */
  | 'retention.purged';

export interface AuditEntry {
  companyId: string;
  action: AuditAction;
  actorType: 'staff' | 'prospect' | 'system';
  actorId?: string;
  proposalId?: string;
  /** Free-form, must never contain secrets or full prompt text. */
  detail?: Record<string, unknown>;
  ipHash?: string;
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await db.collection(COLLECTIONS.auditLog).add({
      ...entry,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // Auditing must never break the primary operation, but it must be visible.
    console.error('[audit] failed to write entry', { action: entry.action, err: (err as Error).message });
  }
}
