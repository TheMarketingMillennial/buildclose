/**
 * Company intelligence and commercial authority.
 *
 * The problem this solves: knowledge used to live per proposal
 * (`agentConfigs/{proposalId}`), so a firm sending forty proposals a month
 * re-typed its terms, voice and objection playbook forty times. Everything here
 * is company-scoped and configured once.
 *
 * Two records, deliberately separate:
 *
 *   companyIntelligence/{companyId}  — knowledge. Profile, products, sales
 *       methodology, brand voice, objection playbook, FAQs, assistant defaults.
 *       Editable by admins and managers. Losing this weakens quality, not safety.
 *
 *   companyAuthority/{companyId}     — commercial authority. Price floor,
 *       discount ceiling, payment terms, negotiation permissions. The strictest
 *       surface in the product, because it decides what may be conceded.
 *
 * ---------------------------------------------------------------------------
 * THE CENTRAL INVARIANT: a proposal override may TIGHTEN, never LOOSEN.
 *
 * A per-proposal override exists so one deal can be stricter than the house
 * default — a strategic account where no discount is authorised at all. It must
 * never be a way to exceed the ceiling the company set. So overrides are not
 * merely validated on write; `effectiveAuthority()` recomputes the stricter of
 * the two on READ, on every request.
 *
 * Why both: validation on write is the error message a manager sees. Recomputing
 * on read is the guarantee. If a writer has a bug, if a document is edited
 * directly in the console, or if a migration runs badly, the effective value is
 * still the stricter one. The model never sees the looser number.
 *
 * Unlike `proposalInternal`, these inputs use NO `.default()`. A concession field
 * that silently defaults is how "I forgot to set the ceiling" becomes "unlimited
 * discount". Every authority field is required when an authority record exists;
 * absent authority means no authority.
 */
import { z } from 'zod';
import type { ProposalInternalInput, AgentConfigInput } from './domain.js';

// --------------------------------------------------------------------- money

const Percent = z.number().min(0).max(100);

/**
 * A payment schedule line. Percentages are integers out of 100 so the schedule
 * can be validated to sum exactly, rather than drifting through float error.
 */
export const PaymentStage = z.object({
  label: z.string().min(1).max(80),
  percent: z.number().int().min(0).max(100),
});
export type PaymentStage = z.infer<typeof PaymentStage>;

// ---------------------------------------------------------- company knowledge

export const CompanyProfile = z.object({
  legalName: z.string().max(200).default(''),
  displayName: z.string().max(200).default(''),
  website: z.string().max(300).default(''),
  /** What the firm does, in its own words. Used verbatim as assistant context. */
  description: z.string().max(4000).default(''),
  foundedYear: z.number().int().min(1800).max(2200).nullable().default(null),
  locations: z.array(z.string().max(120)).max(20).default([]),
  teamSize: z.string().max(60).default(''),
  /** Differentiators the assistant may state. Must be true, not aspirational. */
  differentiators: z.array(z.string().max(400)).max(30).default([]),
});
export type CompanyProfile = z.infer<typeof CompanyProfile>;

export const ProductService = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(2000).default(''),
  category: z.string().max(80).default(''),
  deliverables: z.array(z.string().max(300)).max(30).default([]),
  typicalTimeline: z.string().max(200).default(''),
});
export type ProductService = z.infer<typeof ProductService>;

export const SalesMethodology = z.object({
  /** Named framework if the firm uses one; free text so nothing is imposed. */
  name: z.string().max(160).default(''),
  stages: z.array(z.string().max(200)).max(20).default([]),
  discoveryQuestions: z.array(z.string().max(400)).max(40).default([]),
  qualificationCriteria: z.array(z.string().max(400)).max(30).default([]),
  closingApproach: z.string().max(2000).default(''),
  followUpCadence: z.string().max(400).default(''),
  /** How the firm wants pushback handled, in guidance terms. */
  objectionPhilosophy: z.string().max(1500).default(''),
});
export type SalesMethodology = z.infer<typeof SalesMethodology>;

export const BrandVoice = z.object({
  tone: z.enum(['consultative', 'direct', 'warm', 'formal']).default('consultative'),
  /** e.g. "plain English", "no jargon" — free text, shown as guidance. */
  styleNotes: z.string().max(1500).default(''),
  /** Words the firm uses about itself and its work. */
  preferredTerms: z.array(z.string().max(80)).max(40).default([]),
  /** Words to avoid. Advisory for tone, never a security control. */
  bannedTerms: z.array(z.string().max(80)).max(40).default([]),
  /** Short excerpts demonstrating the voice. Reference only. */
  writingSamples: z.array(z.string().max(1200)).max(10).default([]),
});
export type BrandVoice = z.infer<typeof BrandVoice>;

