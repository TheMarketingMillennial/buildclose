/**
 * End-to-end browser verification (task 2 of the approved plan).
 *
 * These run against the LOCAL stack, not the API directly:
 *
 *   proposal page   http://localhost:8890/proposals/abrica.html   (agency-proposals.com)
 *   assistant       http://localhost:8888/embed                   (agent.buildclose.app)
 *   API + Firestore Firebase emulator on :5001 / :8080
 *
 * What this proves that the API tests cannot:
 *   - the postMessage handshake actually completes between two real origins;
 *   - the generated CSP permits the widget and the iframe (and the iframe's own
 *     CSP permits the API call), so the policies are not silently blocking things;
 *   - the browser's own Origin header satisfies the API allowlist — a sandboxed
 *     iframe can send `Origin: null`, which every unit test would miss;
 *   - a revoked token stops an ALREADY-OPEN conversation, not just new ones.
 *
 * Prerequisites (see docs/RUNBOOK.md):
 *   node tests/serve.mjs apps/agent/dist 8888
 *   node tests/serve.mjs apps/proposals/dist 8890
 *   emulator running, OpenAI stub on :8787, proposal built with a local-pinned token
 *
 * Run: node --test tests/e2e.browser.test.mjs
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { mintProposalToken } from '../functions/lib/lib/tokens.js';

const PROPOSAL_URL = process.env.E2E_PROPOSAL_URL || 'http://localhost:8890/proposals/abrica.html';
const PROPOSAL_ORIGIN = new URL(PROPOSAL_URL).origin;
const AGENT_ORIGIN = process.env.E2E_AGENT_ORIGIN || 'http://localhost:8888';

const seeded = JSON.parse(readFileSync(new URL('../seed/.seeded.json', import.meta.url), 'utf8'));

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'buildclose-dev' });
const db = getFirestore();

let browser;

/** Collect console errors and CSP violations for the whole run. */
function watch(page, bucket) {
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error') bucket.console.push(text);
  });
  page.on('pageerror', (err) => bucket.console.push(String(err)));
}

/**
 * Reset acceptance state for the seeded proposal.
 *
 * Without this, a run that fails mid-acceptance leaves an `acceptances` document
 * and an `acceptanceStatus: 'accepted'` proposal behind. The next run then sees
 * "This proposal has already been accepted" and fails for a reason that has
 * nothing to do with the code. Test isolation is part of the test.
 */
