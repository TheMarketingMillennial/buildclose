# BuildClose — Deployment & Credential Runbook

Firebase project: **buildclose-d4399**
Region: **us-central1**
Repository: `TheMarketingMillennial/buildclose`

This document is written for execution **on your own machine**. Deployment
requires an interactive `firebase login`, which cannot run inside a sandbox, so
every step here is a command you run locally with your own credentials.

**Nothing in this document requires you to paste a secret into any chat.** Every
secret is entered at a `firebase functions:secrets:set` prompt, which writes it
to Google Secret Manager and never to the repository.

---

## 0. Domain architecture

| Host | Purpose | Hosted on |
|---|---|---|
| `buildclose.app` | Commercial website | Netlify (site `buildclose-web`) |
| `app.buildclose.app` | Customer dashboard (staff) | Netlify (site `buildclose-app`) |
| `agent.buildclose.app` | AI assistant infrastructure (`/widget.js`, `/embed`) | Netlify (site `buildclose-agent`) |
| `agency-proposals.com` | Client-facing proposal hosting | Existing host — **do not change DNS until authorized** |

Requirement 3 depends on `agent.` and `app.` being **different origins**. Do not
collapse them onto one hostname.

---

## 1. Prerequisites

Install on your machine:

```bash
# Node 20 or newer (functions runtime is nodejs20)
node --version    # must be >= 20

# Firebase CLI
npm install -g firebase-tools
firebase --version   # 13.x or newer

# Netlify CLI (for the three static sites)
npm install -g netlify-cli

# openssl, for generating secrets locally
openssl version
```

Then clone and install:

```bash
git clone https://github.com/TheMarketingMillennial/buildclose.git
cd buildclose
npm ci
```

---

## 2. Authenticate Firebase

```bash
firebase login
firebase use buildclose-d4399
firebase projects:list      # confirm buildclose-d4399 appears
```

`firebase use` is what selects the project; `.firebaserc` already pins the
default to `buildclose-d4399`, so `firebase deploy` will target it without a
`--project` flag.

---

## 3. Enable Google Cloud services (one-time, in the console)

Open <https://console.firebase.google.com/project/buildclose-d4399> and enable:

1. **Firestore Database** — create in *production mode*, region `us-central1`.
   Production mode is correct: the committed rules deny all direct client access,
   and every read/write is mediated by Cloud Functions using the Admin SDK.
2. **Storage** — default bucket, region `us-central1`.
3. **Authentication** — enable the **Email/Password** provider. Staff sign in
   with email + password; custom claims carry `{companyId, role}`.
4. **Upgrade to Blaze (pay as you go)**. Cloud Functions v2 requires it. Set a
   budget alert at a low threshold (e.g. $20) before deploying.

---

## 4. Set secrets

Run each command below. Each opens an interactive prompt — type the value there.
Never pass a secret as a shell argument (it lands in your shell history).

```bash
# 1. OpenAI API key — used by the prospect chat endpoint.
firebase functions:secrets:set OPENAI_API_KEY

# 2. Session signing secret — HMAC key for prospect session tokens.
#    Generate a strong value first, then paste it at the prompt:
#      openssl rand -base64 48
firebase functions:secrets:set SESSION_SECRET

# 3. Setup code — one-time gate for creating the first company + admin.
#    Any random string of 8+ characters. Delete this secret after step 9.
#      openssl rand -hex 16
firebase functions:secrets:set SETUP_CODE

# 4. Stripe TEST secret key (starts with sk_test_). Never use a live key yet.
firebase functions:secrets:set STRIPE_SECRET_KEY

# 5. Stripe webhook signing secret (starts with whsec_) — created in step 10.
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
```

Verify without revealing values:

```bash
firebase functions:secrets:list
```

You should see all five names. Values are never displayed.

### Which function uses which secret

| Function | Secrets bound |
|---|---|
| `api` | `OPENAI_API_KEY`, `SESSION_SECRET` |
| `bootstrapCompany` | `SETUP_CODE` |
| `createCheckoutSession` | `STRIPE_SECRET_KEY` |
| `stripeWebhook` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |

