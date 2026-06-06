# Sales Persona — Build Plan (hermes agent box)

**Version:** v0.1.0
**Target box:** mailbox2 (ssh `agentbox1`, user `mailbox`), runtime `~/.hermes/hermes-agent`
**Reads grounded against:** `/.../worktrees/shopify-blog/.../hermes-agent-main` (tools/, skills/, cron/)

## TL;DR

The agentBOX Sales Persona maps cleanly onto the hermes box because one proven primitive — the blog learning loop (`tools/blog_learning.py` + the 08:00 learner / 09:00 draft crons) — already embodies the entire Sales-Persona job skeleton: scheduled agent run, pre-run context injection, draft-not-publish default, edit-magnitude scoring of AI-draft-vs-human-final, and gbrain capture. Nine of the ten jobs are "clone blog_learning + add a thin vendor read tool + author a SKILL." The one genuinely net-new primitive across every job is the **per-job L0→L1→L2 trust counter** (consecutive-clean-approvals state), which does not exist today and must be built once as a shared module rather than ten times. Two jobs are externally blocked (1.4 Paid Ads on Meta/TikTok app review; LinkedIn outbound on a compliance decision) and ship read-only / disabled until those clear. Build order front-loads the highest-reuse, fully-unblocked jobs (1.3 Content Engine, 2.3 Speed-to-Lead, 2.1 Enrichment) behind a single shared scaffold.

---

## 1. Persona scaffold (the one reusable pattern)

### 1.1 Shared job skeleton

Every Sales-Persona job on this box is the same five-stage shape, already proven by the blog loop:

| Stage | Box primitive | Notes |
|---|---|---|
| **Trigger** | `cron/jobs.py::create_job` (schedule) + live `gateway handle_message` for inbound | Fresh agent subprocess per run; `context_from` chains detector→drafter |
| **Inputs** | cron `script` field → stdout injected as `## Script Output` (`cron/scheduler.py:1028`) | Deterministic pre-run data pull; **if the script emits nothing, the LLM call is skipped** (cost control). Inject brand voice + ICP + price book + pipeline snapshot here |
| **Work** | a `skills/<cat>/<job>/SKILL.md` (the brain) + a thin `tools/<job>.py` (the hands) | Tools auto-register via `tools/registry.py`; toolset gated by `check_fn` so it no-ops on unconfigured boxes |
| **Approval gate** | draft-not-publish default + `tools/approval.py` (gateway queue) + `tools/clarify_*` | See §1.2. **`managed_tool_gateway.py` is NOT a human gate** (line 1: "Nous-hosted vendor passthroughs") — do not build the gate on it |
| **Output** | gbrain capture (`blog_learning.gbrain_capture`), `send_message`, kanban card, dashboard tile | Delivery + memory + visible queue |

Reused helpers to copy verbatim (verified): `blog_learning.hermes_home()` (:73), `learn_dir()` (:77), `edit_magnitude()` (:162), `CLEAN_APPROVAL_MAX_MAGNITUDE = 0.02` (:54), `record_provenance()` (:214), `gbrain_capture()` (:294), `refresh_digest()` (:409), and the `_gbrain_bin()/_gbrain_env()` PATH shim. `tools/shopify_tools.py::_req()` (:74) is a generic Admin REST client — today only blog paths are wired, but it can reach products/orders/customers/draft_orders/price_rules with the right token scope.

### 1.2 Autonomy / graduation framework (the one net-new primitive)

The L0/L1/L2 model maps onto existing primitives, with one new layer:

- **L0 Draft & approve (default, all jobs start here):** output is produced as an UNSENT artifact (Shopify `published=false` / draft_order / review-folder file / `base.send_draft`). For cron-originated actions, `approvals.cron_mode` defaults to `"deny"` (`approval.py:870`) so an unattended cron **cannot** silently fire a gated action. Interactive sends route through the gateway approval queue (`register_gateway_notify` :529 → `submit_pending` :589 → `resolve_gateway_approval` :554). `clarify_gateway` asks the human/lead when context is missing.
- **L1 Approve-exceptions:** routine actions ship; "exception" actions (defined per job — first-touch to a new domain, price near floor, new SKU claim, compliance category) still route to the queue.
- **L2 Autonomous:** action executes; human reviews on cadence (weekly/daily digest).

