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
| Commercial marketing site | `buildclose.app` | Netlify (site built, not yet deployed) | `apps/marketing` |

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
`auditLog`, `rateLimits`, `subscriptions`, `companyIntelligence`,
`companyAuthority`.

`companyIntelligence` holds the company-level knowledge edited once and reused
across every proposal (profile, products/services, sales methodology, brand
voice, objection playbook, FAQs, commercial policies, assistant defaults).
`companyAuthority` holds the commercial authority: price floor, discount
ceiling, negotiation permissions and boundaries. Both are one document per
company, keyed by `companyId`.

### Company intelligence and the tighten-only override rule

A proposal may make commercial authority **stricter, never looser**. This is
enforced twice, at two different times, because one enforcement point is not
enough:

1. **On write** — `authorityOverrideProblems()` rejects an override that would
   lower the price floor or raise the discount ceiling, and the update callable
   turns those problems into a `permission-denied` error so the author gets
   feedback.
2. **On every read** — `effectiveAuthority()` recomputes the binding limits from
   the stored company record and the proposal record together, taking the
   *tighter* of the two (higher floor, lower ceiling, union of negotiation
   boundaries, permissions never widened). A record written by any other path —
   a migration, a console edit, a future code path — still cannot loosen the
   company limits at request time.

`sanitiseQuotable()` additionally restricts the figures a proposal may quote to
ones already authorised: the company quotable list, approved concession amounts,
or the proposal's own discounts. A representative cannot introduce a quotable
price the company never approved.

`AuthorityOverrides` deliberately has **no defaults and every field optional**.
`ProposalInternalInput` defaults `maxDiscountPercent` to `0`; reading that
default as intent would make "the tighter of the two" resolve to zero for every
proposal and silently disable commerce. Absence means inherit.

Proposal agent config is seeded from `assistantDefaults` **at create time**,
because `AgentConfigInput` defaults `displayName` — a read-time `||` fallback
could never actually inherit. Knowledge merge (`mergeAgentKnowledge`) lets the
proposal win on presentation while unioning safety rules, so a proposal can add
a prohibited claim but never remove one.

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

### `apps/marketing` — commercial site
`buildclose.app`. Static HTML/CSS/JS with **no build step** and **no dependency on
the other three apps** — no shared imports, no Firebase SDK, no call to the
functions host. Its only link into the product is the "Customer sign in" button
pointing at `app.buildclose.app`.

- `index.html` — hero, scripted product demonstration, how it works, features,
  industries, demo-request form, footer.
- `app.js` — the demonstration is **scripted from fictional data** (Meridian Studio
  / Northwind & Co. / £18,500). It makes no network request and calls no model, so
  it cannot misrepresent live behaviour or incur API cost.
- `netlify.toml` — publishes the directory as-is, with a CSP that allows **no**
  inline `style` or `script`, plus `X-Frame-Options: DENY`.

The site states no testimonials, customer counts, conversion rates or prices,
because none have been established. `docs/CONFIGURATION.md` records `APP_BASE_URL`
as **reserved and unread** — the site is the intended consumer, but nothing
generates links from it yet.

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

**Company intelligence** — `getCompanyIntelligence` (any staff role),
`updateCompanyIntelligence` (admin / sales manager), `getCompanyAuthority`
(admin / sales manager — representatives are refused outright rather than
sent a redacted document, so the floor is never disclosed),
`updateCompanyAuthority` (admin / sales manager)

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
