# BuildClose — Configuration & Environment Variable Reference

Every variable the application reads, what it does, whether it is **public
configuration** (safe on the client, safe in git) or a **confidential credential**
(Secret Manager only, never in git, never in chat).

Project: **buildclose-d4399** · Region: **us-central1** · Project number: **761268855407**

---

## 1. Confidential credentials — 6 total

These five live in Google Secret Manager, set with
`firebase functions:secrets:set <NAME>`. The sixth (`PROPOSAL_TOKEN`) is a Netlify
build-time variable for the proposals site.

| Name | Where it lives | Used by | What it is | What happens if leaked |
| --- | --- | --- | --- | --- |
| `OPENAI_API_KEY` | Secret Manager | `api` | OpenAI API key | Third party bills your account. Rotate immediately. |
| `SESSION_SECRET` | Secret Manager | `api` | HMAC key signing prospect session tokens | An attacker can forge prospect sessions for **any** proposal. Rotate; all live prospect sessions die instantly. |
| `SETUP_CODE` | Secret Manager | `bootstrapCompany` | One-time onboarding gate, 8+ chars | Anyone could create the first company before you do. **Destroy it after onboarding** (RUNBOOK §8). |
| `STRIPE_SECRET_KEY` | Secret Manager | `createCheckoutSession`, `stripeWebhook` | Stripe **test** secret key, `sk_test_...` | Test-mode data only, but rotate anyway. Never use a live key. |
| `STRIPE_WEBHOOK_SECRET` | Secret Manager | `stripeWebhook` | Stripe webhook signing secret, `whsec_...` | Forged webhooks could mark subscriptions paid. Rotate. |
| `PROPOSAL_TOKEN` | Netlify env (proposals site) | `apps/proposals` build | The `bc_pk_...` prospect access token injected into the page | Grants one prospect's assistant access to one proposal. **Revoke** via `revokeAccessToken`; mint a new one. |

**Never** commit these. `.gitignore` already excludes `.env.local`,
`.secret.local`, `apps/*/config.js`, `apps/*/dist/`, `seed/.seeded.json`, and
`seed/.local-token.json`.

**Never** pass a secret as a shell argument — it lands in shell history and in
process listings. Use the interactive prompt, or `printf '%s' "$X" | firebase
functions:secrets:set NAME` from a variable that is already in the environment.

---

## 2. Public configuration — safe in git, safe in the browser

### 2a. Firebase web config (dashboard)

**Not committed.** Supplied through Netlify environment variables for the
`buildclose-app` site, or through the gitignored `apps/dashboard/.env.local`
for local development. `apps/dashboard/.env.example` documents every variable
with placeholders.

These values are PUBLIC configuration — Google designs Firebase web config to
ship inside the browser bundle, so anyone who opens `app.buildclose.app` can
read them in `config.js`. The security boundary is the default-deny rules plus
the custom-claims check inside every callable, never the secrecy of these values.

They are kept out of git anyway, for a practical reason: committing an `AIzaSy…`
string triggers GitHub secret scanning on every push, and permanently tolerating
an alert means the first **real** credential added next to it would hide inside
that noise.

Get them from Firebase console → Project settings → Your apps → the Web app →
*SDK setup and configuration* → Config.

| Variable | Value for buildclose-d4399 | Required | Notes |
| --- | --- | --- | --- |
| `FIREBASE_PROJECT_ID` | `buildclose-d4399` | yes | |
| `FIREBASE_API_KEY` | `<from Firebase console>` — `AIzaSy…`, 39 chars | **yes** — build fails without it | Public client identifier. Not a credential. |
| `FIREBASE_APP_ID` | `1:761268855407:web:82c27b93240836a18da39a` | **yes** — build fails without it | |
| `FIREBASE_AUTH_DOMAIN` | `buildclose-d4399.firebaseapp.com` | recommended | Defaults to `<projectId>.firebaseapp.com` if absent. |
| `FIREBASE_STORAGE_BUCKET` | `buildclose-d4399.firebasestorage.app` | **yes** — build fails without it | Newer `.firebasestorage.app` domain, not legacy `.appspot.com`. Needed to build download URLs for acceptance evidence. |
| `FIREBASE_MESSAGING_SENDER_ID` | `761268855407` | **deliberately unused** | No Cloud Messaging in this app. |
| `FIREBASE_MEASUREMENT_ID` | `G-4QLQMTH09E` | **deliberately unused** | Enabling it loads `gtag.js` from a third party, forcing the dashboard CSP off `script-src 'self'` and putting a tracker on the surface holding tenant revenue data. Do not add. |

