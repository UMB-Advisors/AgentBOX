---
phase: quick-260520-ulr
plan: 01
subsystem: classification
tags: [umb-153, umb-154, pre-draft-guards, operator-domain, self-loop, thread-ownership]
dependency_graph:
  requires: [DR-50 operator-domain preclass, dashboard/lib/classification/preclass.ts]
  provides: [precheckSelfLoop, operatorOwnsThread, suppression_reason field]
  affects: [classification-normalize route, normalize.ts ClassificationResult, preclass.ts exports]
tech_stack:
  added: []
  patterns: [fail-open guard pattern, env kill switch, injectable clock for deterministic tests, vi.mock for route unit tests without DB]
key_files:
  created:
    - dashboard/lib/classification/thread-ownership.ts
    - dashboard/test/classification/operator-self-loop.test.ts
    - dashboard/test/classification/thread-ownership.test.ts
    - dashboard/test/classification/thread-ownership-route.test.ts
  modified:
    - dashboard/lib/classification/preclass.ts
    - dashboard/lib/classification/normalize.ts
    - dashboard/app/api/internal/classification-normalize/route.ts
    - dashboard/lib/schemas/internal.ts
decisions:
  - "Self-loop suppression clobbers to spam_marketing (existing drop path) — no migration, no n8n change. Spam mislabel in classification_log is an accepted known wart for v1."
  - "operatorOwnsThread uses TS-side isOperatorAddress filter over a UNION of sent_history + inbox_messages — keeps operator-domain definition single-sourced in preclass.ts."
  - "Evaluation order in applyPreclass: noreply → self-loop → operator-domain. Self-loop must precede operator-domain or from-operator mail gets promoted to internal before the to-address is checked."
  - "suppression_reason field added to ClassificationResult (not a separate table/column) — observable in route response + logs without a migration."
metrics:
  duration: ~15 minutes
  completed: 2026-05-21
  tasks_completed: 3
  tests_added: 33
  tests_skipped_db: 6
---

# Quick Task 260520-ulr: UMB-153 + UMB-154 Pre-draft Operator Domain Guards

**One-liner:** Synchronous self-loop guard (UMB-153) + async operator-owns-thread guard (UMB-154) prevent role-confused drafts on operator outbound loops and already-active threads, both routing through the existing `spam_marketing → drop` path with `suppression_reason` for observability.

## What Was Built

### Task 1 — UMB-153: precheckSelfLoop (synchronous, no DB)

`dashboard/lib/classification/preclass.ts` changes:
- Exported `extractAddress`, `extractDomain` (previously file-private)
- Added `isOperatorAddress(addr): boolean` — single definition reused by both `precheck` and `precheckSelfLoop`
- Added `precheckSelfLoop(ctx): PreclassResult | null` — returns `spam_marketing/1.0/operator-self-loop` when `from` is operator-side AND `to` is present AND `to` is NOT operator-side. Applies `OPERATOR_INBOX_EXCEPTIONS` first (role inboxes like `sales@` must not suppress). Kill switch: `OPERATOR_SELF_LOOP_DISABLE=1`.
- Widened `PreclassResult.source` union to include `'operator-self-loop'`

`dashboard/lib/classification/normalize.ts` changes:
- Added `suppression_reason: 'self_loop' | 'operator_owns_thread' | null` to `ClassificationResult`
- Widened `preclass_source` union to include `'operator-self-loop'` and `'operator-owns-thread'`
- Rewrote `applyPreclass` with explicit evaluation order: noreply → self-loop → operator-domain (self-loop must run before operator-domain or `from=operator` gets promoted to `internal` before `to` is checked)
- Sets `suppression_reason: 'self_loop'` when `precheckSelfLoop` fires

**Live fix:** draft-154 case (`jt@heronlabsinc.com → shabegsh@gmail.com`) now drops via `self_loop`. No n8n change needed — `from`/`to` are already sent by the Normalize node.

### Task 2 — UMB-154: operatorOwnsThread (async, DB-backed)

New file: `dashboard/lib/classification/thread-ownership.ts`

