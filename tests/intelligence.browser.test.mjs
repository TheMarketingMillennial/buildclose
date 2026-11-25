/**
 * Intelligence Center browser verification (Phase 1, step 5).
 *
 * Drives the real dashboard in a real browser against the real emulator. Nothing
 * is mocked: a genuine Firebase ID token with genuine custom claims is obtained
 * through the sign-in form, and every save goes through the actual callable.
 *
 * What this proves that the callable tests cannot:
 *   - the module loads at all (a broken import or a syntax error in
 *     src/intelligence.js shows up here and nowhere else — the callable suites
 *     never load this file);
 *   - the nav entry exists and the route resolves;
 *   - a save round-trips through the UI and survives a reload, i.e. the form is
 *     reading back what the server stored rather than echoing local state;
 *   - the authority tab is absent for a representative, so a forbidden call is
 *     never attempted and never rendered as an empty "unconfigured" form;
 *   - read-only roles get disabled controls rather than controls that silently
 *     fail on save.
 *
 * Prerequisites:
 *   firebase emulators:start --only auth,firestore,functions   (project buildclose-dev)
 *   (cd apps/dashboard && node build.mjs)                       # emits config.js for the emulator
 *   node tests/serve.mjs apps/dashboard 3001
 *
 * Run: DASH_URL=http://127.0.0.1:3001 node --test tests/intelligence.browser.test.mjs
 */
import './support/emulator-env.mjs';
import { assertEmulatorOnly } from './support/emulator-guard.mjs';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { db, createStaffUser, signIn, cleanupCompany, cleanupUsers, FIXTURE_PASSWORD } from './support/staff-fixture.mjs';

assertEmulatorOnly('intelligence-browser');

const DASH = process.env.DASH_URL ?? 'http://127.0.0.1:3001';

const CO = 'zz-intel-browser';
const ADMIN = 'zz-intel-admin@local.test';
const REP = 'zz-intel-rep@local.test';
const EMAILS = [ADMIN, REP];

let browser;

before(async () => {
  await db.collection('companies').doc(CO).set({ name: 'Intelligence Browser Co', settings: { retentionDays: 365 } }, { merge: true });
  await createStaffUser({ email: ADMIN, companyId: CO, role: 'company_admin', displayName: 'Intel Admin' });
  await createStaffUser({ email: REP, companyId: CO, role: 'sales_rep', displayName: 'Intel Rep' });

  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});

after(async () => {
  if (browser) await browser.close();
  await cleanupCompany(CO);
  await cleanupUsers(EMAILS);
});

