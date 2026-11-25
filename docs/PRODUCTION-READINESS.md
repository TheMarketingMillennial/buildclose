# BuildClose — Production Readiness Report

Date: 2026-11-25
Code revision: **`39a97c4`** (`main`)
Firebase project: `buildclose-d4399` · Region: `us-central1`

**Status: READY FOR DEPLOYMENT — NOT DEPLOYED.**
No public deployment has occurred. Production behaviour is unverified by definition;
this report separates what was proven locally from what only production can confirm.

---

## 1. Verdict

The application is ready to be deployed by you, following `docs/RUNBOOK.md`. The
authorisation boundary, tenant isolation, commercial guardrail, acceptance evidence
chain, and retention behaviour all pass against a real emulated Firebase with real ID
tokens carrying real custom claims — 113 test cases, 113 passing, on the revision
being handed off.

Two configuration items must be set correctly at deploy time or a feature will
misbehave in a way that testing cannot catch. Both are called out in §4.

---

## 2. What is verified locally

| Suite | Cases | Result |
| --- | --- | --- |
| unit | 19 | 19/19 |
| middleware | 8 | 8/8 |
| Firestore/Storage rule denial | 9 | 9/9 |
| integration | 27 | 27/27 |
| retention | 11 | 11/11 |
| browser E2E (Playwright, cross-origin) | 10 | 10/10 |
| authenticated dashboard | 29 | 29/29 |

Proven, with evidence in `tests/TEST-RESULTS.md`:

- **Authorisation.** Every staff callable rejects an anonymous call and a malformed
  token. Role checks are enforced in function code, not in the client.
- **Role boundaries.** A `sales_rep` can create a proposal but cannot set commercial
  authority, cannot edit the internal record or assistant after creation, cannot read
  the team or the audit trail, and cannot read another rep's proposal (reported as
  not-found). A `sales_manager` can configure the assistant but cannot manage the
  team and cannot grant a role at or above its own.
- **Tenant isolation.** Cross-tenant proposal, list, analytics, conversations, and
  audit reads all fail, and they fail as **404, never 403** — a 403 would confirm the
  record exists and leak its existence across tenants.
- **Fixtures cannot reach production.** The guard fails closed on an unset or
  unrecognised project id and treats `buildclose-d4399` as explicitly forbidden, and
  it also requires the Firestore and Auth hosts to be localhost.
- **Commercial guardrail.** The chat endpoint does not concede an unauthorised
  discount, and a correct refusal is not mistaken for one.
- **Acceptance chain.** Bootstrap → terms (identity + retention disclosure) → accept
  (201, document version + canonical hash) → analytics shows the record → a changed
  document hash makes a stale accept return 409 → revocation makes the next bootstrap
  return 401.
- **Origin pinning.** A token pinned to one origin is refused on another.
- **Revocation.** Live sessions die on the next request, because token state is
  re-checked per request rather than trusted from the session.
- **Iframe handshake, in a real browser, cross-origin.** The token never enters the
  iframe `src`; it crosses by `postMessage` after the origin handshake.
- **Retention.** Purge deletes messages and inferred insights, tombstones the
  conversation, preserves acceptances/events/audit/aiUsage, clamps below a 30-day
  floor, and refuses cross-tenant purge by a company admin.
- **Direct client access is denied.** Firestore and Storage rules deny every
  unauthenticated and forged-token read and write, including subcollections.

---

## 3. What is NOT verified — production-only unknowns

These cannot be verified without a deploy. Each is a checklist item in RUNBOOK §13/§15.

1. **Cloud Functions cold start and real latency.** Emulator timing says nothing
   about Cloud Run.
2. **OpenAI model availability.** `OPENAI_MODEL=gpt-6.1-sol` must be a model your
   OpenAI account can access. **A wrong value fails on the first chat request, not at
   deploy time.** Confirm before releasing the link. Local tests used a stub.
3. **Real token accounting and cost.** `aiUsage` pricing is computed from a
   committed price table; actual billed cost against your OpenAI account is unverified.
4. **Cloud Scheduler firing `retentionPurge`.** The schedule (daily 03:00 UTC) has
   never fired in production. The job logic is tested; the trigger is not. Confirm a
   first successful run in the Cloud Scheduler console after deploy.
5. **Firestore composite index build.** All queries use declared indexes in
   `firestore.indexes.json`, but the emulator does not enforce index availability the
   way production does. A missing index appears as a `FAILED_PRECONDITION` at query
   time. Watch Firestore → Indexes until every index is *Enabled*.
6. **Netlify header delivery.** `_headers` is generated per build and is verified
   only as generated output locally, not as delivered by Netlify's CDN. Must be
   checked with `curl` against the live hosts (RUNBOOK §9).
7. **DNS and TLS.** No records have been created. CNAME propagation and Netlify's
   certificate issuance are unverified.
8. **Stripe end-to-end.** Test-mode checkout and webhook signature verification have
   not been exercised against Stripe's live test infrastructure.
9. **Real `agency-proposals.com` embed.** The production proposal page has not been
   loaded from its real origin with a production-pinned token.
