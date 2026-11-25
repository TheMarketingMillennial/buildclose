/**
 * Seed the Abrica demonstration proposal.
 *
 * Every figure below is transcribed from the actual proposal document
 * (`index(4).html`, The Marketing Millennial Limited → Hector Abrica, 24 Nov
 * 2026). Nothing here is invented. Figures that appear in the proposal are split
 * by authority:
 *
 *   approvedDiscounts  — concessions the agent may actually OFFER. None exist:
 *                        the proposal states pricing is fixed.
 *   quotableAmounts    — published figures the agent may STATE when asked
 *                        (extra-firm onboarding, support plans, hourly rate).
 *                        Quoting them is not conceding them.
 *
 * The commercial validator rejects any other figure, so an inaccuracy in this
 * file surfaces immediately as a blocked reply rather than a wrong claim.
 */
import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { mintProposalToken } from '../functions/lib/lib/tokens.js';
import { hashProposalDocument } from '../functions/lib/lib/document.js';

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'buildclose-dev';
const USING_EMULATOR = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

if (USING_EMULATOR) {
  process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
}

initializeApp(
  USING_EMULATOR
    ? { projectId: PROJECT_ID }
    : { credential: applicationDefault(), projectId: PROJECT_ID },
);

const db = getFirestore();

// Populated after the build; points at the deployed Netlify site.
const NETLIFY_BASE = process.env.NETLIFY_SITE_URL ?? 'https://buildclose-demo.netlify.app';

const USD = (dollars) => Math.round(dollars * 100);