Only `api` is internet-exposed. The rest are authenticated callables.

---

## 5. Non-secret configuration

Committed at `functions/.env.buildclose-d4399` and loaded automatically by
Firebase at deploy time. It contains **no credentials** — only origins and model
selection. Current contents:

```
CHAT_ORIGIN=https://agent.buildclose.app
DASHBOARD_ORIGIN=https://app.buildclose.app
EMBED_ORIGIN=https://agency-proposals.com
APP_BASE_URL=https://buildclose.app
OPENAI_MODEL=gpt-6.1-sol
```

Notes:

- `EMBED_ORIGIN` is the **authorized proposal host** — where proposal pages with
  the widget live. Per-proposal origins are set individually when minting a token
  (see step 11), so a future customer on their own domain does not require a
  redeploy.
- `OPENAI_MODEL` must name a model your OpenAI account can access. Confirm before
  deploying; a wrong model name fails at request time, not at deploy time.
- To change an origin, edit this file and redeploy. No secret handling involved.

---

## 6. Deploy the backend

```bash
# Compile first — catches TypeScript errors before they reach Cloud Build.
npm run build:functions

# Firestore rules (default-deny), indexes, and storage rules
firebase deploy --only firestore:rules,firestore:indexes,storage

# Cloud Functions
firebase deploy --only functions
```

Index creation can take several minutes. The deploy command returns before
indexes finish building; check status in the console under Firestore → Indexes.

### Expected deploy output

22 functions should be created. If you see fewer, check for a compile error in
the `predeploy` step (`npm --prefix functions run build`), which runs
automatically.

---

## 7. Verify the backend

Confirm the public endpoint is live and returns no internals:

```bash
API=https://us-central1-buildclose-d4399.cloudfunctions.net/api

curl -s $API/api/health
# → {"ok":true,"service":"buildclose","ts":...}

# A foreign origin must NOT receive an Access-Control-Allow-Origin header.
curl -s -D - -o /dev/null -X POST $API/api/terms \
  -H 'Origin: https://attacker.example' \
  -H 'Content-Type: application/json' -d '{}' \
  | grep -i 'access-control-allow-origin'
# → (no output = correct)

# No session ⇒ 401, and never a 500.
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/api/terms \
  -H 'Content-Type: application/json' -d '{}'
# → 401
```

---

## 8. Deploy the three static sites

Each site has its own Netlify project. **Set the Base directory** in Netlify;
the `netlify.toml` files use `publish = "."` because they resolve relative to it.

### Site 1 — `agent.buildclose.app` (chatbot infrastructure)

- Netlify site name: `buildclose-agent`
- Base directory: `apps/agent`
- Build command: `node build.mjs`
- Environment: `FIREBASE_PROJECT_ID=buildclose-d4399`, `FUNCTIONS_REGION=us-central1`

```bash
cd apps/agent && netlify deploy --prod --dir .
```

### Site 2 — `app.buildclose.app` (dashboard)

- Netlify site name: `buildclose-app`
- Base directory: `apps/dashboard`
- Build command: `node build.mjs`
- Environment (all required — the build fails loudly if any is missing):
  - `FIREBASE_PROJECT_ID=buildclose-d4399`
  - `FIREBASE_API_KEY` (Firebase console → Project settings → Web apps)
  - `FIREBASE_APP_ID`

```bash
cd apps/dashboard && netlify deploy --prod --dir .
```

`FIREBASE_API_KEY` is a public client identifier, not a credential. It ships in
the browser by design. The security boundary is the default-deny Firestore rules
plus the custom-claims check inside each callable.

### Site 3 — `buildclose.app` (commercial site)

Static marketing site. Not yet built; deploy whenever the content is ready.

### DNS

Add the records Netlify shows for each site. For subdomains this is a single
`CNAME` per host:

