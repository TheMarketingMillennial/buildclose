/**
 * Domain model and validation.
 *
 * Commercial facts that an AI must never improvise are typed as money amounts in
 * minor units (integers) so a rounding or formatting bug cannot silently change
 * a price. Anything the model may say about price is derived from these records,
 * never from the model's own arithmetic.
 */
import { z } from 'zod';

// ---------------------------------------------------------------- primitives

export const Money = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: z.literal('USD'),
});
export type Money = z.infer<typeof Money>;

export const ProposalStatus = z.enum(['draft', 'published', 'archived']);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export const ROLES = ['platform_admin', 'company_admin', 'sales_manager', 'sales_rep'] as const;
export const RoleSchema = z.enum(ROLES);

// ------------------------------------------------------------------ proposal
// Public-facing proposal record. Contains nothing confidential: the price floor,
// negotiation boundaries and internal playbook live in `proposalInternal`.
export const ProposalInput = z.object({
  title: z.string().min(1).max(200),
  prospectName: z.string().min(1).max(200),
  prospectEmail: z.string().email().max(320).optional().or(z.literal('')),
  prospectCompany: z.string().max(200).optional().or(z.literal('')),
  summary: z.string().max(4000).optional().or(z.literal('')),
  totalValueMinor: z.number().int().nonnegative(),
  commencementMinor: z.number().int().nonnegative(),
  currency: z.literal('USD').default('USD'),
  hostedProposalUrl: z.string().url().max(2000).optional().or(z.literal('')),
  termsNote: z.string().max(2000).optional().or(z.literal('')),
  validUntil: z.string().max(40).optional().or(z.literal('')),
});
export type ProposalInput = z.infer<typeof ProposalInput>;

// Links the agent may offer. Stored as identifiers so the model never emits a
// raw URL: it selects a CTA id and the server resolves the approved link.
//
// `native:` actions are performed inside the chat app itself (for example
// native:accept opens BuildClose's own acceptance form) rather than navigating
// away, so a proposal can be accepted without leaving the conversation.
const CtaUrl = z
  .string()
  .min(1)
  .max(2000)
  .refine((v) => v.startsWith('native:') || /^https?:\/\/\S+$/i.test(v) || v.startsWith('mailto:'), {
    message: 'Must be an https URL, a mailto: link, or a native: action',
  });

export const CtaLink = z.object({
  id: z.enum(['schedule_call', 'accept_proposal', 'sign_agreement', 'pay_commencement', 'contact_rep']),
  label: z.string().min(1).max(80),
  url: CtaUrl,
  enabled: z.boolean().default(true),
});
export type CtaLink = z.infer<typeof CtaLink>;

// ------------------------------------------------- agent config (prospect-visible knowledge)
export const AgentConfigInput = z.object({
  displayName: z.string().min(1).max(80).default('Abrica Assistant'),
  persona: z.string().max(1000).default('consultative, precise, unhurried'),
  tone: z.enum(['consultative', 'direct', 'warm', 'formal']).default('consultative'),
  // Approved, quotable value statements.
  valuePoints: z.array(z.string().max(600)).max(30).default([]),
  // Approved objection responses, keyed by objection type.
  objectionPlaybook: z
    .array(
      z.object({
        type: z.string().min(1).max(60),
        trigger: z.string().max(400),
        response: z.string().max(1200),
      }),
    )
    .max(60)
    .default([]),
  // Facts the agent may state verbatim.
  productFacts: z.array(z.string().max(600)).max(80).default([]),
  // Things it must never claim.
  prohibitedClaims: z.array(z.string().max(400)).max(40).default([]),
  // Closing objective, phrased as guidance.
  closingObjective: z.string().max(600).default(''),
  // Escalation instruction shown to the prospect when the agent is unsure.
  escalationMessage: z.string().max(600).default(''),
  ctaLinks: z.array(CtaLink).max(10).default([]),
});
export type AgentConfigInput = z.infer<typeof AgentConfigInput>;

// ---------------------------------------- internal record (NEVER sent to prospect)
// Requirement 4: kept in a separate document with no client read path at all.
export const ProposalInternalInput = z.object({
  priceFloorMinor: z.number().int().nonnegative(),
  maxDiscountPercent: z.number().min(0).max(100),
  negotiationBoundaries: z.array(z.string().max(600)).max(30).default([]),
  competitorNotes: z
    .array(z.object({ competitor: z.string().max(120), posture: z.string().max(800) }))
    .max(20)
    .default([]),
  internalNotes: z.string().max(4000).default(''),
  approvedDiscounts: z
    .array(z.object({ label: z.string().max(120), amountMinor: z.number().int().nonnegative(), conditions: z.string().max(400) }))
    .max(20)
    .default([]),
  /**
   * Figures the agent may state that are NOT concessions — published schedule
   * prices, add-on rates, rate cards. Kept distinct from `approvedDiscounts` so
   * that "may quote" never implies "may concede": a quotable amount is still not
   * an offer, and the prompt treats the two differently.
   */
  quotableAmountsMinor: z.array(z.number().int().nonnegative()).max(40).default([]),
});
export type ProposalInternalInput = z.infer<typeof ProposalInternalInput>;

// ------------------------------------------------------------- AI response
// The single structured object every model call must return.
export const AiReplySchema = z.object({
  reply: z.string().min(1).max(4000),
  cta_id: z
    .enum(['schedule_call', 'accept_proposal', 'sign_agreement', 'pay_commencement', 'contact_rep'])
    .nullable()
    .default(null),
  objection_type: z.string().max(60).nullable().default(null),
  competitor_mention: z.string().max(120).nullable().default(null),
  interest_signal: z.enum(['none', 'low', 'medium', 'high']).default('none'),
  unanswered_question: z.string().max(400).nullable().default(null),
  escalate: z.boolean().default(false),
  /** Money the agent asserts. Validated server-side against the proposal. */
  asserted_amounts_minor: z.array(z.number().int()).max(20).default([]),
});
export type AiReply = z.infer<typeof AiReplySchema>;

// ------------------------------------------------------------- acceptance
export const AcceptanceInput = z.object({
  fullName: z.string().min(2).max(200),
  email: z.string().email().max(320),
  title: z.string().max(120).optional().or(z.literal('')),
  consent: z.literal(true),
  /** Hash of the exact rendered proposal document the prospect agreed to. */
  documentHash: z.string().min(16).max(128),
  documentVersion: z.number().int().positive(),
  typedSignature: z.string().min(2).max(200),
});
export type AcceptanceInput = z.infer<typeof AcceptanceInput>;

// ------------------------------------------------------------------ helpers
export const cents = (minor: number): string =>
  (minor / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

/** Parse a money amount written in prose back to minor units, if present. */
export function extractAmountsMinor(text: string): number[] {
  const out: number[] = [];
  const re = /\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = (m[1] ?? '').replace(/,/g, '');
    const value = Number.parseFloat(raw);
    if (Number.isFinite(value)) out.push(Math.round(value * 100));
  }
  return out;
}
