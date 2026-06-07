# Addendum: Cloud-Use Doctrine — "Minimize, Don't Eliminate"

**Document type:** Decision Record addendum to `prd-email-agent-appliance.md` §16 (Technology Decision Records)
**Version:** v0.1.0
**Date:** 2026-05-13
**Status:** **DRAFT — pending Eric + Kevin brief before approval** (per parent issue STAQPRO-336 architectural-commitment gate)
**Linear:** STAQPRO-337 (parent: STAQPRO-336; blocks: STAQPRO-345; relates: STAQPRO-339, STAQPRO-344)
**Authors:** Foreman (autonomous draft for review)

---

## TL;DR

The 2026-05-13 design conversation reaffirmed "minimize cloud calls" as a doctrine constraint, but the difference between **soft minimize** (status quo, "local-first, cloud as graceful degradation") and **hard eliminate** (removed from spec) materially affects model bake-off scoring, the LoRA pipeline (STAQPRO-344), the NIM legal review (STAQPRO-339), and the Business PRD's credit-allowance pricing model. This DR codifies the soft interpretation, defines explicit sunset criteria for cloud routing, amends DR-4 and DR-16, and flags the downstream pricing impact.

**The doctrine: minimize, don't eliminate.** Cloud routing remains a supported degradation path. It is not a non-goal. It has explicit sunset criteria — when met, the cloud route is gated off per-customer.

---

## DR-21: Cloud-Use Doctrine — "Minimize, Don't Eliminate"

**Decision:** "Minimize cloud calls" is a soft architectural constraint, not a hard prohibition. Cloud LLM routing remains a supported degradation path for `escalate` / `unknown` / `confidence < 0.75` classifications. The doctrine has explicit per-customer sunset criteria; once any criterion is met, the cloud route MUST be gated off for that appliance and the operator notified.

**Type:** Strategic | **Date:** 2026-05-13 | **Status:** **Draft — Eric + Kevin brief required before approval**

### Context

The 2026-05-13 design conversation produced two interpretations of the long-standing "minimize cloud" principle:

| Interpretation | Position | Architectural impact |
|---|---|---|
| **Soft (this DR — confirmed)** | "Local-first, cloud only as graceful degradation" — status quo per DR-4, DR-16. Needs explicit sunset criteria. | Cloud route stays in the spec, codepath, and pricing tiers. Sunset is per-customer, conditional, and operator-visible. |
| **Hard (rejected for now)** | "Local-only, cloud is a non-goal" — architectural enforcement. | Removes cloud from the spec entirely. Forces immediate action on STAQPRO-339 (NIM license), STAQPRO-344 (LoRA), and credit-allowance repricing. |

Without an explicit DR, every downstream decision inherits the ambiguity:

- **Model bake-off scoring** (STAQPRO-336 children) cannot weight "cloud-fallback rate" without knowing whether cloud-fallback is a permanent or vanishing input.
- **LoRA pipeline design** (STAQPRO-344) cannot decide whether the activation gate is "LoRA improves over local baseline" or "LoRA closes the gap to cloud quality enough to retire cloud."
- **Pricing model** (Business PRD §6.3 — sibling repo / vault, not in this repo) cannot rationally tier credit allowances if cloud volume is on a known glide path to zero in Phase 2+.
- **Per-pack scope** — does the doctrine apply uniformly to MailBOX, receptionBOX, and future packs, or per-pack?

This DR resolves all four.

### The doctrine — restated

> **Minimize cloud routing without eliminating it.** Local-first by default. Cloud routing is a graceful-degradation path for cases where the local model demonstrably underperforms the operator's quality bar. Each appliance has explicit sunset criteria; cloud routing for that appliance terminates when any criterion is met. The cloud codepath remains in the product spec until the last live customer has sunset.

### Sunset criteria (per-customer, ANY-of)

A customer's cloud route is gated off when **any** of the following become true:

