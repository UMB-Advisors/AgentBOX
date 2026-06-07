# Addendum: MailBOX Multi-Account Support (Solo Entrepreneur)

> **Target spec:** thumbox-technical-prd-v2_1-2026-04-16.md (§1.1 FR-4, §6 multi-pack, §7 dashboard)
> **Companion specs:** thumbox-business-prd-v2_1-2026-04-16.md, prd-email-agent-appliance.md (§4.1 FR-4, §13 scope boundaries)
> **Addendum started:** 2026-05-20
> **Status:** DRAFT — pending Kevin / Eric review
> **How to use:** This addendum scopes the expansion of MailBOX from one inbox per appliance to multiple inboxes per appliance, targeting the solo-entrepreneur buyer who runs several email identities (personal, founder, consulting, support). Sections marked AMEND modify existing PRD requirements; sections marked NEW introduce structure that does not yet exist. Decision Records are numbered DR-43 onward; Success Metrics SM-88 onward; open questions NC-30 onward — all continuing the shared namespace. Content is tiered: **Accepted** decisions are committed; **Candidate** decisions are gated on the validation spikes in §6 and must not be promoted without evidence.

---

## Change Log

| Date | Section | Summary |
|------|---------|---------|
| 2026-05-20 | §1 (NEW) | Problem framing — solo entrepreneur is N personas, not a bigger inbox |
| 2026-05-20 | §2 (NEW) | Four expansion vectors in dependency order |
| 2026-05-20 | §3 (AMEND, FR-4) | Multi-account ingestion — promote FR-4 from OPEN |
| 2026-05-20 | §4 (NEW) | Per-account persona / RAG / routing isolation |
| 2026-05-20 | §5 (NEW) | Unified cross-account approval queue |
| 2026-05-20 | §6 (NEW) | Validation spikes and kill criteria |
| 2026-05-20 | DR-43 (NEW, Candidate) | Account as first-class data-model dimension |
| 2026-05-20 | DR-44 (NEW, Accepted) | Multi-account is single-operator, not multi-user |
| 2026-05-20 | DR-45 (NEW, Candidate) | Tier gating — multi-account concurrency is T3-first, T2 serialized |
| 2026-05-20 | SM-88 → SM-90 (NEW) | Success metrics |
| 2026-05-20 | NC-30 → NC-32 (NEW) | Open questions |

---

## §1. Problem Framing (NEW)

The current production deployments (M1 Heron Labs, M2 Staqs.io) are **one business, one inbox, one operator** per appliance. The solo-entrepreneur buyer is a different shape: **one human operating several email identities** — e.g. `me@personal`, `founder@startupA`, `consulting@myllc`, `support@`. Same person, different voices, different counterparties, different trust levels.

The requirement is therefore *not* "a bigger inbox." It is collapsing what is today **N appliances into one appliance serving N personas**. That distinction drives every decision below. The win condition is eliminating the context-switch between inboxes, not merely ingesting more mail.

This is the long-deferred FR-4 (`Support multiple email accounts per appliance (up to 3 accounts in v1)`), which has been carried as OPEN since v1 with single-account-per-appliance in production.

---

## §2. Expansion Vectors (NEW)

Four vectors, sequenced by dependency. Each later vector assumes the earlier ones.

| # | Vector | What it delivers | Dependency |
|---|--------|------------------|------------|
| V1 | **Multi-account ingestion** | Poll N Gmail accounts into one appliance; dedup per account | Schema migration (account dimension) |
| V2 | **Per-account persona / RAG / routing isolation** | Each account drafts in its own voice, scoped to its own history | V1 |
| V3 | **Unified cross-account approval queue** | One review session, drafts badged by account + voice | V1, V2 |
| V4 | **Cross-account intelligence** (deferred, Phase 3+) | "This counterparty emailed your consulting address last month and your founder address today" | V1–V3 + relationship graph |

V1–V3 are the launchable scope for this addendum. V4 is the structural moat — only a single-appliance-multi-account design can know it, and a multi-tenant cloud SaaS structurally cannot — but it is explicitly **deferred** and tracked, not committed. It corresponds to the existing "cross-account graph merge" future-consideration line in prd-email-agent-appliance.md §13.

---

## §3. Multi-Account Ingestion (AMEND — FR-4)

