# Addendum 001 — Absorb MailBOX into the AgentBOX monorepo

> **Created:** 2026-06-07
> **Amends:** [`agentbox-jp72-reproduction.v0.1.0.md`](./agentbox-jp72-reproduction.v0.1.0.md)
> **Status:** in PR #12 (`feat/umb-105-absorb-mailbox`) — not yet merged
> **Linear:** UMB-105 (epic), UMB-110/111/106

This addendum supersedes the parts of the v0.1.0 runbook that describe the
MailBOX stack as a **separately-cloned repo**. As of UMB-105 the stack is
**vendored in this monorepo** under [`mailbox/`](../mailbox); there is no
external clone. Everything else in v0.1.0 (JP7.2 base prep, Hermes 0.15.1 pin,
single-Ollama DR-64, dashboard token handling, verify steps) still holds.

## What changed vs v0.1.0

| Area | v0.1.0 (clone model) | Now (absorbed monorepo) |
|---|---|---|
| MailBOX stack source | `git clone UMB-Advisors/mailbox` @ `MAILBOX_GIT_REF` | **vendored** at `$REPO/mailbox` (subtree of ab1 ground truth `cdebb19`) |
| Installer STAGE 0.5 | clone/fetch into `~/mailbox` | **rsync** `$REPO/mailbox` → `$STACK_DIR` (`cp -a` fallback); preserves runtime `.env`, override, volume data, GGUFs |
| Vars | `MAILBOX_GIT_URL`, `MAILBOX_GIT_REF` | removed (clone is gone) |
| systemd units | `agentbox`, `hermes-dashboard` | **+ `hermes-gateway.service`** (STAGE 8 installs/enables all three) |
| Submodule | `mailbox/vendor/thumbox-common` (gitlink) | dropped — unused on ground truth; monorepo is self-contained |

## TL;DR — set up a new AgentBOX (updated)

Flashed Jetson (JP7.2), then one command — the clone now brings the **whole**
appliance (stack included), no second repo:
```
git clone https://github.com/UMB-Advisors/AgentBOX.git ~/agentbox && cd ~/agentbox
install/agentbox-install.sh --prototype        # bench: throwaway secrets, skip caddy
```
From bare hardware, use **`/agentbox-flash`** as before.

`STACK_DIR` still defaults to `~/mailbox` (the runtime checkout). STAGE 0.5 now
*populates* it from the vendored `mailbox/` instead of cloning, so the runtime
dir and the repo stay in sync on every install/re-run.

## Updated stage 0.5 / 8 (replaces those rows in the v0.1.0 table)

| Stage | Action |
|---|---|
| 0.5 | **sync the vendored MailBOX stack** (`$REPO/mailbox` → `$STACK_DIR`); apply `config/docker-compose.override.yml.template` (loopback publishes) |
| 8 | **boot-to-ready**: install `systemd/{agentbox,hermes-dashboard,hermes-gateway}.service` + enable-linger |

## hermes-gateway.service

The messaging gateway runs on the agentbox1 ground truth but was missing from
the repo and from agentbox2. It is now `systemd/hermes-gateway.service`, captured
from ab1 and converted from a system unit to a **user unit** (matching the other
AgentBOX units: `%h`, `WantedBy=default.target`), keeping the graceful-drain stop
behavior (`TimeoutStopSec=210`, `SIGTERM`, `USR1` reload). It runs
`hermes gateway run --replace` and starts after `hermes-dashboard.service`.

> **Operator note:** the gateway only does useful work once messaging-platform
> credentials are configured in Hermes. On a fresh box it will start but idle (or
> restart) until those are set — verify creds before treating a non-active
> gateway as a failure. (UMB-106 tracks the agentbox2 deploy.)

## Reconciliation notes (2026-06-07)

- The vendored baseline is **agentbox1's running tree `cdebb19`**, which was
  *ahead* of GitHub `feat/agentbox-unified` by two commits (CRM Phase 1 +
  migration 048). GitHub was ahead by one commit — n8n-activation hardening in
  the **legacy** `mailbox/scripts/agentbox-install.sh` — which is being folded
  into the AgentBOX installer (`install/agentbox-install.sh`); the legacy script
  is retained as-is in the vendored tree for reference.
- The compose **override** is deliberately not vendored; `config/docker-compose.override.yml.template` remains the canonical copy and STAGE 0.5 renders it.

## Provenance
Repo absorb performed 2026-06-07 against the live reconciliation of agentbox1
(JP6.2 ground truth) and agentbox2 (JP7.2 rebuild), both serving the `:9119`
unified appliance. Supersedes the "AgentBOX-clones-MailBOX" design (`dc8de53`).
