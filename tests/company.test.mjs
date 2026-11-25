/**
 * Company intelligence and commercial authority tests.
 *
 * Pure logic, no emulator, no credentials — so these gate every commit cheaply
 * and cannot be skipped for environmental reasons.
 *
 * What is proven here, in order of how badly it would hurt to get wrong:
 *
 *   1. A proposal override can only TIGHTEN company authority. Every loosening
 *      direction is exercised explicitly, because this is the rule that stops a
 *      rep handing themselves a discount the company never authorised.
 *   2. Absent authority keeps legacy behaviour (the 113-verified baseline).
 *   3. Knowledge merges are additive for safety rules — a proposal can add a
 *      prohibited claim but never remove the company's.
 *   4. `deepMerge` cannot blank stored fields when a caller sends a partial patch.
 *   5. Payment schedule arithmetic is validated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CommercialAuthorityInput,
  CompanyIntelligenceInput,
  deepMerge,
  effectiveAuthority,
  mergeAgentKnowledge,
  validateAuthority,
  authorityOverrideProblems,
} from '../functions/lib/lib/company.js';

import { ProposalInternalInput, AgentConfigInput } from '../functions/lib/lib/domain.js';

// ---------------------------------------------------------------- fixtures

/** A company with a 15% ceiling and a $15,000 floor. */
function company(overrides = {}) {
  return CommercialAuthorityInput.parse({
    priceFloorMinor: 1_500_000,
    maxDiscountPercent: 15,
    paymentTerms: 'Net 14',
    paymentSchedule: [
      { label: 'Commencement', percent: 40 },
      { label: 'Midpoint', percent: 30 },
      { label: 'Completion', percent: 30 },
    ],
    negotiationPermissions: {
      canOfferDiscounts: true,
      canAdjustTimeline: false,
      canWaiveFees: false,
      requiresApprovalAbovePercent: 10,
    },
    approvedDiscounts: [
      { label: 'Early payment', amountMinor: 1_800_000, conditions: 'Paid within 7 days' },
    ],
    quotableAmountsMinor: [2_000_000],
    negotiationBoundaries: ['Never discuss competitor pricing.'],
    internalNotes: 'internal',
    ...overrides,
  });
}

function internal(overrides = {}) {
  return ProposalInternalInput.parse(overrides);
}

// --------------------------------------------------- authority: tightening only

test('a proposal cannot raise the discount ceiling above the company ceiling', () => {
  const eff = effectiveAuthority(company(), { maxDiscountPercent: 50 }, internal());
  assert.equal(eff.maxDiscountPercent, 15, 'company ceiling must bind');
  assert.ok(eff.tightened.includes('maxDiscountPercent'), 'and must be reported as tightened');
});

test('a proposal CAN lower the discount ceiling below the company ceiling', () => {
  const eff = effectiveAuthority(company(), { maxDiscountPercent: 5 }, internal());
  assert.equal(eff.maxDiscountPercent, 5, 'stricter override honoured');
  assert.deepEqual(eff.tightened, [], 'nothing was overridden upward');
});

test('a proposal cannot lower the price floor beneath the company floor', () => {
  const eff = effectiveAuthority(company(), { priceFloorMinor: 500_000 }, internal());
  assert.equal(eff.priceFloorMinor, 1_500_000, 'company floor must bind');
  assert.ok(eff.tightened.includes('priceFloorMinor'));
});

test('a proposal CAN raise the price floor above the company floor', () => {
  const eff = effectiveAuthority(company(), { priceFloorMinor: 2_000_000 }, internal());
  assert.equal(eff.priceFloorMinor, 2_000_000, 'stricter override honoured');
});

test('a proposal cannot widen the negotiated permissions', () => {
  const eff = effectiveAuthority(company(), null, internal());
  assert.equal(eff.negotiable.canAdjustTimeline, false, 'timeline permission stays off');
  assert.equal(eff.negotiable.canWaiveFees, false, 'waiver permission stays off');
});

test('zero discount ceiling makes offering discounts impossible regardless of permission', () => {
  const c = company({ maxDiscountPercent: 0 });
  const eff = effectiveAuthority(c, null, internal());
  assert.equal(eff.negotiable.canOfferDiscounts, false, 'permission AND ceiling must both allow it');
});

