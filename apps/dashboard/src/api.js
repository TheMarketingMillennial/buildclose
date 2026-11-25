/**
 * Dashboard client: Firebase Auth + Cloud Functions callables, over REST.
 *
 * WHY NOT THE FIREBASE SDK
 * The dashboard CSP is `script-src 'self'`. Loading the SDK from a CDN would
 * require loosening that to a third-party script origin, which is a materially
 * worse posture for the surface that holds staff sessions. The two protocols the
 * dashboard actually needs are small and stable:
 *
 *   Identity Toolkit  POST {authBase}/v1/accounts:signInWithPassword?key=…
 *   Refresh           POST {tokenBase}/v1/token?key=…
 *   Callable          POST {functionsBase}/{name}   Authorization: Bearer <idToken>
 *
 * The callable envelope is {data: …} in, {result: …} out — exactly what the SDK
 * serialises.
 */

const cfg = window.__BC_CONFIG__ ?? {};
const STORAGE_KEY = 'bc.dashboard.session';

/** A deniable, retryable failure with a message safe to render. */
export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Session persistence.
 *
 * localStorage, deliberately, and only here: this is the staff dashboard on its
 * own origin with a login screen, not the prospect surface. The prospect session
 * stays in memory precisely because a proposal page may be an arbitrary third
 * party's site. Refresh tokens are per-origin, so this cannot be read by
 * agent.buildclose.app.
 */
const store = {
  read() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  write(s) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      /* private mode — session lives for this tab only */
    }
  },
  clear() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
};

let session = store.read();

function authError(json, status) {
  const reason = json?.error?.message ?? 'UNKNOWN';
  const map = {
    EMAIL_NOT_FOUND: 'No account with that email.',
    INVALID_PASSWORD: 'Incorrect password.',
    INVALID_LOGIN_CREDENTIALS: 'Incorrect email or password.',
    USER_DISABLED: 'This account has been disabled.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Try again in a few minutes.',
    INVALID_EMAIL: 'That email address is not valid.',
  };
  return new ApiError(reason, map[reason] ?? 'Sign-in failed.', status);
}

/**
 * Read the payload of an ID token.
 *
 * UI GATING ONLY. The custom claims inside this token are what the server
 * independently re-reads and enforces on every callable; decoding them here just
 * avoids showing a rep a button that would fail. A tampered payload changes what
 * the browser paints, never what the server permits.
 */
function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return {};
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    const bin = atob(b64 + pad);
    let pct = '';
    for (let i = 0; i < bin.length; i += 1) {
      pct += `%${bin.charCodeAt(i).toString(16).padStart(2, '0')}`;
    }
    return JSON.parse(decodeURIComponent(pct));
  } catch {
    return {};
  }
}

export const auth = {
  get user() {
    return session ? { uid: session.uid, email: session.email } : null;
  },
  get isSignedIn() {
    return Boolean(session?.idToken);
  },

  /**
   * Decoded claims from the current ID token, refreshed first if needed.
   * Returns `{ uid, email, companyId, role }` — companyId/role may be absent if
   * the account has not been attached to a tenant yet.
   */
  async claims() {
    const token = await auth.token();
    const payload = decodeJwt(token);
    return {
      uid: payload.user_id ?? payload.sub ?? session?.uid ?? null,
      email: payload.email ?? session?.email ?? null,
      companyId: payload.companyId ?? null,
      role: payload.role ?? null,
    };
  },

  async signIn(email, password) {
    const res = await fetch(
      `${cfg.authBase}/v1/accounts:signInWithPassword?key=${encodeURIComponent(cfg.firebase.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      },
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw authError(json, res.status);

    session = {
      idToken: json.idToken,
      refreshToken: json.refreshToken,
      // Expiry with a 60s skew so a token never dies mid-request.
      expiresAt: Date.now() + (Number(json.expiresIn ?? 3600) - 60) * 1000,
      uid: json.localId,
      email: json.email ?? email,
    };
    store.write(session);
    return auth.user;
  },

  async signOut() {
    session = null;
    store.clear();
  },

  /** Return a valid idToken, refreshing if needed. */
  async token() {
    if (!session) throw new ApiError('unauthenticated', 'Please sign in.', 401);
    if (Date.now() < session.expiresAt) return session.idToken;

    const res = await fetch(
      `${cfg.tokenBase}/v1/token?key=${encodeURIComponent(cfg.firebase.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken }),
      },
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      await auth.signOut();
      throw new ApiError('unauthenticated', 'Your session expired. Please sign in again.', 401);
    }
    session.idToken = json.id_token;
    session.refreshToken = json.refresh_token ?? session.refreshToken;
    session.expiresAt = Date.now() + (Number(json.expires_in ?? 3600) - 60) * 1000;
    store.write(session);
    return session.idToken;
  },
};

/** Invoke a Cloud Function callable and unwrap its result. */
export async function call(name, data = {}) {
  const token = await auth.token();
  const res = await fetch(`${cfg.functionsBase}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ data }),
  });
  const json = await res.json().catch(() => ({}));

  if (!res.ok || json.error) {
    const message = json?.error?.message ?? json?.error?.status ?? 'Request failed.';
    if (res.status === 401 || /unauthenticated/i.test(String(json?.error?.status))) {
      await auth.signOut();
    }
    throw new ApiError(json?.error?.status ?? 'error', message, res.status);
  }
  return json.result;
}

/** Currency from minor units. Returns an em dash for absent values. */
export function money(minor, currency = 'USD') {
  if (minor === null || minor === undefined) return '—';
  return (Number(minor) / 100).toLocaleString('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  });
}

export function pct(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return `${(Number(n) * 100).toFixed(1)}%`;
}

export function when(ms) {
  if (!ms) return '—';
  return new Date(Number(ms)).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
