# BuildClose

**Build the proposal. Close the deal.**

An AI sales agent attached to a proposal you have already sent. It continues the
conversation with the prospect after the document goes out — answering only from
approved knowledge, and never inventing facts, conceding discounts, changing
contractual terms, guaranteeing outcomes, or making commitments the seller has not
authorised.

---

## Repositories and domains

| Purpose | Host | Deployed on | App directory |
| --- | --- | --- | --- |
| Assistant infrastructure (`/widget.js`, `/embed`) | `agent.buildclose.app` | Netlify | `apps/agent` |
| Staff dashboard | `app.buildclose.app` | Netlify | `apps/dashboard` |
| Client-facing proposal document | `agency-proposals.com` | Netlify | `apps/proposals` |
| Commercial marketing site | `buildclose.app` | not built yet | — |

- Source: <https://github.com/TheMarketingMillennial/buildclose.git>
- Firebase project: **`buildclose-d4399`** (region `us-central1`)
- Google Cloud project number: `761268855407`

`agency-proposals.com` keeps its current DNS and hosting until explicitly
authorised. Nothing in this repository changes its records.

---

## Data architecture

Three collections carry the security model:

- **`proposals`** — the public-facing commercial facts the assistant may quote.
- **`proposalInternal`** — price floor, discount ceiling, negotiation boundaries,
  competitor notes, approved discounts, quotable amounts. A **separate document
  with no client read path at all**, so internal material is unreachable
  structurally rather than filtered per field.
- **`events`** (observed) and **`insights`** (AI-inferred) — kept in separate
  collections so the dashboard can never present an estimate as a measurement.

Supporting collections: `companies`, `users`, `agentConfigs`, `accessTokens`,
`conversations` (+ `messages` subcollection), `acceptances`, `aiUsage`,
`auditLog`, `rateLimits`, `subscriptions`.

Money is stored as integer **minor units** with a `PRICING_VERSION`. The model
never performs arithmetic on price.

---

## Security model

1. **Prospect access tokens** — 256-bit random, `bc_pk_` prefix, stored only as
   SHA-256. Plaintext is shown once. Revocable individually; archiving a proposal
   revokes every token on it.
2. **Per-token origin pinning** — each token carries `allowedOrigins`, and the
   caller's origin must also pass the server allowlist. A token issued for
   `agency-proposals.com` is refused on every other host. Allowlisting a domain is
   never the sole authorisation mechanism.
3. **HMAC session tokens** — stateless verification plus a per-request state
   re-check, so revocation takes effect on the next request rather than at expiry.
4. **Origin separation** — the chat app is `agent.buildclose.app`, the dashboard is
   `app.buildclose.app`, and the proposal page is a third origin. The token crosses
   the boundary by `postMessage` after an origin handshake; it never appears in the
   **iframe URL**, so it cannot leak through `Referer`, history, or server logs.
   The shareable link (`/p/<token>`) is a capability URL and does contain it, by
   design — that is the thing being shared.
5. **Sandboxed iframe** — no `allow-same-origin`.
6. **Firestore and Storage default-deny** for all direct client access. The Admin
   SDK bypasses rules by design, so tenancy and role are enforced in function code
   from custom claims `{companyId, role}`, never from the request body.
7. **Rate limiting** — Firestore-backed fixed window keyed on a salted IP hash,
   **fails closed**.
8. **Prompt-injection defence** — knowledge is passed inside
   `<<<KNOWLEDGE_DATA … KNOWLEDGE_DATA>>>` delimited blocks and treated as data.
