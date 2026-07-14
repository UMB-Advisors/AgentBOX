<!-- PASTE-READY comment for Linear MBOX-498 (linear-staqs MCP was not available in the run session;
     post manually, or via: mcp tool save_comment issueId=MBOX-498). -->

## MBOX-498 spike complete — both reachability planes proven on hardware ✅

Ran the off-LAN reachability spike end-to-end on **agentboxhonduras** over the real internet. Full write-up + go/no-go: `docs/spikes/mbox-498-relay-poc.md`. Verdict: **GO on the model, not production-ready as-is.**

**Plane A — Tagged fleet (vendor path): PROVEN.**
Box enrolled as **`tag:box`** on `tail377a9a`. Key result: re-tagging a user-owned box to a tag **did not break vendor SSH** — an anti-lockout SSH rule was added to the prod ACL *before* the re-tag. Change was **additive**; the live mailbox fleet policy (`tag:mailbox`/`tag:fleet-worker`, both fail-closed validators, kill switches) was preserved verbatim (the API rejects any ACL that fails those tests). Enrolled via the admin device/tags API (the box has no passwordless sudo). Rollback captured.

**Plane B — Cloud relay (no-Tailscale consumer path): PROVEN.**
Tiny authenticated WSS relay on Railway (`https://relay-production-13f6.up.railway.app`); the **box dials out**, phone speaks plain public HTTPS — no Tailscale on the phone, no port-forward on the home router.
- Dashboard loads over the public internet with a per-box token: `?key=` → HttpOnly cookie → **200 `AgentBOX — Dashboard`**; cookie reuse 200; no/bad token **401**; unknown box **404**; >10MB **413**; http→https **301**.
- Resilience: kill box client → clean **503**, auto-reconnect → **200 in ~1s**. Stable systemd `--user` unit, NRestarts=0.
- Latency: relay path ~**0.3s** vs box-local ~5ms.

**Go/No-Go**
- Plane A → **GO** for vendor/operator use now (pending a `tag:box` lateral-movement audit).
- Plane B → **GO as the consumer fallback, NO-GO for GA as-is.** Must-fix before customer GA: single shared per-box token → per-phone rotating tokens; relay is in the data path unencrypted at the edge hop → E2E encryption *or* migrate consumers to libtailscale (drop the relay); add rate-limit + audit log; harden path check (encoded `..%2f` bypasses the literal `..` guard — LOW severity today: auth-gated, cannot cross boxes, same-box content only). Branded domain ties to **MBOX-451**.

**Known caveat (not a relay defect):** `/hermes/` → 502 on this box because the **hermes upstream (:9119) isn't running** on the bench box; the relay transparently serves the sidecar dashboard (200) and passes the 502 through. It'll be 200 once hermes is up. Detail in `notes/phase3-box-client.md`.

**Left running** for demo (Railway ~low-single-digit $/mo; dev box, token-gated). Teardown one-liner in the spike doc.

_Artifacts:_ code `infra/relay-poc/` (node --test 7/7), phase notes + ACL rollback under `infra/relay-poc/notes/`, branch `feat/mbox-498-relay-poc` (not pushed).
