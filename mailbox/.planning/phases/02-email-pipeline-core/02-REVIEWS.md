---
phase: 2
reviewers: [codex]
reviewed_at: 2026-04-13T12:05:44-07:00
plans_reviewed:
  - 02-01-dashboard-backend-bootstrap-PLAN.md
  - 02-02-schema-foundation-PLAN.md
  - 02-03-imap-ingestion-watchdog-PLAN.md
  - 02-04-classification-routing-PLAN.md
  - 02-05-rag-ingest-retrieval-PLAN.md
  - 02-06-persona-extract-refresh-PLAN.md
  - 02-07-draft-generation-local-cloud-smtp-PLAN.md
  - 02-08-onboarding-wizard-and-queue-api-PLAN.md
---

# Cross-AI Plan Review — Phase 2: Email Pipeline Core

Only one external reviewer was available in this environment (Codex CLI via ChatGPT
subscription). Gemini, Claude (separate session), CodeRabbit, and OpenCode were not
installed. A single-reviewer pass still catches real issues, but treat the findings
below as one perspective rather than a multi-model consensus.

---

## Codex Review

## Plan 02-01 — Dashboard Backend Bootstrap

**Summary** — This plan stands up the Node/Express backend, DB connectivity, and WebSocket plumbing that the rest of Phase 2 depends on. As infrastructure bootstrap it is plausible, but it already bakes in a Phase-2/UI contradiction: the plan leaves only a static placeholder while the roadmap/UI contract expects actual onboarding surfaces in this phase.

**Strengths**
- Clear bootstrap target: config, DB client, health route, WS, compose wiring.
- Good early validation gates for container health and DB reachability.
- Centralized env parsing gives later plans a single config entrypoint.

**Concerns**
- [HIGH] `.planning/phases/02-email-pipeline-core/02-01-dashboard-backend-bootstrap-PLAN.md:25`, `447-487` explicitly keep only a placeholder HTML page. That conflicts with Phase 2 success criterion 5 and `02-UI-SPEC.md`, which require a first-boot wizard in this phase. This plan hardens the wrong boundary.
- [MEDIUM] `...02-01...:29-30` says `/api/health` returns `{"status":"ok","db":"ok"}`, but the proposed route returns an extra `ts` field at `233-248`. Small, but it means the plan's own contract is inconsistent.
- [LOW] `...02-01...:395-409` uses `npm install` without a lockfile, so builds are not reproducible on an appliance/OTA path.

**Suggestions**
- Reframe this as backend bootstrap plus a minimal real onboarding UI shell, not a placeholder-only page.
- Make the health-route contract exact or loosen the acceptance check.
- Add lockfile use (`package-lock.json`/`npm ci`) before this becomes the OTA baseline.

**Plan risk:** MEDIUM — solid foundation work, but it cements a Phase 2/Phase 4 boundary that contradicts the roadmap.

## Plan 02-02 — Schema Foundation

**Summary** — This plan defines the core tables and enums for queueing, history, persona, and onboarding. The overall shape is sensible, but it leaves integrity gaps that later plans assume away.

**Strengths**
- Queue/onboarding/persona tables mostly line up with `02-CONTEXT.md`.
- Onboarding columns already anticipate later progress/tuning state.
- Indexing the queue hot path early is the right call.

**Concerns**
- [HIGH] `...02-02...:143-156`, `163-198`, `205-245` define relation columns but no foreign keys or uniqueness across `email_raw`, `classification_log`, `draft_queue`, `sent_history`, and `rejected_history`. Later plans rely on one-row-per-email and atomic archival; without constraints, duplicate or orphaned rows become easy.
- [MEDIUM] `...02-02...:118`, `143`, `164`, `205`, `232` mix `bigserial` PKs with plain `integer` FK-like columns. It works at low volume, but it is an avoidable type mismatch in the core schema.
- [MEDIUM] `...02-02...:186-187` includes `approved`/`rejected` statuses even though `D-19` says approved/rejected rows are moved out of `draft_queue`. That is not fatal, but it encourages ambiguous queue states.
- [LOW] `...02-02...:184`, `217` rely on TS-side JSON defaults; the plan does not prove the generated SQL default is correct.