async function main() {
  console.log(`[seed] project=${PROJECT_ID} emulator=${USING_EMULATOR}`);

  // ---------------------------------------------------------------- company
  const companyRef = db.collection('companies').doc('abrica-demo');
  await companyRef.set(
    {
      name: 'The Marketing Millennial',
      slug: 'marketing-millennial',
      settings: {
        retentionDays: 365,
        aiBudgetUsd: 25,
        // Self-serve embed domains are recorded here for reporting only; the
        // access token is what authorises a prospect, not this list.
        embedDomains: [],
      },
      createdAt: FieldValue.serverTimestamp(),
      seeded: true,
    },
    { merge: true },
  );

  const companyId = companyRef.id;

  // --------------------------------------------------------------- proposal
  const proposalRef = db.collection('proposals').doc('abrica-stage-one');
  const proposalTerms = {
    title: 'Abrica — Stage One: Launch & Monetize',
    prospectName: 'Hector Abrica',
    prospectCompany: 'Abrica',
    prospectEmail: 'hector@abrica.example',
    summary:
      'A branded intake and case workspace for personal injury law firms, billed per case. The client completes intake on the firm\u2019s own page, signs the retainer on the same screen, and the case opens with its documents already attached.',
    totalValueMinor: USD(24000),
    commencementMinor: USD(8000),
    currency: 'USD',
    hostedProposalUrl: `${NETLIFY_BASE}/proposals/abrica.html`,
    termsNote:
      'Stage One only, $24,000, delivered over fourteen weeks, released against four working checkpoints. Commencement of $8,000 is due on the executed agreement; work begins the following Monday.',
    validUntil: '8 December 2026',
  };

  const documentHash = hashProposalDocument(proposalTerms);

  await proposalRef.set(
    {
      companyId,
      ...proposalTerms,
      status: 'published',
      acceptanceStatus: 'none',
      documentVersion: 1,
      documentHash,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      seeded: true,
    },
    { merge: true },
  );

  // -------------------------------------------------- prospect-visible knowledge
  await db.collection('agentConfigs').doc(proposalRef.id).set(
    {
      // Identity is neutral and seller-branded. The prospect is Abrica's guest:
      // nothing here says "BuildClose", and vendor branding stays off.
      displayName: 'Proposal Assistant',
      subtitle: 'Ask anything about this proposal',
      accentColor: '#1b3a6b',
      showVendorBranding: false,
      welcomeMessage:
        'Thanks for taking a look at the Stage One proposal. I can walk you through the scope, the $24,000 investment, how the four checkpoints work, or what happens after you accept — what would be most useful?',
      persona:
        'A calm, precise product specialist who knows the Stage One scope in detail. Speaks in short paragraphs, never oversells, and is comfortable saying that something is out of scope.',
      tone: 'consultative',
      productFacts: [
        'Stage One is a branded intake and case workspace for personal injury firms.',
        'A prospective client completes intake on the firm\u2019s own branded page, uploads documents from a phone, and signs the retainer in the same session.',
        'When intake completes, the case opens in the firm\u2019s portal with the intake, the documents and the executed retainer already attached.',
        'Each firm gets its own branded environment with its own clients, documents and cases, isolated at the database level.',
        'Intake uses conditional logic: a truck collision asks about the company that owned the vehicle; a slip-and-fall asks who manages the property.',
        'The representation question is asked before the retainer. If the person already has a lawyer, the intake stops and no retainer is sent.',
        'Cases that arrive by phone or walk-in can be keyed in directly and are billed at the same per-case rate.',
        'Closed and archived cases stay readable and retrievable but stop being billable.',
        'Firms see a running billable-case count and projected invoice at all times, and can flag a disputed count for review.',
        'Stage One includes configuration of two firms.',
        'Firm login supports multi-factor authentication.',
        'Every document, status change, assignment and signature event is timestamped on the case timeline.',
        'Stage One is positioned between an intake form and a full practice management system. It is not a replacement for Clio or Filevine.',

        // Ownership — section 11 of the proposal. Asked about often, and the answer
        // is a commercial promise, so it is stated verbatim from the document.
        'You own the client-specific components built for you.',
        'You hold a perpetual, non-exclusive, worldwide licence to operate, brand, market and sell subscription access to the platform, including selling the business itself.',
        'Every account the platform runs on is opened in your name: hosting, database, storage, domain, email, monitoring and e-signature.',
        'Administrative access is held by the developer while the engagement runs and is removed when it ends.',
        'You receive the source code, the infrastructure configuration, an architecture document and a runbook, so another qualified developer can pick the platform up and maintain it.',

        // Stages Two to Four — described in the proposal for planning only. The
        // assistant may explain them but must never sell them or imply they are
        // included in this proposal.
        'Stage Two is Expand & Scale: workers\u2019 compensation intake, Spanish-language intake, and self-service firm onboarding.',
        'Stage Three is Automate & Measure: pipeline visibility, automated follow-up on incomplete intakes, consultation booking, and source attribution to a signed retainer.',
        'Stage Four is Differentiate & Compete: telephone intake with transcription, document intelligence, and multi-office dashboards.',
        'Stages Two to Four are not part of this proposal. Each is described for planning and would be confirmed and bought separately, later.',
      ],
      valuePoints: [
        'The value is the hour after someone submits an enquiry: the retainer can be signed and the case opened while they are still willing to act.',
        'Because the case opens itself, the firm receives a file ready to work rather than a notification and a link.',
        'Per-case pricing means the fee is for the workspace the firm uses, not for the enquiry it received \u2014 which is why most cases arriving by phone are still billable.',
        'A signed retainer, the documents, and a timestamped activity record answer the question of where a client came from and what they agreed to.',
        'Revenue on the platform grows with the firm\u2019s own case load, so a single busy practice can be worth more than three quiet ones.',
      ],
      objectionPlaybook: [
        {
          type: 'price',
          trigger: 'The total seems high, or they push for a reduction.',
          response:
            'The price reflects fourteen weeks of build released against four working checkpoints \u2014 you pay the next instalment only when the work before it is running. If the intake is not working on your phone at the end of week four, the second payment is not invoiced. Pricing on this proposal is fixed, but I can put you in touch with the team if you want to talk through the structure.',
        },
        {
          type: 'timing',
          trigger: 'They want to think about it, or delay the start.',
          response:
            'That is reasonable. Two things are worth knowing: the proposal is valid for fourteen days, and the item that most often moves a launch date is the first firm\u2019s retainer document, because no real client can sign without it. Getting that PDF in week one is what protects the schedule.',
        },
        {
          type: 'scope',
          trigger: 'They ask whether something like trust accounting, court calendaring or time tracking is included.',
          response:
            'Those are deliberately out of Stage One. Trust accounting, court calendar integration, legal time tracking, settlement management and advanced document automation are what separate a case workspace from a full practice management system, and they are available in the software the firm already uses. If one of them turns out to be essential for your first firm, it is better raised before week two, because it becomes a change order rather than a surprise.',
        },
        {
          type: 'competitor',
          trigger: 'They mention Clio, Filevine or another practice management system.',
          response:
            'This is not an attempt to replace Clio or Filevine. A firm that already runs one should keep it, and this sits alongside it as the place a case lives from enquiry through acceptance and its first documents. Competing head-on would mean building trust accounting and time capture, and it would put the product in a price comparison it is not designed to win.',
        },
        {
          type: 'risk',
          trigger: 'They worry about being dependent on one developer.',
          response:
            'Every account the platform runs on is opened in your name \u2014 hosting, database, storage, domain, email, monitoring, e-signature. You receive the source code, the infrastructure configuration, an architecture document and a runbook, so another qualified developer can pick it up. Administrative access is removed when the engagement ends.',
        },
        {
          type: 'value',
          trigger: 'They question whether per-case pricing will actually earn.',
          response:
            'I would rather be straight with you: the revenue illustration in the proposal is an illustration, not a forecast, and no subscription revenue is guaranteed. The number of active cases per firm should be confirmed against real practices before it is relied upon. What makes the model defensible is that a firm pays for cases it is actually working, and stops paying when a case closes.',
        },
        {
          type: 'trust',
          trigger: 'They ask about security, data isolation or compliance.',
          response:
            'Stage One includes firm login with MFA, secure document storage, and isolation of each firm\u2019s data at the database level rather than by convention. Security testing and quality assurance run throughout the build rather than being compressed into the final fortnight. I should be clear that I cannot give legal advice on how any fee arrangement sits under the rules of professional conduct \u2014 that is a question for each firm and its counsel.',
        },
        {
          type: 'budget',
          trigger: 'They ask about ongoing running costs.',
          response:
            'Hosting, database, storage, email, monitoring and backups run at roughly $90 to $140 per month at Stage One volume, billed to you at cost and not part of the build fee. That assumes each firm connects its own e-signature account during onboarding, which keeps retainers in the firm\u2019s own account under its own retention settings. Cost rises with firm count and case volume.',
        },
      ],
      prohibitedClaims: [
        'Do not promise or imply specific revenue, profit, ROI or case volumes.',
        'Do not describe the revenue illustration as a forecast.',
        'Do not claim Stage One replaces a full practice management system.',
        'Do not claim any certification, audit or compliance accreditation.',
        'Do not state a launch date other than the fourteen-week, four-checkpoint structure.',
        'Do not offer a discount, payment plan or altered terms.',
        'Do not give legal or tax advice.',
      ],
      closingObjective:
        'Help Hector reach an informed decision on Stage One. When he is ready, point him to accepting the proposal and paying the $8,000 commencement, or to a call with the team if he still has open questions.',
      escalationMessage:
        'I don\u2019t have that detail to hand. I can connect you directly with the team, who can confirm it properly rather than have me guess.',
      ctaLinks: [
        { id: 'accept_proposal', label: 'Accept this proposal', url: 'native:accept', enabled: true },
        { id: 'schedule_call', label: 'Book a call', url: 'https://cal.com/marketingmillennial/abrica', enabled: true },
        { id: 'pay_commencement', label: 'Pay the $8,000 commencement', url: 'https://buy.stripe.com/test_abrica_commencement', enabled: true },
        { id: 'contact_rep', label: 'Talk to the team', url: 'mailto:hello@marketingmillennial.example?subject=Abrica%20proposal', enabled: true },
      ],
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  // -------------------------------------------------- INTERNAL (server only)
  // `quotableAmountsMinor` are published schedule figures, not concessions.
  await db.collection('proposalInternal').doc(proposalRef.id).set(
    {
      companyId,
      priceFloorMinor: USD(24000), // proposal states pricing is fixed
      maxDiscountPercent: 0,
      approvedDiscounts: [],
      quotableAmountsMinor: [
        USD(1250), // per additional firm beyond the first two
        USD(750), // Essential support plan, monthly
        USD(1500), // Growth support plan, monthly
        USD(3000), // Enterprise support plan, monthly
        USD(175), // hourly rate beyond included support hours
        USD(8000), // commencement
        USD(6000), // checkpoint two
        USD(5000), // checkpoints three and four
        USD(90), // running cost low
        USD(140), // running cost high
      ],
      negotiationBoundaries: [
        'Pricing is fixed at $24,000. No discount is authorised at any level.',
        'Payment structure is fixed: $8,000 / $6,000 / $5,000 / $5,000 against checkpoints.',
        'Do not agree to scope additions; refer them to a change order discussion.',
        'Do not commit to dates beyond the fourteen-week, four-checkpoint structure.',
      ],
      competitorNotes: [
        {
          competitor: 'Clio',
          posture: 'Position as complementary, never as a replacement. Keep it, and let Abrica hold the case from enquiry to first documents.',
        },
        {
          competitor: 'Filevine',
          posture: 'Same posture as Clio: adjacent, not competitive. Avoid feature-by-feature comparison.',
        },
      ],
      internalNotes:
        'Prospect currently takes intakes through Google Forms with no onboarding system. The retainer document is the schedule-critical dependency. Revenue illustration is illustrative only and must never be described as a forecast.',
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  // ---------------------------------------------------------- access tokens
  // Two tokens: one for the live embed, one short-lived for testing revocation.
  const demo = mintProposalToken();
  const expiresAt = new Date(Date.now() + 30 * 86_400_000);

  await db.collection('accessTokens').doc(demo.hash).set({
    companyId,
    proposalId: proposalRef.id,
    label: 'Hector Abrica — proposal link',
    // Pinned to the authorized proposal host. This is the per-proposal origin
    // configuration: the token only works from the page it was intended for, so a
    // leaked link pasted on a different site is refused. Future customers get
    // their own entry here with their own domain.
    allowedOrigins: ['https://agency-proposals.com'],
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
    revokedAt: null,
    createdBy: 'seed',
    useCount: 0,
  });

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('  Abrica proposal seeded');
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`  companyId   ${companyId}`);
  console.log(`  proposalId  ${proposalRef.id}`);
  console.log(`  total       $24,000.00  (commencement $8,000.00)`);
  console.log(`  hash        ${documentHash.slice(0, 32)}…`);
  console.log(`  expires     ${expiresAt.toISOString()}`);
  console.log('\n  PROSPECT LINK (contains the access token — do not log in prod)');
  console.log(`  ${demo.plaintext}`);
  console.log('\n  Token hash (stored, shown in the dashboard):');
  console.log(`  ${demo.hash}`);
  console.log('──────────────────────────────────────────────────────────────\n');

  // Written for the local test harness only; gitignored.
  const fs = await import('node:fs/promises');
  await fs.writeFile(
    new URL('./.seeded.json', import.meta.url),
    JSON.stringify(
      { companyId, proposalId: proposalRef.id, token: demo.plaintext, tokenHash: demo.hash, documentHash },
      null,
      2,
    ),
    'utf8',
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed] failed', err);
    process.exit(1);
  });