- `operatorOwnsThread({ thread_id, current_to, now? }): Promise<OwnershipResult>` — checks whether any operator-domain address sent a message in this thread within the active window (default 24h)
- Source: `UNION ALL` of `mailbox.sent_history` (outbound) + `mailbox.inbox_messages` (inbound, covers operator messages that landed back as inbound). TS-side `isOperatorAddress` filter keeps operator-domain definition single-sourced.
- Returns `{ owned: true, reason: 'operator_owns_thread' }` within window; `{ owned: false, reason: 'lapsed' }` when >24h; `{ owned: false, reason: 'no_operator_msg' }` when operator never replied; `{ owned: false, reason: 'no_thread_id' }` when thread_id is null/empty; `{ owned: false, reason: 'db_unavailable' }` on any DB error (fail-open)
- Window tunable: `OPERATOR_THREAD_WINDOW_HOURS` (default 24). Kill switch: `OPERATOR_THREAD_GUARD_DISABLE=1`. Injectable `now` for deterministic tests.

### Task 3 — Wire thread-ownership into the normalize route

`dashboard/lib/schemas/internal.ts`:
- Added `thread_id: z.string().optional()` to `classificationNormalizeBodySchema`

`dashboard/app/api/internal/classification-normalize/route.ts`:
- Destructures `thread_id` from parsed body
- After sync `normalizeClassifierOutput`, if `result.route !== 'drop'` AND `thread_id` present: calls `operatorOwnsThread`. If owned → spreads result with `category='spam_marketing'`, `route='drop'`, `preclass_source='operator-owns-thread'`, `suppression_reason='operator_owns_thread'`
- Already-dropped results (spam/noreply/self-loop) short-circuit before the DB query
- Structured `console.log` on every suppression: `[classify] suppressed draft reason=<...> from=<...> thread=<...>`

**Live fix:** draft-158 case (shabegsh@gmail.com → jt@ on thread jt@ replied to <24h ago) now drops via `operator_owns_thread`.

## Out-of-Band Deploy Step (CRITICAL for UMB-154 to fire in production)

**UMB-153 needs no n8n change.** The `from` and `to` fields are already present in the Normalize node's `jsonBody`.

**UMB-154 requires one n8n edit.** The `MailBOX-Classify` workflow's `Normalize` HTTP node `jsonBody` must add:

```
"thread_id": {{ JSON.stringify($('Load Inbox Row').item.json.thread_id || '') }}
```

Without this line, `thread_id` is never sent to the route, the guard remains dormant (fails open — drafts continue normally), and UMB-154 has zero effect in production. The code-side change is complete; this is the operator deploy step.

**Deploy sequence:**
1. `git pull && docker compose up -d --build --remove-orphans` on the Jetson (picks up the dashboard changes)
2. Edit `MailBOX-Classify` Normalize node in the n8n editor — add the `thread_id` line to `jsonBody`
3. Save + re-activate the workflow
4. Verify via a known self-loop message: the next classify cycle should produce no draft and the route response should show `suppression_reason: 'operator_owns_thread'` in n8n execution logs

## Test Results

| Suite | Tests | Skipped | Notes |
|-------|-------|---------|-------|
| operator-self-loop.test.ts | 17 | 0 | Pure logic, all pass |
| thread-ownership.test.ts | 4 | 6 | 4 pure-logic pass; 6 DB-backed skip (no TEST_POSTGRES_URL) |
| thread-ownership-route.test.ts | 6 | 0 | Pure unit via vi.mock, all pass |
| preclass.test.ts (existing) | 18 | 0 | Unchanged, all pass |
| normalize-route-field.test.ts (existing) | 5 | 0 | Unchanged, all pass |
| routing-reason.test.ts (existing) | 5 | 0 | Unchanged, all pass |
| **Total classification/** | **55 + 26 prior** | **6** | |

`npx tsc --noEmit` — clean, no errors.

**DB-backed skipped cases** (require `TEST_POSTGRES_URL`):
1. owned:true when operator replied 1h ago (draft-158 case)
2. owned:false when last operator reply was 26h ago (lapsed)
3. owned:false when only counterparty messages exist (never replied)
4. owned:true when operator message is in inbox_messages (self-loop as inbound)
5. owned:true uses any operator-domain address, not just current_to
6. respects OPERATOR_THREAD_WINDOW_HOURS env override

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. Both guards are fully wired. UMB-154 is dormant in production until the n8n out-of-band deploy step above is completed, but that is an operator deploy step, not a code stub.

## Threat Flags

None — no new network endpoints, auth paths, or schema changes introduced.
