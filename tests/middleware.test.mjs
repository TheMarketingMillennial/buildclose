/**
 * Middleware tests: the Express chain in isolation.
 *
 * WHY THIS FILE EXISTS
 * The Firebase Functions emulator wraps every function in its own permissive CORS
 * layer (`app.use(cors({ origin: true }))` in firebase-tools' ExpressBasedEmulator).
 * That layer answers OPTIONS preflights before the function's own code runs — a
 * request to a route that does not even exist still comes back 204 with
 * `Access-Control-Allow-Origin: <whatever the caller sent>`.
 *
 * Consequence: any CORS assertion made through http://127.0.0.1:5001 measures the
 * emulator, not BuildClose. Verified empirically — a preflight to a nonexistent
 * path returned 204 + the reflected attacker origin and none of the headers this
 * app always sets (nosniff, Cache-Control).
 *
 * So the app is mounted here in a bare Node HTTP server, with no emulator in the
 * path. This is the only place the CORS and security-header contract can be
 * tested honestly.
 *
 * Run: node --test tests/middleware.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

// Configure before importing the app: getConfig() reads process.env per call.
process.env.OPENAI_API_KEY = 'test-placeholder';
process.env.SESSION_SECRET = 'test-session-secret-not-used-here';
process.env.CHAT_ORIGIN = 'http://localhost:8888';
process.env.DASHBOARD_ORIGIN = 'http://localhost:8889';
process.env.EMBED_ORIGIN = 'http://localhost:8890';
process.env.NODE_ENV = 'development'; // keeps localhost dev origins permitted
delete process.env.FUNCTIONS_EMULATOR; // do not let emulator detection add origins

const { createApp } = await import('../functions/lib/app.js');

const CHAT_ORIGIN = 'http://localhost:8888';
const FOREIGN_ORIGIN = 'https://attacker.example';

/** Boot the real middleware chain on an ephemeral port. */
async function boot() {
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('a disallowed origin is refused at preflight with no allow header', async () => {
  const s = await boot();
  try {
    const res = await fetch(`${s.base}/api/terms`, {
      method: 'OPTIONS',
      headers: { Origin: FOREIGN_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(res.status, 403, 'foreign preflight must be refused');
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'no ACAO for a foreign origin');
    assert.equal(res.headers.get('access-control-allow-methods'), null, 'no method allowance leaked');
  } finally {
    await s.close();
  }
});

test('the permitted chat origin is echoed exactly, never wildcarded', async () => {
  const s = await boot();
  try {
    const res = await fetch(`${s.base}/api/terms`, {
      method: 'OPTIONS',
      headers: { Origin: CHAT_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), CHAT_ORIGIN);
    assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
    assert.match(String(res.headers.get('vary') ?? ''), /Origin/i, 'response must vary by origin');
  } finally {
    await s.close();
  }
});

test('a foreign origin gets no ACAO on an actual request either', async () => {
  const s = await boot();
  try {
    // Malformed token: rejected on shape alone, before any database access, so
    // this test needs no Firestore and cannot be perturbed by the rate limiter.
    const res = await fetch(`${s.base}/api/bootstrap`, {
      method: 'POST',
      headers: { Origin: FOREIGN_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'definitely-not-a-proposal-token' }),
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    // Without an allow header the browser cannot read whatever comes back.
    assert.equal(res.status, 401);
  } finally {
    await s.close();
  }
});

test('security headers are present on success responses', async () => {
  const s = await boot();
  try {
    const res = await fetch(`${s.base}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    await s.close();
  }
});

test('security headers are present on error responses too', async () => {
  const s = await boot();
  try {
    const res = await fetch(`${s.base}/api/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'definitely-not-a-proposal-token' }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    await s.close();
  }
});

/**
 * Regression guard for the error-mapping defect: AppError used to be flattened to
 * 500 by the fallback handler, so a rejected request looked like a server crash.
 *
 * Uses a structurally invalid token that is still long enough to satisfy the body
 * schema, so it is refused by the token-shape check — which runs BEFORE the rate
 * limiter and before any database access. That keeps this a pure error-mapping
 * assertion, with no Firestore dependency.
 */
test('an AppError keeps its real status instead of collapsing to 500', async () => {
  const s = await boot();
  try {
    const res = await fetch(`${s.base}/api/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: CHAT_ORIGIN },
      // Long enough for the body schema (>=10 chars) but missing the bc_pk_ prefix.
      body: JSON.stringify({ token: 'not-a-proposal-token-shape' }),
    });
    assert.equal(res.status, 401, 'a rejected token is 401, not 500');
    const body = await res.json();
    assert.equal(body.error.code, 'unauthorized');
  } finally {
    await s.close();
  }
});

test('malformed JSON is a 400 client fault, not a 500', async () => {
  const s = await boot();
  try {
    const res = await fetch(`${s.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: CHAT_ORIGIN },
      body: '{not valid json',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'bad_request');
  } finally {
    await s.close();
  }
});

test('an unknown route 404s without leaking internals', async () => {
  const s = await boot();
  try {
    const res = await fetch(`${s.base}/api/does-not-exist`, { method: 'POST' });
    assert.ok([404, 405].includes(res.status), `expected 404/405, got ${res.status}`);
    const text = await res.text();
    assert.ok(!/at .*\.js:\d+/.test(text), 'no stack trace in the body');
  } finally {
    await s.close();
  }
});