/** Sign in through the real form and land on the dashboard. */
async function signInAs(email) {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(DASH, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('you@company.com').fill(email);
  await page.getByPlaceholder('••••••••').fill(FIXTURE_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();

  // The nav only renders once claims are loaded and the tenant is known.
  await page.getByRole('link', { name: /intelligence/i }).waitFor({ state: 'visible', timeout: 20000 });
  return { context, page };
}

test('an admin opens the Intelligence Center and sees the authority tab', async () => {
  const { context, page } = await signInAs(ADMIN);

  await page.getByRole('link', { name: /intelligence/i }).click();
  await page.getByRole('heading', { name: /intelligence center/i }).waitFor({ timeout: 20000 });

  // All eight knowledge tabs plus authority for a config role.
  for (const label of [
    'Company profile',
    'Products & services',
    'Sales methodology',
    'Brand voice',
    'Objection playbook',
    'FAQs',
    'Commercial policies',
    'Assistant defaults',
    'Commercial authority',
  ]) {
    await page.getByRole('tab', { name: label }).waitFor({ state: 'visible', timeout: 10000 });
  }

  // The profile tab is selected by default, so its form must already be rendered.
  await page.getByPlaceholder('Meridian Studio', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });

  await context.close();
});

test('a saved profile survives a reload', async () => {
  const { context, page } = await signInAs(ADMIN);

  await page.getByRole('link', { name: /intelligence/i }).click();
  await page.getByRole('heading', { name: /intelligence center/i }).waitFor({ timeout: 20000 });

  const displayName = page.getByPlaceholder('Meridian Studio', { exact: true });
  await displayName.fill('Roundtrip Studio');
  await page.getByPlaceholder('Meridian Studio Ltd').fill('Roundtrip Studio Ltd');
  await page.getByPlaceholder('35 people').fill('42 people');

  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast-ok').waitFor({ state: 'visible', timeout: 15000 });

  // Reload from the server, not from local state: a form that only echoed what was
  // typed would pass the assertion above but fail here.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: /intelligence/i }).click();
  await page.getByRole('heading', { name: /intelligence center/i }).waitFor({ timeout: 20000 });

  await page.waitForFunction(
    () => {
      const el = document.querySelector('input[placeholder="Meridian Studio"]');
      return el && el.value === 'Roundtrip Studio';
    },
    { timeout: 15000 },
  );

  assert.equal(await page.getByPlaceholder('Meridian Studio', { exact: true }).inputValue(), 'Roundtrip Studio');
  assert.equal(await page.getByPlaceholder('Meridian Studio Ltd').inputValue(), 'Roundtrip Studio Ltd');
  assert.equal(await page.getByPlaceholder('35 people').inputValue(), '42 people');

  // Confirm at the database layer too, so this cannot pass on a stale cache.
  const snap = await db.collection('companyIntelligence').doc(CO).get();
  assert.equal(snap.data().profile.displayName, 'Roundtrip Studio');

  await context.close();
});

test('commercial authority saves from the authority tab', async () => {
  const { context, page } = await signInAs(ADMIN);

  await page.getByRole('link', { name: /intelligence/i }).click();
  await page.getByRole('heading', { name: /intelligence center/i }).waitFor({ timeout: 20000 });

  await page.getByRole('tab', { name: 'Commercial authority' }).click();

  // The authority form is the only place a discount ceiling can be set, so the
  // control must be present and writable for a config role.
  const ceiling = page.locator('input[type="number"]').first();
  await ceiling.waitFor({ state: 'visible', timeout: 10000 });
  await ceiling.fill('12');

  const save = page.getByRole('button', { name: 'Save' }).last();
  await save.click();

  // Either it saved, or the form reports why. Silent failure is the bug this
  // guards: the button must never appear to do nothing.
  await Promise.race([
    page.locator('.toast-ok').waitFor({ state: 'visible', timeout: 15000 }),
    page.locator('.form-error').waitFor({ state: 'visible', timeout: 15000 }),
  ]);

  const errored = await page.locator('.form-error').count();
  if (errored > 0) {
    const msg = await page.locator('.form-error').first().textContent();
    assert.fail(`authority save reported an error: ${msg}`);
  }

  const snap = await db.collection('companyAuthority').doc(CO).get();
  assert.equal(snap.exists, true, 'authority record was not written');
  assert.equal(snap.data().maxDiscountPercent, 12);

  await context.close();
});

test('a representative reads intelligence without an authority tab and cannot edit', async () => {
  const { context, page } = await signInAs(REP);

  await page.getByRole('link', { name: /intelligence/i }).click();
  await page.getByRole('heading', { name: /intelligence center/i }).waitFor({ timeout: 20000 });

  // The knowledge tabs are readable.
  await page.getByRole('tab', { name: 'Company profile' }).waitFor({ state: 'visible', timeout: 10000 });

  // But the authority tab must not exist: a rep calling getCompanyAuthority gets
  // permission-denied, and showing an empty form would present "forbidden" as
  // "unconfigured".
  assert.equal(
    await page.getByRole('tab', { name: 'Commercial authority' }).count(),
    0,
    'the authority tab was rendered for a sales rep',
  );

  // The profile values are visible...
  const displayName = page.getByPlaceholder('Meridian Studio', { exact: true });
  await displayName.waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await displayName.inputValue(), 'Roundtrip Studio', 'rep could not read the configured value');

  // ...but disabled, so an edit cannot appear to be possible and then fail.
  assert.equal(await displayName.isDisabled(), true, 'a read-only role received an editable control');
  assert.equal(
    await page.getByRole('button', { name: 'Save' }).first().isDisabled(),
    true,
    'a read-only role received an enabled Save button',
  );

  await context.close();
});