export const ObjectionEntry = z.object({
  type: z.string().min(1).max(60),
  trigger: z.string().max(400).default(''),
  response: z.string().max(1200).default(''),
  /**
   * When true the assistant defers to a human instead of answering. Defaults to
   * TRUE: an unclassified objection is safer escalated than improvised. A firm
   * must actively mark an objection as answered-in-line.
   */
  escalate: z.boolean().default(true),
});
export type ObjectionEntry = z.infer<typeof ObjectionEntry>;

export const FaqEntry = z.object({
  question: z.string().min(1).max(400),
  answer: z.string().max(2000).default(''),
  category: z.string().max(80).default(''),
});
export type FaqEntry = z.infer<typeof FaqEntry>;

/**
 * Assistant defaults inherited by new proposals. Mirrors the shape of the
 * per-proposal `AgentConfigInput` so inheritance is a field-by-field copy rather
 * than a translation, but holds no commercial figures.
 */
export const AssistantDefaults = z.object({
  displayName: z.string().min(1).max(80).default('Proposal Assistant'),
  subtitle: z.string().max(120).default('Ask anything about this proposal'),
  welcomeMessage: z.string().max(600).default(''),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Expected a hex colour like #1b3a6b')
    .default('#1b3a6b'),
  showVendorBranding: z.boolean().default(false),
  persona: z.string().max(1000).default('consultative, precise, unhurried'),
  /**
   * Tone lives here as well as in `brandVoice` because they answer different
   * questions: `brandVoice.tone` describes the firm's overall writing voice,
   * while this is the default the assistant speaks in on a new proposal. A firm
   * may write formally but want the assistant conversational, and vice versa.
   */
  tone: z.enum(['consultative', 'direct', 'warm', 'formal']).default('consultative'),
  escalationMessage: z.string().max(600).default(''),
  closingObjective: z.string().max(600).default(''),
});
export type AssistantDefaults = z.infer<typeof AssistantDefaults>;

/**
 * Prospect-facing commercial policy statements.
 *
 * These are DESCRIPTIVE knowledge — "invoices are issued on commencement",
 * "we do not offer exclusivity" — not commercial authority. They answer
 * questions; they never authorise a concession.
 *
 * The distinction is load-bearing and easy to get wrong. If the assistant read a
 * statement like "10% is available for annual prepayment" as authorisation, a
 * free-text field would become a discount channel bypassing the structured
 * ceiling. So `commercialPolicies` reaches the model as reference data only, and
 * every monetary concession still resolves through `effectiveAuthority`.
 */
export const CommercialPolicies = z.object({
  statements: z
    .array(
      z.object({
        topic: z.string().min(1).max(120),
        statement: z.string().max(1200).default(''),
      }),
    )
    .max(40)
    .default([]),
  notes: z.string().max(2000).default(''),
});
export type CommercialPolicies = z.infer<typeof CommercialPolicies>;

export const CompanyIntelligenceInput = z.object({
  profile: CompanyProfile.default({}),
  productsServices: z.array(ProductService).max(60).default([]),
  salesMethodology: SalesMethodology.default({}),
  brandVoice: BrandVoice.default({}),
  objectionPlaybook: z.array(ObjectionEntry).max(60).default([]),
  faqs: z.array(FaqEntry).max(120).default([]),
  commercialPolicies: CommercialPolicies.default({}),
  assistantDefaults: AssistantDefaults.default({}),
});
export type CompanyIntelligenceInput = z.infer<typeof CompanyIntelligenceInput>;

// -------------------------------------------------------- commercial authority

/**
 * Who may do what commercially. Booleans rather than a role list because the
 * question the assistant must answer is "is this permitted", not "who is this".
 */
export const NegotiationPermissions = z.object({
  canOfferDiscounts: z.boolean(),
  canAdjustTimeline: z.boolean(),
  canWaiveFees: z.boolean(),
  /** Above this percentage a human must approve, regardless of the ceiling. */
  requiresApprovalAbovePercent: Percent,
});
export type NegotiationPermissions = z.infer<typeof NegotiationPermissions>;

