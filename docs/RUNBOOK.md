# BuildClose — Deployment & Credential Runbook

Firebase project: **buildclose-d4399**
Region: **us-central1**
Repository: `TheMarketingMillennial/buildclose`

This document is written to be executed **on your own machine**. Deployment needs an
interactive `firebase login`, which cannot run inside a sandbox, so every step here
is a command you run locally with your own credentials.

**No step in this document requires you to paste a secret into any chat or into the
repository.** Every secret is entered at a `firebase functions:secrets:set` prompt,
which writes it to Google Secret Manager.

Companion documents: `docs/CONFIGURATION.md` (every variable, public vs confidential)
and `docs/PRODUCTION-READINESS.md` (what is verified and what is not).

---

## 0. What runs where

| Host | Serves | Netlify site | Base directory |
| --- | --- | --- | --- |
| `agent.buildclose.app` | `/widget.js` loader + `/embed` chat app | `buildclose-agent` | `apps/agent` |
| `app.buildclose.app` | Staff dashboard | `buildclose-app` | `apps/dashboard` |
| `agency-proposals.com` | The proposal document a prospect reads | `buildclose-proposals` | `apps/proposals` |
| `buildclose.app` | Marketing site | not built | — |

These are **three different origins on purpose**. The assistant must not share an
origin with the dashboard, and the proposal page must hold no staff session. Do not
collapse them.

Backend: 25 Cloud Functions in `us-central1`. Only `api` (prospect API) and
`stripeWebhook` are publicly reachable; the other 23 are authenticated callables.

---

## 1. Prerequisites

```bash
node --version          # >= 20 (functions runtime is nodejs20)
npm install -g firebase-tools
npm install -g netlify-cli
openssl version
```

```bash
git clone https://github.com/TheMarketingMillennial/buildclose.git
cd buildclose
npm ci
```

Local-only alternative to global installs: prefix commands with `npx`, e.g.
`npx firebase --version`.

---

## 2. Authenticate and select the project

```bash
firebase login
firebase use buildclose-d4399
firebase projects:list      # buildclose-d4399 must appear
```

`.firebaserc` already pins `buildclose-d4399` as the default, so `firebase deploy`
targets it without a `--project` flag.

> **Never** point local development at `buildclose-d4399`. Local work uses the
> emulator project `buildclose-dev`, and the dashboard build fails the build if the
> project id and the functions host disagree.

---

## 3. Enable Google Cloud services (one time, in the console)

Open <https://console.firebase.google.com/project/buildclose-d4399>.

1. **Firestore** — create in *production mode*, region `us-central1`.
   Production mode is correct here: the committed rules deny all direct client
   access, and every read/write is mediated by a Cloud Function using the Admin SDK.
2. **Storage** — default bucket, region `us-central1`. The bucket name for this
   project is `buildclose-d4399.firebasestorage.app` (newer `.firebasestorage.app`
   domain, not the legacy `.appspot.com` form). You will pin this name in §5.
3. **Authentication** — enable **Email/Password**. Staff sign in with email and
   password; `{companyId, role}` travel as custom claims.
4. **Upgrade to Blaze (pay as you go)**. Cloud Functions v2 requires Blaze, and the
   scheduled retention job requires Cloud Scheduler, which also requires Blaze.
   **Set a budget alert at a low threshold (e.g. $20) before deploying.**
5. **Confirm Cloud Scheduler is enabled** for the project (it is auto-enabled on
   first scheduled deploy, but verifying avoids a silent no-op for `retentionPurge`).

---

## 4. Set the five secrets

Each command opens an interactive prompt. Type the value there — never pass a secret
as a shell argument, where it lands in your shell history.

```bash
# 1. OpenAI key used by the prospect chat endpoint.
firebase functions:secrets:set OPENAI_API_KEY

# 2. HMAC key for prospect session tokens. Generate a strong value first:
#      openssl rand -base64 48
firebase functions:secrets:set SESSION_SECRET

# 3. One-time gate for creating the first company + admin.
#      openssl rand -hex 16
firebase functions:secrets:set SETUP_CODE

# 4. Stripe TEST secret key (sk_test_...). Do not use a live key.
firebase functions:secrets:set STRIPE_SECRET_KEY

# 5. Stripe webhook signing secret (whsec_...) — created in §12.
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
```

Verify names only (values are never displayed):

```bash
firebase functions:secrets:list
```

### Which function binds which secret

