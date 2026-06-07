# Quick Task 260527-k3k — MBOX-345: n8n workflow expression lint

**Completed:** 2026-05-27
**Branch:** `fix/mbox-345-n8n-expression-lint` (off `origin/master`)
**Outcome:** Done — regression guard for the MBOX-344 bug class shipped into the CI gate.

## What shipped

| File | Change |
|------|--------|
| `dashboard/lib/n8n-expr-lint.ts` | New pure analyzer (no I/O): `buildMainInputPredecessors`, `extractJsonFieldReads`, `postgresReturningFields`, `lintWorkflow`. |
| `dashboard/test/n8n-expr-lint.test.ts` | Vitest guard (14 cases) in the `dashboard (typecheck + test)` CI gate. |
| `n8n/workflows/README.md` | New "Cross-node `$json` references" section + Known-pitfalls bullet, citing MBOX-344 and the guard. |
| `scripts/smoke-send-lock.sh` | Guarded static expr-lint pre-check before any appliance call (exit 1 on violation; skips when npx/dashboard absent). |

## How it works

- **FLOOR assertion (must-have):** MailBOX-Send's `Gmail Reply` `messageId`/`message` must reference `$('Load Draft')` and never bare `$json.` — the exact MBOX-344 regression. A bare-`$json` revert fails CI.
- **General rule (low false-positive):** for a node whose SOLE immediate main-input predecessor is a Postgres `executeQuery`, parse the predecessor's `RETURNING`/`SELECT` output set; flag any `$json.<field>` the predecessor provably does not produce. When the predecessor's output is undeterminable (e.g. `SELECT *`, or a non-Postgres / multi-predecessor / pass-through IF), it does NOT flag — zero false positives on the current workflow set.
- **Whole-suite-green test** asserts `lintWorkflow` returns `[]` for every `n8n/workflows/*.json` today.

## Known limitation (documented, by design)

The real MailBOX-Send path has an intervening `Lock Acquired?` IF node between `Acquire Send Lock` (Postgres) and `Gmail Reply`, so the *general* rule does not reach across it — the **FLOOR assertion** is the authoritative guard for that specific path. The general rule catches the broader class where a Postgres node is the direct predecessor. Traversing through pass-through control nodes (IF/NoOp) was deliberately NOT attempted to keep false positives at zero. Captured as a possible future enhancement.

## Verification

- `npm run typecheck` — clean.
- `npx vitest run test/n8n-expr-lint.test.ts` — 14/14 pass (floor green on real JSON; floor red on a mutated bare-`$json` copy; synthetic MBOX-344 replica → exactly one violation on `message_id`; whole-suite green).
- `npm test` (full dashboard suite) — 684 passed / 165 skipped (DB-backed), nothing regressed.
- `biome check` — clean on both new files.
- `bash -n scripts/smoke-send-lock.sh` — parses clean.

## Commits

- `1e17133` test(dashboard): MBOX-345 add n8n workflow expression lint (analyzer + vitest)
- `5b6a8d5` docs(n8n): MBOX-345 document `$('Node').item.json.*` convention + wire smoke pre-check

## Follow-up

PR not yet opened — branch is local + first push pending. (`.planning/` artifacts may want filtering via `gsd-pr-branch` before review.)
