/**
 * Build step for app.buildclose.app (the customer dashboard).
 *
 * Emits config.js from environment variables so no key is committed and the same
 * source runs against the emulator, staging, and production unchanged.
 *
 * These values are PUBLIC identifiers, not credentials: Firebase web config is
 * designed to ship in the browser. The security boundary is the default-deny
 * Firestore rules plus the custom-claims check inside every callable — never the
 * presence of this file.
 *
 * Run from the app directory (Netlify sets the base directory per site):
 *     node build.mjs
 *
 * Local development against the emulator:
 *     AUTH_BASE=http://127.0.0.1:9099/identitytoolkit.googleapis.com \
 *     FUNCTIONS_BASE=http://127.0.0.1:5001/buildclose-dev/us-central1 \
 *     FIREBASE_API_KEY=fake FIREBASE_APP_ID=fake node build.mjs
 *
 * Configuration precedence mirrors the Cloud Functions convention, so there is
 * one rule to remember across the repo:
 *
 *     real process.env  >  .env.local  >  .env.<FIREBASE_PROJECT_ID>
 *
 * Real environment variables win so Netlify can override anything per deploy
 * without editing a committed file. `.env.local` wins over the project file so a
 * developer's emulator settings never leak into a production build.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Minimal dotenv loader.
 *
 * Deliberately hand-rolled: this file runs as a Netlify build step with no
 * installed dependencies at the site root, and pulling a dotenv package in just
 * to read two small files would be a supply-chain cost for no benefit. It
 * supports the only syntax these files use: `KEY=value`, `#` comments, optional
 * surrounding quotes.
 *
 * Precedence is enforced by the caller, not here: this function always writes,
 * and the caller supplies the set of keys that came from the real environment
 * and must not be touched. An earlier version skipped keys that merely already
 * existed, which silently made the project file beat `.env.local` — the exact
 * opposite of the Firebase convention — and produced a build pointing at the
 * emulator while claiming the production project.
 */
function loadEnvFile(name, root, locked) {
  const path = fileURLToPath(new URL(name, root));
  if (!existsSync(path)) return 0;

  let loaded = 0;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key || locked.has(key)) continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    loaded += 1;
  }
  return loaded;
}

const root = new URL('./', import.meta.url);
// Real environment wins over every file, so Netlify can override per deploy.
const locked = new Set(Object.keys(process.env));
// Then the project file, then `.env.local` on top of it.
loadEnvFile('.env.buildclose-d4399', root, locked);
loadEnvFile('.env.local', root, locked);

const projectId = process.env.FIREBASE_PROJECT_ID || 'buildclose-d4399';
const region = process.env.FUNCTIONS_REGION || 'us-central1';

function required(name) {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(
      `Missing ${name}. Set it in Netlify > Site configuration > Environment variables, ` +
        `or export it in your shell for a local build. Never commit a real value.`,
    );
  }
  return v.trim();
}

const config = {
  // Callables are served at <functionsBase>/<functionName>.
  functionsBase:
    process.env.FUNCTIONS_BASE || `https://${region}-${projectId}.cloudfunctions.net`,
  // Identity Toolkit. No SDK is loaded: the dashboard speaks the REST protocol
  // directly so the CSP can stay `script-src 'self'` with no third-party scripts.
  authBase: process.env.AUTH_BASE || 'https://identitytoolkit.googleapis.com',
  tokenBase: process.env.TOKEN_BASE || 'https://securetoken.googleapis.com',
  // Origin of the chat app. Used to render the embed snippet for a proposal; the
  // dashboard never calls it, and it never calls the dashboard.
  agentOrigin: process.env.AGENT_ORIGIN || 'https://agent.buildclose.app',
  firebase: {
    apiKey: required('FIREBASE_API_KEY'),
    projectId,
    appId: required('FIREBASE_APP_ID'),
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
    // Needed to build a download URL for acceptance evidence (signature images),
    // which are the one binary artefact this application stores. Note the newer
    // `.firebasestorage.app` domain: the legacy `.appspot.com` bucket name still
    // resolves for older projects, but new ones get the former.
    storageBucket: required('FIREBASE_STORAGE_BUCKET'),
  },
};

// Refuse to emit a config whose endpoints disagree with its project.
//
// This is the failure that wastes an afternoon: a build that carries the
// emulator's functions host together with a production API key "works" right up
// until a callable returns an opaque permission error, because the ID token's
// project claim and the Firestore it is checked against are different projects.
// Catching it here turns that into a one-line build failure.
const isEmulator = /127\.0\.0\.1|localhost/.test(config.functionsBase);
const isEmulatorProject = projectId === 'buildclose-dev';
if (isEmulator !== isEmulatorProject) {
  throw new Error(
    `Inconsistent Firebase target: functionsBase=${config.functionsBase} ` +
      `but projectId=${projectId}. Point both at the emulator (buildclose-dev) ` +
      `or both at production (buildclose-d4399).`,
  );
}

const banner = `/* Generated by build.mjs — do not edit. See build.mjs for the source. */\n`;
const body = `window.__BC_CONFIG__ = ${JSON.stringify(config, null, 2)};\n`;

writeFileSync(new URL('./config.js', import.meta.url), banner + body, 'utf8');
console.log(`[dashboard] config.js written -> functions ${config.functionsBase}`);
