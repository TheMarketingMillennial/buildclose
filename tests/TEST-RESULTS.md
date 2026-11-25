# Test results log

Batched runs against the local emulator (`buildclose-dev`). Suites are run in
small batches and the emulator is restarted between them because this sandbox has
1991 MB of memory and the Firebase emulator stack alone needs a large share of it.

Keep this file updated after each batch so progress survives a sandbox reset.

## Four product fixes (found during task 4, all in commit 89a5318 or later)

| # | Fix | Runtime verified |
|---|-----|------------------|
| 1 | `ProposalInternalInput` priceFloor/maxDiscount now `.default(0)` so createProposal stops throwing ZodError | YES (probe: create ok) |
| 2 | `createProposal` applies `companyId` after parse so the internal record is tenant-stamped (prospect path no longer 404s) | YES (probe: `internal present: true`) |
| 3 | `createProposal` requires `CONFIG_ROLES` when an internal/agent block is supplied (rep can no longer self-grant discount authority) | YES (batch 1) |
| 4 | `UpdateInput.proposal` is `.optional()` so the dashboard can save assistant config without resending the whole proposal | YES (batch 1) |

## Batch history

### Batch 0 (full suite, pre-reset) — ABANDONED
Emulator starved and died mid-suite; remaining tests failed with `fetch failed`.
Not a code signal. Superseded by batched runs.

### Batch 1 — PASS 3/3
Pattern: `updates assistant configuration|may create a proposal but may not set|may configure the assistant but may not manage`
- ok updates assistant configuration and persists it  (fix 4)
- ok may configure the assistant but may not manage the team
- ok may create a proposal but may not set commercial authority  (fix 3)

Note: an earlier attempt at this batch failed with "Invalid update payload"
because `proposalId` was assigned inside a test body that
`--test-name-pattern` skipped. Fixed by creating the shared proposal in
`before()`; the lifecycle test now uses a local id.

### Batch 2 — PASS 4/4
Pattern: `mints a token|records a prospect acceptance|refuses an acceptance whose document hash|revokes the link`
- ok mints a token, storing only its hash and honouring the origin pin
- ok records a prospect acceptance end to end through the minted link
- ok refuses an acceptance whose document hash is stale (409)
- ok revokes the link and the next bootstrap is refused (401 token_revoked)

Full prospect path proven end to end through a dashboard-minted link:
bootstrap -> terms (identity + retention disclosure) -> accept 201 ->
analytics shows the acceptance record -> hash change makes a stale accept 409 ->
revoke makes bootstrap 401.

Also fixed: the shared proposal is created in the top-level `before()` and the
access-link mint moved to a block-level `before()`, so every batch is
self-sufficient under `--test-name-pattern`.