9. **Negation-aware commercial validation** — a correct refusal ("I can't offer a
   discount on that") survives validation; an actual unauthorised concession does
   not.
10. **Canonical document hashing** — acceptance evidence binds the exact document
    version the prospect agreed to.

---

## Native acceptance

Acceptance is recorded natively, with no external e-signature vendor: explicit
consent step, timestamp, document version, canonical document hash, full name, and
an audit entry. The stored shape keeps `signature.provider` so an e-signature
provider can be layered on later without migrating evidence.

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
| `showVendorBranding` | `false` |

---

## Application surfaces

### `apps/agent` — assistant infrastructure
- `widget.js` — dependency-free loader (~5 KB). Reads `data-bc` (token),
  `data-chat-origin`, `data-label`, `data-accent`, `data-position`.
- `embed/` — the framed chat app. Consumes the `identity` block from `/api/terms`.
- `build.mjs` generates `dist/config.js` and `dist/_headers` from the same
  environment variables, so the API base and the CSP can never drift apart.

### `apps/dashboard` — staff dashboard
Zero Firebase SDK, deliberately: the CSP is `script-src 'self'`, so the client
speaks the Identity Toolkit and callable REST protocols directly instead of loading
a third-party script onto the origin that holds staff sessions.

Views: sign-in, overview, proposals list, create, proposal detail (overview /
assistant / access links / conversations / internal / edit), team, audit log.

`build.mjs` emits `config.js` from environment variables. It **fails the build** if
`FIREBASE_API_KEY`, `FIREBASE_APP_ID`, or `FIREBASE_STORAGE_BUCKET` is missing, and
also fails if the project id and the functions host point at different
environments — the failure that otherwise surfaces much later as an opaque
permission error.

### `apps/proposals` — client-facing proposal
- `abrica.src.html` — the proposal document as a template with three placeholders.
- `build.mjs` injects the token, the assistant origin, and the payment link at
  build time, then generates `_headers` from the same values.

The token is injected rather than committed so it never enters git history, build
logs, or a repository archive, and rotating it is an environment-variable change.

---

## Cloud Functions (25)

All in `us-central1`, Node.js 20. Only `api` and `stripeWebhook` are
internet-exposed; every other export is an authenticated callable.

**Prospect API** (`api`, Express) — `POST /api/health`, `/api/bootstrap`,
`/api/chat`, `/api/event`, `/api/terms`, `/api/accept`, `/api/decline`

**Proposals** — `createProposal`, `getProposal`, `listProposals`, `updateProposal`,
`publishProposal`, `unpublishProposal`, `archiveProposal`, `duplicateProposal`
(does not copy tokens)

**Access tokens** — `mintAccessToken`, `listAccessTokens`, `revokeAccessToken`

**Intelligence** — `getCompanyDashboard`, `getProposalAnalytics`,
`listConversations`, `getConversation`, `getAuditLog`

**Team** — `inviteStaff`, `setStaffRole`, `listStaff`, `bootstrapCompany`

**Billing** — `createCheckoutSession`, `stripeWebhook` (test mode)

**Retention** — `retentionPurge` (scheduled daily 03:00 UTC), `runRetentionPurge`
(staff callable twin, for on-request deletions and for the emulator, which cannot
invoke Cloud Scheduler)

---

## Retention

`settings.retentionDays` per company, default **365**, floor **30**. The daily job
deletes conversation messages and inferred insights, tombstones the conversation,
and **preserves** acceptances, events, audit log, and AI usage. Idempotent and
resumable, so `retryCount: 0` is correct rather than risky: a retry would only
re-scan work that a completed run already finished.

Deletion is scoped by role in code: a `company_admin` can purge only its own
tenant; `platform_admin` may target any tenant.

---

## Testing

Local results, all against emulator project `buildclose-dev`:

| Suite | Result |
| --- | --- |
| `tests/unit.test.mjs` | 19/19 |
| `tests/middleware.test.mjs` | 8/8 |
| `tests/rules.test.mjs` (direct-access denial) | 9/9 |
| `tests/integration.test.mjs` | 27/27 |
| `tests/retention.test.mjs` | 11/11 |
| `tests/e2e.browser.test.mjs` (Playwright) | 10/10 |
| `tests/dashboard.auth.test.mjs` (authenticated) | 29/29 |

`dashboard.auth` is executed in small batches against one code revision because
this sandbox has ~2 GB of RAM and the emulator stack consumes most of it; see
`tests/TEST-RESULTS.md` for the per-batch record. Full detail, including what is
**not** verified, is in `docs/PRODUCTION-READINESS.md`.

Production has **no** verified behaviour: no deploy has occurred.

---

## Documentation

| Document | Purpose |
| --- | --- |
| `docs/RUNBOOK.md` | Step-by-step deployment, from zero to a private Abrica link |
| `docs/CONFIGURATION.md` | Every environment variable and secret, public vs confidential |
| `docs/PRODUCTION-READINESS.md` | Readiness report, including unverified items |
| `tests/TEST-RESULTS.md` | Batched test log and coverage summary |

---

## Go-live gate — not cleared

The Abrica proposal must not be publicly released until:

- [ ] Every check in RUNBOOK §13 passes against the deployed backend
- [ ] Headers verified on all three Netlify sites (RUNBOOK §9)
- [ ] The iframe handshake verified in a real browser: token absent from the iframe
      URL, assistant replies, revocation behaves
- [ ] The prospect experience reviewed and approved

No public deployment is authorised by this repository.

---

## Tech stack

Express on **Firebase Cloud Functions v2** (Cloud Run) · Firestore · Firebase Auth ·
Cloud Storage · OpenAI API · Stripe (test mode) · vanilla ES modules on **Netlify**
· TypeScript · Zod

No Cloudflare, no Base44, no additional infrastructure vendors.