| Function | Secrets |
| --- | --- |
| `api` | `OPENAI_API_KEY`, `SESSION_SECRET` |
| `bootstrapCompany` | `SETUP_CODE` |
| `createCheckoutSession` | `STRIPE_SECRET_KEY` |
| `stripeWebhook` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |

Secrets are bound in `functions/src/index.ts`. Adding a secret that is read in code
but not declared in that binding list yields `undefined` at runtime — this has
already happened once in this codebase and is the reason the list is explicit.

---

## 5. Non-secret configuration

Committed at `functions/.env.buildclose-d4399` and loaded by Firebase at deploy time.
It contains no credentials.

```
CHAT_ORIGIN=https://agent.buildclose.app
DASHBOARD_ORIGIN=https://app.buildclose.app
EMBED_ORIGIN=https://agency-proposals.com
APP_BASE_URL=https://buildclose.app
OPENAI_MODEL=gpt-6.1-sol
```

**Add this line before your first deploy** — see the note below:

```
STORAGE_BUCKET=buildclose-d4399.firebasestorage.app
```

Two things to confirm yourself:

- **`OPENAI_MODEL`** must name a model your OpenAI account can actually access. A
  wrong model name does not fail at deploy time; it fails on the first chat request.
  Prices for each supported model live in `functions/src/lib/pricing.ts`, and the
  version string is stamped onto every `aiUsage` record.
- **`STORAGE_BUCKET`** — if unset, the code falls back to
  `${GCLOUD_PROJECT}.appspot.com`, but this project's bucket is
  `buildclose-d4399.firebasestorage.app`. Setting it explicitly avoids constructing
  download URLs for acceptance-evidence images against the wrong domain. This is
  corrected config, not a code change. **Verify acceptance evidence opens correctly
  in production (§13).**

`EMBED_ORIGIN` is the *default* authorised proposal host. Each access token also
carries its own `allowedOrigins`, so a future customer on their own domain is pinned
per proposal without a redeploy.

---

## 6. Deploy the backend

```bash
npm run build:functions        # catches TypeScript errors before Cloud Build

firebase deploy --only firestore:rules,firestore:indexes,storage
firebase deploy --only functions
```

Index creation runs in the background and commonly takes several minutes; the deploy
command returns before it finishes. Watch Firestore → Indexes in the console.

**Expected: 25 functions created.** If you see fewer, read the `predeploy` output —
`npm --prefix functions run build` runs automatically and a compile error stops the
deploy.

---

## 7. Verify the backend is live

```bash
API=https://us-central1-buildclose-d4399.cloudfunctions.net/api

curl -s $API/api/health
# → {"ok":true,"service":"buildclose","ts":...}

# A foreign origin must receive no CORS allow header.
curl -s -D - -o /dev/null -X POST $API/api/terms \
  -H 'Origin: https://attacker.example' \
  -H 'Content-Type: application/json' -d '{}' | grep -i 'access-control-allow-origin'
# → no output is correct

# No session ⇒ 401, never 500.
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/api/terms \
  -H 'Content-Type: application/json' -d '{}'
# → 401
```

---

## 8. Create your first administrator account

`bootstrapCompany` creates the company, the admin Auth user, and the custom claims in
one call. It refuses to run if **any** company already exists, and it is gated by the
`SETUP_CODE` secret.

**Important, and different from how you might expect:** `bootstrapCompany` does not
require a signed-in caller. It is protected by the setup code plus the empty-database
condition. That is deliberate — there is nobody to authenticate as yet — and it is
why the code must be destroyed immediately afterwards (step 5 below).

```bash
BOOT=https://us-central1-buildclose-d4399.cloudfunctions.net/bootstrapCompany
CODE='<the SETUP_CODE you set in §4>'

curl -s -X POST $BOOT \
  -H 'Content-Type: application/json' \
  -d "{\"data\":{\"code\":\"$CODE\",\"companyName\":\"Your Company\",\"adminEmail\":\"you@yourdomain.com\",\"adminName\":\"Your Name\"}}"
```

Expected response:

```json
{"result":{"companyId":"...","adminUid":"..."}}
```

If the call returns `invalid-argument`, the payload shape is wrong. If it returns
`permission-denied`, the code did not match. If it returns `failed-precondition`, a
company already exists (either from an earlier run or from seeded data).

Then:

1. **Set a password for the admin.** `bootstrapCompany` creates the Auth user without
   one. In the console → Authentication → the new user → *Reset password*, or use
   "Forgot password" on the dashboard once email templates are configured. Until a
   password is set, that account cannot sign in.