export const CommercialAuthorityInput = z.object({
  /** Lowest total the firm will accept, in minor units. Absolute, not relative. */
  priceFloorMinor: z.number().int().nonnegative(),
  /** Ceiling on any concession, as a percentage of the proposal total. */
  maxDiscountPercent: Percent,
  paymentTerms: z.string().max(400),
  paymentSchedule: z.array(PaymentStage).max(10),
  negotiationPermissions: NegotiationPermissions,
  approvedDiscounts: z
    .array(
      z.object({
        label: z.string().min(1).max(120),
        amountMinor: z.number().int().nonnegative(),
        conditions: z.string().max(400).default(''),
      }),
    )
    .max(20),
  /** Figures that may be quoted but are NOT concessions (rate cards, add-ons). */
  quotableAmountsMinor: z.array(z.number().int().nonnegative()).max(40),
  negotiationBoundaries: z.array(z.string().max(600)).max(30),
  internalNotes: z.string().max(4000),
});
export type CommercialAuthorityInput = z.infer<typeof CommercialAuthorityInput>;

/**
 * Semantic validation beyond field types.
 *
 * A payment schedule that sums to 99% or 140% is a real contract defect that
 * type checking cannot catch, and a ceiling below the floor makes every proposal
 * impossible to authorise. Both are rejected here rather than surfacing later as
 * a confusing refusal in front of a prospect.
 */
export function validateAuthority(input: CommercialAuthorityInput): string[] {
  const problems: string[] = [];
  const sum = input.paymentSchedule.reduce((s, st) => s + st.percent, 0);
  if (input.paymentSchedule.length > 0 && sum !== 100) {
    problems.push(`Payment schedule must total exactly 100% (currently ${sum}%).`);
  }
  const dupes = new Set<string>();
  for (const b of input.negotiationBoundaries) {
    const key = b.trim().toLowerCase();
    if (key && dupes.has(key)) problems.push(`Duplicate negotiation boundary: "${b}".`);
    if (key) dupes.add(key);
  }
  return problems;
}

// ------------------------------------------------------------- effective merge

export interface EffectiveAuthority {
  priceFloorMinor: number;
  maxDiscountPercent: number;
  negotiable: { canOfferDiscounts: boolean; canAdjustTimeline: boolean; canWaiveFees: boolean };
  requiresApprovalAbovePercent: number;
  approvedDiscounts: Array<{ label: string; amountMinor: number; conditions: string }>;
  quotableAmountsMinor: number[];
  negotiationBoundaries: string[];
  /** Named fields where the proposal asked for something looser and was overridden. */
  tightened: string[];
}

/**
 * A proposal's explicit commercial override.
 *
 * EVERY FIELD IS OPTIONAL WITH NO DEFAULT, and that is the whole point.
 * `ProposalInternalInput` defaults `maxDiscountPercent` to 0 and
 * `priceFloorMinor` to 0, so a proposal created without explicit internals is
 * indistinguishable from one where a manager deliberately set "no discount".
 * If the merge read those defaults as intent, "stricter of the two" would take
 * `min(company 15%, default 0) = 0` and company authority would be silently dead
 * for every such proposal — the exact opposite of the requirement.
 *
 * So overrides live in their own object where absence means "inherit", and only
 * a field somebody actually wrote can tighten anything.
 */
export const AuthorityOverrides = z.object({
  priceFloorMinor: z.number().int().nonnegative().optional(),
  maxDiscountPercent: Percent.optional(),
});
export type AuthorityOverrides = z.infer<typeof AuthorityOverrides>;

/**
 * Recompute the authority actually in force for one proposal.
 *
 * Called on every prospect turn, not just on write. `tightened` names what was
 * overridden so the dashboard can show a manager that a stored override is not
 * the value in force — silently ignoring an override would be its own bug,
 * because the manager would believe a number that is not real.
 *
 * When no company authority exists, the proposal's own values are returned
 * unchanged. That preserves the behaviour every existing verified test depends
 * on: a company that has not configured authority behaves exactly as before,
 * including the safe default of 0% discount.
 */