test('negotiation boundaries are a union, so a proposal cannot remove a company rule', () => {
  const eff = effectiveAuthority(
    company(),
    null,
    internal({ negotiationBoundaries: ['No exclusivity.'] }),
  );
  assert.ok(eff.negotiationBoundaries.includes('Never discuss competitor pricing.'), 'company rule retained');
  assert.ok(eff.negotiationBoundaries.includes('No exclusivity.'), 'proposal rule added');
  assert.equal(eff.negotiationBoundaries.length, 2);
});

test('a proposal cannot quote an arbitrary figure the company never authorised', () => {
  // The attack: put an invented number in the proposal's quotable list so the
  // assistant is "allowed" to state a price nobody approved.
  const eff = effectiveAuthority(
    company(),
    null,
    internal({ quotableAmountsMinor: [9_999_900] }),
  );
  assert.deepEqual(eff.quotableAmountsMinor, [], 'an unauthorised quotable figure is dropped');
});

test('a proposal may quote a figure the company did publish', () => {
  const eff = effectiveAuthority(company(), null, internal({ quotableAmountsMinor: [2_000_000] }));
  assert.deepEqual(eff.quotableAmountsMinor, [2_000_000]);
});

test('an approved concession below the effective floor is not carried forward', () => {
  // A $10,000 concession against a $15,000 floor can never lawfully be offered,
  // so presenting it to the model would invite a breach of the floor.
  const c = company({
    approvedDiscounts: [{ label: 'Stale deal', amountMinor: 1_000_000, conditions: '' }],
  });
  const eff = effectiveAuthority(c, null, internal());
  assert.equal(
    eff.approvedDiscounts.some((d) => d.amountMinor === 1_000_000),
    false,
    'unofferable concession must be filtered out',
  );
});

// ------------------------------------------------------- absent authority path

test('with no company authority, proposal values stand unchanged (legacy behaviour)', () => {
  const eff = effectiveAuthority(null, null, internal({ priceFloorMinor: 900_000, maxDiscountPercent: 20 }));
  assert.equal(eff.priceFloorMinor, 900_000);
  assert.equal(eff.maxDiscountPercent, 20);
  assert.deepEqual(eff.tightened, []);
});

test('with no company authority and no internal record, no discount is authorised', () => {
  // This is the safe default the whole product depends on: an unconfigured
  // proposal must not mean "unlimited concession".
  const eff = effectiveAuthority(null, null, internal({}));
  assert.equal(eff.maxDiscountPercent, 0);
  assert.equal(eff.negotiable.canOfferDiscounts, false);
});

test('an unset proposal override does not clamp the company ceiling to zero', () => {
  // Regression guard for the bug this design exists to prevent: ProposalInternalInput
  // defaults maxDiscountPercent to 0, so treating that default as intent would make
  // company authority dead for every proposal created without explicit internals.
  const eff = effectiveAuthority(company(), {}, internal({}));
  assert.equal(eff.maxDiscountPercent, 15, 'company ceiling survives an unset override');
  assert.deepEqual(eff.tightened, [], 'nothing was overridden');
});

// -------------------------------------------------------------- override write

test('authorityOverrideProblems rejects a loosening override with a message', () => {
  const problems = authorityOverrideProblems(company(), {
    priceFloorMinor: 100_000,
    maxDiscountPercent: 60,
  });
  assert.equal(problems.length, 2);
  assert.match(problems.join(' '), /only be stricter/i);
});

test('authorityOverrideProblems accepts a tightening override', () => {
  const problems = authorityOverrideProblems(company(), {
    priceFloorMinor: 2_000_000,
    maxDiscountPercent: 5,
  });
  assert.deepEqual(problems, []);
});

test('authorityOverrideProblems is a no-op when no company authority exists', () => {
  assert.deepEqual(authorityOverrideProblems(null, { maxDiscountPercent: 90 }), []);
});

// ------------------------------------------------------------------- merge

test('deepMerge cannot blank stored fields when the patch is partial', () => {
  const stored = {
    profile: { displayName: 'Meridian', description: 'We build sites.', differentiators: ['Fast'] },
    faqs: [{ question: 'Q', answer: 'A', category: '' }],
  };
  const merged = deepMerge(stored, { profile: { displayName: 'Meridian Studio' } });
  assert.equal(merged.profile.displayName, 'Meridian Studio', 'patched field updated');
  assert.equal(merged.profile.description, 'We build sites.', 'unpatched field preserved');
  assert.deepEqual(merged.profile.differentiators, ['Fast'], 'unpatched array preserved');
  assert.deepEqual(merged.faqs, stored.faqs, 'untouched section preserved');
});

