/**
 * Runtime configuration.
 *
 * Secrets are read from the process environment at invocation time, never at
 * module scope: Cloud Functions resolves secret params per invocation, and a
 * top-level read yields undefined. This shape also lets the emulator and the
 * test suite inject values normally.
 *
 * Deployment binding lives in src/index.ts via the `secrets: [...]` option on
 * each function, which is what populates these environment variables.
 */

export class ConfigError extends Error {
  constructor(public readonly missing: string) {
    super(`Missing required configuration: ${missing}`);
    this.name = 'ConfigError';
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') throw new ConfigError(name);
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

export interface RuntimeConfig {
  openaiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  sessionSecret: string;
  chatOrigin: string;
  dashboardOrigin: string;
  embedOrigin: string;
  appBaseUrl: string;
  ipSalt: string;
  stripeKey: string;
  stripeWebhookSecret: string;
}

/** Loaded lazily inside handlers so a missing secret fails that request only. */
export function getConfig(): RuntimeConfig {
  return {
    openaiKey: required('OPENAI_API_KEY'),
    openaiBaseUrl: optional('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    openaiModel: optional('OPENAI_MODEL', 'gpt-6.1-sol'),
    sessionSecret: required('SESSION_SECRET'),
    chatOrigin: optional('CHAT_ORIGIN', 'https://chat.buildclose.app'),
    dashboardOrigin: optional('DASHBOARD_ORIGIN', 'https://app.buildclose.app'),
    embedOrigin: optional('EMBED_ORIGIN', 'https://embed.buildclose.app'),
    appBaseUrl: optional('APP_BASE_URL', 'https://buildclose.app'),
    // Separate salt so a leaked hash cannot be reversed by guessing IPs.
    ipSalt: optional('IP_SALT', 'buildclose-dev-salt'),
    stripeKey: optional('STRIPE_SECRET_KEY', ''),
    stripeWebhookSecret: optional('STRIPE_WEBHOOK_SECRET', ''),
  };
}

/** Trim a trailing slash so origin comparisons are exact. */
export function normaliseOrigin(raw: string): string {
  return raw.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Compare a request Origin header against the permitted set.
 * Returns the canonical origin to echo in CORS headers, or null if refused.
 * Echoing the matched value (rather than '*') is required because the chat
 * endpoint carries a bearer-style session and must never be wildcard-readable.
 */
export function allowedCorsOrigin(requestOrigin: string | undefined, permitted: string[]): string | null {
  if (!requestOrigin) return null;
  const candidate = normaliseOrigin(requestOrigin);
  for (const p of permitted) {
    if (normaliseOrigin(p) === candidate) return p;
  }
  return null;
}
