# MBOX-122 — Email Triage UX Overhaul: Implementation Plan

**Version:** v0.1.0
**Date:** 2026-05-28
**Status:** Planning (not started)
**Parent epic:** MBOX-111 (M5 — Production Box) → roll-up STAQPRO-336
**Branch (work):** `dustin/mbox-122`

> **TL;DR** — MBOX-122 was scoped as a four-part overhaul (filters/sort, classification override, urgency engine, daily digest). Three of the four backend deliverables and the override UX have **already shipped** as child issues (MBOX-123 override, MBOX-133 filter persistence, MBOX-134 urgency engine, MBOX-132 digest). The remaining net-new work is the **production queue-UX port**: wiring the already-built urgency engine, filter persistence, and sandbox UI components into the live `QueueClient`. The single biggest open question is whether the production queue should switch from `listDrafts` to `getQueueWithUrgency` (server-side urgency) or compute badges client-side — this drives the whole data-flow shape.

---

## 1. Goal + acceptance (restated)

Upgrade the approval queue from a flat "draft approval" list into a "triage dashboard" by surfacing: (1) filter chips + sort controls with server-side persistence, (2) an operator classification-override control, (3) urgency badges + a dashboard-wide red-flag, and (4) a daily digest email.

**Epic-level acceptance (from MBOX-122):**

- [ ] Phase 1 sandbox surface PR merged with the four UI elements iterated to design-locked state — **DONE** (sandbox shipped under MBOX-128 / STAQPRO-382 substrate)
- [ ] Phase 2 child tickets filed + each shipped with migrations, tests, production-ready UI port
- [ ] CLAUDE.md updated with new tables and routes — **largely DONE** (urgency engine, VIP, digest, idempotency all documented)
- [ ] One end-to-end UAT: operator overrides a misclassification, urgency badge fires on an `escalate`, daily digest arrives at the configured time

**The scope this plan covers** is the residual: porting the sandbox UI into production and wiring it to the existing backends. Most "Phase 2 backend" deliverables are already merged — see §2.

---

## 2. What already exists in the codebase

The codebase is substantially further along than the MBOX-122 description implies. Each sub-area below is mapped to its current state.

### 2.1 Classification override — DONE (MBOX-123)

| Piece | File | State |
|---|---|---|
| Override route | `dashboard/app/api/drafts/[id]/classification/route.ts` | **Built.** `PATCH`, body `{category, reason?}`. v1 = **relabel only, no re-draft** (the open question is resolved). One transaction: updates `drafts.classification_category`, `inbox_messages.classification` (denorm), appends `classification_log` row with `model_version='operator-override'`, `confidence=1.0`. Sets `mailbox.actor`/`mailbox.transition_reason` GUCs. |
| Body schema | `dashboard/lib/schemas/drafts.ts` → `classificationOverrideBodySchema` | Built. |
| Production component | `dashboard/components/ClassificationOverride.tsx` | **Built + wired.** Popover anchored to category pill, dark-theme tokens, sourced from canonical `CATEGORIES`. |
| Wiring | `dashboard/components/DraftDetail.tsx:107-108` | **Wired** — renders `<ClassificationOverride>` with `onChange={onReclassify}` when `!readOnly`. |
| Handler | `dashboard/components/QueueClient.tsx` (`fireReclassify` near L446) | Built — `PATCH`es then `fetchData(true)`. |

**Residual:** verify `onReclassify` exists and the toast copy. The "override → re-draft?" open question is **resolved as relabel-only** in code; carry that decision into the plan (do not re-litigate).

### 2.2 Urgency engine — DONE (MBOX-134, Delivered 2026-05-23, PR #139)