### 2b. Dashboard — optional overrides

All defaults are production-correct; set these only to override.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FUNCTIONS_REGION` | `us-central1` | Region used to construct the functions host |
| `FUNCTIONS_BASE` | `https://<region>-<projectId>.cloudfunctions.net` | Full callable base URL |
| `AUTH_BASE` | `https://identitytoolkit.googleapis.com` | Identity Toolkit REST base |
| `TOKEN_BASE` | `https://securetoken.googleapis.com` | Refresh-token endpoint |
| `AGENT_ORIGIN` | `https://agent.buildclose.app` | Rendered in the embed snippet; the dashboard never calls it |
| `DASHBOARD_ORIGIN` | `https://app.buildclose.app` | Informational |

The build **fails** if `FUNCTIONS_BASE` points at localhost while
`FIREBASE_PROJECT_ID` is `buildclose-d4399` (or vice versa). That guard exists because
a mismatched pair produces an opaque permission error much later, not a build error.

### 2c. Agent site — environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID` | `buildclose-d4399` | Builds the functions host |
| `FUNCTIONS_REGION` | `us-central1` | Same |
| `API_BASE` | `https://<region>-<projectId>.cloudfunctions.net/api` | Must be an absolute URL; validated at build |
| `EMBED_FRAME_ANCESTORS` | `https:` | CSP `frame-ancestors`. **Never `*`** — it would let any site frame the assistant invisibly over its own click targets. |

### 2d. Proposals site — environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `PROPOSAL_TOKEN` | **yes** — build fails without it | Must match `bc_pk_[A-Za-z0-9_-]{20,}`. **Confidential** (see §1). Rotate via re-mint. |
| `AGENT_ORIGIN` | yes (default provided) | Bare https origin; goes into both CSP and the widget tag |
| `PAYMENT_URL` | no | https only. The payment button is hidden when unset. |
| `PROPOSAL_SLUG` | no | Output filename, default `abrica` |
| `ALLOW_PAYMENT_IFRAME` | no | `"true"` also permits Stripe in `frame-src` |

### 2e. Cloud Functions — non-secret config

Committed at `functions/.env.buildclose-d4399`. Loaded by Firebase at deploy time.

| Variable | Value | Purpose |
| --- | --- | --- |
| `CHAT_ORIGIN` | `https://agent.buildclose.app` | **The** allowed API caller origin. Changing it to an unmatched value instantly CORS-blocks every browser call — useful as an emergency stop (RUNBOOK §16). |
| `DASHBOARD_ORIGIN` | `https://app.buildclose.app` | Staff origin |
| `EMBED_ORIGIN` | `https://agency-proposals.com` | Default authorised proposal host for embeds |
| `APP_BASE_URL` | `https://buildclose.app` | **Reserved — not currently read by any code.** Declared in `functions/src/lib/config.ts` but consumed by nothing, so no link is generated from it today. Safe to leave set for when the marketing site goes live. |
| `OPENAI_MODEL` | `gpt-6.1-sol` | Model id. **Must be a model your OpenAI account can access**; a wrong value fails on the first chat request, not at deploy. Pricing per model is in `functions/src/lib/pricing.ts`. |
| `STORAGE_BUCKET` | **not yet in the file — add it** | `buildclose-d4399.firebasestorage.app`. If unset, code falls back to `<project>.appspot.com`, which is the wrong domain for this project. See RUNBOOK §5. |

