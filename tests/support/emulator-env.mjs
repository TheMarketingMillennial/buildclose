/**
 * Emulator environment, imported FIRST by any test that loads functions/lib.
 *
 * Why a separate module instead of a few `process.env` lines at the top of the
 * test: ES module imports are hoisted and evaluated before any other top-level
 * statement in the importing file. So this:
 *
 *     process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';   // runs second
 *     import { x } from '../functions/lib/lib/retention.js';      // runs first
 *
 * evaluates functions/lib/firebase.ts BEFORE the emulator host exists. That module
 * decides at import time whether to call applicationDefault(), sees no emulator,
 * tries to fetch real Google credentials, and the suite dies with
 * "Could not load the default credentials" — a confusing failure far from its cause.
 *
 * Importing this module first fixes the ordering, because sibling imports are
 * evaluated in source order.
 */

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
process.env.GCLOUD_PROJECT ||= 'buildclose-dev';
// Firebase Admin reads this to pick the emulator project; without it the SDK
// resolves the project lazily and can end up with `undefined` in document paths.
process.env.GOOGLE_CLOUD_PROJECT ||= process.env.GCLOUD_PROJECT;