2. **Sign in at `https://app.buildclose.app`** once Netlify is deployed (§9). The
   dashboard reads `{companyId, role}` from the ID token; a successful sign-in landing
   on the overview screen proves the claims are present.
3. **Destroy the setup gate.** This is not optional:

```bash
firebase functions:secrets:destroy SETUP_CODE
firebase deploy --only functions:bootstrapCompany
```

After this, `bootstrapCompany` returns `failed-precondition` ("Setup is not enabled")
for every caller, permanently. Additional staff are added from the dashboard's Team
view or with the `inviteStaff` callable, not by bootstrapping again.

### Adding the rest of your team

Sign in as the admin, then Team → invite. Roles are `company_admin`,
`sales_manager`, `sales_rep`. Nobody can grant a role at or above their own, so a
`sales_manager` can create reps but not admins.

---

## 9. Deploy the three Netlify sites

For each site: create the Netlify project, set **Base directory** (the `netlify.toml`
files use paths relative to it), set the environment variables, then deploy.

### Site 1 — `buildclose-agent` → `agent.buildclose.app`

- Base directory: `apps/agent`
- Build command: `node build.mjs`
- Publish directory: `dist`
- Environment:

```
FIREBASE_PROJECT_ID=buildclose-d4399
FUNCTIONS_REGION=us-central1
```

`API_BASE` and `EMBED_FRAME_ANCESTORS` may be left unset: they default to the
production functions host and `https:` respectively. Do not set
`EMBED_FRAME_ANCESTORS=*` — that CSP is the only thing stopping an arbitrary site
from framing the assistant invisibly over its own click targets.

### Site 2 — `buildclose-app` → `app.buildclose.app`

- Base directory: `apps/dashboard`
- Build command: `node build.mjs`
- Publish directory: `.`
- Environment (the build fails loudly if any of the first four is missing):

```
FIREBASE_PROJECT_ID=buildclose-d4399
FIREBASE_API_KEY=AIzaSyBKUWWTyENnUHyCbK4Iq0DeJ7h19GoQwPU
FIREBASE_APP_ID=1:761268855407:web:82c27b93240836a18da39a
FIREBASE_STORAGE_BUCKET=buildclose-d4399.firebasestorage.app
FIREBASE_AUTH_DOMAIN=buildclose-d4399.firebaseapp.com
```

Optional overrides (defaults shown):

```
FUNCTIONS_REGION=us-central1
AGENT_ORIGIN=https://agent.buildclose.app
```

`FIREBASE_API_KEY` is a **public client identifier**, not a credential. It ships in
`config.js` in the browser by design. The security boundary is the default-deny
rules plus the custom-claims check inside every callable.

**Deliberately not wired:** `FIREBASE_MEASUREMENT_ID` and
`FIREBASE_MESSAGING_SENDER_ID`. Enabling the measurement id would load `gtag.js` from
a third party, forcing the dashboard CSP off `script-src 'self'` and putting a
tracker on the surface that renders tenant revenue data. There is no Cloud Messaging
in this application. Do not add them.

### Site 3 — `buildclose-proposals` → `agency-proposals.com`

- Base directory: `apps/proposals`
- Build command: `node build.mjs`
- Publish directory: `dist`
- Environment — **`PROPOSAL_TOKEN` does not exist yet.** Do §11 first, then set:

```
PROPOSAL_TOKEN=bc_pk_...
AGENT_ORIGIN=https://agent.buildclose.app
```

Optional: `PAYMENT_URL` (https only; the payment button is hidden when unset),
`PROPOSAL_SLUG` (default `abrica`).

The build **fails** if `PROPOSAL_TOKEN` is missing or malformed, or if a `__BC_`
placeholder survives substitution — so a broken token cannot silently ship a page
that shows a literal placeholder to a prospect.

### Verify the headers actually shipped

These are the controls; confirm them rather than assuming. Netlify merges matching
rules, which is why the CSP, not `X-Frame-Options`, carries the framing policy.

```bash
curl -s -D - -o /dev/null https://agent.buildclose.app/widget.js | grep -i 'access-control-allow-origin'
# → Access-Control-Allow-Origin: *

curl -s -D - -o /dev/null https://agent.buildclose.app/embed | grep -i 'content-security-policy'
# → must contain frame-ancestors https:

curl -s -D - -o /dev/null https://app.buildclose.app/ | grep -iE 'x-frame-options|content-security-policy'
# → X-Frame-Options: DENY and frame-ancestors 'none'

curl -s -D - -o /dev/null https://agency-proposals.com/proposals/abrica.html | grep -i 'content-security-policy'
# → must contain frame-ancestors 'none' and frame-src https://agent.buildclose.app
```

