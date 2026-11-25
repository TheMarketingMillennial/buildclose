/**
 * Shared API client for the chat app.
 *
 * The session token lives in memory only — never localStorage, never a cookie.
 * That choice means:
 *   - an XSS payload cannot read it from storage;
 *   - it cannot leak cross-origin (no cookie is sent automatically);
 *   - a reload requires re-bootstrapping, which is cheap because the widget
 *     re-sends the proposal token on open.
 *
 * Trade-off accepted deliberately: the prospect stays signed in for the session
 * lifetime (1 hour) but not across reloads. For a proposal page that is fine, and
 * the cost of a leak is far higher than the cost of a re-handshake.
 */

export interface Cta {
  id: string;
  label: string;
  url: string;
}

export interface Terms {
  proposal: {
    title: string;
    prospectName: string;
    prospectCompany: string;
    summary: string;
    totalValueMinor: number;
    commencementMinor: number;
    currency: string;
    termsNote: string;
    validUntil: string;
    hostedProposalUrl: string;
  };
  documentVersion: number;
  documentHash: string;
  acceptanceStatus: string;
  ctas: Cta[];
  disclosure: { conversationLogged: boolean; retentionDays: number; assistantIsAI: boolean };
}

export interface ChatResponse {
  reply: string;
  cta: Cta | null;
  escalate: boolean;
  conversationId: string;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  private session: string | null = null;
  private sessionExpiresAt = 0;

  constructor(private readonly baseUrl: string) {}

  get isAuthenticated(): boolean {
    return Boolean(this.session) && this.sessionExpiresAt > Date.now() + 30_000;
  }

  /** Exchange a proposal token for a session. Called on every widget handshake. */
  async bootstrap(token: string, embedOrigin: string): Promise<{ title: string; prospectName: string }> {
    const res = await this.post('/api/bootstrap', { token, embedOrigin }, null);
    const data = (await res.json()) as { session: string; expiresAt: number; proposal: { title: string; prospectName: string } };
    this.session = data.session;
    this.sessionExpiresAt = data.expiresAt;
    return data.proposal;
  }

  async terms(): Promise<Terms> {
    const res = await this.post('/api/terms', {}, this.requireSession());
    return (await res.json()) as Terms;
  }

  async chat(message: string): Promise<ChatResponse> {
    const res = await this.post('/api/chat', { message }, this.requireSession());
    return (await res.json()) as ChatResponse;
  }

  async event(type: string, ctaId?: string): Promise<void> {
    if (!this.isAuthenticated) return; // analytics must never block the UI
    try {
      await this.post('/api/event', { type, ...(ctaId ? { ctaId } : {}) }, this.requireSession());
    } catch {
      /* non-critical */
    }
  }

  async accept(payload: {
    fullName: string;
    email: string;
    title?: string;
    documentHash: string;
    documentVersion: number;
    typedSignature: string;
  }): Promise<{ acceptedAt: number; documentVersion: number }> {
    const res = await this.post(
      '/api/accept',
      { ...payload, consent: true, accept: true },
      this.requireSession(),
    );
    return (await res.json()) as { acceptedAt: number; documentVersion: number };
  }

  async decline(reason?: string): Promise<void> {
    try {
      await this.post('/api/decline', { reason }, this.requireSession());
    } catch {
      /* non-critical */
    }
  }

  clear(): void {
    this.session = null;
    this.sessionExpiresAt = 0;
  }

  private requireSession(): string {
    if (!this.session) throw new ApiError('unauthorized', 'Session expired. Please reopen the assistant.', 401);
    return this.session;
  }

  private async post(path: string, body: unknown, bearer: string | null): Promise<Response> {
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
        const data = (await res.json()) as { error?: { code?: string; message?: string } };
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

export const money = (minor: number): string =>
  (minor / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