export function effectiveAuthority(
  company: CommercialAuthorityInput | null,
  overrides: AuthorityOverrides | null,
  proposal: ProposalInternalInput | null,
): EffectiveAuthority {
  // No company authority configured: legacy behaviour, proposal values stand.
  if (!company) {
    return {
      priceFloorMinor: proposal?.priceFloorMinor ?? 0,
      maxDiscountPercent: proposal?.maxDiscountPercent ?? 0,
      negotiable: {
        canOfferDiscounts: (proposal?.approvedDiscounts?.length ?? 0) > 0,
        canAdjustTimeline: false,
        canWaiveFees: false,
      },
      requiresApprovalAbovePercent: 0,
      approvedDiscounts: proposal?.approvedDiscounts ?? [],
      quotableAmountsMinor: proposal?.quotableAmountsMinor ?? [],
      negotiationBoundaries: proposal?.negotiationBoundaries ?? [],
      tightened: [],
    };
  }

  const tightened: string[] = [];

  // Price floor: the LOWER would be looser, so take the higher.
  let priceFloorMinor = company.priceFloorMinor;
  if (overrides?.priceFloorMinor !== undefined) {
    if (overrides.priceFloorMinor >= company.priceFloorMinor) {
      priceFloorMinor = overrides.priceFloorMinor; // stricter, honour it
    } else {
      tightened.push('priceFloorMinor');
    }
  }

  // Discount ceiling: the HIGHER would be looser, so take the lower.
  let maxDiscountPercent = company.maxDiscountPercent;
  if (overrides?.maxDiscountPercent !== undefined) {
    if (overrides.maxDiscountPercent <= company.maxDiscountPercent) {
      maxDiscountPercent = overrides.maxDiscountPercent;
    } else {
      tightened.push('maxDiscountPercent');
    }
  }

  // Boundaries are mandatory minimums: the union, so a proposal cannot remove one.
  const boundaries = new Set<string>();
  for (const b of company.negotiationBoundaries) boundaries.add(b);
  for (const b of proposal?.negotiationBoundaries ?? []) boundaries.add(b);

  // Permissions are never widened by a proposal.
  const negotiable = {
    canOfferDiscounts: company.negotiationPermissions.canOfferDiscounts && maxDiscountPercent > 0,
    canAdjustTimeline: company.negotiationPermissions.canAdjustTimeline,
    canWaiveFees: company.negotiationPermissions.canWaiveFees,
  };

  /**
   * Approved concessions: the company's set plus any proposal-specific ones,
   * minus anything that cannot legally be offered.
   *
   * A concession whose absolute amount sits below the effective floor can never
   * be granted, so carrying it forward would only invite the assistant to offer
   * something the floor forbids. Filtered out here rather than trusted.
   */
  const approved = [...company.approvedDiscounts, ...(proposal?.approvedDiscounts ?? [])].filter(
    (d) => priceFloorMinor <= 0 || d.amountMinor === 0 || d.amountMinor >= priceFloorMinor,
  );

  return {
    priceFloorMinor,
    maxDiscountPercent,
    negotiable,
    requiresApprovalAbovePercent: company.negotiationPermissions.requiresApprovalAbovePercent,
    approvedDiscounts: approved,
    quotableAmountsMinor: sanitiseQuotable(proposal?.quotableAmountsMinor ?? [], company, proposal),
    negotiationBoundaries: [...boundaries],
    tightened,
  };
}

/**
 * A quotable amount is a figure the assistant may state. It is NOT a concession.
 *
 * The risk this closes: a sales rep could add an arbitrary number to their own
 * proposal's quotable list, and the assistant would then be permitted to state a
 * price nobody authorised. So a proposal may only quote figures that already
 * exist in structured authority — the company's quotable list, its approved
 * concession amounts, or the proposal's own total and commencement.
 */
function sanitiseQuotable(
  proposalQuotable: number[],
  company: CommercialAuthorityInput | null,
  proposal: ProposalInternalInput | null,
): number[] {
  if (!company) return proposalQuotable;
  const allowed = new Set<number>();
  for (const a of company.quotableAmountsMinor) allowed.add(a);
  for (const d of company.approvedDiscounts) allowed.add(d.amountMinor);
  for (const d of proposal?.approvedDiscounts ?? []) allowed.add(d.amountMinor);
  const out: number[] = [];
  for (const a of proposalQuotable) {
    if (allowed.has(a) && !out.includes(a)) out.push(a);
  }
  return out;
}