Runtime-injected by the platform — do not set manually:
`GCLOUD_PROJECT`, `K_SERVICE`, `FUNCTION_TARGET`, `FIREBASE_CONFIG`.

---

## 3. Local development only — never in any deploy

Set in `functions/.env.local` / `apps/dashboard/.env.local` (both gitignored).

| Variable | Value | Purpose |
| --- | --- | --- |
| `GCLOUD_PROJECT` | `buildclose-dev` | Emulator project. **Never** `buildclose-d4399`. |
| `FIRESTORE_EMULATOR_HOST` | `127.0.0.1:8080` | |
| `FIREBASE_AUTH_EMULATOR_HOST` | `127.0.0.1:9099` | |
| `FUNCTIONS_EMULATOR` | `true` | |
| `FIREBASE_API_KEY` | any non-empty string | The emulator does not validate it |
| `FUNCTIONS_BASE` | `http://127.0.0.1:5001/buildclose-dev/us-central1` | |
| `AUTH_BASE` | `http://127.0.0.1:9099/identitytoolkit.googleapis.com` | |
| `SETUP_CODE` | a local throwaway value | Only ever from `.secret.local`, gitignored |

The test fixtures refuse to run unless the project is one of `buildclose-dev`,
`demo-buildclose`, `buildclose-test` **and** the emulator hosts are localhost, and
they treat `buildclose-d4399` as explicitly forbidden. An unrecognised project id
fails closed rather than being assumed safe.

---

## 4. Complete deployment checklist

**Secret Manager (5):**
```
OPENAI_API_KEY
SESSION_SECRET
SETUP_CODE            ← destroy after onboarding
STRIPE_SECRET_KEY     ← sk_test_ only
STRIPE_WEBHOOK_SECRET
```

**`functions/.env.buildclose-d4399` (6, add the last one):**
```
CHAT_ORIGIN=https://agent.buildclose.app
DASHBOARD_ORIGIN=https://app.buildclose.app
EMBED_ORIGIN=https://agency-proposals.com
APP_BASE_URL=https://buildclose.app
OPENAI_MODEL=gpt-6.1-sol
STORAGE_BUCKET=buildclose-d4399.firebasestorage.app
```

**Netlify `buildclose-agent` (2):**
```
FIREBASE_PROJECT_ID=buildclose-d4399
FUNCTIONS_REGION=us-central1
```

**Netlify `buildclose-app` (5 required):**
```
FIREBASE_PROJECT_ID=buildclose-d4399
FIREBASE_API_KEY=AIzaSy_REPLACE_WITH_YOUR_WEB_API_KEY
FIREBASE_APP_ID=1:761268855407:web:82c27b93240836a18da39a
FIREBASE_STORAGE_BUCKET=buildclose-d4399.firebasestorage.app
FIREBASE_AUTH_DOMAIN=buildclose-d4399.firebaseapp.com
```

**Netlify `buildclose-proposals` (2):**
```
PROPOSAL_TOKEN=bc_pk_...            ← from mintAccessToken; confidential
AGENT_ORIGIN=https://agent.buildclose.app
```

**Console settings:**
- Firestore — production mode, `us-central1`, rules + indexes deployed
- Authentication — Email/Password enabled
- Storage — default bucket `buildclose-d4399.firebasestorage.app`
- Blaze plan — enabled, **budget alert set at a low threshold**
- Cloud Scheduler — enabled (required by `retentionPurge`)
- Stripe — test mode, webhook pointing at `stripeWebhook`

**DNS:**
```
app.buildclose.app     CNAME  <buildclose-app>.netlify.app
agent.buildclose.app   CNAME  <buildclose-agent>.netlify.app
agency-proposals.com   ← DO NOT CHANGE until explicitly authorised
```