| Piece | File | State |
|---|---|---|
| Rule evaluator (SoT) | `dashboard/lib/urgency.ts` → `evaluateUrgency()` | **Built.** Signals `escalate` / `vip` / `aged` / `low_conf`. `LOW_CONF_FLOOR=0.75`. Per-category age thresholds env-resolved (`ageThresholdHours`, `ageHoursEnvVar`). |
| SQL set-wise helper | `dashboard/lib/queries.ts` → `getQueueWithUrgency()` (L203), `countUrgentDrafts()` (L268) | **Built.** Mirrors evaluator in SQL — no N+1. VIP match via `EXISTS` on `mailbox.vip_senders` (exact email OR domain-suffix). Returns `DraftWithUrgency` (`{...draft, urgency:{urgent, signals}}`). |
| Signal vocab (SoT) | `dashboard/lib/types.ts` → `URGENCY_SIGNALS` (L143) | Built. Display order `escalate→vip→aged→low_conf`. |
| VIP table | `dashboard/migrations/028-create-vip-senders-v1-2026-05-22.sql` | **Built.** |
| VIP queries | `dashboard/lib/queries-vip.ts` | Built. |
| VIP schema | `dashboard/lib/schemas/vip.ts` | Built. |
| VIP routes | `dashboard/app/api/vip-senders/route.ts`, `.../[id]/route.ts` | **Built.** |
| VIP management UI | `dashboard/app/settings/vip/page.tsx`, `.../VipSenders.tsx` | **Built.** |
| Red-flag count route | `dashboard/app/api/queue/urgent-count/route.ts` | **Built** — returns `{count}`. |

**Residual:** the urgency engine is fully built on the backend but **not surfaced in the production queue**. `dashboard/app/queue/page.tsx` calls `listDrafts()`, NOT `getQueueWithUrgency()`. `QueueClient.tsx` does not import any urgency badge. The red-flag count route exists but no header consumes it. This is the core of the remaining work.

### 2.3 Filter persistence — DONE backend (MBOX-133)

| Piece | File | State |
|---|---|---|
| Migration | `dashboard/migrations/026-create-user-filter-preferences-v1-2026-05-22.sql` | **Built.** `user_filter_preferences(operator_id NULL, key, value jsonb)`, partial unique indexes for NULL-operator + per-operator. |
| Routes | `dashboard/app/api/operator/preferences/[key]/route.ts` | **Built** — `GET`/`PUT`. |
| Queries | `dashboard/lib/queries-preferences.ts` (`getPreference`, `upsertPreference`) | Built. |
| Schema | `dashboard/lib/schemas/preferences.ts` | Built. `PREFERENCE_KEY_RE`, dotted-namespace keys (`queue.filters`, `queue.sort`). |
| Sandbox hook | `sandbox/src/lib/usePreference.ts` | Built (sandbox only). |

**Residual:** production has no `usePreference()` hook and no filter chips. The only production sort is `QueueClient.tsx`'s local `sortOrder: 'newest'|'oldest'` state (STAQPRO-331 #8) — not persisted, not the urgency-score sort the epic asks for.

### 2.4 Daily digest — DONE (MBOX-132)

| Piece | File | State |
|---|---|---|
| Render + send-decision | `dashboard/lib/digest/render.ts`, `dashboard/lib/digest/recipient.ts` | **Built.** |
| Internal route | `dashboard/app/api/internal/digest/route.ts`, `.../digest/record/route.ts` | **Built.** |
| Migration | `dashboard/migrations/029-create-digest-sends-v1-2026-05-22.sql` | **Built.** `UNIQUE(sent_on)` once-per-day. |
| n8n workflow | `MailBOX-Digest` | Documented in CLAUDE.md (Daily digest worker section). Sent FROM appliance Gmail OAuth → `MAILBOX_OPERATOR_EMAIL`. |
| Sandbox HTML mockup | `sandbox/src/DigestPreview.tsx` | Built. |

**Residual:** the epic's open question "digest send-from: separate domain vs inbound side-channel" was **resolved to appliance Gmail OAuth** (per CLAUDE.md). Digest is functionally complete; only per-appliance import/activation remains (operational, not code).

### 2.5 Sandbox UI (Phase 1 — DONE, the port source)

`sandbox/src/components/`: `FilterBar.tsx`, `SortControls.tsx`, `UrgencyBadge.tsx`, `RedFlagHeader.tsx`, `ClassificationOverride.tsx` (already ported). `sandbox/src/lib/urgency.ts` (mirror of prod), `sandbox/src/VipManagementPage.tsx` (already ported to `settings/vip`). These are the **design-locked source** for the production port.

### 2.6 Summary: what is net-new

| Sub-area | Backend | Sandbox UI | Production UI | Net-new work |
|---|---|---|---|---|
| Classification override | ✅ | ✅ | ✅ | Verify only |
| Urgency engine | ✅ | ✅ | ❌ | **Port badges + red-flag, switch queue query** |
| Filter + sort | ✅ (persistence) | ✅ | ❌ | **Port FilterBar/SortControls + usePreference hook + server filter** |
| Daily digest | ✅ | ✅ | n/a (email) | Operational activation only |