10. **PDF/proposal upload path**, if used, is untested in production.
11. **Email deliverability** for password resets depends on Firebase Auth email
    templates, which have not been configured or tested.
12. **Cross-browser behaviour.** Playwright ran Chromium only. Safari and Firefox,
    particularly around the sandboxed iframe and `postMessage`, are unverified.
13. **Load and concurrency.** Instance caps (10 for `api`, 20 elsewhere) have never
    been exercised.

---

## 4. Configuration that must be right at deploy time

Two items are correctness-critical and would not be caught by the test suite:

1. **`STORAGE_BUCKET`** must be set to `buildclose-d4399.firebasestorage.app` in
   `functions/.env.buildclose-d4399`. If unset, the code falls back to
   `<project>.appspot.com`, which is the wrong domain for this project, and the
   download URLs built for acceptance-evidence images will point at a bucket that
   does not exist. **Verify an acceptance evidence image opens after your first
   acceptance** (RUNBOOK §13, browser check 6).

2. **`OPENAI_MODEL`** must name a model your account can access, and it must be one
   present in `functions/src/lib/pricing.ts`, otherwise cost accounting for that
   model has no price row. A wrong name fails at request time, not deploy time.

Also correctness-critical, but already handled by the build: the dashboard build
refuses to emit a config whose project id and functions host point at different
environments.

---

## 5. Security posture summary

| Control | State |
| --- | --- |
| Firestore direct client access | Denied by rules (default-deny), tested |
| Storage direct client access | Denied by rules, tested |
| Tenancy source of truth | Custom claims, never the request body |
| Cross-tenant reads | 404, never 403 |
| Prospect token at rest | SHA-256 only; plaintext shown once |
| Token in iframe URL | Never — `postMessage` after origin handshake |
| Token in shareable link | Yes, by design (capability URL) |
| Per-token origin pinning | Enforced server-side |
| Session revocation | Per-request re-check, immediate |
| Rate limiting | Firestore fixed window, fails closed |
| Internal commercial data | Separate collection, no client read path |
| Accepted-evidence integrity | Canonical document hash bound to version |
| Setup gate | `SETUP_CODE` secret — **must be destroyed after onboarding** |
| Prompt injection | Delimited data blocks, treated as data |
| Audit | Append-only log per company |

### Residual risks, stated plainly

- **The shareable link is a credential.** Anyone with `/p/<token>` can talk to that
  proposal until the token is revoked or expires. That is the intended design of a
  capability URL, but it means link distribution is the security boundary. Use a
  short `expiresInDays` for pre-approval sharing, and revoke after.
- **`bootstrapCompany` is code-protected, not identity-protected.** It must be
  callable before any user exists. After onboarding, destroy `SETUP_CODE`; until you
  do, anyone who learns the code and reaches the function before you create your
  company can create theirs.
- **Email/password staff auth.** There is no MFA, no SSO, and no email verification
  requirement. Accounts are provisioned by an admin, so the exposure is limited to
  password strength and reset-email deliverability. Worth a follow-up decision, not a
  blocker for a private pilot.
- **Stripe is test mode.** No live payment path exists yet, by design.

---

## 6. Handoff checklist

Before you begin: `docs/CONFIGURATION.md` lists every variable, separated into
confidential credentials and public configuration.

1. Enable Firestore, Storage, Email/Password auth, Blaze + budget alert, Cloud
   Scheduler — RUNBOOK §3.
2. Set five secrets — RUNBOOK §4.
3. Add `STORAGE_BUCKET` to the functions env file, confirm `OPENAI_MODEL` —
   RUNBOOK §5.
4. Deploy rules, indexes, storage, then functions. Expect **25 functions** —
   RUNBOOK §6.
5. Verify `api/api/health` and the CORS posture — RUNBOOK §7.
6. Bootstrap your admin, set its password, then **destroy `SETUP_CODE`** —
   RUNBOOK §8.
7. Deploy the three Netlify sites and verify the shipped headers — RUNBOOK §9.
8. DNS for the two subdomains; leave `agency-proposals.com` alone — RUNBOOK §10.
9. Mint the Abrica token as a `company_admin` — RUNBOOK §11.
10. Configure the Stripe test webhook — RUNBOOK §12.
11. Run the full smoke suite, including the browser checks — RUNBOOK §13.
12. Publish the proposal privately via a Netlify draft deploy — RUNBOOK §14.
13. Sign off the go-live gate — RUNBOOK §15.

Do not release the proposal publicly until every line in RUNBOOK §15 is true.

---

## 7. Recommended post-deploy follow-ups

Not blockers; ordered by value.

1. Confirm the retention job's first scheduled run actually fired.
2. Decide on MFA or SSO for staff accounts.
3. Add Firefox and Safari to the browser E2E matrix.
4. Configure Firebase Auth email templates for password reset.
5. Obtain an independent review of `firestore.rules` and `storage.rules` before
   onboarding a second tenant — the current posture is default-deny, which is the
   safe default, but rules are the kind of file where a second pair of eyes pays.
6. Move the sandbox-bound test suites to CI with enough memory to run them
   unbatched; the nine-batch workaround exists only because of this sandbox's 2 GB.
