# Phase 2 Entrance Criteria Runbook v0.1.0

**Status:** v0.1.0 — first version, tracks STAQPRO-173.

**Audience:** Product (Dustin / Eric) deciding whether M4 ("Phase 2 — RAG follow-on, edit-to-skill, multi-pack") moves from Backlog to active execution. Without an objective bar this becomes a vibe call; this runbook is the gate.

**Tracks:** STAQPRO-173. Parent: STAQPRO-167 (M4 scope-preservation umbrella).

**Companion docs:**
- `customer-2-success-criteria.v0.1.0.md` (STAQPRO-179) — M3 entry gate (customer #2 Delivered). This doc is the next gate after that one closes.
- `customer-2-day-1-monitoring.v0.1.0.md` (STAQPRO-178) — first-72h watchlist applied to every new appliance; feeds the "steady state" definition below.

---

## When to use this runbook

Run all gates immediately before starting any M4 work (the open Backlog issues under STAQPRO-167 plus any future RAG follow-on / edit-to-skill / multi-pack work). Evaluate every other Friday until all gates PASS; once all pass, Phase 2 (M4) starts the following Monday. If any single gate flips from PASS to FAIL after Phase 2 starts, do **not** retroactively halt — finish the in-flight plan, then re-evaluate before picking up the next one.

This runbook is **not** for daily monitoring (that's the day-1 runbook) and **not** for continuous SM tracking (that's the post-M3 dashboards). It's the once-per-eval-cycle Backlog/Active decision.

---

## Gates — all must pass

Each gate has a metric source, a target, and a measurement command (or a pointer to where the value lives today). If a gate has no measurement infrastructure yet, that gap is itself blocking — write the SQL or surface the value before claiming PASS.

### 1. Classification accuracy holds

**Why**: M4 work (RAG follow-on, edit-to-skill) assumes the classifier is good enough that its output can be trusted as a routing signal and as a training label for the edit-to-skill loop. Below ~92% the classifier itself is the load-bearing problem, not retrieval or learning.

**Metric**: PRD §10 SM-2 (rolling 7-day classification accuracy). Operator-corrected ratio: `1 - (corrections / total classified)`.

**Target**: ≥ 92% sustained for 4 consecutive weeks across all live customers, computed weekly.

**Measurement**:
```sh
ssh mailbox1 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -c "
  SELECT
    DATE_TRUNC('\''week'\'', classified_at) AS wk,
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE corrected = false) * 1.0 / NULLIF(COUNT(*), 0) AS accuracy
  FROM mailbox.classification_log
  WHERE classified_at >= NOW() - INTERVAL '\''4 weeks'\''
  GROUP BY 1
  ORDER BY 1;"'
```
Repeat for mailbox2. PASS = every week-bucket ≥ 0.92 on both appliances.

**Note on the corpus-score vs production-score distinction**: the MAIL-08 gate PASS at 73.2% (2026-04-30) is a *route* score on a 635-row labeled corpus, not a production operator-correction score. This gate uses the production correction signal because that's what M4 work consumes.

---

### 2. Draft approval rate holds

**Why**: edit-to-skill (one of the three M4 tracks) needs an approval-rate baseline to measure improvement against. Below ~60% approved-without-edit the operator is doing more rewriting than approving, which means the current persona + RAG path is already broken — fixing it is M3.5 / persona work, not M4.

**Metric**: PRD §10 SM-4 (rolling 7-day approval rate). `count(status = 'approved' OR status = 'sent') / count(all drafts)` where the draft was not edited before approval.

**Target**: ≥ 60% sustained for 4 consecutive weeks across all live customers.

**Measurement**:
```sh
ssh mailbox1 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -c "
  SELECT
    DATE_TRUNC('\''week'\'', created_at) AS wk,
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE status IN ('\''approved'\'', '\''sent'\'')) * 1.0
      / NULLIF(COUNT(*), 0) AS approval_rate
  FROM mailbox.drafts
  WHERE created_at >= NOW() - INTERVAL '\''4 weeks'\''
  GROUP BY 1
  ORDER BY 1;"'
```
Repeat for mailbox2. PASS = every week-bucket ≥ 0.60 on both appliances. "Edited" status counts as non-approval for this gate — that's the signal edit-to-skill is supposed to reduce.

---

### 3. Uptime holds

**Why**: M4 work touches retrieval and learning paths that run inside every classify/draft cycle. If the base pipeline is flaky, M4 changes will be hard to attribute. Need a stable platform first.

**Metric**: PRD §10 SM-5 (monthly appliance uptime). All 6 services healthy as a single boolean per minute-bucket.

**Target**: ≥ 99% uptime for 2 consecutive calendar months across all live customers.

**Measurement**: today this is computed by hand from `docker compose ps` snapshots + the `/status` dashboard. Until automated uptime tracking lands (out of scope here — track separately), the gate-eval step is:
1. SSH each appliance, grep journal for service restarts in the eval window
2. Cross-check against any incidents in the day-1 monitoring runbook or operator-reported outages
3. Compute downtime minutes / total minutes

PASS = ≤ 432 downtime-minutes per 30-day window per appliance.

---

### 4. Customer count + steady-state

**Why**: Phase 2 work is justified only if the build is proven across more than one customer. M3 ships customer #2; M4 should not start with N=1 in steady state.

**Target**: ≥ 2 customers live AND each customer ≥ 30 days post day-1 monitoring close (i.e., the `customer-2-day-1-monitoring.v0.1.0.md` runbook closed PASS with no Sev-1 follow-up open).

**Measurement**: roster check.
- Customer #1 (Heron Labs / mailbox1): live since 2026-04-29 (M1 Delivered), day-1 monitoring N/A (preceded the runbook).
- Customer #2 (Staqs / mailbox2): live since 2026-05-05 (M2 Delivered). Day-1 monitoring close target T+72h ≈ 2026-05-08; steady-state-30 = 2026-06-07.

PASS = today's date ≥ 2026-06-07 AND no open Sev-1 issue on either appliance.

---

### 5. Corpus volume

**Why**: RAG follow-on work needs a non-trivial corpus before retrieval delivers signal over the existing persona + KB drafting path. Below ~200 sent drafts the relationship graph is too sparse to be measurably better than the persona stub.

**Target**: ≥ 200 sent drafts across all live customers in the trailing 30 days at eval time.

**Measurement**:
```sh
ssh mailbox1 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT COUNT(*) FROM mailbox.sent_history WHERE sent_at >= NOW() - INTERVAL '\''30 days'\'';"'
ssh mailbox2 'docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -tAc \
  "SELECT COUNT(*) FROM mailbox.sent_history WHERE sent_at >= NOW() - INTERVAL '\''30 days'\'';"'
```
PASS = `sum across appliances ≥ 200`.

---

### 6. Concrete asks exist

**Why**: M4 features should be pulled by real customer demand, not pushed by curiosity. The M4 description gates Phase 2 on "customer feedback bandwidth" — this turns that into an artifact check.

**Target**: ≥ 3 distinct customer-originated requests for Phase 2 features (RAG follow-on, edit-to-skill, multi-pack) captured as Linear issues or written customer-feedback notes, with customer attribution. Theoretical wants from internal team don't count.

**Measurement**: hand-search Linear for issues tagged `mailbox` + `customer-feedback` (or equivalent label) created in the trailing 90 days where the description names a specific customer + a specific Phase 2 capability.

PASS = ≥ 3 such issues found.

---

### 7. Risk closure

**Why**: M4 expands surface area (more pipelines, more state). Carrying unowned risks into a scope expansion is how outages happen.

**Target**: every active risk on STAQPRO-166 (M2 risk + SM owner assignments) has a named owner AND a mitigation that is either DELIVERED or has a target-date inside the next quarter. No open Urgent or High-priority risk without an owner.

**Measurement**: open STAQPRO-166, walk the 7-risk + 6-SM table (post-DR-22 KILL counts), confirm each row has `owner != null` and `status in {DELIVERED, in-flight with date}`.

PASS = all rows green.

---

## Today's snapshot (2026-05-13)

Filled in by hand at doc commit; refresh on each eval. Numbers below are inventory only — they do **not** unlock M4 until the targets above hold on the eval-date measurement.

| Gate | Current state | Target | PASS? |
|---|---|---|---|
| 1. Classification accuracy | Last measured 2026-04-30: 73.2% route accuracy on labeled corpus (MAIL-08 gate). Production operator-correction ratio not yet computed weekly. | ≥ 92% × 4 wk | UNKNOWN — measurement infra gap |
| 2. Draft approval rate | M2 (Staqs) week 1 saw 0 approved / 96 rejected before STAQPRO-330 fix; post-fix data ≤ 1 week old. Heron Labs steady-state TBD measure. | ≥ 60% × 4 wk | UNKNOWN — too soon post-fix |
| 3. Uptime | No formal tracking. Anecdotal: mailbox1 has been up since 2026-04-29 with one Gmail rate-limit incident; mailbox2 since 2026-05-05 with the Qwen3 thinking-mode regression resolved 2026-05-12. | ≥ 99% × 2 mo | UNKNOWN — measurement infra gap |
| 4. Customer count + steady-state | 2 customers live. mailbox2 steady-state-30 reaches 2026-06-07. | 2 customers × 30 days post day-1 | NO (date) |
| 5. Corpus volume | Trailing 30-day sent count: not yet measured. Customer #2 was rate-limited / regressing for first week, so likely low. | ≥ 200 / 30 days | UNKNOWN |
| 6. Concrete asks | None captured against the M4 issues to date. M4 issues (STAQPRO-169/170/171) were internally created; STAQPRO-172/173 are housekeeping. | ≥ 3 | NO |
| 7. Risk closure | STAQPRO-166 status not refreshed since M2 close 2026-05-01. | All owned + dated | UNKNOWN |

**Net**: Phase 2 (M4) entrance gate is **NOT MET** as of 2026-05-13. Earliest feasible re-eval is **2026-06-07** (gate 4 date-floor). Before then, the measurement gaps in gates 1, 3, 5, 7 should close — otherwise re-eval will return UNKNOWN even if the underlying metrics are healthy.

---

## Out of scope

- Defining the metrics themselves — PRD §10 is the source of truth.
- Building the dashboards / queries that surface metrics continuously — separate ops work (referenced as a gap above; not blocking this doc).
- Actually doing Phase 2 work — STAQPRO-167 + Backlog stubs own that.
- The M5 (productization) entrance gate — sibling milestone, different criteria, not covered here.

---

## Evolution

- v0.1.0 (2026-05-13) — initial draft, STAQPRO-173.
- Bump patch on snapshot refresh, minor on adding/removing gates, major on changing the "all must pass" rule.

---

## Re-eval cadence

Every other Friday 09:00 PT until all gates PASS. After PASS, this doc is archived; the M4 issues move from Backlog to Todo and execution begins the following Monday. Re-eval is owned by Dustin; one-line status posted to project channel (or whatever the standup surface is at that time).
