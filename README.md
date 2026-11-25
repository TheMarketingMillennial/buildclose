# BuildClose

**Build the proposal. Close the deal.**

An AI sales agent that is assigned to a proposal you have already sent. It continues
the conversation with the prospect after the document goes out — answering questions
from approved knowledge only, and never inventing facts, conceding discounts, changing
contractual terms, guaranteeing outcomes, or making commitments the seller has not
authorised.

---

## Repositories and domains

| Purpose | Domain | Host |
| --- | --- | --- |
| Commercial site | `buildclose.app` | — (not yet deployed) |
| Customer dashboard | `app.buildclose.app` | Netlify |
| Assistant infrastructure (`/widget.js`, `/embed`) | `agent.buildclose.app` | Netlify |
| Client-facing proposal hosting | `agency-proposals.com` | Netlify — **existing DNS/hosting untouched pending authorisation** |

Source: <https://github.com/TheMarketingMillennial/buildclose.git>
Firebase project: `buildclose-d4399`

---

## Data architecture

Three collections carry the security model:

- **`proposals`** — public-facing commercial facts the assistant may quote.
- **`proposalInternal`** — price floor, discount ceiling, negotiation boundaries,
  competitor notes, approved discounts, quotable amounts. **Separate document, no
  client read path at all.** Requirement 4 is satisfied structurally rather than by
  field filtering.
- **`events`** (observed) and **`insights`** (AI-inferred) — kept in separate
  collections so the dashboard can never present an estimate as a measurement.

Supporting collections: `companies`, `users`, `agentConfigs`, `accessTokens`,
`conversations` (+ `messages` subcollection), `acceptances`, `aiUsage`, `auditLog`,
`rateLimits`, `subscriptions`.

Money is stored as integer **minor units** with a `PRICING_VERSION`; the AI never does
arithmetic on price.

---

## Security model

1. **Prospect access tokens** — 256-bit random, `bc_pk_` prefix, stored only as
   SHA-256. Plaintext shown once. Revocable per token; archiving a proposal revokes
   every token on it.
2. **Per-proposal origin pinning** — each token carries `allowedOrigins`. A token
   issued for `agency-proposals.com` is refused on every other host. Public embed keys
   and domain allowlisting are **not** the sole authorisation mechanism.
3. **HMAC session tokens** — stateless verification plus a per-request state re-check,
   so revocation takes effect immediately rather than at token expiry.
4. **Origin separation** — the chat iframe is `agent.buildclose.app`; the admin
   dashboard is `app.buildclose.app`. The dashboard cannot read prospect conversations;
   the prospect surface cannot reach dashboard data.
5. **Sandboxed iframe** — no `allow-same-origin`. The token is handed over by
   `postMessage` after an origin handshake and **never appears in a URL**, so it cannot
   leak via `Referer`, history, or server logs.
6. **Firestore rules default-deny** for all client access. The Admin SDK bypasses rules
   by design; tenancy is enforced in code from custom claims `{companyId, role}`.
7. **Rate limiting** — Firestore-backed fixed window, **fails closed**.
8. **Prompt-injection defence** — knowledge is passed inside
   `<<<KNOWLEDGE_DATA … KNOWLEDGE_DATA>>>` delimited blocks and treated as data, not
   instructions.
