# Plan 003: Integration-test the approve→send money path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ad6b760..HEAD -- "mailbox/dashboard/app/api/drafts/[id]/approve/" mailbox/dashboard/lib/transitions.ts mailbox/dashboard/lib/n8n.ts mailbox/dashboard/test/`
> On any mismatch with the excerpts below, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (test-only change, but fetch-mocking can be brittle)
- **Depends on**: plans/001-root-ci-gate.md (so the new test actually runs on PRs)
- **Category**: tests
- **Planned at**: commit `ad6b760`, 2026-06-11

## Why this matters

Clicking "approve" in the queue sends a real email to a real customer contact:
the route flips the draft to `approved` and fires the n8n send webhook. This
is the single highest-stakes path in the product, and it has **no test**: the
vitest suite covers auto-send rule evaluation and finalize, but nothing
exercises `POST /api/drafts/[id]/approve` → `transitionToApprovedAndSend` →
`triggerSendWebhook`, nor the failure contract (webhook 5xx must leave the row
at `approved` with `error_message` persisted — per STAQPRO-271 and the
2026-05-08 double-send incident writeup referenced in code comments).

## Current state

- `mailbox/dashboard/app/api/drafts/[id]/approve/route.ts` — thin route
  (excerpt, verbatim):
  ```ts
  return transitionToApprovedAndSend(p.data.id, {
    fromStates: ['pending', 'edited'],
    fromStatesLabel: 'pending or edited',
    clearError: true,
    routeName: 'approve',
  });
  ```