The live ingestion path multi-accounts cleanly because it is poll-based, not push-based (Pub/Sub was retired under DR-22). The validated pattern is `Schedule trigger → Gmail Get Many (label-filtered) → Postgres Insert ON CONFLICT (message_id) DO NOTHING`.

**Required changes:**

1. **One Gmail OAuth credential per account**, stored in n8n's encrypted credential store. Credentials remain per-account isolated (consistent with the platform's per-pack credential isolation principle — a compromise of one account's tokens must not leak another's).
2. **An `account_id` (or `mailbox_id`) dimension** added to every pipeline table that currently assumes a single mailbox: `inbox_messages`, `drafts`, `classification_log`, the Qdrant RAG collection payload, and state-transition audit. This is the substantive work — a schema migration, not a feature toggle. See DR-43.
3. **Ingestion fan-out**: either loop the Gmail Get node over a configured account list, or run parallel Schedule triggers per account. Decision deferred to implementation; both fit the existing dedup-idempotency model.

**Quota note:** Gmail's quota is ~1B units/day per user and the dedup-poll pattern already runs ~5x a true-trigger's quota. Three accounts polled every 5 min remains trivially within budget — **but confirm the quota is per-account, not per-appliance/per-project**, before fan-out. (Tracked as part of §6 spike work.)

---

## §4. Per-Account Persona / RAG / Routing Isolation (NEW)

This is the vector that makes multi-account worth paying for. The architecture is already most of the way there: persona is a prompt-layer override, and RAG is counterparty-scoped. The change is promoting **account** to a first-class scoping key.