---

## 10. DNS

Add what Netlify shows for each site. Subdomains are one CNAME each:

```
app.buildclose.app     CNAME  <buildclose-app>.netlify.app
agent.buildclose.app   CNAME  <buildclose-agent>.netlify.app
```

Netlify issues TLS after the CNAME resolves.

**`agency-proposals.com` — do not touch its DNS or hosting yet.** It keeps its
current host until you explicitly authorise the switch. Everything in §12 can be
verified on a Netlify preview URL first.

---

## 11. Mint the prospect token for Abrica

This authorises one prospect to talk to one proposal. Call it as an authenticated
`company_admin` — easiest route is the Firebase console → Functions →
`mintAccessToken` → *Test*, while signed in, or from the dashboard's access-links
view once deployed.

```json
{
  "data": {
    "proposalId": "abrica-stage-one",
    "label": "Hector Abrica — proposal link",
    "expiresInDays": 30,
    "allowedOrigins": ["https://agency-proposals.com"]
  }
}
```

Omit `allowedOrigins` (or pass `[]`) to make the token portable to any host, for a
customer who embeds on a domain you have not pre-registered.

The response contains the plaintext token **once**. Only its SHA-256 hash is stored,
so it cannot be recovered later; if you lose it, revoke it and mint another.

---

## 12. Stripe (test mode only)

1. Stripe dashboard with **Test mode** on → Developers → Webhooks → *Add endpoint*.
2. URL: `https://us-central1-buildclose-d4399.cloudfunctions.net/stripeWebhook`
3. Events: `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`.
4. Copy the `whsec_...` signing secret and re-run `firebase functions:secrets:set
   STRIPE_WEBHOOK_SECRET`, then redeploy `stripeWebhook`.

The code rejects any key that is not `sk_test_` until `NODE_ENV=production`. **Do not
set that variable yet.**

---

## 13. Production smoke tests

Run every line. Each asserts a security property, not just liveness.

```bash
API=https://us-central1-buildclose-d4399.cloudfunctions.net/api
CHAT=https://agent.buildclose.app
TOK=bc_pk_...        # from §11

# --- CORS ---------------------------------------------------------------
curl -s -D - -o /dev/null -X OPTIONS $API/api/terms \
  -H "Origin: $CHAT" -H 'Access-Control-Request-Method: POST' \
  | grep -i 'access-control-allow-origin'
# → Access-Control-Allow-Origin: https://agent.buildclose.app

curl -s -D - -o /dev/null -X OPTIONS $API/api/terms \
  -H 'Origin: https://attacker.example' -H 'Access-Control-Request-Method: POST' \
  | grep -i 'access-control-allow-origin'
# → no output

# --- Token → session ----------------------------------------------------
SESS=$(curl -s -X POST $API/api/bootstrap \
  -H "Origin: $CHAT" -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOK\",\"embedOrigin\":\"https://agency-proposals.com\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).session')

# --- The body cannot redirect the session to another proposal -----------
curl -s -X POST $API/api/terms \
  -H "Origin: $CHAT" -H "Authorization: Bearer $SESS" \
  -H 'Content-Type: application/json' \
  -d '{"proposalId":"some-other-proposal"}' | grep -c 'some-other-proposal'
# → 0

# --- Origin pinning: a foreign origin cannot use this token -------------
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/api/bootstrap \
  -H 'Origin: https://attacker.example' -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOK\"}"
# → 403

# --- Commercial guardrail: no invented discount -------------------------
curl -s -X POST $API/api/chat \
  -H "Origin: $CHAT" -H "Authorization: Bearer $SESS" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Can you do it for 18000?"}' | grep -v '18,000'
# → reply must not contain a new 18,000 offer

# --- Revocation kills the live session ----------------------------------
# Revoke that tokenHash via revokeAccessToken, then:
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/api/terms \
  -H "Origin: $CHAT" -H "Authorization: Bearer $SESS" \
  -H 'Content-Type: application/json' -d '{}'
# → 401

# --- Rate limiting ------------------------------------------------------
for i in $(seq 1 40); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST $API/api/bootstrap \
    -H "Origin: $CHAT" -H 'Content-Type: application/json' \
    -d '{"token":"bc_pk_'"$(openssl rand -hex 24)"'"}'
done; echo
# → a 429 appears within the run
```

### Browser checks (cannot be done with curl)

