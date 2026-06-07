# MBOX-162 — S1/S2/S3 spike results (v0.1, 2026-05-28)

Evidence for the addendum §6 validation spikes. Per §6, DR-43 and DR-45 stay
**Candidate** until this evidence is reviewed.

## S1 — T2 concurrency benchmark — NOT RUN (blocked on safety)

The harness is built + unit-tested (`dashboard/lib/eval/concurrency-bench.ts`,
`dashboard/scripts/concurrency-bench.ts`, 17 deterministic tests). It was **not
executed on M1** — recon showed the live box cannot safely host the test in its
current state:

- **Memory headroom too low.** Baseline `MemTotal ≈ 7.43 GiB`, `MemAvailable ≈
  1.67 GiB`, swap already ~1.1 GiB in use. The classify step loads
  `qwen3:4b-ctx4k` (2.5 GB) into Ollama *alongside* the resident llama-cpp
  drafter — the exact DR-25 contention pattern that caused 138 llama-cpp
  restarts. With 1.67 GiB free, even serialized load risks taking down Heron's
  live drafter, before concurrency is even tested.
- **No trace set on the box** (eval/ is gitignored, not in the image) — would
  need building from the live DB first.
- **Harness memory metric — FIXED (2026-05-28).** Previously
  `defaultReadUsedMemGiB()` host-total (`MemTotal − MemAvailable`, ~5.8 GiB on a
  live box) was compared directly to the 4.0 GiB ceiling → guaranteed false-FAIL.
  Now the verdict compares the **workload-attributable delta** (peak − t0
  baseline): `ConcurrencyBenchResult` carries `baseline_mem_gib` +
  `peak_workload_mem_gib`, and `evaluateS1Verdict` takes `peakWorkloadMemGiB`.
  A live-box unit test proves a 6.0 GiB absolute peak with a 0.2 GiB delta now
  PASSES. Caveat: the t0 baseline should be captured with engines warm-but-idle
  for a true model+KV reading (a cold baseline folds model weights into the delta).

**Scheduling decision (operator, 2026-05-28):** accounts are processed
**serially** (scheduled one after another), not simultaneously. This is DR-45's
serialized model and it largely de-risks S1: serialized peak ≈ today's working
single-account peak (one active inference at a time), so the memory envelope is
already satisfied by current operation. The concurrent mode becomes the
"what-if / T3" stress case, not the gate.

**Recommended path for a valid S1 run:** with serialized scheduling + the
delta metric, S1's memory dimension is largely answered (≈ single-account, which
the box already sustains). The remaining measurable signal is **throughput/
latency** — can the box process 3 accounts' mail serially within the poll cycle
while holding classify p95 < 5s. Run on a quiesced window or idle Jetson when
convenient; it is no longer a high-risk gate under the serialized model.

## S2 — Schema migration dry-run — PASS

Candidate migration: `docs/s2-account-id-migration-candidate-v0_1-2026-05-28.sql`
(DRY-RUN artifact — NOT in `dashboard/migrations/`; DR-43 still Candidate).

Dry-run executed against an M1-shaped schema in a throwaway `postgres:17-alpine`
(psql exit 0):

- **Backfill is deterministic.** M1 is single-account today (1,217 inbox /
  239 drafts / 1,218 classify-log / 448 sent rows, one connected mailbox). All
  historical rows backfill to a single seeded `accounts` row — zero ambiguity,
  no manual surgery. **DR-43 kill criterion NOT triggered.**
- **Substantive reshape required:** `inbox_messages` `UNIQUE(message_id)` →
  `UNIQUE(account_id, message_id)`. The same Gmail message can legitimately land
  in two connected inboxes (addressed to founder@ and consulting@); the global
  unique would wrongly reject it. The `/api/internal/inbox-messages` xmax dedup
  must key on `(account_id, message_id)`.
- Verified: composite unique accepts cross-account dup; same-account dup still
  rejected; NOT NULL + FK enforced post-backfill.
- **Out of band:** existing Qdrant `email_messages` points need `account_id`
  added to payload (deterministic → default account; one-shot re-tag, not SQL).

**Verdict: S2 PASS for the 4-table core; promote scope incomplete** (Linus, PR #166).
The dry-run proves DR-43's clean-separation design migrates cleanly with
deterministic backfill for the four core pipeline tables — risk is mechanics
(the unique reshape + dedup-key change), not backfill ambiguity. **But** the live
schema has grown other account-scoped tables the promote-time migration must also
cover: `kb_documents`, `vip_senders`, `auto_send_rules`, `auto_send_audit`,
`chat_conversations`, `chat_messages`, `oauth_tokens`, `draft_feedback`,
`rejected_history` (`state_transitions` inherits via its drafts FK). Extending the
migration to these is a second pass before DR-43 promotes.

## S3 — Gmail quota: per-account or per-project — ANSWERED

> Note: live Google docs could not be re-fetched this session (fetch tooling
> failed). Figures below are from stable, long-published Gmail API limits —
> reconfirm exact numbers against the live quota page if precision matters; the
> per-project vs per-user *structure* is the decision-relevant, stable fact.

- **Daily usage quota is PER-PROJECT:** ~1,000,000,000 quota units/day, shared
  across every account authenticated through that GCP project's OAuth client. So
  3 accounts on one appliance/one project draw from the **same** daily pool.
- **Rate limit is PER-USER:** ~250 quota units per user per second (moving
  average). Each connected Gmail account is a distinct user → **independent**
  per-second buckets; no cross-account per-second contention.
- Per-method cost (approx): `messages.list` 5, `messages.get` 5,
  `messages.send` 100, `messages.modify` 5.

**Fan-out re-derivation (3 accounts):** per 5-min cycle per account ≈
`list(5) + ~50×get(5) = 255` units → 3 × 255 = 765/cycle × 288 cycles/day ≈
**220K units/day** against the 1B/day per-project pool = **~0.02%**. Trivially
within budget even though the daily quota is shared.

**Verdict: S3 resolved** — the per-project daily quota is NOT a constraint for
3 accounts; the binding limit is per-user/sec (independent per account, already
covered by the existing per-account rate-limit cooldown machinery). The
accounts-per-appliance cap (NC-31) is S1/memory-bound, not quota-bound.

## Net

- **S2 PASS, S3 resolved** → DR-43 has clean migration evidence; the remaining
  blocker for promoting DR-43/DR-45 is **S1**, which is gated on (a) a harness
  memory-metric fix and (b) a quiesced/idle-hardware run window.