---

## 3. Proposed approach

Single focused workstream: **port the four sandbox UI surfaces into the production `QueueClient`, backed by the already-built engines.** No new tables, no new routes (all exist). Decision-gate on the data-flow question (§5) first, then implement.

**Sequencing:**

1. **Data-flow decision (blocking, §5).** Switch `queue/page.tsx` from `listDrafts` → `getQueueWithUrgency` (recommended) so urgency signals arrive server-side with the queue, avoiding a second round-trip and an N+1. The polling refresh in `QueueClient.fetchData` currently hits `/api/drafts?status=...`; add an urgency-bearing variant or extend the drafts route.
2. **Urgency badges.** Create production `UrgencyBadge.tsx` (port from sandbox), render in `DraftCard.tsx` + `DraftDetail.tsx` from `draft.urgency.signals`.
3. **Red-flag header.** Port `RedFlagHeader.tsx`, poll `/api/queue/urgent-count`, render in `AppShell`/queue header.
4. **Filter + sort.** Port `FilterBar.tsx` + `SortControls.tsx`, add a production `usePreference()` hook (localStorage fallback + `GET`/`PUT /api/operator/preferences/[key]`), wire client-side filtering over the fetched list (category/status/route/confidence-band/age-band) plus the new urgency-score sort.
5. **CLAUDE.md** — confirm Conventions/Routes already cover everything (they do for urgency/VIP/digest/filter-prefs); add a "Triage queue UX" note documenting which queue query feeds badges.
6. **UAT + tests.**

**Filtering strategy:** the queue caps at 50 rows (`limit=50`). Client-side filtering over 50 rows is trivial and matches the existing `visibleList` pattern in `QueueClient` (L459). Do **not** push filters into SQL for v1 — keep the server query as "the queue slice" and filter/sort in the client, persisting the chip state via `usePreference`. (Server-side filtering becomes worthwhile only if the queue grows past the 50-row cap; note as a future enhancement.)

---

## 4. Task breakdown (files to touch)

| # | Task | Files | Notes |
|---|---|---|---|
| T1 | Decide + switch queue data source to urgency-bearing | `dashboard/app/queue/page.tsx` (L67 `listDrafts`→`getQueueWithUrgency`), `dashboard/lib/types.ts` (export `DraftWithUrgency` to client), `dashboard/components/QueueClient.tsx` (`Props.initialList: DraftWithUrgency[]`) | See §5 Q1. Archive folders (sent/rejected) can stay on `listDrafts` — urgency only matters for the active queue. |
| T2 | Add urgency to the polling fetch | `dashboard/app/api/drafts/route.ts` (add `?urgency=1` or new `/api/queue` GET returning `DraftWithUrgency[]`), `QueueClient.fetchData` (L102-131) | Keep the existing `/api/drafts` contract intact for archive folders; gate urgency by query param. |
| T3 | Production `UrgencyBadge` | NEW `dashboard/components/UrgencyBadge.tsx` (port `sandbox/src/components/UrgencyBadge.tsx`), render in `dashboard/components/DraftCard.tsx` + `dashboard/components/DraftDetail.tsx` | Map `URGENCY_SIGNALS` order; dark `@theme` tokens (mirror ClassificationOverride port pattern). |
| T4 | Red-flag header | NEW `dashboard/components/RedFlagHeader.tsx` (port sandbox), poll `/api/queue/urgent-count`, mount in `dashboard/components/AppShell.tsx` or queue header | Resolve red-flag math open question (§5 Q2). |
| T5 | Production `usePreference` hook | NEW `dashboard/lib/usePreference.ts` (port `sandbox/src/lib/usePreference.ts`) | localStorage fallback + `GET`/`PUT /api/operator/preferences/[key]`. Keys: `queue.filters`, `queue.sort`. |
| T6 | FilterBar + SortControls (prod) | NEW `dashboard/components/FilterBar.tsx`, `dashboard/components/SortControls.tsx` (port sandbox), mount in `QueueClient`, extend `visibleList` (L459) with category/status/route/confidence/age filters + `urgency` sort | Replace the local `sortOrder` state with persisted pref; keep `newest`/`oldest` and add `urgency`. |
| T7 | Tests | `dashboard/lib/__tests__/*` (filter predicate unit tests), reuse existing urgency evaluator tests | See §6. |
| T8 | CLAUDE.md | root `CLAUDE.md` Conventions | Add a "Triage queue UX" note: production queue reads `getQueueWithUrgency`; filter/sort persisted via `user_filter_preferences`. |
| T9 | Verify override path | `dashboard/components/QueueClient.tsx` `fireReclassify`, `DraftDetail.tsx` `onReclassify` | Confirm wired end-to-end; UAT item. |