1. Open the proposal page. The assistant launcher appears.
2. Open it and confirm a reply arrives.
3. In DevTools → Elements, inspect the `<iframe>`: its `src` must **not** contain
   `bc_pk_`. The token is delivered by `postMessage` after the origin handshake.
4. Accept the proposal. The acceptance record must appear in the dashboard with the
   correct document version and hash.
5. Change a commercial term, re-publish, and confirm the previous acceptance flips to
   `superseded`.
6. Open an acceptance's evidence image to confirm the storage bucket name is right
   (§5).

---

## 14. Publishing the Abrica proposal privately

Until the go-live gate is cleared, publish it where only you can reach it.

1. **Deploy to a preview URL, not production.** Netlify's draft deploy gives a
   random URL that is not indexed and is not linked from anywhere:

```bash
cd apps/proposals && netlify deploy --dir dist
```

2. **Give the draft a Netlify password** (Site configuration → Access control →
   Password protection) if you are sending it to anyone before approval.
3. **Keep the token pinned** to `https://agency-proposals.com` — the destination
   origin. When you test on the preview URL, mint a *separate* short-lived token
   pinned to that preview origin rather than unpinning the real one. Widening a pin
   to test is how a token ends up usable on a host you did not intend.
4. `robots.txt` / noindex: the proposal page is `Cache-Control: no-store` and is not
   linked publicly, but for pre-launch use add a `Disallow: /` `robots.txt` in
   `apps/proposals` if the preview URL will be shared.
5. **Only when every gate in §15 is signed off**, and only with explicit
   authorisation for the DNS change, promote with `netlify deploy --prod --dir dist`
   and move the `agency-proposals.com` DNS.

---

## 15. Go-live gate

Do not release the proposal publicly until every line is true:

- [ ] All 25 functions deployed; `api/api/health` returns `ok`
- [ ] Every smoke test in §13 matches, including 403 on a foreign origin and 401 after
      revocation
- [ ] Headers verified on all three sites (§9)
- [ ] Browser handshake verified: token absent from the iframe `src`, assistant
      replies, acceptance recorded, `superseded` on term change
- [ ] Acceptance evidence image opens (confirms `STORAGE_BUCKET`)
- [ ] `SETUP_CODE` destroyed and `bootstrapCompany` now refuses
- [ ] Stripe is in test mode and the webhook signature verifies
- [ ] You have read `docs/PRODUCTION-READINESS.md` and accepted the unverified items
- [ ] You have reviewed the prospect experience and approved it

---

## 16. Rollback

Functions are not versioned by Firebase Hosting channels. To roll back, redeploy a
previous commit:

```bash
git checkout <previous-sha>
npm run build:functions
firebase deploy --only functions
```

Static sites roll back in the Netlify UI: *Deploys* → select the previous successful
deploy → *Publish deploy*. That is instant and does not require a rebuild.

Rules roll back the same way as functions (`firebase deploy --only
firestore:rules,storage` from the older commit).

**Emergency revocation of one prospect:** call `revokeAccessToken` with that token's
hash. Live sessions die on their next request because token state is re-checked per
request rather than trusted from the session.

**Emergency stop for the whole assistant:** set `CHAT_ORIGIN` to a value no real
origin can match and redeploy `api`. Every browser call then fails CORS. This is
blunt but takes effect immediately and does not require a code change.

**Rotating `SESSION_SECRET`** invalidates every live prospect session at once; the
widget shows "please request a new link". Rotating `OPENAI_API_KEY` is invisible to
prospects.

---

## 17. Operational notes

- **Cost.** `api` is capped at 10 instances, everything else at 20, each at 512 MiB
  with a 60 s timeout. Each company carries a monthly `aiBudgetUsd` (default $25)
  enforced before every model call. Retention job timeout is 540 s.
- **Retention.** `retentionPurge` runs daily at 03:00 UTC. It deletes messages and
  inferred insights, tombstones the conversation, and preserves acceptances, events,
  audit log, and AI usage. It is idempotent with `retryCount: 0`. A company admin can
  only purge their own tenant; `platform_admin` may target any tenant.
- **Audit.** Every state change appends to `auditLog` with the actor and company.
- **Secrets you must never commit:** `OPENAI_API_KEY`, `SESSION_SECRET`,
  `SETUP_CODE`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PROPOSAL_TOKEN`.
  `.gitignore` already excludes `.env.local`, `.secret.local`, `apps/*/config.js`,
  `apps/*/dist/`, `seed/.seeded.json`, and `seed/.local-token.json`.