- **Persona:** each account carries its own persona prompt (its own voice). A `consulting@` reply and a `support@` reply should not sound the same.
- **RAG scope:** retrieval is scoped to `account_id` by default (a founder's startup history must not bleed into consulting drafts). Cross-account retrieval is a deliberate, opt-in V4 feature, not a default.
- **Routing:** per-account classification routing config (`LOCAL_CATEGORIES` / `CLOUD_CATEGORIES` / confidence thresholds) so a high-stakes account can be tuned more conservatively than a low-stakes one.

---

## §5. Unified Cross-Account Approval Queue (NEW)

The solo founder's whole problem is context-switching between inboxes; the appliance's job is to eliminate that switch. **One queue, one review session**, with each draft badged by which account it belongs to and which voice it was written in. Account becomes a filter/badge dimension, not a separate queue.

This is the same pattern as the platform's existing cross-pack unified approval queue, applied one level down (cross-account instead of cross-pack). This is where the persona is won or lost — a per-account queue that forces N separate review sessions defeats the entire value proposition.

---

## §6. Validation Spikes & Kill Criteria (NEW)

Two Candidate decisions (DR-43, DR-45) are gated on these spikes. Do not promote to Accepted without evidence.

| Spike | Question it answers | Kill criterion |
|-------|---------------------|----------------|
| **S1 — T2 concurrency benchmark** | Can a Jetson (T2) classify+draft for 3 accounts under realistic concurrent inbound without breaching the 4.0 GiB / 4K-ctx ceiling or violating the p95 < 5s classify SLO? | If serialized 3-account load on T2 cannot hold classify p95 < 5s with acceptable draft latency, multi-account concurrency is **T3-only** and T2 is capped or serialized (DR-45). |
| **S2 — Schema migration dry-run** | Does adding `account_id` across `inbox_messages` / `drafts` / `classification_log` / RAG payload / audit migrate cleanly against M1/M2 live data with backfill? | If backfill cannot assign a deterministic account to historical rows without manual surgery, the migration design needs rework before any customer ships. |
| **S3 — Gmail quota verification** | Is the daily quota per-account or per-appliance/project? | If per-project, fan-out math must be re-derived before promising 3 accounts. |

This mirrors the financeBOX NC-14 discipline: the most likely kill criterion (T2 hardware adequacy under concurrent load) is the first benchmark to run.

---

## §7. Decision Records

### DR-43: Account as a First-Class Data-Model Dimension (Candidate)

**Decision:** Introduce `account_id` as a first-class scoping key across the pipeline schema, rather than overloading the existing customer/appliance abstraction.

**Type:** Architectural | **Date:** 2026-05-20 | **Status:** CANDIDATE — gated on S2 (§6)

**Alternatives considered:**

| Option | Trade-off |
|--------|-----------|
| Overload existing customer/appliance row | No migration; but conflates "who owns the box" with "which inbox" — breaks the moment one operator has multiple identities, which is the entire use case. |
| New `accounts` table + FK across pipeline tables | Clean separation; requires migration touching 5+ tables + RAG payload + backfill. |
| Per-account separate Postgres schema | Strong isolation; defeats the unified-queue requirement (§5) and multiplies operational surface. |

**Kill criterion:** S2 backfill cannot assign deterministic account to historical rows without manual surgery.

**Confidence:** Medium-high. The clean-separation option is almost certainly correct; the risk is migration mechanics, not the design.

---

### DR-44: Multi-Account is Single-Operator, Not Multi-User (Accepted)

**Decision:** Multi-account support assumes **one human operator** managing multiple inboxes. It does NOT introduce multi-user access control, roles, or RBAC. The appliance remains single-admin (v1 is single admin user).

**Type:** Scope | **Date:** 2026-05-20 | **Status:** Accepted

**Rationale:** A solo entrepreneur is, by definition, one person. Pinning this explicitly avoids scope-creep into the multi-user/RBAC rabbit hole (which remains a separate Phase 3+ future-consideration). Multi-account and multi-user are orthogonal and must not be conflated.

**Consequences:**
- No change to Caddy basic_auth single-credential model.
- The unified queue (§5) is single-operator by design — no per-user views.

**Cost impact:** None — this decision *prevents* cost by bounding scope.

---

### DR-45: Multi-Account Concurrency is T3-First; T2 Serialized or Capped (Candidate)

**Decision:** On T2 (Jetson), multi-account inference is serialized through the existing single-model envelope; true concurrent multi-account processing is a T3 (Mac mini) capability. T2 may cap the account count or queue cross-account work rather than run it in parallel.

**Type:** Architectural | **Date:** 2026-05-20 | **Status:** CANDIDATE — gated on S1 (§6)

**Rationale:** T2's validated ceiling is 4.0 GiB combined model + KV cache at 4K context. Three accounts implies up to 3x classify+draft load on the same box. Concurrent inference plausibly breaches the envelope; serialization preserves it at the cost of latency. The benchmark decides.

**Kill criterion:** If S1 shows serialized 3-account T2 load cannot hold classify p95 < 5s, multi-account ships T3-only and T2 is explicitly capped (e.g. 2 accounts) or excluded.

**Confidence:** Low until S1 runs. This is the most likely thing to constrain the feature.

---

## §8. Success Metrics

| # | Metric | Target |
|---|--------|--------|
| SM-88 | Per-account draft-voice acceptance | Per-account approval rate within 10% of the single-account baseline (voices are genuinely distinct and usable) |
| SM-89 | Context-switch elimination | Operator reviews all accounts in a single queue session; zero per-account queue navigation required |
| SM-90 | T2 SLO under multi-account load | Classify p95 < 5s sustained with N accounts active (N determined by S1) |

---

## §9. Open Questions

| # | Question | Section | Impact |
|---|----------|---------|--------|
| NC-30 | Does multi-account force the Outlook/M365 dependency? Solo founders frequently run mixed providers (a Gmail + an Outlook). NC-29 already gates Outlook on "customer #N where Gmail isn't on the table" — multi-account may *be* that forcing function. | §3 | Provider scope; may pull NC-29 forward |
| NC-31 | What is the launch cap on accounts-per-appliance? FR-4 says "up to 3 in v1." Is 3 still right post-S1, or does T2 cap lower / T3 cap higher? | §6 (S1), DR-45 | Feature boundary + marketing copy |
| NC-32 | Is multi-account a Standard-tier feature or a Pro-tier upsell? It is a natural premium differentiator for the solo-entrepreneur segment but adds load the box must absorb. | §4, Business PRD §6.3 | Subscription tier design |

---

## §10. Cross-References

- **Technical PRD v2.1 §1.1 (FR-4)** — the requirement promoted here.
- **Technical PRD v2.1 §6** — T2 operational envelope (the S1 constraint).
- **Technical PRD v2.1 §6.3 / §7** — cross-pack unified approval pattern (§5 inherits it).
- **prd-email-agent-appliance.md §4.1 (FR-4), §13** — live status + cross-account graph future-consideration (V4).
- **prd-email-agent-appliance.md §17.3 (DR-22)** — Pub/Sub kill; why ingestion is poll-based and fans out cleanly.
- **financeBOX discovery gate (NC-14)** — methodological precedent for the S1 hardware-adequacy-first kill criterion.

---

*End of addendum.*