---

## 5. Risks / unknowns + open questions for the operator

| # | Question | Recommendation | Why it matters |
|---|---|---|---|
| **Q1** | **Switch production queue from `listDrafts` to `getQueueWithUrgency`?** (THE biggest open question) | **Yes** — server-side, set-wise urgency is already built precisely to avoid N+1; client-side recomputation would duplicate the rule SoT and risk drift. | Drives the entire data-flow shape (page.tsx, the drafts route, QueueClient props, the polling fetch). Everything else depends on this. |
| Q2 | Red-flag math: count of urgent-untouched, or 1/0 alert? | Show the **count** (the route already returns `{count}`); render `0` as no-flag, `>0` as a red badge with the number. | Epic lists this as open; the route shape already presumes a count. |
| Q3 | Should the new `urgency` sort be the default queue order? | No — keep `newest` default (matches server `created_at DESC`), make `urgency` opt-in via SortControls. Persisted per operator. | Avoids surprising the operator's current muscle memory. |
| Q4 | Filter persistence scope — per-appliance (operator_id NULL) only? | Yes for v1 — single-operator-per-appliance. Migration 026 already keys on nullable `operator_id`. | No code change needed; just confirm. |
| Q5 | Confidence-band + age-band thresholds for filter chips — reuse urgency `LOW_CONF_FLOOR` (0.75) and `ageThresholdHours`? | Yes — reuse the SoT constants so filter bands and urgency signals agree. | Prevents a second set of magic numbers. |

**Resolved (do not re-open):** override→re-draft is **relabel-only** (in code). Digest send-from is **appliance Gmail OAuth** (in CLAUDE.md). VIP match is **exact-email + domain-suffix, no regex** (built). Thresholds are **env, not table** (built).

---

## 6. Test strategy

- **Urgency evaluator** — already unit-tested (`evaluateUrgency` is the pinned SoT). No new tests; reuse.
- **SQL urgency parity** — `getQueueWithUrgency`/`countUrgentDrafts` are covered by MBOX-134's suite (PR #139). Add a fixture asserting `DraftWithUrgency.urgency.signals` survives the client serialization round-trip.
- **Filter predicate** — pure function unit tests for the new client-side filter/sort (`dashboard/lib/__tests__/queue-filter.test.ts`): each chip (category/status/route/confidence-band/age-band) and each sort key against a fixture list. Reuse `sandbox/src/fixtures/drafts.ts` shapes.
- **Preference round-trip** — integration test for `GET`/`PUT /api/operator/preferences/queue.filters` (route already exists; add a test if MBOX-133 didn't).
- **Vitest** runs in CI (44+ cases, STAQPRO-133). The `dashboard (typecheck + test)` gate is real as of MBOX-337.
- **E2E UAT** (epic acceptance): on M1, override a misclassification → confirm `classification_log` row + denorm sync; let an `escalate` draft sit → confirm badge fires; confirm digest arrives at `DIGEST_SEND_HOUR_LOCAL`.

---

## 7. Blockers / dependencies

- **No hard blockers.** All backends (override, urgency, VIP, filter-prefs, digest) are merged. Sandbox design is locked.
- **Soft dependency:** Q1 decision must be made before T1-T2 start (it's a 1-line call but cascades).
- **Deploy note:** changing `queue/page.tsx` to `getQueueWithUrgency` requires the migration-028 VIP table to exist on the target appliance (it does on M1). Verify before deploy via `/api/system/status`.
- **Digest activation** is per-appliance operational work (re-link Gmail OAuth, set `DIGEST_*` env) — out of code scope; flag to operator for M1.
- **Cross-link:** STAQPRO-284 (surface-but-don't-draft for `security-noreply`) overlaps with the override UX surface — coordinate if both land in the same release, but not a blocker.