9. **Negation-aware commercial validation** — a correct refusal ("I can't offer a
   discount on that") survives validation; an actual unauthorised concession does not.
10. **Canonical document hashing** — acceptance evidence binds the exact document
    version the prospect agreed to.

---

## Native acceptance

Acceptance is recorded natively: explicit consent step, timestamp, document version,
canonical document hash, full name, and an audit entry. **No external e-signature
vendor is used.** The record shape keeps `signature.provider` so an e-signature
provider can be layered on later without changing the stored evidence.

Changing any commercial term issues a new document version and resets a prior
acceptance to `superseded`.

---

## Assistant identity

Neutral and configurable per proposal. Defaults are deliberately vendor-free so the
prospect's experience belongs to the seller:

| Field | Default |
| --- | --- |
| `displayName` | `Proposal Assistant` |
| `subtitle` | `Ask anything about this proposal` |
| `accentColor` | `#1b3a6b` |
| `showVendorBranding` | **`false`** |

---

## Application surfaces

### `apps/agent` — assistant infrastructure
- `widget.js` — dependency-free embed (~5 KB). Reads `data-bc` (token),
  `data-chat-origin`, `data-label`, `data-accent`, `data-position`.
- `embed/` — the chat UI. Consumes the `identity` block from `/api/terms`.
- `_headers` — plaintext Netlify headers: `frame-ancestors https:` on `/embed`,
  `connect-src` pinned to the Cloud Functions origin, CORS `*` on `/widget.js`.

### `apps/dashboard` — staff dashboard
Zero Firebase SDK, deliberately: the CSP is `script-src 'self'`, so the client speaks
the Identity Toolkit and callable REST protocols directly rather than loading a
third-party script onto the origin that holds staff sessions.

Views: sign-in, overview, proposals list, create, proposal detail
(overview / assistant / access links / conversations / internal / edit), team, audit log.

`build.mjs` generates `config.js` from environment variables; it **exits 1** if
`FIREBASE_API_KEY` or `FIREBASE_APP_ID` is missing, so a deploy cannot silently ship a
broken config.

---

## Callable API (staff)

**Proposals** — `createProposal`, `getProposal`, `listProposals`, `updateProposal`,
`publishProposal`, `unpublishProposal`, `archiveProposal`, `duplicateProposal`
(does not copy tokens)

**Tokens** — `mintAccessToken({proposalId,label?,expiresInDays,allowedOrigins?})`,
`listAccessTokens({proposalId})`, `revokeAccessToken({tokenHash})`

**Intelligence** — `getCompanyDashboard`, `getProposalAnalytics({proposalId})`,
`listConversations({proposalId})`, `getConversation({conversationId})`, `getAuditLog`

**Team** — `inviteStaff`, `setStaffRole`, `listStaff`, `bootstrapCompany`

**Billing** — `createCheckoutSession`, `stripeWebhook` (Stripe **test mode** during
development)

### Prospect API (Express, `api`)
`POST /api/health`, `/api/bootstrap`, `/api/chat`, `/api/event`, `/api/terms`,
`/api/accept`, `/api/decline`

---

## Status

**Completed development**
- Prospect API with error mapping that preserves `AppError` status codes (a revoked
  link returns `401`, not `500`) and sends `Retry-After` on rate limits.
- Neutral configurable assistant identity (schema → DTO → chat UI → seed).
- Per-proposal origin pinning, including a pinned Abrica token.
- Missing `secrets` bindings fixed for `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `SETUP_CODE` — previously read but never declared, so `undefined` in production.
- Anti-spoofing client IP extraction (rightmost `X-Forwarded-For`).
- `apps/_headers` rebuilt as plaintext inside a publish directory; it had been an ES
  module outside every publish root, so no CSP or `frame-ancestors` was ever served.
- Dashboard SPA (all views above).
- `listConversations` callable — added because `getProposalAnalytics` returned only a
  conversation count and `getConversation` needs an id, leaving no path to a transcript.
- `docs/RUNBOOK.md` — 14-section deployment and credential runbook.

**Locally verified**
- `tsc` clean; integration **27/27**, rules **9/9**, unit **19/19**, middleware **8/8**.
- Origin pinning live: correct origin `200`, wrong origin `403 origin_not_allowed`, with
  no title leakage.
- Unauthenticated `/api/terms` → `401` (previously `500`).
- Dashboard served and the sign-in view renders in a real browser.

**Production verified — none.** No deploy has occurred.

**Not started**
- Retention purge job (`settings.retentionDays` exists; no implementation).
- Abrica widget integration into the proposal for `agency-proposals.com`.
- Browser verification of the sandboxed iframe handshake end to end.
- Production smoke tests (RUNBOOK §12).

---

## Deployment

Full instructions: **`docs/RUNBOOK.md`**. Summary:

```bash
firebase login
firebase use buildclose-d4399
firebase functions:secrets:set OPENAI_API_KEY      # never as a shell argument
firebase functions:secrets:set SESSION_SECRET
firebase functions:secrets:set SETUP_CODE
firebase functions:secrets:set STRIPE_SECRET_KEY
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
firebase deploy --only functions,firestore:rules
```

Then create three Netlify sites (`buildclose-app`, `buildclose-agent`,
`buildclose-proposals`), set **Base directory** per site and the environment variables
listed in RUNBOOK §7, and add the DNS CNAMEs in §8.

`agency-proposals.com` keeps its current DNS and hosting until explicitly authorised.

---

## Go-live gate — NOT yet cleared

The Abrica proposal must **not** be publicly released until all of the following hold:

- [ ] Production smoke tests pass (CORS, auth, tenant isolation, commercial guardrail,
      revocation, rate limiting)
- [ ] Browser verification of the iframe handshake with session auth and origin
      validation
- [ ] Final experience approved by the user

---

## Tech stack

Hono-free Express on **Firebase Cloud Functions v2** (Cloud Run) · Firestore · Firebase
Auth · OpenAI API · Stripe (test mode) · Vanilla ES modules on **Netlify** · TypeScript
· Zod

No Cloudflare, no Base44, no additional infrastructure vendors.