**Suggestions**
- Add FK constraints and idempotency constraints now, especially on `classification_log.email_raw_id`, `draft_queue.email_raw_id`, and archival tables.
- Normalize integer widths to `bigint`/`bigserial` consistently.
- Decide whether `approved`/`rejected` are transient workflow states or archival-only states, and encode that consistently.

**Plan risk:** MEDIUM — good base schema, but later workflow safety depends on integrity the DDL does not enforce.

## Plan 02-03 — IMAP Ingestion Watchdog

**Summary** — This plan handles inbound email ingest and the n8n IMAP watchdog. It covers the basic pipeline entrance, but several details are wrong enough to threaten correctness.

**Strengths**
- Commits workflows as JSON instead of burying them in n8n state.
- Treats the IMAP watchdog as mandatory, which matches `STATE.md`.
- Persists inbound mail before downstream classification, which is the right failure boundary.

**Concerns**
- [HIGH] `...02-03...:97`, `141-144`, `272-274` hardcode a single `Gmail IMAP`/`Customer SMTP` credential path. That does not satisfy `MAIL-14` ("up to 3 email accounts per appliance").
- [HIGH] `...02-03...:104-107` sets `thread_id` from the current message's `Message-ID`. That is not a thread identifier; every reply gets a new Message-ID. Thread reconstruction will be wrong.
- [HIGH] `...02-03...:171-179` watchdog logic keys off "last execution finished." On a quiet inbox, an IMAP trigger may legitimately have no recent executions. This can create false stale detections, restart loops, and bogus operator alerts.
- [MEDIUM] `...02-03...:97` uses `include unread only true`. If the operator reads mail elsewhere before polling, the appliance can miss messages entirely.

**Suggestions**
- Explicitly model multiple accounts now or remove `MAIL-14` from the claimed coverage.
- Store actual threading primitives (`message_id`, `in_reply_to`, `references`) and derive thread grouping later; do not invent `thread_id`.
- Validate watchdog freshness against trigger health/registration, not only recent message executions.
- Avoid unread-only semantics unless the product can tolerate missed mail.

**Plan risk:** HIGH — the ingest edge is foundational, and this version has both requirement and correctness gaps.

## Plan 02-04 — Classification Routing

**Summary** — This plan classifies inbound mail, writes the classification log, and routes to local/cloud drafting. The routing policy is reasonable, but the implementation contract drifts across runtime and offline evaluation.

**Strengths**
- Good fallback behavior: invalid JSON becomes `unknown` instead of crashing.
- Category-plus-confidence routing matches the design contract.
- Explicit spam drop and escalate handling are clear.

**Concerns**
- [HIGH] `...02-04...:34`, `119-121`, `224-259` claim a "single source of truth" prompt, but the n8n workflow copy-pastes the prompt and re-implements parsing, and the scoring script defines a separate `SYSTEM` prompt/parser again. Runtime behavior and MAIL-08 scoring can drift.
- [MEDIUM] `...02-04...:79-84` uses a greedy `\{[\s\S]*\}` extraction. If the model emits multiple brace blocks, parse behavior becomes unstable; fallback saves the pipeline, but accuracy/testing becomes noisy.
- [MEDIUM] `...02-04...:138-154` inserts `draft_queue` rows before drafting exists and explicitly tolerates downstream sub-workflow failure. Combined with `02-08` live-gate changes, this can create queue rows with no draft but a normal review status.

**Suggestions**
- Put prompt + parse logic in one importable module and have both the scorer and backend use it directly; for n8n, generate node text from that source rather than copy-paste.
- Use a stricter JSON extraction strategy.
- Distinguish "classified but not drafted" from `pending_review` in the queue schema/status model.

**Plan risk:** MEDIUM — routing itself is fine, but drift between scoring and production weakens the main accuracy gate.