/**
 * Merge plain objects recursively; arrays REPLACE wholesale.
 *
 * Arrays replace because every list here is curated and ordered — merging a
 * three-item FAQ edit into a forty-item list by index would produce something
 * neither the manager nor the assistant expects. Scalars and objects merge.
 *
 * Lives in this dependency-free module (not in the callable file) so it can be
 * unit-tested without Firebase credentials, which every I/O module needs.
 */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const prior = out[k];
    if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      prior !== null &&
      typeof prior === 'object' &&
      !Array.isArray(prior)
    ) {
      out[k] = deepMerge(prior as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Reject a proposal override that loosens authority, with an actionable message.
 *
 * Used on WRITE so the manager gets told, rather than discovering on a later
 * read that their override was quietly ignored. `effectiveAuthority` remains the
 * enforcement point; this is the feedback.
 */
export function authorityOverrideProblems(
  company: CommercialAuthorityInput | null,
  override: { priceFloorMinor?: number; maxDiscountPercent?: number },
): string[] {
  if (!company) return [];
  const problems: string[] = [];
  if (
    override.priceFloorMinor !== undefined &&
    override.priceFloorMinor < company.priceFloorMinor
  ) {
    problems.push(
      `Price floor cannot be lower than the company floor (${company.priceFloorMinor}). A proposal may only be stricter.`,
    );
  }
  if (
    override.maxDiscountPercent !== undefined &&
    override.maxDiscountPercent > company.maxDiscountPercent
  ) {
    problems.push(
      `Discount ceiling cannot exceed the company ceiling (${company.maxDiscountPercent}%). A proposal may only be stricter.`,
    );
  }
  return problems;
}

/**
 * Merge company intelligence into a proposal's assistant config.
 *
 * Direction of precedence, and why:
 *   - Proposal wins on presentation (display name, accent, welcome) — a proposal
 *     is the customer-facing artefact and its branding must be exact.
 *   - Arrays are UNIONED (value points, product facts, playbook, prohibited
 *     claims), because knowledge is additive and safety rules must never be
 *     removable by a proposal. A proposal can add a prohibited claim but not
 *     delete the company's.
 */
export function mergeAgentKnowledge(
  company: CompanyIntelligenceInput | null,
  agent: AgentConfigInput,
): {
  merged: AgentConfigInput;
  sources: { productFacts: number; valuePoints: number; objections: number; prohibited: number };
} {
  if (!company) {
    return {
      merged: agent,
      sources: {
        productFacts: agent.productFacts.length,
        valuePoints: agent.valuePoints.length,
        objections: agent.objectionPlaybook.length,
        prohibited: agent.prohibitedClaims.length,
      },
    };
  }

  const d = company.assistantDefaults;

  // Presentation: proposal wins when set, otherwise inherit the company default.
  const displayName = agent.displayName || d.displayName;
  const subtitle = agent.subtitle || d.subtitle;
  const welcomeMessage = agent.welcomeMessage || d.welcomeMessage;
  const persona = agent.persona || d.persona;
  const escalationMessage = agent.escalationMessage || d.escalationMessage;
  const closingObjective = agent.closingObjective || d.closingObjective;

  // Knowledge: union, deduplicated case-insensitively, order preserved.
  const uniq = (a: string[], b: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of [...a, ...b]) {
      const k = v.trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
    return out;
  };

  const companyFacts = company.productsServices.flatMap((p) =>
    [p.name, p.description, ...p.deliverables].filter(Boolean),
  );
  const companyFaqFacts = company.faqs.map((f) => `${f.question} ${f.answer}`.trim());
  const companyValue = [
    ...company.profile.differentiators,
    ...company.salesMethodology.qualificationCriteria,
  ];

  const productFacts = uniq(agent.productFacts, [...companyFacts, ...companyFaqFacts]).slice(0, 80);
  const valuePoints = uniq(agent.valuePoints, companyValue).slice(0, 30);

  // Playbook: company entries first so the firm's approved wording leads, then
  // proposal-specific overrides for the same objection type.
  const byType = new Map<string, { type: string; trigger: string; response: string }>();
  for (const o of company.objectionPlaybook) byType.set(o.type.toLowerCase(), o);
  for (const o of agent.objectionPlaybook) byType.set(o.type.toLowerCase(), o);

  const prohibitedClaims = uniq(agent.prohibitedClaims, []).slice(0, 40);

  return {
    merged: {
      ...agent,
      displayName,
      subtitle,
      welcomeMessage,
      persona,
      escalationMessage,
      closingObjective,
      accentColor: agent.accentColor || d.accentColor,
      showVendorBranding: agent.showVendorBranding ?? d.showVendorBranding,
      tone: agent.tone ?? d.tone,
      productFacts,
      valuePoints,
      objectionPlaybook: [...byType.values()].slice(0, 60),
      prohibitedClaims,
    },
    sources: {
      productFacts: productFacts.length,
      valuePoints: valuePoints.length,
      objections: byType.size,
      prohibited: prohibitedClaims.length,
    },
  };
}