- `mailbox/dashboard/lib/transitions.ts:39` — `transitionToApprovedAndSend`.
  Step 1 CAS-updates the row status (409 if not in `fromStates`); step 2 calls
  `triggerSendWebhook(id, provider)` (line 120). On webhook failure (excerpt):
  ```ts
  const errMsg = webhookResult.error ?? 'Send webhook failed (no detail)';
  // best-effort persist to drafts.error_message, then:
  return NextResponse.json({ success: false, draft_id: id, error: errMsg }, { status: 502 });
  ```
  Note: the row stays `approved` on webhook failure — this is **by design**
  (comment: "Send-side errors now leave the row at 'approved'; the retry route
  handles operator-driven recovery"). Tests must assert that, not "rollback".
- `mailbox/dashboard/lib/n8n.ts:74` — `triggerSendWebhook(id, provider)` does
  an HTTP `fetch` to the n8n webhook URL (provider-routed: gmail →
  mailbox-send, imap → mailbox-imap-send). Read this function fully before
  writing mocks — confirm it uses global `fetch` and which env var holds the
  webhook base URL (the compose file sets `N8N_WEBHOOK_URL: http://n8n:5678/webhook/mailbox-send`).
- Test infrastructure:
  - `test/helpers/db.ts` — `HAS_DB` gate (skips DB suites without
    `TEST_POSTGRES_URL`), `seedDraft`, `getDraftStatus`, `getLatestTransition`,
    `fakeRequest`, `getTestPool`, `closeTestPool`.
  - `test/routes/auto-send.test.ts` — the structural exemplar: imports route
    handlers directly, uses `dbDescribe = HAS_DB ? describe : describe.skip`,
    cleans tables in `beforeEach`/`afterEach`, notes that vitest runs files
    serially (`fileParallelism: false`).
  - vitest is the runner: `npm test` (in `mailbox/dashboard`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `cd mailbox/dashboard && npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Run just this suite | `TEST_POSTGRES_URL=postgresql://mailbox:mailbox@localhost:5432/mailbox npm test -- drafts-approve` | all pass |
| Full suite | `npm test` (same env) | all pass |

(If no local Postgres: start one with the same image CI uses —
`docker run -d --rm -p 5432:5432 -e POSTGRES_USER=mailbox -e POSTGRES_PASSWORD=mailbox -e POSTGRES_DB=mailbox postgres:17-alpine`,
then `PGPASSWORD=mailbox psql -h localhost -U mailbox -d mailbox -f test/fixtures/schema.sql`.)

## Scope

**In scope**:
- `mailbox/dashboard/test/routes/drafts-approve.test.ts` (create)
- `mailbox/dashboard/test/helpers/db.ts` — only if a small helper addition is
  genuinely needed (prefer not to touch it)

**Out of scope**:
- `lib/transitions.ts`, `lib/n8n.ts`, the approve/retry routes — this plan
  adds tests for current behavior; it does NOT change behavior. If a test
  reveals a real bug, STOP and report.
- n8n workflow JSON.

## Git workflow

- Branch: `test/drafts-approve-route`
- One commit: `test(dashboard): integration-test approve→send transition + webhook failure contract`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Read the two load-bearing functions

Read `lib/transitions.ts` (whole file) and `lib/n8n.ts:60-130`. Confirm:
(a) `triggerSendWebhook` uses global `fetch`; (b) which env var(s) configure
the webhook URL; (c) how `provider` is resolved for a seeded draft (follow the
query in `transitionToApprovedAndSend` that selects the draft/account). Note
what `seedDraft` in `test/helpers/db.ts` produces (provider/account fields).

**Verify**: you can state, in a comment at the top of the new test file, the
exact URL `triggerSendWebhook` will call for a seeded gmail-provider draft.

### Step 2: Write the suite

Create `test/routes/drafts-approve.test.ts`, modeled on
`test/routes/auto-send.test.ts` (same imports/gating/cleanup pattern). Mock
the webhook with `vi.stubGlobal('fetch', vi.fn(...))` (restore in
`afterEach` with `vi.unstubAllGlobals()`); mock **only** `fetch` — the DB is
real. Cases:

1. **Happy path**: seed a `pending` draft; mock fetch → 200 with the JSON
   body shape n8n returns (read `triggerSendWebhook`'s response parsing to
   construct it). POST the approve route handler with `fakeRequest` and
   `{ params: { id } }`. Assert: response 200; `getDraftStatus` shows the
   post-send status the code actually produces (verify in transitions.ts —
   likely `approved`, with n8n flipping to `sent` later, out of process);
   fetch called once with the expected webhook URL and draft id in the body.
2. **Wrong-state 409**: seed a draft already in a non-`pending`/`edited`
   status; assert 409 and fetch **not** called.
3. **Webhook failure contract**: mock fetch → 502 (or network throw,
   whichever `triggerSendWebhook` maps to `success:false`). Assert: response
   status 502; body `{ success: false, draft_id, error }`; row status is
   `approved` (NOT rolled back); `drafts.error_message` contains the error
   text (query via `getTestPool`).
4. **clearError on re-approval**: seed a draft in `pending` with a non-null
   `error_message`; happy-path approve; assert `error_message` is cleared
   (the `clearError: true` contract from the route comment).

**Verify**: `TEST_POSTGRES_URL=... npm test -- drafts-approve` → 4 passing
(or skipped cleanly without the env var).

### Step 3: Full-suite regression check

**Verify**: `npm test` (with TEST_POSTGRES_URL) → all suites pass; confirm no
rule/table leakage into `pipeline-smoke` (the auto-send exemplar's comments
warn about cross-file Postgres state; follow its `beforeEach`/`afterEach`
cleanup discipline for any rows you create).

## Test plan

(This plan IS the test plan — see Step 2 cases.)

## Done criteria

- [ ] `test/routes/drafts-approve.test.ts` exists with the 4 cases above
- [ ] `npm run typecheck`, `npm run lint` exit 0
- [ ] Suite passes with `TEST_POSTGRES_URL`; suite skips (not fails) without it
- [ ] `lib/transitions.ts`, `lib/n8n.ts`, route files unmodified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- `triggerSendWebhook` does NOT use global `fetch` (e.g., an http client
  instance) — report the actual mechanism instead of inventing a mock seam.
- A test exposes behavior that contradicts the documented contract (e.g., the
  row does NOT stay `approved` on webhook failure, or `error_message` is not
  persisted) — that's a finding, not something to paper over.
- `seedDraft` cannot produce a draft that satisfies the provider lookup in
  `transitionToApprovedAndSend` without schema changes.

## Maintenance notes

- When the retry route or send-lock logic changes, extend this suite first —
  it's the characterization net for the money path.
- Reviewer: check the mocked n8n response body matches the real workflow's
  `Respond Success` node shape; a wrong mock here gives false confidence.
- Deferred: a true E2E with a live n8n container (heavier; consider only if
  webhook contract drift actually bites).
