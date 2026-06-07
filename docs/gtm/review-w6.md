# W6 Review Gate — MailBox One GTM Motion

> **Gate:** Week 6 (day 42) of the public motion.
> **Owner:** Dustin · **Attendees:** Dustin, Kevin, Eric Helms
> **Source of truth:** addendum-mailbox-gtm-roadmap-v0_2-2026-05-19.md §3.2, §9.1, §9.2
> **Held during:** the W6 weekly sync (see `sync-agenda.md`)
> **Purpose:** Decide whether price / wedge / channel are right before committing to W8+ scale.

Fill-in-live document. Copy to `review-w6-<YYYY-MM-DD>.md` at the gate, complete during
the sync, record the decision. Leave this template clean.

---

## 0. Snapshot

| Field | Value |
|---|---|
| Review date | `____-__-__` |
| W0 launch date | `____-__-__` |
| Days elapsed since W0 | `__` |
| Filled by | `____` |

## 1. Deposit + order count (the gate metric)

> "External" = customer #3 onward (addendum §2.1). Existing M1/M2 are excluded from these counts.

| Metric | Count | Target context |
|---|---|---|
| External deposits collected (Stripe) | `__` | §9.2 floor: ≥ 3 by W6 |
| External orders confirmed | `__` | §3.2 exit: 10 total customers (2 existing + 8 new) by W6 |
| Total customers (incl. M1/M2) | `__` | |
| Refunds / cancelled deposits | `__` | DR-39 deposits are refundable |

## 2. Kill-criteria status

Per addendum §9.2:

- [ ] **PASS** — 3 or more external deposits by day 42.
- [ ] **BREACH** — **fewer than 3** external deposits → re-examine whether price, wedge, or channel is wrong (§3 below).

## 3. Conversion rates

| Stage | Rate | Notes |
|---|---|---|
| Visitor → order-form start (Plausible) | `__%` | |
| Order-form start → deposit | `__%` | |
| Deposit → confirmed order | `__%` | |
| **Day-60 support continuation** (DR-40) | `__%` | Only if any customer has hit day 60. First subscription-continuation signal; feeds SM-6. |

## 4. Cohort retention (only if a 60-day-plus cohort exists)

> DR-40: every appliance includes 60 days of support, then opt-out at day 60.
> M1 (since April) and M2 (since 2026-05-05) are the only rows likely past day 60 at W6.

- [ ] No customer has reached day 60 yet → **N/A this gate**, revisit at W12.
- [ ] At least one customer past day 60 → fill below:

| Metric | Value | Target |
|---|---|---|
| Customers past day 60 | `__` | |
| Continued at $49/mo | `__` | |
| Opted out (reverted to hardware-only) | `__` | |
| Day-60 continuation rate | `__%` | SM-6 path: ≥ 70% at 6mo (long-run) |

## 5. Price / wedge / channel assessment

Triggered hard if §2 is a BREACH; worth a light pass even on PASS.

**Price** ($699 one-time + $49/mo optional + cloud cost+20%):
- [ ] Right · [ ] Too high · [ ] Too low / under-monetized · [ ] Structure wrong (one-time vs sub mix)
- Evidence: `____`

**Wedge** ("small operator businesses, any industry"; industry-agnostic per 2026-05-08 scrub):
- [ ] Right · [ ] Too broad (no one feels spoken to) · [ ] Should pick a beachhead vertical
- Evidence: `____`

**Channel** (LinkedIn / X / blog / Discord / GitHub per §6):
- [ ] Working · [ ] Wrong channels · [ ] Right channels, weak message · [ ] Under-invested
- Best-performing channel so far: `____`
- Evidence: `____`

## 6. Headline metrics check-in (§9.1)

| Metric | Now | W12 target |
|---|---|---|
| External customers | `__` | 8 (10 total) |
| Classification accuracy (SM-2, classification_log) | `__%` | ≥ 92% wk4 |
| Draft approval rate (SM-4, state_transitions) | `__%` | ≥ 60% wk4 |
| Discord active members (30d) | `__` | ≥ 50 |
| GitHub stars | `__` | ≥ 200 |
| External merged PRs | `__` | ≥ 2 |
| Blog posts shipped | `__/6` | 12/12 by W12 |

## 7. Decision

Pick exactly one.

- [ ] **CONTINUE** — ≥ 3 deposits, fundamentals sound. Proceed into W4→W12 first-shipments + Story 2 activation (§3.3).
- [ ] **ADJUST + CONTINUE** — deposits exist but one of price/wedge/channel is wrong. Name the single biggest change and re-test through W8.
- [ ] **PIVOT** — < 3 deposits. One of price/wedge/channel is materially wrong. Pick which lever moves first; do not scale spend until re-validated.

**Decision:** `____`
**Single biggest change:** `____`
**Owner / deadline:** `____`

## 8. Output

- [ ] Decision recorded above and in the W6 sync notes.
- [ ] If material change to narrative/offer/pricing → feeds **addendum v0.3** (§9.3).
- [ ] Action items carried into next weekly sync agenda.
