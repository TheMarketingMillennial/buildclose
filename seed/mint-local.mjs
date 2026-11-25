/**
 * Mint an access token for local end-to-end testing, pinned to a local origin.
 *
 * WHY THIS EXISTS
 * The seeded token is pinned to https://agency-proposals.com — the production
 * posture. That pinning is the control being tested, so it must not be weakened
 * for convenience. Instead, a second token is minted with a localhost pin, which
 * lets the browser test exercise the real allowlist logic (correct origin → 200,
 * any other origin → 403) without touching the production token.
 *
 * Usage:
 *   GCLOUD_PROJECT=buildclose-dev FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
 *   node seed/mint-local.mjs http://localhost:8890 30
 *
 * Prints the plaintext token (once — only its hash is stored) and writes it to
 * seed/.local-token.json, which is gitignored.
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { mintProposalToken } from '../functions/lib/lib/tokens.js';

const origin = (process.argv[2] || 'http://localhost:8890').trim().replace(/\/+$/, '');
const days = Number(process.argv[3] || 30);

if (!/^https?:\/\/[^/]+$/.test(origin)) {
  console.error(`[mint-local] origin must be scheme + host with no path, got: ${origin}`);
  process.exit(1);
}
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('[mint-local] refusing to run outside the emulator (FIRESTORE_EMULATOR_HOST unset)');
  process.exit(1);
}

initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'buildclose-dev' });
const db = getFirestore();

const token = mintProposalToken();
const expiresAt = new Date(Date.now() + days * 86_400_000);

await db.collection('accessTokens').doc(token.hash).set({
  companyId: 'abrica-demo',
  proposalId: 'abrica-stage-one',
  label: `Local e2e @ ${origin}`,
  allowedOrigins: [origin],
  createdAt: FieldValue.serverTimestamp(),
  expiresAt,
  revokedAt: null,
  createdBy: 'mint-local',
  useCount: 0,
});

const fs = await import('node:fs/promises');
await fs.writeFile(
  new URL('./.local-token.json', import.meta.url),
  JSON.stringify({ token: token.plaintext, tokenHash: token.hash, origin, expiresAt }, null, 2),
  'utf8',
);

console.log(token.plaintext);