1. **Local approval rate ≥ 90% over a rolling 30-day window** for that customer's `LOCAL_CATEGORIES` traffic, **AND** local approval rate ≥ 75% for the previous `CLOUD_CATEGORIES` traffic that gets re-routed local. The 30-day window guards against single-week novelty. Threshold values are open for Eric/Kevin tuning during brief.
2. **A customer-specific LoRA adapter (STAQPRO-344) is trained, activated, and passes the eval-gated quality bar** (criteria TBD as part of STAQPRO-344 — likely: tone/sign-off F1 ≥ baseline-cloud Haiku, and edit-distance on operator-approved drafts ≤ baseline-cloud).
3. **Operator opt-out flag** — `mailbox.system_state.cloud_route_enabled = false` (column to be added in a future migration). Operator-toggleable from a dashboard settings UI; the toggle bypasses #1 and #2. This is the explicit "I want zero cloud, I accept lower quality" lever.
4. **Cloud provider becomes unavailable to us** (legal — STAQPRO-339, billing, deprecation, etc.). Auto-flip to gated-off; notify operator; surface a banner.

When any criterion fires, the routing layer (`dashboard/lib/classification/prompt.ts:routeFor`) returns `local` regardless of category, and the dashboard surfaces the change in the operator's settings page so they understand why a draft they expected to be cloud-quality is now local.

### Per-pack scope

The doctrine applies **uniformly across all packs** (MailBOX, future receptionBOX, etc.) at the doctrine level. Per-pack escape hatches are permitted for one specific reason only: a pack ships with **no local model capable of the task**. In that case, the pack's spec MUST document the cloud dependency in its own `§5.x Cloud LLM` section and call out the doctrine deviation explicitly. receptionBOX v1 (per the issue's reference to its §5.3 "Cloud LLM (optional, OFF default)") is already aligned — verify in receptionBOX repo (see follow-ups).

### Reconciliation with prior DRs

- **DR-4 (Hybrid Local + Cloud Inference)** — amended (see "Amendment to DR-4" below). DR-4's "80%+ local, cloud fallback for quality-sensitive drafts" framing is preserved; this DR adds the sunset machinery that DR-4 lacked.
- **DR-16 (NVIDIA NIM as Phase 1 cloud provider)** — amended (see "Amendment to DR-16" below). NIM's "developer evaluation perk" caveat plus the Ollama Cloud / Anthropic pivot already documented in root CLAUDE.md mean DR-16 needs a sunset date independent of this DR; folding both together here.
- **DR-23 (Anthropic Haiku 4.5 as primary cloud draft model)** — already SUPERSEDED 2026-04-30 in root CLAUDE.md (Ollama Cloud `gpt-oss:120b` is now default). No change here.

### Alternatives considered

| Option | Trade-off | Why rejected |
|---|---|---|
| **Hard "local-only" doctrine** | Maximally clear; eliminates legal/cost surface. | Premature. Local-only quality on `escalate` traffic isn't proven. Forces STAQPRO-339 and STAQPRO-344 to be blockers, not parallel work. |
| **No sunset criteria — keep cloud as permanent fallback** | Simplest. | Indefensible. Without sunset machinery, "minimize" is rhetorical. Operators have no path to opt out of cloud. |
| **Time-based sunset** (e.g., "cloud removed at end of Phase 2") | Easy to communicate. | Couples doctrine to schedule, not to capability. If LoRA slips, we either ship with cloud past the deadline (doctrine violated) or ship without it (quality regression). Capability-gated sunset is the right primitive. |
| **Per-customer toggle only — no auto-gate** | Maximally operator-respecting. | Operators won't notice when local quality crosses the line. The auto-gate is the observability mechanism. The toggle remains as override. |

### Rationale

1. **Local-first is the product, not the implementation detail.** The privacy story (CLAUDE.md project Constraints: "All email content stored only on local appliance. No bulk corpus sent to cloud.") is the central differentiator. Codifying it as soft doctrine with sunset criteria converts marketing language into operational machinery.
2. **Capability-gated sunsets respect reality.** LoRA may close the gap in 6 weeks or 6 months. The criteria fire when the local route is provably good enough, not when the calendar says so.
3. **The cloud route stays cheap to maintain.** Per the n8n boundary contract, cloud is the same `/api/chat` shape as local Ollama with a different `baseUrl` + `apiKey`. Keeping it costs ~50 lines of routing code and one row in the persona resolver. Removing it doesn't materially simplify the codebase.
4. **Per-customer sunset > global sunset.** Customer #1 (Heron Labs, CPG) and customer #2 (Staqs, dev tools) will not cross sunset criteria at the same time. Per-appliance state already exists in `mailbox.system_state` (post-STAQPRO-226); adding `cloud_route_enabled` is a single-column migration.
5. **Eric + Kevin briefing is non-negotiable.** Per the issue's "Eric and Kevin briefed before approval (per memory note on architectural commitments)" gate — this DR is shipped as **Draft** and MUST NOT be marked Approved without explicit sign-off captured in the Linear issue thread.