async function resetAcceptance() {
  const existing = await db.collection('acceptances').where('proposalId', '==', seeded.proposalId).get();
  await Promise.all(existing.docs.map((d) => d.ref.delete()));
  await db.collection('proposals').doc(seeded.proposalId).update({
    acceptanceStatus: 'none',
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const bucket = { console: [] };
  watch(page, bucket);
  return { ctx, page, bucket };
}

/**
 * Wait until the widget script has initialised on the host page.
 *
 * `window.BuildClose` is the widget's public hook, so its presence is the
 * deterministic signal that the loader has run. Without this wait, a click on a
 * page-level control can land before the loader does, and the page's fallback
 * ("Loading assistant…") fires instead — a flaky test that would look like a
 * product bug.
 */
async function waitForWidget(page) {
  await page.waitForFunction(() => Boolean(window.BuildClose && window.BuildClose.open), null, {
    timeout: 15000,
  });
}

/**
 * Open the assistant the way a prospect does.
 *
 * The widget mounts its iframe EAGERLY (so a reader who never opens the chat
 * still registers a proposal view) but keeps `.bcw-panel` at `display:none`
 * until the launcher is pressed. Nothing inside a display:none subtree can be
 * "visible" to Playwright, so tests that assert on the chat UI must open the
 * panel first — exactly as a prospect would. Clicking the real launcher also
 * exercises the open path and its aria state.
 */
async function openAssistant(page) {
  await waitForWidget(page);
  const launcher = page.locator('.bcw-btn');
  await launcher.waitFor({ state: 'visible', timeout: 15000 });
  await launcher.click();

  // The open state is the contract other code depends on; assert it rather than
  // assuming the click landed.
  await page.locator('.bcw-panel.bcw-open').waitFor({ state: 'attached', timeout: 10000 });
  assert.equal(await launcher.getAttribute('aria-expanded'), 'true');
}

before(async () => {
  await resetAcceptance();
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});

after(async () => {
  await browser?.close();
});

// ---------------------------------------------------------------------------

describe('Abrica proposal page', () => {
  it('loads with the original design and commercial terms intact', async () => {
    const { ctx, page } = await newPage();
    const res = await page.goto(PROPOSAL_URL, { waitUntil: 'domcontentloaded' });
    assert.equal(res.status(), 200);

    // Commercial facts must survive the integration untouched.
    const body = await page.textContent('body');
    for (const fact of ['$24,000', '$8,000', '$1,250', '$175', 'Fourteen weeks', 'Hector Abrica']) {
      assert.ok(body.includes(fact), `proposal should still state ${fact}`);
    }

    // The design's own type system and section structure must be preserved.
    assert.equal(await page.locator('section.band').count() >= 8, true, 'expected the original banded sections');
    const family = await page.evaluate(() => getComputedStyle(document.querySelector('.display')).fontFamily);
    assert.match(family, /Garamond|serif/i, 'display type should still be the original serif');

    // The forbidden vendor's beacon must be gone.
    const html = await page.content();
    assert.ok(!html.includes('cloudflareinsights'), 'Cloudflare Insights beacon must not be present');

    // One document per prospect: never indexed.
    assert.equal(await page.getAttribute('meta[name="robots"]', 'content'), 'noindex, nofollow');

    await ctx.close();
  });

  it('offers native acceptance and a payment link without a second acceptance path', async () => {
    const { ctx, page } = await newPage();
    await page.goto(PROPOSAL_URL, { waitUntil: 'domcontentloaded' });

    assert.equal(await page.isVisible('#bc-accept'), true, 'Accept control should be visible');
    assert.equal(await page.isVisible('#bc-pay'), true, 'configured payment link should be visible');
    const payHref = await page.getAttribute('#bc-pay', 'href');
    assert.match(payHref, /^https:\/\//, 'payment link must be https');

    await ctx.close();
  });

  it('renders correctly at a phone viewport', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(PROPOSAL_URL, { waitUntil: 'domcontentloaded' });

    // No horizontal overflow: the single most common mobile failure in a dense
    // document, and it would push the assistant launcher off-screen.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert.ok(overflow <= 1, `expected no horizontal overflow, got ${overflow}px`);

    // Acceptance must be reachable and full-width on a phone.
    assert.equal(await page.isVisible('#bc-accept'), true);
    const box = await page.locator('#bc-accept').boundingBox();
    assert.ok(box.width > 300, `accept button should be full width on mobile, got ${box.width}`);

    await ctx.close();
  });
});

// ---------------------------------------------------------------------------

describe('iframe handshake and session', () => {
  it('completes the postMessage handshake and shows a neutral identity', async () => {
    const { ctx, page, bucket } = await newPage();
    await page.goto(PROPOSAL_URL, { waitUntil: 'domcontentloaded' });

    // The widget mounts the frame eagerly so a reader who never opens the chat
    // still registers a proposal view.
    const frameEl = page.locator('iframe.bcw-frame');
    await frameEl.waitFor({ state: 'attached', timeout: 15000 });

    await openAssistant(page);

    const chat = page.frameLocator('iframe.bcw-frame');
    // Reaching the chat state means: bc:ready → bc:init → bootstrap → terms all
    // succeeded across two origins, under the generated CSPs.
    await chat.locator('#chat').waitFor({ state: 'visible', timeout: 20000 });

    assert.equal(await chat.locator('#title').textContent(), 'Proposal Assistant');
    assert.equal(await chat.locator('#subtitle').textContent(), 'Ask anything about this proposal');

    // BuildClose branding must not dominate the prospect's experience.
    assert.equal(await chat.locator('#vendor-badge').isHidden(), true, 'vendor badge must stay hidden');

    const cspErrors = bucket.console.filter((e) => /Content Security Policy|Refused to/i.test(e));
    assert.deepEqual(cspErrors, [], `CSP violations:\n${cspErrors.join('\n')}`);

    await ctx.close();
  });

  it('sends a prospect message and receives a grounded reply', async () => {
    const { ctx, page } = await newPage();
    await page.goto(PROPOSAL_URL, { waitUntil: 'domcontentloaded' });

    await openAssistant(page);

    const chat = page.frameLocator('iframe.bcw-frame');
    await chat.locator('#chat').waitFor({ state: 'visible', timeout: 20000 });

    await chat.locator('#input').fill('What is the total cost of Stage One?');
    await chat.locator('#send').click();

    // A reply bubble appears after ours; the stub answers from approved facts.
    await chat.locator('.msg.bot .bubble').nth(1).waitFor({ state: 'visible', timeout: 25000 });
    const reply = await chat.locator('.msg.bot .bubble').nth(1).textContent();
    assert.ok(/24,000|24000/.test(reply), `reply should quote the approved figure, got: ${reply}`);

    await ctx.close();
  });

  it('opens the native acceptance screen from the proposal page button', async () => {
    const { ctx, page } = await newPage();
    await page.goto(PROPOSAL_URL, { waitUntil: 'domcontentloaded' });
    await waitForWidget(page);

    const chat = page.frameLocator('iframe.bcw-frame');

    // The page's own button must drive the frame's single acceptance implementation.
    // It calls BuildClose.openAcceptance(), which opens the panel itself — so no
    // launcher click here, and #accept is what we wait on, not #chat.
    await page.click('#bc-accept');
    await chat.locator('#accept').waitFor({ state: 'visible', timeout: 20000 });

    const terms = await chat.locator('#terms').textContent();
    assert.ok(terms.includes('$24,000'), 'acceptance screen should restate the total');
    assert.ok(terms.includes('$8,000'), 'acceptance screen should restate the commencement fee');

    await ctx.close();
  });

  it('records an acceptance with name, timestamp and document version', async () => {
    const { ctx, page } = await newPage();
    await page.goto(PROPOSAL_URL, { waitUntil: 'domcontentloaded' });
    await waitForWidget(page);

    const chat = page.frameLocator('iframe.bcw-frame');
    await page.click('#bc-accept');
    await chat.locator('#accept').waitFor({ state: 'visible', timeout: 20000 });

    await chat.locator('#a-name').fill('Hector Abrica');
    await chat.locator('#a-email').fill('hector@abrica.example');
    await chat.locator('#a-sig').fill('Hector Abrica');
    await chat.locator('#a-consent').check();
    await chat.locator('#accept-submit').click();

    await chat.locator('#done').waitFor({ state: 'visible', timeout: 20000 });

    // Verify server-side: the acceptance record must be evidence, not a UI state.
    const snap = await db
      .collection('acceptances')
      .where('proposalId', '==', seeded.proposalId)
      .limit(1)
      .get();
    assert.equal(snap.size, 1, 'an acceptance document should exist');

    const rec = snap.docs[0].data();
    assert.equal(rec.fullName, 'Hector Abrica');
    assert.ok(rec.acceptedAt, 'acceptance must carry a timestamp');
    assert.equal(rec.documentVersion >= 1, true, 'acceptance must pin a document version');
    assert.match(String(rec.documentHash), /^[0-9a-f]{64}$/, 'acceptance must pin the document hash');

    // Leave the proposal accept-able for later runs.
    await snap.docs[0].ref.delete();
    await db.collection('proposals').doc(seeded.proposalId).update({
      acceptanceStatus: 'none',
      updatedAt: FieldValue.serverTimestamp(),
    });

    await ctx.close();
  });
});

// ---------------------------------------------------------------------------

describe('origin validation', () => {
  it('refuses a direct API call from the proposal page origin', async () => {
    const { ctx, page } = await newPage();
    await page.goto(PROPOSAL_URL, { waitUntil: 'domcontentloaded' });

    // The proposal page is NOT a permitted API caller — only the assistant origin
    // is. This is what stops a customer page holding a token from calling the API
    // directly and bypassing the widget handshake. The browser sends
    // `Origin: http://localhost:8890`, which is absent from the allowlist, so the
    // response carries no Access-Control-Allow-Origin and fetch rejects.
    const outcome = await page.evaluate(async (apiBase) => {
      try {
        const res = await fetch(`${apiBase}/api/terms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        return { reached: true, status: res.status };
      } catch (err) {
        // Expected: CORS rejection surfaces as a TypeError before any status.
        return { reached: false, reason: String(err).slice(0, 80) };
      }
    }, 'http://127.0.0.1:5001/buildclose-dev/us-central1');

    // A readable 200 would mean the proposal origin can call the API directly.
    if (outcome.reached) {
      assert.notEqual(outcome.status, 200, 'proposal page must not be able to call the API directly');
    }

    await ctx.close();
  });

  it('refuses the token when the reported embed origin is not the pinned one', async () => {
    // Performed from Node so the request carries a controllable Origin header —
    // exactly the shape an attacker replaying a leaked token would use: a
    // TRUSTED caller origin (the chat app) with a DIFFERENT embedOrigin.
    const res = await fetch('http://127.0.0.1:5001/buildclose-dev/us-central1/api/api/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: AGENT_ORIGIN },
      body: JSON.stringify({ token: seeded.token, embedOrigin: 'https://evil.example' }),
    });

    assert.equal(res.status, 403, 'a token pinned to one host must be refused from another');
    const body = await res.json();
    assert.equal(body?.error?.code, 'origin_not_allowed');

    // And it must not leak the proposal title while refusing.
    assert.ok(!JSON.stringify(body).includes('Abrica'), 'refusal must not leak proposal data');
  });
});

// ---------------------------------------------------------------------------

describe('token revocation', () => {
  it('stops an already-open conversation immediately', async () => {
    const { ctx, page } = await newPage();

    // A dedicated token so revoking here cannot disturb other tests.
    const minted = mintProposalToken();
    await db.collection('accessTokens').doc(minted.hash).set({
      companyId: seeded.companyId,
      proposalId: seeded.proposalId,
      label: 'e2e revocation',
      allowedOrigins: [PROPOSAL_ORIGIN],
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: null,
      createdBy: 'e2e',
      useCount: 0,
    });

    // A throwaway host page running the real widget with this token. Served from
    // the proposal origin so the pinning check passes and only revocation is
    // under test.
    await page.goto(PROPOSAL_URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(
      ({ token, agentOrigin }) => {
        document.body.innerHTML = '<h1>Revocation test host</h1>';
        window.__buildCloseWidgetLoaded = false;
        const s = document.createElement('script');
        s.src = `${agentOrigin}/widget.js`;
        s.setAttribute('data-bc', token);
        s.setAttribute('data-chat-origin', agentOrigin);
        s.defer = true;
        document.body.appendChild(s);
      },
      { token: minted.plaintext, agentOrigin: AGENT_ORIGIN },
    );

    await openAssistant(page);

    const chat = page.frameLocator('iframe.bcw-frame');
    await chat.locator('#chat').waitFor({ state: 'visible', timeout: 20000 });

    // Revoke server-side while the session is live.
    await db.collection('accessTokens').doc(minted.hash).update({ revokedAt: FieldValue.serverTimestamp() });

    // The next message must fail: the session is re-validated against the token
    // record on every request, so revocation does not wait for expiry.
    await chat.locator('#input').fill('Are you still there?');
    await chat.locator('#send').click();

    // Either the frame swaps to its error state, or the reply is replaced by an
    // error bubble. Both prove the revoked token stopped serving.
    await page.waitForTimeout(4000);
    const appText = await chat.locator('#app').textContent();
    const errorVisible = await chat.locator('#error').isVisible();
    const refused = errorVisible || /ended|expired|revoked|invalid|reopen/i.test(appText);

    assert.equal(refused, true, `a revoked token must stop serving; app showed: ${appText?.slice(0, 200)}`);

    await ctx.close();
  });
});