## Plan 02-05 — RAG Ingest Retrieval

**Summary** — This plan creates the Qdrant/Ollama-based RAG layer, document upload API, and onboarding sent-history ingest. The broad structure works, but the sent-history ingest contract is internally inconsistent and contaminates later persona logic.

**Strengths**
- Sensible single-collection design for a single-operator appliance.
- Serial embedding is the right bias on 8GB unified memory.
- KB CRUD over the dashboard backend is a good integration point.

**Concerns**
- [HIGH] `...02-05...:352` says historical sent messages should also be inserted into `mailbox.sent_history` with `draft_source='local_qwen3'` default. That fabricates provenance for historical mail and pollutes PERS-05, which later reads `sent_history` as approved/generated output.
- [HIGH] `...02-05...:352` also does not match the `sent_history` schema from `02-02`; required fields like `classification_category`, `classification_confidence`, and `rag_context_refs` are not accounted for. The proposed insert is underspecified at best.
- [HIGH] `...02-05...:387-395` says `07-rag-index-new-message` should fire after `draft_queue` insert in `01-email-pipeline-main`, but `draft_queue` is inserted in `03-classify-email-sub`, not workflow 01. That handoff is wrong.
- [MEDIUM] `...02-05...:19`, `81-83` define top-5 retrieval, but `02-07` consumes only top-3 directly. The requirement/API boundary is muddy.
- [MEDIUM] `...02-05...:229-238` uses in-memory upload handling for up to 20MB documents on the appliance. It is probably fine, but it is an avoidable RAM spike on the smallest box.

**Suggestions**
- Separate historical sent-mail corpus from operator-approved/generated `sent_history`; use a dedicated table or Qdrant-only ingest metadata.
- Fix the incremental-index handoff to the classification workflow, where the queue row actually exists.
- Define one contract: retrieve top-5 from Qdrant, then explicitly select top-3 for prompt injection.

**Plan risk:** HIGH — the historical-ingest path currently distorts downstream persona and audit semantics.

## Plan 02-06 — Persona Extract Refresh

**Summary** — This plan builds deterministic persona markers and exemplar curation from sent mail. The approach is lightweight and aligned with the hardware, but the data source and workflow handoff are not consistent with the rest of the phase.

**Strengths**
- Statistical markers are cheap and debuggable on-device.
- Per-category exemplar selection matches the spec better than a single prose persona blob.
- Persona build is exposed through a simple API, which is easy to test.

**Concerns**
- [HIGH] `...02-06...:263-266` says there is a Qdrant fallback if `sent_history` is empty, but the code only reads `mailbox.sent_history`. That comment is false, and onboarding persona build depends on `02-05`'s questionable historical `sent_history` insert.
- [HIGH] `...02-06...:365-370` defines `09-persona-extract-trigger` as only calling `/api/persona/extract` and updating a counter. But `02-08` assumes this workflow also hands off to tuning-sample generation. The plans disagree on the contract.
- [MEDIUM] `...02-06...:27`, `395-399` say "02:00 local time" in the must-have, then implement `0 2 1 * *` UTC. That is not the same schedule.

**Suggestions**
- Make the onboarding persona source explicit and separate from approved live sends.
- Add the actual handoff from persona extraction to tuning-sample generation, or move that responsibility fully into `02-08`.
- Resolve timezone semantics for monthly refresh instead of mixing "local" and UTC.

**Plan risk:** MEDIUM — the extraction logic is serviceable, but the data-source and handoff assumptions are shaky.

## Plan 02-07 — Draft Generation Local Cloud SMTP

**Summary** — This plan closes the draft and send loop, including cloud degradation and SMTP send. It is the most important plan in the set, and it has the biggest operator-safety issue: outbound send is not idempotent.

**Strengths**
- Clear split between local and cloud drafting paths.
- Good prompt hygiene around untrusted email input.
- `awaiting_cloud` degradation path matches the design contract better than silent fallback.