### Cost

- One column on `mailbox.system_state` (`cloud_route_enabled boolean default true`) — trivial migration.
- One settings UI affordance in the dashboard (operator-visible toggle + sunset-criteria status) — small Next.js page.
- A small daily aggregator that evaluates criteria #1 and writes the toggle state (or surfaces a "ready to sunset" banner if the operator hasn't opted in to auto-gating). Existing `mailbox.classification_log` + `mailbox.drafts` rows are sufficient inputs.
- Eric + Kevin brief time before approval.

### Affects

- **DR-4** — amended (this addendum, "Amendment to DR-4" below).
- **DR-16** — amended (this addendum, "Amendment to DR-16" below).
- **`prd-email-agent-appliance.md` §16** — DR-21 inserts in numerical order at next PRD revision.
- **`prd-email-agent-appliance.md` §7.4 (Classification Router Logic)** — must reference the sunset gate as an additional pre-routing check.
- **`prd-email-agent-appliance.md` §9 (Pricing Model)** — credit allowance and BYOK pricing must accommodate the per-customer sunset trajectory; specifically, customers who cross sunset criteria #1 or #2 will use near-zero cloud credits, so a flat credit-allowance tier (100 / 300 / 800 referenced in the issue body, presumably from Business PRD §6.3) overcharges them. Two options for the pricing reconciliation: (a) keep credit tiers but rebate unused, or (b) move to a base subscription + metered cloud overage. Tracked as a follow-up — needs Business PRD owner (presumably Dustin) to land before pricing materials reprint.
- **Business PRD §6.3 (credit-allowance pricing)** — sibling-repo / vault doc, NOT in this repository. Requires a parallel addendum in that repo. Tracked as a follow-up issue.
- **receptionBOX v1 spec §5.3 ("Cloud LLM (optional, OFF default)")** — sibling-repo / vault doc, NOT in this repository. Issue body says "likely already aligned but verify"; aligned with this DR if §5.3 documents (a) cloud is OFF default, (b) opt-in toggle exists, (c) doctrine deviation is called out in spec body. Tracked as a follow-up issue.
- **STAQPRO-336 children** — cleared to proceed with model bake-off, LoRA pipeline (STAQPRO-344), and NIM legal review (STAQPRO-339) using the soft-doctrine framing.
- **STAQPRO-345** (close-out addendum that merges all M5 workstream learnings into the technical PRD) — this DR's content folds into that addendum verbatim or by reference.

---

## Amendment to DR-4 — Hybrid Local + Cloud Inference

DR-4 (in `prd-email-agent-appliance.md` §16) reads "Route simple tasks to local Ollama, complex tasks to cloud Claude API" with rationale "80%+ of email volume handled locally at zero marginal cost, with cloud fallback for quality-sensitive drafts."

**Amendment (2026-05-13, this addendum):**

1. The "80%+" framing is **descriptive, not aspirational**. The aspirational target per DR-21 is local approval rate ≥ 90% on `LOCAL_CATEGORIES` and ≥ 75% on re-routed `CLOUD_CATEGORIES`, after which the cloud route is gated off for that customer.
2. The "cloud Claude API" identifier is **stale** — already superseded by DR-23 (Ollama Cloud `gpt-oss:120b` default; Anthropic Haiku 4.5 config-ready alt) and again clarified here. The cloud provider is swappable per appliance build per the addendum-t2-build-validation §5.3 amendment.
3. **Sunset criteria** apply per DR-21. Cloud routing for an appliance ends when any DR-21 criterion fires.
4. **Status:** Active (with amendments). Sunset trajectory: per-customer, capability-gated, no global deadline.

---

## Amendment to DR-16 — NVIDIA NIM (Free Dev Tier) as Phase 1 Cloud LLM Provider

