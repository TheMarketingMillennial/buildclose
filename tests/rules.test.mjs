/**
 * Firestore rules denial tests.
 *
 * These run against the emulator's REST API with no credentials, which is exactly
 * the position an attacker is in. The rules are default-deny for every client, so
 * every one of these must fail.
 *
 * This is the test that justifies the architectural choice in firestore.rules:
 * because no client reads Firestore directly, a single missing check cannot expose
 * another tenant's pricing. If any test here starts passing, the boundary has
 * regressed and deployment must stop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const PROJECT = process.env.GCLOUD_PROJECT ?? 'buildclose-dev';
const HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

async function tryRead(path, headers = {}) {
  const res = await fetch(`${BASE}/${path}`, { headers });
  return { status: res.status, body: await res.text() };
}

async function tryWrite(path, headers = {}) {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ fields: { hacked: { booleanValue: true } } }),
  });
  return { status: res.status, body: await res.text() };
}

function assertDenied(result, label) {
  assert.notEqual(result.status, 200, `${label}: request must not succeed (got 200)`);
  assert.ok(
    result.status === 401 || result.status === 403,
    `${label}: expected 401/403, got ${result.status}`,
  );
  // A denial must not leak document content.
  assert.ok(!body(result).includes('24'), `${label}: response leaked document data`);
}

const body = (r) => r.body ?? '';

test('anonymous cannot read a proposal', async () => {
  assertDenied(await tryRead('proposals/abrica-stage-one'), 'anonymous proposal read');
});

test('anonymous cannot read the internal record (price floor, playbook)', async () => {
  assertDenied(await tryRead('proposalInternal/abrica-stage-one'), 'anonymous internal read');
});

test('anonymous cannot read access tokens', async () => {
  assertDenied(await tryRead('accessTokens'), 'anonymous token list');
});

test('anonymous cannot read conversations', async () => {
  assertDenied(await tryRead('conversations'), 'anonymous conversation list');
});

test('anonymous cannot read the audit log', async () => {
  assertDenied(await tryRead('auditLog'), 'anonymous audit read');
});

test('anonymous cannot write to a proposal', async () => {
  assertDenied(await tryWrite('proposals/abrica-stage-one'), 'anonymous proposal write');
});

test('a forged bearer token is still denied', async () => {
  assertDenied(
    await tryRead('proposals/abrica-stage-one', { Authorization: 'Bearer forged-token-value' }),
    'forged bearer read',
  );
});

test('a bearer token pretending to be a staff id token is denied', async () => {
  // Even a well-formed-looking JWT must not satisfy a default-deny rule.
  const fakeJwt = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhdHRhY2tlciJ9.';
  assertDenied(
    await tryRead('proposals/abrica-stage-one', { Authorization: `Bearer ${fakeJwt}` }),
    'fake jwt read',
  );
});

test('writes to subcollections are denied too', async () => {
  // The default-deny must cover nested paths, not just top-level collections.
  assertDenied(await tryWrite('conversations/abc/messages/xyz'), 'subcollection write');
});
