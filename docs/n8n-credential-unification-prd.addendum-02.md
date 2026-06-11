# Addendum 02 — n8n credential unification PRD

**Extends:** `n8n-credential-unification-prd.v0.1.0.md` + `…addendum-01.md`
**Date:** 2026-06-11
**Author:** Dustin (via Claude Code)
**Status:** Draft for review
**Issues:** MBOX-482 (M365/IMAP), MBOX-466 (Gmail), MBOX-464 (ingestion gap). Parent epic MBOX-469.
**Purpose:** Reconcile the addendum-01 *plan* with the code that actually **shipped** in [PR #59](https://github.com/UMB-Advisors/AgentBOX/pull/59) (merged 2026-06-11) and the follow-up security fix (`8e86f01`). Records one architectural element addendum-01 did not anticipate (the registration bridge), retires two now-stale "gap" claims, and states precisely what remains to *close* MBOX-482.

> Addendum, not rewrite. addendum-01's phasing and the Model-A-for-IMAP-only decision **stand**. This addendum reports delivery against that plan and corrects drift — it does not re-decide anything.

---

## TL;DR

- **P1 (IMAP/SMTP cred-sync) and P2 (M365 Graph token-as-data) artifacts are merged** — dashboard routes, both `MailBOX-Graph*` workflows, the IMAP cred-sync + clone tooling. MBOX-482's *code* is in `main`.
- **addendum-01 assumed `mailbox.accounts` was already populated.** It is not — the live operator connect UI is **Hermes-side** (the `0600` file store). PR #59 had to build a **registration bridge** (Hermes → dashboard projection) that addendum-01 never scoped. This is the one genuinely new architectural piece (§2).
- **Two "known gaps" are already closed and should stop being repeated** (§3): (a) the `lib/n8n.ts` Microsoft send-routing switch landed in `8e86f01`; (b) addendum-01 §3's "`oauth_tokens` = single Google master" was reversed by [PR #64](https://github.com/UMB-Advisors/AgentBOX/pull/64) (split-by-surface).
- **MBOX-482 is not done-done.** What ships is **artifacts, not activation**: no box has imported the workflows, synced an IMAP credential, or e2e-verified a live M365/IMAP round-trip. The issue stays open on that, not on missing code (§4).

---

## 1. Delivery against addendum-01's phasing

| Phase (addendum-01 §4) | Plan | Shipped in #59 | State |
|---|---|---|---|
| **P0** — Gmail end-to-end via single Google master | Re-point the access-token minter; collapse Google stores | *Not in #59.* Superseded — see §3. MBOX-464 was already resolved on agentbox2 by other fixes (multi-account polling); the "single master" re-point was the wrong move ([#51 reverted via #60](https://github.com/UMB-Advisors/AgentBOX/pull/60)). | **Reframed, not built** |
| **P0.5** — Gmail send → HTTP token-as-data | Optional; convert `MailBOX-Send.json`'s native gmail node | **Deliberately SKIPPED.** It is the live customer-#1 send path (agentbox2 in prod); HTTP conversion needs a base64url RFC822 MIME build with `In-Reply-To`/`References`/`threadId` in a Code node — materially more than the read path, with no live test rig. | **Deferred, tracked separately** |
| **P1** — IMAP via credential-sync (Model A) | Sync per-account `imap`+`smtp` creds; clone `MailBOX-Imap*` per account | `app/api/internal/imap-credentials` (decrypts app-password → n8n cred payloads, **deterministic ids** `mbximap<id>`/`mbxsmtp<id>`); `bin/mbox-imap-cred-sync.sh` (`docker exec n8n import:credentials`, create/update/`--delete`); `bin/mbox-imap-clone.sh` (per-account workflow clones, binding option (a)). | **Artifacts shipped** |
| **P2** — M365 Graph (net-new), token-as-data | `MailBOX-Graph{,-Send}.json` mirroring Gmail HTTP topology; per-account app-only bearer | `app/api/internal/graph/access-token` (app-only client-credentials mint per poll); `MailBOX-Graph.json` + `MailBOX-Graph-Send.json` (httpRequest-only, migration-025 CAS send lock, tags `provider:'microsoft'`). | **Artifacts shipped** |

**Net:** the addendum-01 plan was followed faithfully — P1 + P2 built, P0.5 consciously deferred with a documented reason, P0 overtaken by events (§3). The Model-A-for-IMAP-only / token-as-data-for-HTTP split from addendum-01 §1–2 held up against implementation with no surprises.

---

## 2. New architectural element — the registration bridge (not in addendum-01)

addendum-01 §3 treated `mailbox.accounts.provider_secret_enc` (store #2) as already containing the IMAP/M365 secret, keyed by `account_id`, ready to feed the cred-sync. **Implementation exposed the gap:** the *operator-facing* mail-account connect UI is **Hermes-side** (`hermes_cli/mail_accounts.py`, a `0600` file store under `$HERMES_HOME` encrypted with `HERMES_MAIL_SECRET_KEY`), while the n8n pipeline only ever reads `mailbox.accounts` + `provider_secret_enc` (encrypted with `MAILBOX_OAUTH_TOKEN_KEY`). Nothing connected the two. So #59 built a bridge addendum-01 never named:

| Aspect | Resolution |
|---|---|
| **Source of truth** | Hermes file store = operator **master**; `mailbox.accounts` = pipeline **projection**. (Same SoT shape as Gmail: the dashboard connect is authoritative, n8n is downstream.) |
| **Connect / re-auth** | `hermes_cli/dashboard_bridge.py` does a best-effort httpx `POST /api/internal/accounts/register` (Hermes has no Postgres of its own). |
| **Disconnect** | `POST /api/internal/accounts/deregister`. |
| **Auth** | Both routes gated by `HERMES_INTERNAL_TOKEN`, constant-time + fail-closed — identical to the Gmail access-token minter. The security fix (`8e86f01`) extracted this into shared `lib/internal-auth.ts` across all four internal routes. |
| **Key boundary** | The transport secret crosses the docker network **plaintext** (the connect just validated it) and the dashboard **re-encrypts under `MAILBOX_OAUTH_TOKEN_KEY`** — because the pipeline only reads `provider_secret_enc`, the secret must land under the mailbox key, not Hermes'. Plaintext is **never persisted**. |
| **Failure mode** | Bridge POSTs are **non-fatal** — the file store is the master and already persisted; the dashboard upsert is idempotent on email, so a missed projection is retryable. |

This does **not** create a "4th token store" (addendum-01's acceptance constraint): the secret still lives only in `provider_secret_enc` on the pipeline side; the bridge is a write-path *into* store #2, not a new store. It reconciles addendum-01 §3's assumption ("the secret is already in #2") with reality ("the operator writes it into a Hermes file store; a bridge must project it into #2").

---

## 3. Corrections — two addendum-01 / #59 claims now stale

### 3a. `lib/n8n.ts` Microsoft send routing — **CLOSED** (was the headline gap)

PR #59's body and the deploy runbook (`mbox-482-deploy-runbook.v0.1.0.md`, "Known gaps" §1 + P2 activation step 5) both call the `N8N_GRAPH_WEBHOOK_URL` send-routing switch an unwired follow-up. **It landed in the security-fix commit `8e86f01`.** On `main`, `lib/n8n.ts` carries:

```
const SEND_WEBHOOK_ENV: Partial<Record<MailProviderKind, string>> = {
  imap: 'N8N_IMAP_WEBHOOK_URL',
  microsoft: 'N8N_GRAPH_WEBHOOK_URL',   // gmail stays the N8N_WEBHOOK_URL default
};
```

So `provider='microsoft'` drafts route to the Graph send webhook with no further dashboard code change. **Activation still requires setting `N8N_GRAPH_WEBHOOK_URL` in the dashboard env** (`http://n8n:5678/webhook/mailbox-graph-send`) — but that is config, not the code follow-up the runbook describes. Treat the runbook's P2 step 5 and Known-gap §1 as **superseded by this addendum**.

### 3b. addendum-01 §3 "single Google master" — **REVERSED** ([PR #64](https://github.com/UMB-Advisors/AgentBOX/pull/64))

addendum-01 §3 decided "make `mailbox.oauth_tokens` the single Google master; re-point the minter." The system-wide audit (2026-06-10) showed that is **wrong**: Google data is **split by surface** — Gmail *ingestion* mints from the Hermes host files (`~/.hermes/google_accounts/*.json`); Calendar / Drive / Contacts / Tasks / voice-backfill read `oauth_tokens`. Re-pointing one consumer just relocates the split (what #51 did → reverted via #60). There is **no single Google master yet** — that split *is* the open `google-single-source-of-truth` problem; the go-forward fix is to unify Google onto one at-rest-encrypted store on the Hermes dashboard, out of MBOX-482's scope. PR #64 lands this correction into addendum-01's §3; until #64 merges, `main`'s addendum-01 still reads the old (wrong) decision — **defer to this addendum and #64.**

> This matters for MBOX-482 only insofar as P0 (Gmail) is **not** a prerequisite the way addendum-01 framed it. M365/IMAP (P1/P2) are independent of the Google-store reconciliation — they key on `provider_secret_enc`, never on the Google stores.

---

## 4. What remains to *close* MBOX-482

The code is in `main`; the issue is open on **activation + verification**, all box-side and not auto-applied. In rough order:

1. **Box-side activation (operator).** Per `mbox-482-deploy-runbook.v0.1.0.md`: deploy the dashboard build, connect an M365/IMAP mailbox (bridge projects it into `mailbox.accounts`), smoke the minter, import the `MailBOX-Graph*` / IMAP-clone workflows, sync the IMAP credential, set `N8N_GRAPH_WEBHOOK_URL`, activate + restart n8n. **Nothing here has run on any box yet.**
2. **Live e2e verification (the real acceptance gate).** No live M365 or IMAP account was available; the minter, `normalize()`, and workflow topologies are validated by unit tests (33 passed) + JSON validation + the Gmail reference pattern — **not a real inbound→classify→draft→approve→send round-trip.** MBOX-482's acceptance ("a freshly connected M365 *or* IMAP account receives inbound + can send, no manual n8n setup") is unmet until one account completes that loop on a box.
3. **Residual threading limitations (follow-up, not blockers).**
   - **Multi-IMAP-account boxes** still share the single `mailbox-imap-send` webhook path; >1 IMAP account on one box needs per-account webhook paths (the clone generator notes this).
   - **Graph reply is a flat `Re:` send** — no RFC `In-Reply-To`/`References` headers — the same residual as IMAP send. Acceptable for v1; track for threading fidelity.
4. **P0.5 (Gmail send → HTTP token-as-data)** remains deliberately deferred (§1) — a separate, test-gated change, not part of closing MBOX-482.

**Box-gated, not code-gated.** A peer session can verify activation on agentbox2 once an M365 or IMAP test mailbox exists; do not re-implement — the artifacts are complete.

---

## 5. Reconciliation table — addendum-01/#59 said vs. reality on `main`

| Source claim | Reality (this addendum) |
|---|---|
| addendum-01 §3: secret already in `provider_secret_enc`, ready to sync. | True only *after* the **registration bridge** projects the Hermes-side connect into it. Bridge is new (§2). |
| #59 body + runbook: `lib/n8n.ts` Microsoft send routing is an unwired follow-up. | **Wired** in `8e86f01`. Only `N8N_GRAPH_WEBHOOK_URL` env config remains (§3a). |
| addendum-01 §3: `oauth_tokens` becomes the single Google master. | **Reversed** — Google is split by surface; no single master yet (#64). Independent of P1/P2 (§3b). |
| Issue acceptance implies "shipped = live." | Shipped = **artifacts**; live requires box-side activation + a real round-trip (§4). |
| addendum-01: Model A applies to all of IMAP/SMTP/M365 sync. | Held — Model A = IMAP/SMTP only; M365 + Gmail = token-as-data. Implementation confirmed the split (§1). |

Unchanged from addendum-01: Model-A-for-IMAP-only; token-as-data for all HTTP providers; n8n stays a downstream credential consumer (creds only for IMAP/SMTP); the shared classify/draft/approve/send pipeline is untouched; the live `MailBOX.json` Gmail flow is byte-untouched by everything in #59.