**Concerns**
- [HIGH] `...02-07...:420-450` is not idempotent. The workflow reads an approved row, sends SMTP, then archives by deleting from `draft_queue`. If SMTP succeeds and the archive step fails, or if the workflow retries after partial success, the same email can be sent twice.
- [HIGH] `...02-07...:42`, `366-376` threat model promises a `retry_count` column, but the implementation uses n8n `staticData.global.retryAttempts`. That state is not durable across restarts/imports and is not tied to the row. The bounded-retry guarantee is false.
- [MEDIUM] `...02-07...:326` marks `awaiting_cloud` only on rows with `draft_original IS NULL`, but there is no persistent failure metadata for why the row is waiting or how many attempts have happened.
- [MEDIUM] `...02-07...:430-436` sends only to the original `from_addr`; CC/recipient preservation is not addressed, which is risky for real operational threads.

**Suggestions**
- Add a durable send-state transition before SMTP send, or use a compare-and-swap/send-lock pattern with a unique outbound id.
- Put retry counters and last-error metadata in Postgres, not n8n static state.
- Store/send richer recipient/thread metadata if threaded operational mail matters.

**Plan risk:** HIGH — duplicate sends are the most serious operator-safety failure in the phase, and this plan does not prevent them.

## Plan 02-08 — Onboarding Wizard And Queue API

**Summary** — This plan provides onboarding, queue, and tuning APIs, and updates the live gate. It delivers useful backend contracts, but it does not actually deliver the Phase 2 onboarding wizard, and several route contracts are stubbed or nonfunctional.

**Strengths**
- Good consolidation point for queue/onboarding/tuning APIs.
- Password hashing approach is appropriate for the appliance.
- Adding a live gate before production drafting is directionally correct.

**Concerns**
- [HIGH] `...02-08...:18-19`, `705-761` explicitly say the front-end UI ships in Phase 4 and use API-only smoke tests. That does not satisfy the roadmap or `02-UI-SPEC.md`, both of which put the onboarding wizard in Phase 2.
- [HIGH] `...02-08...:25`, `252-259`, `261-283` claim support for `{ oauth_code }` and manual IMAP/SMTP credentials, but the actual schema does not accept `oauth_code` or password fields and does not provision n8n credentials. ONBR-02 and MAIL-01 are not actually implemented here.
- [HIGH] `...02-08...:275-279`, `405-409`, `418-422` call `.../rest/workflows/run-by-name?...` on n8n with no auth contract and no prior plan establishing that endpoint. `02-03` used an internal API token for different REST calls. This handoff is likely broken.
- [HIGH] `...02-08...:395-412` marks a queue row `approved` before confirming the send workflow was accepted, then swallows fetch errors. A failed n8n call yields a false success and a stuck approved-unsent row.
- [HIGH] `...02-08...:552-569` generates tuning samples from `email_raw` + `classification_log`, but `02-05` onboarding ingest only backfills the sent folder. There may be no historical inbound corpus to generate the promised 20 samples.
- [MEDIUM] `...02-08...:29-30`, `374-376`, `411`, `423`, `511` promise queue/onboarding WS events including `queue.inserted` and `onboarding.progress`, but the code shown only broadcasts a subset.

**Suggestions**
- Either ship the actual wizard UI in Phase 2 or move the roadmap/scope docs; right now the plans disagree.
- Replace stub email-connect handling with a real credential/OAuth provisioning path, or stop claiming ONBR-02/MAIL-01 coverage.
- Make queue approve/reject synchronous enough to know whether downstream workflow dispatch succeeded.
- Redesign tuning-sample generation to use a corpus that onboarding actually ingests.

**Plan risk:** HIGH — this plan is carrying too much unresolved contract debt and misses core phase-success deliverables.

## Overall Phase 2 Assessment