**NEW shared module: `tools/sales_trust.py`** (build once, all 10 jobs import it):

- **State:** one JSON file per job, `$HERMES_HOME/sales_trust/<job_id>.json`, holding `{level, consecutive_clean, N, material_rule, frozen}`. Must be **on-disk and durable** — cron spawns a fresh subprocess per run, so in-process state (like `approval.py`'s per-session map) would reset every run.
- **API:** `get_state(job_id)`, `record_outcome(job_id, ai_draft, human_final)`, `freeze(job_id)`, `downgrade(job_id)`, `can_autoact(job_id)`.
- **Scoring:** reuse `blog_learning.edit_magnitude(ai_draft, human_final)`. A "clean approval" is `magnitude <= material threshold AND no structural change`. **Critical refinement (from the 1.1 risk):** for judgment-heavy artifacts (ICP segment change, a price-line change, a positioning change), treat the change as material **regardless of text magnitude** — `edit_magnitude` is a blog-HTML heuristic and will under-count strategically significant small edits.
- **Graduation:** clean → `consecutive_clean++`; reject or material edit → reset to 0. At `consecutive_clean >= N`, bump level. L2 is gated behind **explicit human authorization** for any money/reputation-touching job, never auto-reached.
- **Visibility (spec requirement):** the counter must surface. Two cheap surfaces ship in v1 — (a) a header line in every delivered report / draft notification (`"Trust: L1, 3/5 clean toward L2"`), and (b) a small dashboard tile in `mailbox-dashboard` reading the `sales_trust/<job_id>.json` files. The header-line is the no-new-codebase fallback; the tile is the proper surface.
- **Freeze/downgrade:** client edits `frozen`/`level` in the JSON or via a dashboard toggle; handlers honor it on every run.

This module is the single highest-leverage build: it is the only piece common to all ten jobs and the only piece with no existing analog.

---

## 2. All ten jobs

| Job | Phase | Primary reuses | Buildable now | Blocked on | Shape | Effort | Rank |
|---|---|---|---|---|---|---|---|
| **1.1** Market & ICP Research | TOF | web/x_search, shopify `_req` (catalog read), gbrain, edit_magnitude | Yes | OQ1 (runtime clarify), OQ5 (surface only) | composite | M | 2 |
| **1.2** Funnel & Landing Pages | TOF | shopify `_req` (pages/discounts), shopify-blog scaffold, edit_magnitude | Yes | OQ2 (ESP), token scopes (write_themes/discounts) | composite | L | 2 |
| **1.3** Content Engine | TOF | **blog_learning loop already = blog channel**, image/video gen, xurl, send_message | Yes (partial done) | IG/TikTok publish (degrade to draft), Google Cal trigger | composite | L | 1 |
| **1.4** Paid Ad Management | TOF | shopify `_req` pattern (template), shopify-blog scaffold, gbrain | Track A yes / Track B no | Meta+TikTok API app review, ad creds store | composite | XL | 7 |
| **2.1** Lead Enrichment & Scoring | Outbound | blog_learning clone, web/x_search, gbrain, kanban | Yes (firmographic-only) | OQ3 (Apollo/contact-level), OQ1 (rubric) | composite | M | 2 |
| **2.2** Outbound Sequencing | Outbound | google_api Gmail CLI (send/reply/search/modify), blog_learning state, approval | Yes (email-first) | Gmail send re-consent (SMTP fallback), LinkedIn (compliance) | composite | L | 2 |
| **2.3** Speed-to-Lead | Outbound | gateway email/DM inbound + `send_draft`/`create_handoff_thread`, clarify_gateway, blog_learning | Yes | OQ1 (provisional rubric), idempotency guard | composite | L | 1 |
| **3.1** Quote & Line-Sheet | Conversion | shopify `_req` (draft_orders), blog_learning clone, clarify | Yes | OQ1 (tiers), price_book source | composite | L | 4 |
| **3.2** Pipeline & Forecasting | Conversion | kanban SQLite, shopify `_req` (orders), blog_learning, clarify_gateway | Yes (kanban-as-CRM) | OQ2 (kanban vs Postgres), read_orders scope | composite | L | 3 |
| **3.3** Reorder & Expansion | Conversion | shopify `_req` (orders/customers), blog_learning clone, kanban, send_message | Yes (stub/CSV first) | read_orders/read_customers scope, OQ1 (wholesale tag) | composite | L | 2 |

All ten are `composite` (skill + thin tool + cron + trust counter). None is a pure greenfield integration except Track B of 1.4.

---

## 3. Phased roadmap

The spec priority is TOF → Outbound → Conversion. We respect that ordering **within** each wave but front-load by reuse and unblocked-ness, since the scaffold makes cross-phase parallelism cheap.

### Phase 0 — Shared scaffold (gates everything; ~1 increment)
- `tools/sales_trust.py` (the L0/L1/L2 counter, §1.2).
- A `skills/sales/_persona-scaffold/` reference SKILL documenting the five-stage skeleton so each job clones it.
- Dashboard Trust tile (or header-line fallback if dashboard work is deferred).
- Confirm `$HERMES_HOME` resolution + a `sales_trust/` runtime dir created on first run.

### Phase 1 — TOF, reuse-maximal
- **1.3 Content Engine (rank 1).** The blog channel is **already built** (`blog_learning.py` + the 08:00/09:00 crons = a working draft→learn loop for the Shopify blog). Work = generalize blog_learning into a channel-namespaced `content_engine` (drafts/<channel>/, per-channel digest), add X (xurl draft) + email (send_message draft) + IG/TikTok (image/video gen → review folder, **draft-only**, honest about no publish API), and wire Google Calendar as the editorial trigger into the pre-run injector. Compliance/claims lessons hard-gate regardless of trust level.
- **1.1 Market & ICP Research (rank 2).** Author `skills/research/icp-research`, add read-only `tools/shopify_catalog.py` (GET products/collections/price_rules via `_req`, strictly no writes), monthly refresh cron, gbrain artifacts (icp-definitions / competitive-brief / demand-calendar). Output feeds 1.3 and 2.1.
- **1.2 Funnel Pages (rank 2).** Add `create/update/list_shopify_page` (pages.json, current `write_content` token works) + `create_shopify_discount` and `publish_shopify_page` (gated, behind scope check). Pages ship draft-only.

### Phase 2 — Outbound
- **2.3 Speed-to-Lead (rank 1).** Highest urgency-value: reuse the live gateway inbound path (`gateway/platforms/email.py` IMAP poll) + `base.send_draft` + `clarify_gateway` + a 5-min backstop cron with prerun un-actioned-inbox dump. Idempotency keyed on message UID via the provenance store. Provisional qualification rubric until OQ1.
- **2.1 Lead Enrichment (rank 2).** Clone blog_learning → `tools/enrichment_tools.py`; firmographic-only via web/x_search (no Apollo); scored accounts → kanban cards (priority = fit score) feeding 2.2/2.3. Apollo seam = `managed_tool_gateway.build_vendor_gateway_url('apollo')` for later.
- **2.2 Outbound Sequencing (rank 2).** `tools/outbound_sequencing.py` delegating to the verified Gmail CLI (`gmail_send`/`gmail_reply`/`gmail_search`/`gmail_modify`). Two crons (daily send-due + 15-min reply-sweep). **Deliverability guardrails are mandatory v1** (per-day cap, per-domain throttle, suppression list, CAN-SPAM footer). Replies are **always L0 handoff** — exempt from graduation. Needs one operator action: run `google-workspace setup.py` to grant `gmail.send` (SMTP fallback otherwise). **LinkedIn ships disabled behind a channel flag.**

### Phase 3 — Conversion
- **3.2 Pipeline & Forecasting (rank 3).** `tools/pipeline_tools.py` modeling deals on the existing kanban SQLite board (`~/.hermes/kanban.db`) + read-only Shopify order pull. Reporting is read-only → autonomous fast; only WRITE mutations (stage moves) are trust-gated. Decide kanban-vs-Postgres (OQ2) before populating real deals to avoid a migration.
- **3.1 Quote & Line-Sheet (rank 4).** Add `list_products`/`list_variants`/`create_shopify_draft_order` (the draft_order IS the unsent-artifact L0 gate). Operator-owned `$HERMES_HOME/quoting/price_book.yaml` is mandatory — Shopify retail prices ≠ wholesale terms. Hard never-auto-send-below-floor guard even at L2.
- **3.3 Reorder & Expansion (rank 2 within phase).** Cadence model (rolling median inter-order gap) + expansion heuristics over Shopify order history; detector cron emits-nothing-when-none-due. Requires re-minted token with `read_orders`/`read_customers`; ship against CSV/stub first.

### Phase 4 — Externally blocked
- **1.4 Paid Ads (rank 7).** **Track A now** (read-only reporting + pacing recommendations, toolset structurally omits spend tools so it cannot mutate budget). **Track B later** (Meta Marketing + TikTok Business clients on the `_req` template, in-tool approval checkpoint before every spend write) — gated on multi-week Meta Business verification + `ads_management` app review.

---

## 4. Open questions → jobs gated → recommended default

| OQ | Question | Jobs gated | Recommended default to unblock |
|---|---|---|---|
| **OQ1** | Real Yes! Cacao DTC : wholesale : corporate-gifting channel split | 1.1, 1.2, 1.3, 2.1, 2.3, 3.1, 3.3 | **Resolve at runtime via `clarify_tool`**, not at build time. Ship a provisional single-wholesale-tier + DTC default; treat early human edits as the training signal. Block only the *final delivery* of the ICP brief (1.1) on a resolved split. |
| **OQ2** | What CRM / email platform is actually in place | 2.1, 2.2, 2.3, 3.1, 3.2, 3.3 | Confirmed substrate: Shopify (live) + dashboard Postgres CRM + Gmail via google-workspace skill + local kanban SQLite. **Default v1 to kanban SQLite + `$HERMES_HOME` JSON state**; expose the dashboard Postgres CRM as a toolset later. Avoids cross-codebase DB coupling now. |
| **OQ3** | Enrichment provider (ties to LinkedIn compliance) | 2.1 (contact-level), 2.2/2.3 (depth) | **Defer.** Ship firmographic-only v1 from web/x_search. Add Apollo/Clearbit behind the `managed_tool_gateway` vendor passthrough once compliance signs off — no code churn in the loop. |
| **OQ4** | Graduation thresholds: default vs per-client | all (trust counter) | **Ship configurable defaults.** N=5 judgment-heavy (1.1, 3.1), N=10 high-volume/low-risk (1.3, 2.1), N=20 reputation-critical (2.2 sends). "Material" defaults: `edit_magnitude>0.02` OR any structural change (segment/price-line/positioning). Make all per-job overridable in config. |
| **OQ5** | Persona standalone agentBOX vs Optimus Sales Command Center profile | none structurally (surface only) | **Default to the existing mailbox-dashboard** as the trust/queue surface. The skills/tools/crons are identical either way; only the render target moves. |

Net: **no OQ hard-blocks the v1 build.** OQ1 is resolved at runtime; OQ2/OQ3 have sane unblocked defaults; OQ4 ships as config; OQ5 affects only the dashboard tile.

---

## 5. Integration shopping list (build vs buy)

| Integration | Needed by | Status on box | Build vs buy |
|---|---|---|---|
| **Meta Marketing API** (Graph ad accounts/campaigns/insights, System User token) | 1.4 Track B | Absent | **Build** client on `_req` template; **buy** = the multi-week Business verification + `ads_management` app review (external, rejection risk). Ship Track A read-only first. |
| **TikTok Business API** | 1.4 Track B | Absent | Same as Meta — build client, external review gate. |
| **Lead enrichment** (Apollo / Clearbit / People Data Labs) | 2.1, 2.2, 2.3 | Absent | **Buy** (vendor), fronted by `managed_tool_gateway.build_vendor_gateway_url('apollo')`. Not required for firmographic v1. Gated on LinkedIn compliance. |
| **ESP** (Klaviyo / Mailchimp) | 1.2 capture flows, 1.3 email channel | Absent | **Buy.** v1 degrades to Shopify-native newsletter block + customer tag, or `send_message` drafts. Be honest that "email capture" is constrained without it. |
| **Gmail send scope** | 2.2, 2.3 | Scope present in google-workspace skill token; needs one-time consent on box | **Operator action** (run `setup.py`). SMTP fallback exists but loses native threading. |
| **Shopify scope expansion** | 3.1 (draft_orders), 3.2/3.3 (read_orders/read_customers), 1.2 (write_themes/discounts) | Token is `write_content` only | **Re-mint** the offline `shpat_` token with added scopes. Hard prerequisite for live order/customer data. |
| **PDF / line-sheet render** | 3.1, 1.2 lead magnets | nano-pdf / powerpoint skills exist, not wired | **Build** thin wiring; or rely on Shopify draft-order invoice URL for 3.1 v1. |
| **Google Calendar trigger** | 1.3 editorial calendar | `hermes_cli/google_*.py` on box (creds live) | **Build** thin pull into the pre-run injector. |
| **CRM-as-toolset** (dashboard Postgres → agent) | 2.x, 3.x (long-term) | Postgres exists, not exposed to agent | **Build** thin read/write toolset later; v1 uses kanban + JSON. |

---

## 6. Recommended FIRST increment

Build the scaffold plus the three highest-leverage fully-unblocked jobs. This proves the autonomy framework end-to-end on a job that is already half-done (1.3), then a high-value inbound job (2.3) and the data spine for outbound (2.1).

**Concrete artifacts to create on the box:**

1. **`tools/sales_trust.py`** — shared L0/L1/L2 counter; state in `$HERMES_HOME/sales_trust/<job_id>.json`; `record_outcome` reuses `blog_learning.edit_magnitude` + structural-change override; `get_state/freeze/downgrade/can_autoact`; registers a `sales_trust` toolset.
2. **Trust visibility** — header-line in every delivered draft (`"Trust: Lx, k/N clean"`) now; `mailbox-dashboard` Trust tile next.
3. **1.3 Content Engine:** generalize `blog_learning.py` → `tools/content_engine.py` (channel-namespaced drafts + digests, blog as the done reference); `skills/social-media/content-engine/SKILL.md`; per-channel draft crons (X via xurl, email via send_message, IG/TikTok → review folder draft-only); pre-run injector pulling brand voice + ICP + Google Calendar. Compliance-claims carve-out always gated.
4. **2.3 Speed-to-Lead:** `tools/speed_to_lead.py` (provenance + injected qualification/voice digest + gbrain context + sales_trust hook + UID idempotency); `skills/sales/speed-to-lead/SKILL.md`; `$HERMES_HOME/speed_to_lead/playbook.md` (provisional rubric); 5-min backstop cron with prerun un-actioned-inbox dump; "Wholesale Pipeline" kanban board.
5. **2.1 Lead Enrichment:** `tools/enrichment_tools.py` (clone of blog_learning: `record_account_score`/`list_pending_accounts`/`get_icp_digest`, gbrain + JSONL); `skills/productivity/sales-enrichment/` + `install_enrichment_cron.py` + `inject_icp_rubric.py`; firmographic-only via web/x_search; scored accounts → kanban cards.

**Why these three:** 1.3 already has a working slice so it validates the trust counter against real human edits immediately; 2.3 delivers the most operator-felt value (instant inbound response) with zero external blockers; 2.1 produces the scored-account spine that 2.2/2.3/3.x all consume. All three need only the shared scaffold + thin tools + clones of an already-proven loop.

---

## 7. Non-goals / deferred

- **LinkedIn outbound** — ships **disabled behind a channel flag** until the firm-wide compliance decision (browser automation vs compliant provider). No browser-automation LinkedIn code written until then.
- **Paid ads spend mutation (1.4 Track B)** — deferred until Meta Business verification + `ads_management` / TikTok app review clear (multi-week, external, rejection risk). Track A (read-only reporting + recommendations) ships; spend tools are **never** loaded into any autonomous cron toolset.
- **Contact-level enrichment** (names/emails/titles via Apollo/Clearbit) — deferred behind OQ3 + LinkedIn compliance; v1 is firmographic-only.
- **Real ESP email campaigns** — deferred; v1 email is `send_message` drafts / Shopify-native capture, not Klaviyo/Mailchimp sends.
- **CRM-as-agent-toolset over dashboard Postgres** — deferred; v1 uses kanban SQLite + `$HERMES_HOME` JSON. Avoids giving the box DB creds + network reach to the dashboard's Postgres (blast-radius expansion).
- **True A/B serving** (1.2) — the box can produce two page drafts but cannot serve/measure a split natively; v1 produces variants for external/manual testing only.
- **L2 autonomy on money/reputation jobs** (1.4 spend, 2.2 first-touch sends, 3.1 below-floor quotes) — never auto-reached; gated behind explicit human authorization with hard floor guards even after graduation.
- **The "Adva Cera automated-quoting" shared structure** referenced in spec §3.1 — that codebase is NOT on this box; treat as aspirational, not a verifiable reuse.