DR-16 (in `dashboard/.planning/spec/addendum-t2-build-validation-v0_1-2026-04-25.md`) named NVIDIA NIM's free developer tier as the cloud LLM provider for **internal/staff** appliances during Phase 1.

**Amendment (2026-05-13, this addendum):**

1. **Production status correction:** NIM was always scoped to internal/dev only (per DR-16's own "Caveats" — 40 RPM and ~1000 req/month cap). Live customer #1 and #2 do **not** route through NIM; they route through Ollama Cloud `gpt-oss:120b` per the 2026-04-30 pivot already documented in root CLAUDE.md.
2. **DR-16 is therefore effectively retired for production use** as of the 2026-04-30 pivot, even though no formal sunset was recorded at that time. This amendment records the retirement.
3. **Internal/dev usage of NIM** may continue for prototyping if it remains a free tier. A formal NIM legal review for any redistribution scenario is tracked in **STAQPRO-339** (related issue per parent STAQPRO-336).
4. **Sunset criteria** for the production cloud route (Ollama Cloud `gpt-oss:120b`) apply per DR-21. NIM is not in the production route, so DR-21 sunset does not directly apply to it; if NIM is reintroduced for any production use it inherits DR-21 sunset.
5. **Status:** Superseded for production (by 2026-04-30 Ollama Cloud pivot, formally recorded here). Active for internal/dev only, gated on STAQPRO-339 outcome.

---

## Brief checklist (Eric + Kevin, before approval)

Mark each box and capture decisions in the STAQPRO-337 Linear thread before flipping this DR to Approved:

- [ ] Eric reviewed: doctrine framing — soft minimize, not hard eliminate.
- [ ] Kevin reviewed: doctrine framing.
- [ ] Sunset criterion #1 thresholds (90% / 75% / 30-day) confirmed or revised.
- [ ] Sunset criterion #2 — LoRA activation gate criteria deferred to STAQPRO-344 — confirmed.
- [ ] Sunset criterion #3 — operator opt-out toggle scope confirmed (column + UI + cost model).
- [ ] Per-pack scope confirmed — uniform across MailBOX / receptionBOX / future packs.
- [ ] Pricing reconciliation owner assigned (Business PRD §6.3 follow-up).
- [ ] receptionBOX §5.3 verification owner assigned (sibling-repo follow-up).
- [ ] Approved date and approver names captured here and in STAQPRO-337 thread.

Once the brief is captured, this addendum's `Status` line flips from **Draft** to **Approved (date / Eric, Kevin)**, this section is left in place as evidence, and STAQPRO-337 is moved to Done.

---

## Follow-ups (open after this DR)

| # | Action | Owner | Tracking |
|---|---|---|---|
| 1 | Brief Eric and Kevin; capture decisions; flip to Approved | Dustin | STAQPRO-337 thread |
| 2 | Parallel addendum in Business PRD repo for §6.3 credit-allowance reconciliation | Business PRD owner (Dustin) | New issue, link to STAQPRO-337 |
| 3 | Verify receptionBOX v1 spec §5.3 alignment | receptionBOX spec owner | New issue, link to STAQPRO-337 |
| 4 | Add `mailbox.system_state.cloud_route_enabled` column + dashboard settings UI + daily sunset-criteria aggregator | Eng | New STAQPRO-* issue (downstream of approval) |
| 5 | Update `dashboard/lib/classification/prompt.ts:routeFor` to honor the sunset gate | Eng | Same issue as #4 |
| 6 | Fold this DR into STAQPRO-345 (M5 close-out addendum) once Approved | Whoever drives STAQPRO-345 | STAQPRO-345 |

---

## Sources

- Linear: STAQPRO-337 (this issue), STAQPRO-336 (parent), STAQPRO-339 (NIM legal), STAQPRO-344 (LoRA), STAQPRO-345 (close-out)
- `prd-email-agent-appliance.md` §16 (DR-1 through DR-5; DR-4 is the original hybrid-routing decision)
- `dashboard/.planning/spec/addendum-t2-build-validation-v0_1-2026-04-25.md` §5.3, DR-16 through DR-20
- Root `CLAUDE.md` Active Decision Records table (DR-17 superseded; DR-22 KILLED; DR-23 SUPERSEDED — frame for how supersession is recorded)
- Conversation: 2026-05-13 design discussion (referenced in issue body; not transcribed in repo)