**Cross-plan dependency issues**
- `02-05` wires incremental RAG indexing to the wrong workflow boundary (`02-05:387-395`).
- `02-06` and `02-08` disagree on whether `09-persona-extract-trigger` launches tuning-sample generation (`02-06:365-370` vs `02-08:549-579`).
- `02-07` threat model assumes a durable `retry_count`, but `02-02` never adds one and `02-07` uses volatile n8n state instead (`02-07:42`, `366-376`).
- `02-08` depends on an n8n "run by name" API that no earlier plan establishes, while `02-03` uses a different internal-API pattern (`02-03:180-181`, `02-08:275-279`, `405-422`).
- The onboarding/tuning corpus contract does not line up: onboarding ingests sent mail, but tuning generation requires historical inbound mail plus classifications (`02-05:327-353`, `02-08:552-569`).

**Coverage gaps vs. Phase 2 success criteria**
- Success criterion 5 is not met by the plan set as written. The docs require a first-boot wizard with progress indicator and tuning session before live email, but the plans explicitly defer UI to Phase 4 and test only API endpoints.
- Success criterion 1 is only partially covered because SMTP/approval dispatch is not reliable enough and IMAP watchdog correctness is questionable.
- Success criterion 4 is weakened by non-idempotent send and fire-and-forget approval dispatch.

**Coverage gaps vs. requirements**
- `MAIL-14` is effectively unaddressed; everything is single-account.
- `MAIL-01` / `ONBR-02` are only stubbed; no real OAuth/manual credential provisioning path exists.
- `RAG-03` is incomplete: new inbound messages are indexed, but new outbound approved sends are not clearly indexed as live corpus.
- `PERS-04` is asserted but not operationalized or tested.
- `ONBR-04`, `ONBR-05`, `APPR-01`, and parts of `RAG-06` are API-only, not actual dashboard/onboarding surfaces.
- `APPR-02` is incomplete: approve/edit/reject exist, but operator "escalate" action is missing as an API/UI contract.

**Scope creep / over-engineering**
- Reusing `sent_history` for historical sent-mail ingest is the wrong shortcut; it collapses audit, live-send history, and onboarding corpus into one table.
- Some API/websocket surface area is ahead of the actual product phase boundary. The plans are designing Phase 4 contracts while not yet landing Phase 2 UI and send safety.

**Hardware/resource risks**
- The plans are mostly conservative on model size, but they do not adequately schedule concurrent onboarding work. Historical embed ingest, Qwen tuning-sample generation, and live classification/drafting can contend on an 8GB Jetson.
- Document upload uses in-memory buffering; acceptable for small files, but it is an avoidable RAM spike.
- No new plan directly regresses the Qdrant ARM64/jemalloc workaround, but none of the Phase 2 plans re-verify it after touching compose/runtime assumptions.

**Security / privacy risks**
- Best privacy rule in the PRD, "no bulk corpus to cloud," is mostly respected, but outbound send safety is weaker than the threat models claim.
- Fire-and-forget approval/send dispatch can silently fail or duplicate sends.
- OAuth/manual credential handling is described but not implemented; that is not a small omission because token storage/provisioning is the high-risk path.

**Testability**
- There are many smoke tests, but not enough proof tests.
- No plan proves duplicate-send prevention, because there is no duplicate-send prevention.
- The 80% classification gate is documented, but the real 100-email corpus process is still manual and drift-prone because the scorer duplicates prompt logic.
- The 90-second end-to-end gate is only lightly exercised and depends on several cross-plan contracts that are currently inconsistent.

**Overall phase risk:** HIGH — the individual pieces are mostly sensible, but the phase does not yet compose into a trustworthy end-to-end loop. The biggest blockers are missing real onboarding/UI delivery, broken or unspecified handoffs between plans, and operator-safety gaps around approval/send idempotency.

---

## Synthesis — Top Findings To Address Before Execution

Single-reviewer pass, so this is a distillation rather than a cross-reviewer consensus. Ordered by severity and cross-plan impact.

### Must-fix before executing Phase 2