```
app.buildclose.app     CNAME  <site>.netlify.app
agent.buildclose.app   CNAME  <site>.netlify.app
```

Netlify provisions the TLS certificate after the CNAME resolves.

### Verify the headers actually shipped

The prospects' protection depends on these; confirm them rather than assuming:

```bash
curl -s -D - -o /dev/null https://agent.buildclose.app/widget.js | grep -i 'access-control-allow-origin'
# → Access-Control-Allow-Origin: *

curl -s -D - -o /dev/null https://agent.buildclose.app/embed | grep -i 'content-security-policy'
# → must contain frame-ancestors https:

curl -s -D - -o /dev/null https://app.buildclose.app/ | grep -iE 'x-frame-options|content-security-policy'
# → X-Frame-Options: DENY  and  frame-ancestors 'none'
```

---

## 9. Create the first company and admin

This runs once. `bootstrapCompany` refuses if any company already exists.

1. In the Firebase console → Authentication → Users → **Add user**. Enter the
   admin email and a strong password.
2. Copy that user's **UID**.
3. Call the function. The easiest route is the Functions emulator shell or a
   short Node script using the Firebase Admin SDK; from the console you can also
   use the "Test" tab on the `bootstrapCompany` function.

```js
// save as bootstrap.mjs and run: node bootstrap.mjs
// Requires GOOGLE_APPLICATION_CREDENTIALS to point at a service-account key
// with the "Cloud Datastore User" + "Firebase Authentication Admin" roles.
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFunctions } from 'firebase-admin/functions';

// Alternatively use the Firebase console's callable "Test" panel — it is simpler
// and avoids handling a service-account key at all.
```

Because handling a service-account key is the riskiest part of this step, use the
**console route**: Firebase console → Functions → `bootstrapCompany` → *Test*,
and send:

```json
{
  "data": {
    "code": "<the SETUP_CODE you set in step 4>",
    "companyName": "Abrica Demo",
    "adminEmail": "you@example.com",
    "adminName": "Your Name"
  }
}
```

The callable requires an authenticated staff identity, so sign in first — or run
it from the dashboard once the login screen exists. If it returns
`unauthenticated`, that is the expected behaviour for an anonymous call.

4. Set the admin's custom claims so every callable recognises the tenant. In the
   console → Authentication → the user → *Custom claims*, or via a one-off Admin
   SDK script:

```json
{ "companyId": "<companyId returned by bootstrapCompany>", "role": "company_admin" }
```

5. **Revoke the setup gate.** Delete the secret so the endpoint cannot be called
   again:

```bash
firebase functions:secrets:destroy SETUP_CODE
firebase deploy --only functions:bootstrapCompany
```

---

## 10. Stripe (test mode only)

1. In the Stripe dashboard with **Test mode** enabled → Developers → Webhooks →
   *Add endpoint*.
2. URL:
   `https://us-central1-buildclose-d4399.cloudfunctions.net/stripeWebhook`
3. Events to send:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. Copy the signing secret (`whsec_…`) and re-run step 4 for
   `STRIPE_WEBHOOK_SECRET`.

The code rejects anything that is not `sk_test_` until `NODE_ENV=production`.
Do not set that variable yet.

---

## 11. Mint the Abrica prospect token

This is what authorizes one specific prospect to talk to one specific proposal.

Call `mintAccessToken` as an authenticated `company_admin` (console *Test* panel
again, signed in as the admin):

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

`allowedOrigins` pins this token to the authorized proposal host. Omit it (or
pass `[]`) to make the token portable to any host — useful for a customer who
embeds on a domain you have not pre-registered.

The response contains the plaintext token **once**. It is stored only as a
SHA-256 hash, so it cannot be recovered later. Place it in the proposal page as:

```html
<script src="https://agent.buildclose.app/widget.js"
        data-bc="bc_pk_…"
        defer></script>
```

---

## 12. Production smoke tests

Run these against the deployed backend. Each asserts a security property, not
just liveness.

