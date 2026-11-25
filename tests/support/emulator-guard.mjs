/**
 * Hard guard: these tests may only ever touch an emulator.
 *
 * Requirement: test fixtures must be isolated from production and must be
 * incapable of executing against the real Firebase project. A comment saying
 * "emulator only" is not a control — this module is, and every fixture imports
 * it before doing anything else.
 *
 * It fails closed. If the environment cannot positively be identified as a local
 * emulator, the test aborts rather than proceeding on an assumption.
 */

/** Project ids that are unambiguously local development. */
const DEV_PROJECTS = new Set(['buildclose-dev', 'demo-buildclose', 'buildclose-test']);

/** Production must never appear anywhere in a test process. */
const FORBIDDEN_PROJECTS = new Set(['buildclose-d4399']);

function isLocalHost(hostport) {
  if (!hostport) return false;
  const host = hostport.startsWith('[')
    ? hostport.slice(1, hostport.indexOf(']'))
    : hostport.split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export class ProductionSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProductionSafetyError';
  }
}

/**
 * Assert the current process is pointed at a local emulator.
 * Call this at the top of every fixture and every emulator-backed test file.
 */
export function assertEmulatorOnly(where = 'test') {
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '';
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || '';
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || '';
  const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST || process.env.API_BASE || '';

  if (FORBIDDEN_PROJECTS.has(project)) {
    throw new ProductionSafetyError(
      `${where}: refusing to run against the PRODUCTION project "${project}". ` +
        'Tests must never touch production data.',
    );
  }
  if (!DEV_PROJECTS.has(project)) {
    throw new ProductionSafetyError(
      `${where}: project "${project || '(unset)'}" is not a known development project. ` +
        `Expected one of: ${[...DEV_PROJECTS].join(', ')}.`,
    );
  }
  if (!isLocalHost(firestoreHost)) {
    throw new ProductionSafetyError(
      `${where}: FIRESTORE_EMULATOR_HOST is "${firestoreHost || '(unset)'}", which is not a local emulator. ` +
        'Set it to 127.0.0.1:8080.',
    );
  }
  if (!isLocalHost(authHost)) {
    throw new ProductionSafetyError(
      `${where}: FIREBASE_AUTH_EMULATOR_HOST is "${authHost || '(unset)'}", which is not a local emulator. ` +
        'Set it to 127.0.0.1:9099.',
    );
  }
  // API_BASE may legitimately be empty in unit-only runs; when set it must be local.
  if (functionsHost && !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(functionsHost)) {
    throw new ProductionSafetyError(
      `${where}: API_BASE/FUNCTIONS_EMULATOR_HOST is "${functionsHost}", which is not local.`,
    );
  }

  return { project, firestoreHost, authHost };
}