test('deepMerge replaces arrays rather than merging them by index', () => {
  const merged = deepMerge({ list: ['a', 'b', 'c'] }, { list: ['z'] });
  assert.deepEqual(merged.list, ['z'], 'arrays replace wholesale');
});

test('deepMerge ignores undefined values instead of clearing them', () => {
  const merged = deepMerge({ a: 1 }, { a: undefined });
  assert.equal(merged.a, 1);
});

// --------------------------------------------------------------- knowledge merge

test('company product facts and FAQs reach a proposal that supplies none', () => {
  const intel = CompanyIntelligenceInput.parse({
    productsServices: [
      { name: 'Brand refresh', description: 'Identity and rollout', deliverables: ['Logo', 'Guidelines'] },
    ],
    faqs: [{ question: 'Do you travel?', answer: 'Yes, nationwide.' }],
  });
  const agent = AgentConfigInput.parse({});
  const { merged } = mergeAgentKnowledge(intel, agent);
  const joined = merged.productFacts.join(' | ');
  assert.match(joined, /Brand refresh/);
  assert.match(joined, /Logo/);
  assert.match(joined, /Do you travel/);
});

test('a proposal cannot remove a company prohibited claim', () => {
  const intel = CompanyIntelligenceInput.parse({});
  const agent = AgentConfigInput.parse({ prohibitedClaims: ['Never promise rankings.'] });
  const { merged } = mergeAgentKnowledge(intel, agent);
  assert.ok(merged.prohibitedClaims.includes('Never promise rankings.'));
});

test('proposal display settings win over company defaults', () => {
  const intel = CompanyIntelligenceInput.parse({
    assistantDefaults: { displayName: 'Company Default', accentColor: '#112233' },
  });
  const agent = AgentConfigInput.parse({ displayName: 'Northwind Assistant', accentColor: '#445566' });
  const { merged } = mergeAgentKnowledge(intel, agent);
  assert.equal(merged.displayName, 'Northwind Assistant', 'the proposal is the customer-facing artefact');
  assert.equal(merged.accentColor, '#445566');
});

test('company objection playbook is used when the proposal has none', () => {
  const intel = CompanyIntelligenceInput.parse({
    objectionPlaybook: [{ type: 'price', trigger: 'Too expensive', response: 'Here is the value case.' }],
  });
  const { merged } = mergeAgentKnowledge(intel, AgentConfigInput.parse({}));
  assert.equal(merged.objectionPlaybook.length, 1);
  assert.equal(merged.objectionPlaybook[0].type, 'price');
});

test('merge with no intelligence returns the proposal config untouched', () => {
  const agent = AgentConfigInput.parse({ displayName: 'Solo', productFacts: ['Only fact'] });
  const { merged } = mergeAgentKnowledge(null, agent);
  assert.deepEqual(merged.productFacts, ['Only fact']);
  assert.equal(merged.displayName, 'Solo');
});

// -------------------------------------------------------------- authority validation

test('payment schedule that does not total 100% is rejected', () => {
  const bad = CommercialAuthorityInput.parse({
    priceFloorMinor: 0,
    maxDiscountPercent: 0,
    paymentTerms: '',
    paymentSchedule: [
      { label: 'A', percent: 40 },
      { label: 'B', percent: 30 },
    ],
    negotiationPermissions: {
      canOfferDiscounts: false,
      canAdjustTimeline: false,
      canWaiveFees: false,
      requiresApprovalAbovePercent: 0,
    },
    approvedDiscounts: [],
    quotableAmountsMinor: [],
    negotiationBoundaries: [],
    internalNotes: '',
  });
  const problems = validateAuthority(bad);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /100%/);
});

test('a valid authority record produces no validation problems', () => {
  assert.deepEqual(validateAuthority(company()), []);
});

test('authority fields are required, not defaulted, when a record exists', () => {
  // A partial authority document must fail loudly rather than materialise
  // "0% ceiling, everything off" and look like a deliberate policy.
  const result = CommercialAuthorityInput.safeParse({ priceFloorMinor: 100 });
  assert.equal(result.success, false);
});
