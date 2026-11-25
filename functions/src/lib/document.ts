/**
 * Canonical proposal document and its hash.
 *
 * Kept dependency-free (no Firebase, no config) on purpose: the seed script, the
 * staff functions and the prospect acceptance handler all import *this* module,
 * so the hash a prospect's browser compares against and the hash recorded at
 * acceptance are produced by the same code path. Duplicating this logic
 * elsewhere would let the two drift and silently invalidate acceptance evidence.
 */
import { createHash } from 'node:crypto';

export interface CanonicalProposal {
  title?: unknown;
  prospectName?: unknown;
  prospectCompany?: unknown;
  totalValueMinor?: unknown;
  commencementMinor?: unknown;
  termsNote?: unknown;
  validUntil?: unknown;
  hostedProposalUrl?: unknown;
}

/**
 * Deterministic projection of the commercial terms a prospect agrees to.
 *
 * Every value is explicitly coerced because `JSON.stringify` omits keys whose
 * value is `undefined`: a proposal created with an absent optional field and the
 * same proposal read back with that field defaulted to `''` would otherwise hash
 * differently.
 */
export function canonicalProposalDocument(p: CanonicalProposal): string {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '');
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  return JSON.stringify({
    schema: 'buildclose.proposal.v1',
    title: s(p.title),
    prospectName: s(p.prospectName),
    prospectCompany: s(p.prospectCompany),
    totalValueMinor: n(p.totalValueMinor),
    commencementMinor: n(p.commencementMinor),
    currency: 'USD',
    termsNote: s(p.termsNote),
    validUntil: s(p.validUntil),
    hostedProposalUrl: s(p.hostedProposalUrl),
  });
}

export function hashProposalDocument(p: CanonicalProposal): string {
  return createHash('sha256').update(canonicalProposalDocument(p), 'utf8').digest('hex');
}
