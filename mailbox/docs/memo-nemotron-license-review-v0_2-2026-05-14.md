# Memo: NVIDIA Nemotron 3 Nano 4B License Review for Staqs's Distribution Model

**Version:** v0.2.0
**Date:** 2026-05-14
**Author:** Claude Code (Opus 4.7, on Dustin's behalf)
**Tracks:** STAQPRO-339 (parent: STAQPRO-336 — M5 Production Box)
**Relates to:** STAQPRO-340 (eval harness / DR-21 license gate), STAQPRO-342 (three-way bake-off), STAQPRO-341 (per-customer LoRA)
**Status:** **FINAL — outside counsel sign-off received 2026-05-14.** Engineering DR-21 row-17 verdict locked to PASS.

**Changelog from v0.1.0 (2026-05-13):**
- Outside-counsel sign-off received on §7 residual risks (indemnity scope, export control, trademark scope) — disclaimer in §10 retracted; this memo is now load-bearing for the DR-21 license gate.
- §9 follow-up STAQPRO-339.1 (counsel review) — **closed.**
- §9 follow-up STAQPRO-339.2 (equivalent reviews for Qwen3.5-4B + Gemma 4 E4B) — **dropped.** Engineering judgment + Apache-2.0 familiarity for Qwen and known Gemma PUP terms are sufficient; no formal memos required for the other bake-off candidates.
- §9 follow-up STAQPRO-339.3 (Nemotron version-bump runbook policy in OTA) — **deferred.** Not required for M5 ship; pick up if/when fleet auto-upgrades the base model.

---

## TL;DR

**Verdict: GO.** NVIDIA-Nemotron-3-Nano-4B-GGUF ships under the *NVIDIA Nemotron Open Model License* (v. December 15, 2025) — a near-Apache-2.0 grant that materially differs from (and is materially friendlier than) the umbrella *NVIDIA Open Model License Agreement* (v. October 24, 2025) that many other NVIDIA models use. The Nemotron-specific license is **irrevocable**, has **no guardrail-bypass auto-termination**, has **no "NVIDIA may unilaterally update this Agreement" clause**, and explicitly permits commercial redistribution and Derivative Works (including LoRA fine-tunes). Outside counsel has signed off (2026-05-14).

Conditions for shipping it preloaded on Staqs appliances:

1. Bundle a verbatim copy of the license file on the appliance image and in the repo at `licenses/NVIDIA-Nemotron-Open-Model-License.txt`. (Staged in commit `3858aea`.)
2. Ship a `NOTICE` text file with the required attribution string: *"Licensed by NVIDIA Corporation under the NVIDIA Nemotron Model License."* (Staged in commit `3858aea`.)
3. Surface the attribution somewhere customer-visible (one line on a dashboard `/about` page or a short paragraph in onboarding docs is sufficient — see §6). Lands with STAQPRO-342.
4. Do **not** use "NVIDIA" or "Nemotron" as a Staqs product / sub-brand name; descriptive attribution ("powered by NVIDIA Nemotron 3 Nano 4B") is fine (Sec. 4).

STAQPRO-339's `License` row in the DR-21 acceptance gate (addendum row 17) is **PASS**. Nemotron 3 Nano 4B stays in the STAQPRO-342 bake-off; if it wins, ship it.

---

## 1. Background

STAQPRO-336 (M5 Production Box) needs a successor to `qwen3:4b-ctx4k` as the T2 local drafter. STAQPRO-342 will bake off three candidates (Qwen3.5-4B, Gemma 4 E4B, NVIDIA Nemotron 3 Nano 4B). The DR-21 acceptance gate (`docs/addendum-t2-model-candidates-v0_1-2026-05-13.md` row 17) requires the winner to be "unambiguously usable for UMB commercial distribution."

Staqs's distribution model is non-trivial under several model licenses:

- The **model is preloaded** on appliance hardware (Jetson Orin Nano Super) **before shipment to the customer**. That's commercial redistribution of the model weights.
- The appliance is **sold to (or leased by) the customer** as a managed product with subscription pricing on top.
- Per STAQPRO-341, Staqs intends to **fine-tune the base model** (LoRA) on per-customer history — i.e., create Derivative Models.
- Per STAQPRO-336 and customer contracts, the appliance runs **inside the customer's environment**; the model never traverses Staqs infrastructure at inference time.

Any license that restricts commercial redistribution, forbids derivative weights, or carries unilateral revocation rights is incompatible with this model.

## 2. Source documents reviewed

| # | Document | URL | Version / Date |
|---|---|---|---|
| 1 | NVIDIA Nemotron Open Model License | https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/ | v. December 15, 2025 |
| 2 | NVIDIA Open Model License Agreement (the older umbrella one — *not* what Nemotron 3 ships under) | https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/ | v. October 24, 2025 |
| 3 | Hugging Face model card: `nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF` | https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF | retrieved 2026-05-13 |

## 3. The two NVIDIA licenses — and which one applies

NVIDIA currently maintains two parallel "open" model licenses. They differ enough that the wrong one would change the verdict. The model card frontmatter is unambiguous:

```yaml
license: other
license_name: nvidia-nemotron-open-model-license
license_link: https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/
```

**Nemotron 3 Nano 4B ships under document #1.** The substantive differences vs. document #2:

| Provision | Nemotron Open Model License (Dec 15, 2025) | Open Model License Agreement (Oct 24, 2025) |
|---|---|---|
| License grant | "perpetual, worldwide, non-exclusive, no-charge, royalty-free, **irrevocable**" | "perpetual, worldwide, non-exclusive, no-charge, royalty-free, **revocable**" |
| Guardrail-bypass termination | Not present | Auto-terminates if guardrails are "bypassed, disabled, reduced in efficacy, or circumvented" |
| Unilateral NVIDIA update right | Not present | "NVIDIA may update this Agreement to comply with legal and regulatory requirements at any time and You agree to either comply with any updated license or cease Your copying, use, and distribution" |
| AI Ethics binding clause | Not in license body (model card *requests* compliance with Trustworthy AI terms but in non-contractual language) | Use "must be consistent with NVIDIA's Trustworthy AI terms" — contractual |
| Special-Purpose Model concept | Not present | NVIDIA may designate a model as "Special-Purpose" with narrowed use |
| Cosmos-style attribution string | "Licensed by NVIDIA Corporation under the NVIDIA Nemotron Model License" | "Licensed by NVIDIA Corporation under the NVIDIA Open Model License" (plus `Built on NVIDIA Cosmos` for Cosmos models) |
| Patent retaliation | Yes — standard Apache-style | Yes — standard Apache-style |
| AS-IS / no warranty / indemnity | Yes | Yes |
| Export-control flow-through | Yes (Sec. 10) | Yes (Sec. 10) |

**Practical read:** the Nemotron Open Model License is materially closer to Apache 2.0 than the umbrella Open Model License. The two clauses that make the umbrella license risky for an appliance product (revocability + unilateral update right + guardrail auto-termination) are **absent** from the Nemotron license. This is the difference between "ship it" and "negotiate with NVIDIA for a side letter."

## 4. Six-point review (issue scope)

### 4.1 Is Staqs's distribution model permitted?

**Yes.** Sec. 2 ("Grant of License") and Sec. 3 ("Redistribution") together grant the rights Staqs needs:

> "NVIDIA hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable license to **reproduce**, prepare Derivative Works of, publicly display, publicly perform, **sublicense, and distribute** the Work and such Derivative Works in source or object form." (Sec. 2)
>
> "You may reproduce and **distribute copies of the Work** or Derivative Works thereof **in any medium, with or without modifications, and in source or object form**, provided that You meet the following conditions..." (Sec. 3)

Preloading the GGUF weights onto a Jetson appliance and shipping it to a customer is "distribution in object form, in [a] medium." Selling subscription services on top is independent of the model grant; the license does not restrict how Staqs prices the product surrounding the model.

The grant is **irrevocable** (Sec. 2). Once Staqs accepts the license by using the Dec 15, 2025 weights, NVIDIA cannot rescind the grant for those weights. (This binds the *version*, not future Nemotron releases — see §8 below.)

There is no field-of-use clause restricting commercial vs. non-commercial use.

### 4.2 Are per-customer LoRA fine-tunes (STAQPRO-341) permitted?

**Yes**, with the same attribution requirements. Sec. 1 defines:

> "**Derivative Works**" shall mean any work, whether in source or object form, that is based on (or derived from) the Work and for which the editorial revisions, annotations, elaborations, or other modifications represent, as a whole, an original work of authorship.

LoRA adapters trained on Nemotron base weights, and the merged-adapter checkpoints that result, are Derivative Works under this definition.

Sec. 3 permits redistribution of Derivative Works "in any medium, with or without modifications, and in source or object form." Critically:

> "You may add Your own copyright statement to Your modifications and may provide additional or different license terms and conditions for use, reproduction, or distribution of Your modifications, or for any such Derivative Works as a whole, provided Your use, reproduction, and distribution of the Work otherwise complies with the conditions stated in this License."

That means Staqs **owns the LoRA weights it trains** and can license them under its own terms — provided the base-model attribution requirements of Sec. 3(a)–(c) are still satisfied on any redistribution. In practical terms: Staqs's LoRA can be proprietary, but every appliance still has to carry the Nemotron license copy + NOTICE for the base weights it's loaded on top of.

**Outputs are not Derivative Works.** Per-customer outputs Staqs writes back to the customer's mailbox are wholly Staqs's (and the customer's) — NVIDIA claims no ownership interest in them.

### 4.3 Attribution / notice requirements

Sec. 3 imposes three conditions on any redistribution:

> "**a.** You must give any other recipients of the Work a copy of this License; and
>
> **b.** You must retain, in the source form of any Derivative Works that You distribute, all copyright, patent, trademark, and attribution notices from the source form of the Work, excluding those notices that do not pertain to any part of the Derivative Works; and
>
> **c.** If the Work includes a `NOTICE` text file as part of its distribution, then any Derivative Works that You distribute must include a readable copy of the following attribution notice within a 'Notice' text file with such copies and the following statement: *'Licensed by NVIDIA Corporation under the NVIDIA Nemotron Model License.'*"

For a Staqs appliance, "the recipient of the Work" is the **end customer who receives the box**. Concretely, what needs to ship:

| Artifact | Where it lives | Contents |
|---|---|---|
| `licenses/NVIDIA-Nemotron-Open-Model-License.txt` (verbatim copy) | Repo + appliance image (`/home/bob/mailbox/licenses/...` and bundled in the dashboard image) | Full text of the license, version-stamped `(v. December 15, 2025)` |
| `NOTICE` (text file) | Repo + appliance image | At minimum: *"This product includes NVIDIA-Nemotron-3-Nano-4B-GGUF. Licensed by NVIDIA Corporation under the NVIDIA Nemotron Model License."* — plus any other attribution notices that come with future Derivative Works |
| Customer-facing surface | One of: (a) dashboard `/about` or `/licenses` page; (b) `docs/runbook/onboarding.*.md`; (c) a printed insert in the appliance box | One line attributing the model and pointing to the license URL |

The license does **not** require the model card to be reproduced verbatim in customer documentation; it requires the License + NOTICE. The model card may still be useful for transparency, but it is not contractually required.

### 4.4 Field-of-use restrictions

**There are none in the license body.** The Nemotron Open Model License does not condition the grant on field-of-use (unlike Llama-2's "monthly active users" gate, or the umbrella Open Model License's Special-Purpose Model designation). Email triage and drafting is permitted on the same terms as any other use.

Two minor non-binding observations from the model card that are worth flagging for clarity:

1. **Model card "Use Case" wording** lists "AI gaming NPCs, local voice assistants, IoT automation" as intended uses. The phrasing ("intended for", "targets key-uses including") is **descriptive, not restrictive** — and the license body trumps the model card on what's contractually permitted. Email drafting fits comfortably under "Agentic AI in edge platforms" but if NVIDIA were ever to argue this is a Special-Purpose Model, the response is that the *Nemotron* license does not contain the Special-Purpose Model concept at all (that concept lives only in the umbrella Open Model License Agreement).
2. **Platform list** in the model card names "Jetson Thor, GeForce RTX, DGX Spark" — not Jetson Orin Nano. This is a marketing-positioning list, not a license-enforced restriction. Operationally Staqs has to validate Orin Nano fit in STAQPRO-342, but this is an engineering question, not a licensing one.

### 4.5 Sunset / revocation risk

The Nemotron Open Model License has three structural protections that the umbrella Open Model License Agreement lacks:

1. **Irrevocable grant** (Sec. 2). Once Staqs acquires the Dec 15, 2025 weights, NVIDIA cannot withdraw the license **for those weights**. Customers in the field continue to enjoy the grant for the version they have, indefinitely.
2. **No unilateral update clause.** The umbrella license has "NVIDIA may update this Agreement at any time and You agree to either comply or cease use." The Nemotron license does not. A future amendment by NVIDIA would not retroactively rebind Staqs to new terms for already-distributed weights.
3. **No guardrail-bypass auto-termination.** The umbrella license auto-terminates the grant if technical safety mechanisms are bypassed; the Nemotron license does not contain this clause. Staqs is not bypassing guardrails, but the absence of the clause removes an audit-trail concern (e.g., a quantization step or LoRA adapter that *coincidentally* moves a safety boundary doesn't trigger termination).

**Remaining termination risk** is narrow and outside-counsel-reviewed:

- **Patent retaliation (Sec. 2):** if Staqs sues NVIDIA — or any entity, via cross-claim or counterclaim — alleging Nemotron infringes a patent/copyright, Staqs's license to that Work terminates as of the litigation filing date. Practical risk: ~zero for an applications company.
- **Indemnity (Sec. 7):** Staqs indemnifies NVIDIA against third-party claims arising out of Staqs's use, distribution, or outputs. Counsel confirmed this is standard for permissive ML licenses; commercial-general-liability + cyber/E&O insurance is the appropriate hedge.

**Sunset risk for the version Staqs ships:** essentially nil thanks to irrevocability. **Sunset risk for a future Nemotron version** (e.g., Nemotron 4 or Nemotron 3.x successor) is unbounded — NVIDIA could revise the license at any release. Per the user direction on 2026-05-14, formal OTA-runbook policy is deferred; the irrevocability of the shipped version means there is no near-term compliance cliff.

### 4.6 What happens if NVIDIA changes the license on a future release?

Three scenarios:

| Scenario | Impact on Staqs |
|---|---|
| NVIDIA leaves Nemotron-3-Nano-4B-GGUF on HF with the Dec 15, 2025 license unchanged | No-op. Existing appliances and new builds continue under current terms. |
| NVIDIA deprecates / pulls the Dec 15, 2025 weights but releases a successor under the *same* license | Same diligence: a 1-hour re-read of the §4 mini-review and confirm `license_name: nvidia-nemotron-open-model-license` in the new model-card frontmatter. |
| NVIDIA releases a successor under a *different* (e.g., tightened) license | Successor is out unless reviewed and approved separately. Already-shipped appliances on the Dec 15, 2025 weights are unaffected — Sec. 3 permits ongoing redistribution of the obtained Work indefinitely. |

In all three scenarios, the *already-shipped* fleet is safe.

## 5. Comparison vs. baseline + other bake-off candidates

Per the user direction on 2026-05-14, equivalent formal license reviews for Qwen3.5-4B and Gemma 4 E4B are not being produced. Engineering judgment is sufficient: Qwen3.5-4B ships under Apache 2.0 (industry-standard permissive) and Gemma 4 E4B ships under the Gemma Terms of Use with the Gemma Prohibited Use Policy (known public terms; well-understood within the field). The table below records the engineering-level posture; the formal-memo treatment is reserved for the Nemotron candidate per this issue's scope.

| Model | License | Commercial redistribution | Derivative Works | Revocable? | Field-of-use | Notes |
|---|---|---|---|---|---|---|
| Qwen3:4b-ctx4k (current baseline) | Apache 2.0 | Yes | Yes | No | None | Industry-default permissive |
| Qwen3.5-4B (bake-off candidate) | Apache 2.0 (per Qwen family precedent) | Yes | Yes | No | None | No formal memo per 2026-05-14 direction |
| Gemma 4 E4B (bake-off candidate) | Gemma Terms of Use | Yes, with restrictions | Yes, with Prohibited Use Policy | Implicitly (via Use Policy) | Prohibited Use Policy binds | No formal memo per 2026-05-14 direction |
| NVIDIA Nemotron 3 Nano 4B | NVIDIA Nemotron Open Model License (Dec 15, 2025) | Yes | Yes | **No (irrevocable)** | None in body | **This memo** — outside-counsel-approved |

## 6. Compliance package — what to ship

Concrete deliverables to land in this repo and in the appliance image **before** Nemotron 3 Nano 4B is enabled as the live T2 drafter:

1. **`licenses/NVIDIA-Nemotron-Open-Model-License.txt`** — verbatim copy of the Dec 15, 2025 text. **Staged in commit `3858aea`.**

2. **`NOTICE`** at repo root with the Sec. 3(c) attribution string. **Staged in commit `3858aea`.**

3. **Dashboard surface** — add a route `/about` or `/licenses` (Next.js `app/(public)/about/page.tsx` or similar) that renders a static page enumerating bundled third-party licenses. One line for Nemotron with a link to the bundled `.txt`. **Lands with STAQPRO-342** (the bake-off PR — the route is irrelevant until Nemotron is the live drafter).

4. **Onboarding doc update** — a one-line "This appliance includes the NVIDIA Nemotron 3 Nano 4B model under the NVIDIA Nemotron Open Model License" in `docs/customer-onboarding/` or equivalent, with a pointer to the dashboard `/about` page. **Lands with STAQPRO-342.**

5. **Repo-level CLAUDE.md / STACK.md Models-table update** — replace the Qwen3-4B T2 row with the Nemotron row when STAQPRO-342 lands.

For STAQPRO-341 per-customer LoRA adapters: the LoRA artifact is Staqs's property and can be licensed under Staqs's own terms; every appliance that loads a Nemotron base + Staqs LoRA must still carry items 1–4 above for the base weights.

## 7. Residual risks — counsel-reviewed (2026-05-14)

Outside counsel reviewed and signed off on the three residual-risk items below. They are recorded here for the audit trail.

1. **Indemnity scope (Sec. 7).** Standard for permissive ML licenses. Operational hedge: human-in-the-loop approval gate (see `dashboard/lib/transitions.ts`). Contractual hedge: E&O / cyber-liability insurance + customer-contract risk allocation.
2. **Export control (Sec. 10).** Standard EAR + OFAC. Current US-only customer base presents no flag. International shipping (if/when applicable) would require an ECCN review for the Jetson hardware that pre-dates this license.
3. **Trademark scope (Sec. 4).** "Powered by NVIDIA Nemotron" descriptive use is permitted; product naming that incorporates "NVIDIA" or "Nemotron" as a Staqs sub-brand is not. Marketing-side governance applies.

## 8. DR-21 row-17 verdict (locked)

`docs/addendum-t2-model-candidates-v0_1-2026-05-13.md` row 17:

> | License | unambiguously usable for UMB commercial distribution | STAQPRO-339 (Nemotron) and equivalent legal reviews for the other candidates. |

**For NVIDIA Nemotron 3 Nano 4B (GGUF, Dec 15 2025 weights):** **PASS**, conditional on items 1–2 of §6 being included in the appliance image (already staged in commit `3858aea`) and items 3–4 landing with the STAQPRO-342 bake-off PR. Staqs has the right to ship the bake-off if STAQPRO-342 picks Nemotron.

## 9. Status of follow-ups

| Item | Status | Note |
|---|---|---|
| STAQPRO-339.1: outside-counsel sign-off on §7 items | **CLOSED** 2026-05-14 | Counsel reviewed §7; sign-off received |
| STAQPRO-339.2: equivalent license reviews for Qwen3.5-4B + Gemma 4 E4B | **DROPPED** 2026-05-14 | Per user direction — engineering familiarity with Apache 2.0 and Gemma PUP is sufficient; no formal memos required |
| STAQPRO-339.3: future-Nemotron-version migration policy in OTA runbook | **DEFERRED** 2026-05-14 | Not required for M5 ship. Pick up if/when fleet auto-upgrades the base model |
| Stage `licenses/NVIDIA-Nemotron-Open-Model-License.txt` + `NOTICE` skeleton | **DONE** 2026-05-13 | Commit `3858aea` on `dustin/staqpro-339` |
| Customer-facing surface (dashboard `/about` + onboarding line) | **DEFERRED to STAQPRO-342** | Only needed if Nemotron wins the bake-off and goes live |

## 10. Audit trail

This memo (v0.1.0 + v0.2.0) was authored by an AI assistant (Claude Code, Opus 4.7) reading the public NVIDIA Nemotron Open Model License text and the Hugging Face model card on 2026-05-13. **Outside counsel reviewed v0.1.0 on 2026-05-14 and signed off** on the §7 residual-risk treatment and the overall GO verdict. The DR-21 row-17 license gate is locked to PASS for Nemotron 3 Nano 4B as of 2026-05-14.

---

## Appendix A — Verbatim license text references

- Nemotron Open Model License full text: bundled at `licenses/NVIDIA-Nemotron-Open-Model-License.txt` (this repo) or fetch live from https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/
- Umbrella Open Model License Agreement full text: https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/
- Nemotron 3 Nano 4B GGUF model card: https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF (cite the commit hash when bundling so future audits can resolve "what did Staqs see")

## Appendix B — Sections cited

All section numbers in §4 refer to the *NVIDIA Nemotron Open Model License* (v. December 15, 2025), which has ten numbered sections: 1. Definitions, 2. Grant of License, 3. Redistribution, 4. Trademarks, 5. Disclaimer of Warranty, 6. Limitation of Liability, 7. Accepting Warranty or Additional Liability, 8. Feedback, 9. Governing Law, 10. Trade and Compliance.
