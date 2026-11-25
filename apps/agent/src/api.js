/**
 * Shared API client for the chat app.
 *
 * PLAIN JAVASCRIPT — deliberately. This file is served to the browser as-is;
 * there is no bundler or transpiler in front of it. Keeping types here as JSDoc
 * rather than TypeScript syntax means the file cannot fail to parse at runtime.
 *
 * (History: these files were TypeScript while a Vite build existed. When the
 * build was removed the types stayed, and since the frame is sandboxed any parse
 * error just left the widget on its loading state with no visible cause. build.mjs
 * now syntax-checks every served script, so this cannot regress silently.)
 *
 * The session token lives in memory only — never localStorage, never a cookie.
 * That means:
 *   - an XSS payload cannot read it from storage;
 *   - it cannot leak cross-origin (no cookie is sent automatically);
 *   - a reload requires re-bootstrapping, which is cheap because the widget
 *     re-sends the proposal token on open.
 *
 * Trade-off accepted deliberately: the prospect stays signed in for the session
 * lifetime (1 hour) but not across reloads. For a proposal page that is fine, and
 * the cost of a leak is far higher than the cost of a re-handshake.
 */

/**
 * @typedef {object} Cta
 * @property {string} id
 * @property {string} label
 * @property {string} url
 */

/**
 * @typedef {object} Terms
 * @property {{title: string, prospectName: string, prospectCompany: string,
 *   summary: string, totalValueMinor: number, commencementMinor: number,
 *   currency: string, termsNote: string, validUntil: string,
 *   hostedProposalUrl: string}} proposal
 * @property {number} documentVersion
 * @property {string} documentHash
 * @property {string} acceptanceStatus
 * @property {Cta[]} ctas
 * @property {{displayName?: string, subtitle?: string, accentColor?: string,
 *   showVendorBranding?: boolean, welcomeMessage?: string}} [identity]
 * @property {{conversationLogged: boolean, retentionDays: number, assistantIsAI: boolean}} disclosure
 */

/**
 * @typedef {object} ChatResponse
 * @property {string} reply
 * @property {Cta | null} cta
 * @property {boolean} escalate
 * @property {string} conversationId
 */

/** A deniable, retryable failure with a message safe to render. */
export class ApiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} status
   */
  constructor(code, message, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export class ApiClient {
  /** @param {string} baseUrl */
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    /** @type {string | null} */
    this.session = null;
    this.sessionExpiresAt = 0;
  }

  get isAuthenticated() {
    return Boolean(this.session) && this.sessionExpiresAt > Date.now() + 30_000;
  }

  /**
   * Exchange a proposal token for a session. Called on every widget handshake.
   * @param {string} token
   * @param {string} embedOrigin
   */
  async bootstrap(token, embedOrigin) {
    const res = await this.post('/api/bootstrap', { token, embedOrigin }, null);
    /** @type {{session: string, expiresAt: number, proposal: {title: string, prospectName: string}}} */
    const data = await res.json();
    this.session = data.session;
    this.sessionExpiresAt = data.expiresAt;
    return data.proposal;
  }

  /** @returns {Promise<Terms>} */
  async terms() {
    const res = await this.post('/api/terms', {}, this.requireSession());
    return res.json();
  }

  /**
   * @param {string} message
   * @returns {Promise<ChatResponse>}
   */
  async chat(message) {
    const res = await this.post('/api/chat', { message }, this.requireSession());
    return res.json();
  }

  /**
   * @param {string} type
   * @param {string} [ctaId]
   */
  async event(type, ctaId) {
    if (!this.isAuthenticated) return; // analytics must never block the UI
    try {
      await this.post('/api/event', { type, ...(ctaId ? { ctaId } : {}) }, this.requireSession());
    } catch {
      /* non-critical */
    }
  }

  /**
   * @param {{fullName: string, email: string, title?: string, documentHash: string,
   *   documentVersion: number, typedSignature: string}} payload
   * @returns {Promise<{acceptedAt: number, documentVersion: number}>}
   */
  async accept(payload) {
    const res = await this.post(
      '/api/accept',
      { ...payload, consent: true, accept: true },
      this.requireSession(),
    );
    return res.json();
  }

  /** @param {string} [reason] */
  async decline(reason) {
    try {
      await this.post('/api/decline', { reason }, this.requireSession());
    } catch {
      /* non-critical */
    }
  }

  clear() {
    this.session = null;
    this.sessionExpiresAt = 0;
  }

  /** @returns {string} */
  requireSession() {
    if (!this.session) throw new ApiError('unauthorized', 'Session expired. Please reopen the assistant.', 401);
    return this.session;
  }

  /**
   * @param {string} path
   * @param {unknown} body
   * @param {string | null} bearer
   * @returns {Promise<Response>}
   */
  async post(path, body, bearer) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
      // No credentials: the API is bearer-only, so no cookie can ride along.
      credentials: 'omit',
    });

    if (!res.ok) {
      let code = 'request_failed';
      let message = 'Something went wrong.';
      try {
        /** @type {{error?: {code?: string, message?: string}}} */
        const data = await res.json();
        code = data.error?.code ?? code;
        message = data.error?.message ?? message;
      } catch {
        /* keep defaults */
      }
      // A dead session must be discarded so the next handshake re-bootstraps.
      if (res.status === 401) this.clear();
      throw new ApiError(code, message, res.status);
    }
    return res;
  }
}

/** @param {number} minor */
export const money = (minor) =>
  (minor / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