```bash
API=https://us-central1-buildclose-d4399.cloudfunctions.net/api
TOK=bc_pk_...   # from step 11

# --- CORS: the chat origin is allowed, everyone else is not -----------------
CHAT=https://agent.buildclose.app

curl -s -D - -o /dev/null -X OPTIONS $API/api/terms \
  -H "Origin: $CHAT" -H 'Access-Control-Request-Method: POST' \
  | grep -i 'access-control-allow-origin'
# → Access-Control-Allow-Origin: https://agent.buildclose.app

curl -s -D - -o /dev/null -X OPTIONS $API/api/terms \
  -H 'Origin: https://attacker.example' -H 'Access-Control-Request-Method: POST' \
  | grep -i 'access-control-allow-origin'
# → (no output)

# --- Auth: a token exchanges for a session; nothing internal comes back -----
SESS=$(curl -s -X POST $API/api/bootstrap \
  -H "Origin: $CHAT" -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOK\",\"embedOrigin\":\"https://agency-proposals.com\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).session')

# --- Tenant isolation: body cannot redirect the session to another proposal -
curl -s -X POST $API/api/terms \
  -H "Origin: $CHAT" -H "Authorization: Bearer $SESS" \
  -H 'Content-Type: application/json' \
  -d '{"proposalId":"some-other-proposal"}' \
  | grep -c 'some-other-proposal'
# → 0 (the body is ignored; the session decides)

# --- Commercial guardrail: an invented discount is blocked -----------------
curl -s -X POST $API/api/chat \
  -H "Origin: $CHAT" -H "Authorization: Bearer $SESS" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Can you do it for 18000?"}' \
  | grep -v '18,000'
# → reply must NOT contain an 18,000 offer

# --- Revocation: revoke, then confirm the live session dies ----------------
# Revoke via the mintAccessToken response's tokenHash, calling revokeAccessToken
# in the console, then:
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/api/terms \
  -H "Origin: $CHAT" -H "Authorization: Bearer $SESS" \
  -H 'Content-Type: application/json' -d '{}'
# → 401

# --- Rate limiting: hammer bootstrap and expect a 429 ---------------------
for i in $(seq 1 40); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST $API/api/bootstrap \
    -H "Origin: $CHAT" -H 'Content-Type: application/json' \
    -d '{"token":"bc_pk_'"$(openssl rand -hex 24)"'"}'
done; echo
# → a 429 appears within the run
```

Sign off only when every line above matches.

---

## 13. Abrica go-live gate

Do **not** publish the proposal until all of these are true:

- [ ] Every check in step 12 passes against the deployed backend
- [ ] Headers verified in step 8 (`frame-ancestors`, `X-Frame-Options`)
- [ ] The iframe handshake works in a real browser: the token never appears in a
      URL, and the assistant replies
- [ ] You have reviewed the prospect experience and approved it

Until then the proposal stays unpublished and no token is distributed.

---

## 14. Operational notes

**Rotating a secret.** Re-run `functions:secrets:set <NAME>`, then redeploy the
function that binds it. Rotating `SESSION_SECRET` invalidates every live prospect
session immediately — they receive `401` and the widget shows "please request a
new link". Rotating `OPENAI_API_KEY` is otherwise invisible to prospects.

**Revoking one prospect.** Call `revokeAccessToken` with that token's hash.
Live sessions stop working on their next request, because token state is
re-checked per request rather than trusted from the session.

**Rolling back.** `firebase hosting:channel` does not apply to Functions. To roll
back, check out the previous commit and redeploy:

```bash
git checkout <previous-sha>
firebase deploy --only functions
```

**Cost control.** `api` is capped at 10 instances and the others at 20, and each
company has a monthly AI budget (`aiBudgetUsd`) enforced before every model call.

**Emulator workflow.** `npm run emu` starts auth, Firestore, Storage and
Functions locally; `npm run emu:seed` builds and seeds the Abrica demo data.
Never point local development at `buildclose-d4399`.