1. **Non-idempotent SMTP send (02-07)** — approved → send → archive is not atomic. A partial failure or retry can double-send. Add a durable `send_state` transition or unique outbound id before SMTP fires. This is the single biggest operator-safety risk in the phase.
2. **Approval dispatch is fire-and-forget (02-08)** — queue row flips to `approved` before confirming the send workflow accepted the dispatch, and errors are swallowed. Make approve/reject wait for workflow acceptance and surface failures.
3. **Onboarding wizard deferred to Phase 4 (02-01, 02-08)** — roadmap success criterion 5 and `02-UI-SPEC.md` put the wizard (with progress indicator and tuning session) in Phase 2, but the plans explicitly defer the UI. Either land the wizard UI here or reconcile the roadmap/UI-SPEC before execution.
4. **OAuth / manual credential provisioning stubbed (02-08 → MAIL-01, ONBR-02)** — the documented payload shape does not match the schema, and n8n credentials are never actually provisioned. This is load-bearing for the whole phase.
5. **Cross-plan workflow handoffs are inconsistent** — `02-05` indexes after a workflow boundary that does not exist, `02-06`/`02-08` disagree on who launches tuning-sample generation, `02-08` calls an n8n "run by name" endpoint `02-03` never established. Reconcile workflow IDs, dispatch endpoints, and handoff points before execution.
6. **`retry_count` promised but not schema-backed (02-07 ↔ 02-02)** — threat model relies on a durable retry counter; implementation uses volatile n8n static data. Add the column in `02-02` and use it in `02-07`.
7. **Historical sent-mail ingest pollutes `sent_history` (02-05 ↔ 02-06, PERS-05)** — inserting backfilled historical mail into the same `sent_history` table used for live approved output breaks persona, audit, and PERS-05 semantics. Use a dedicated table or Qdrant-only metadata.
8. **Thread identity is wrong (02-03)** — `thread_id` is being set from the current message's `Message-ID`, which changes per reply. Store `message_id`, `in_reply_to`, `references` and derive grouping later.

### Should-fix in the same planning pass

9. **Schema integrity gaps (02-02)** — no FKs and no uniqueness across `email_raw`/`classification_log`/`draft_queue`/`sent_history`/`rejected_history`. Later plans assume 1:1 relationships that the DDL does not enforce. Also normalize `bigserial` vs `integer` widths.
10. **Classification prompt/parse duplication (02-04)** — the "single source of truth" prompt is copy-pasted into the n8n node and re-implemented again in the scoring script. Accuracy scoring will drift from production behavior; the MAIL-08 80% gate is not a real gate. Make one module the source and generate the n8n node text from it.
11. **IMAP watchdog false positives (02-03)** — freshness check keys on "last execution finished," which fails on quiet inboxes. Validate against trigger health/registration instead.
12. **`MAIL-14` multi-account is unaddressed (02-03)** — single-credential assumption everywhere. Either model multiple accounts now or drop MAIL-14 from phase coverage.
13. **`APPR-02` escalate action missing (02-08)** — approve/edit/reject exist, but "escalate" has no API/UI contract.
14. **Persona refresh schedule mismatch (02-06)** — "02:00 local time" in the must-have, `0 2 1 * *` UTC in implementation.
15. **Tuning-sample corpus mismatch (02-08 ↔ 02-05)** — tuning samples are generated from inbound `email_raw` + `classification_log`, but onboarding ingests only the sent folder. There is no historical inbound corpus to generate the promised 20 samples from.

### Nice-to-fix

16. **Lockfile discipline (02-01)** — `npm install` without a lockfile makes OTA builds non-reproducible. Use `npm ci` and commit `package-lock.json`.
17. **Top-5 vs top-3 RAG retrieval contract (02-05 ↔ 02-07)** — pick one and document explicit top-K downselection.
18. **In-memory upload buffering (02-05)** — 20MB in-memory on 8GB Jetson is an avoidable RAM spike.
19. **CC / multi-recipient preservation (02-07)** — replies go only to `from_addr`; real operational threads often need CC preserved.

---

## How To Use This Review

To incorporate the findings back into the plans, run:

```
/gsd-plan-phase 2 --reviews
```

That pass should triage each HIGH finding as either "fix in plan" or "document as out-of-scope with justification" before Phase 2 execution begins.
