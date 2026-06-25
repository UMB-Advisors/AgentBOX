# Plan 016: Design spike — branded client-facing URL for the dashboard (MBOX-451)

> **Executor instructions**: This is a DESIGN SPIKE, not a build plan. The
> deliverable is a short design doc with a recommended topology — not code.
> Follow the steps, honor STOP conditions, update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat ad6b760..HEAD -- config/Caddyfile.funnel.template mailbox/caddy/ mailbox/scripts/provision-customer-dns.sh`
> On material change, re-inventory before writing.

## Status

- **Priority**: P3 (product/sales)
- **Effort**: S–M (spike); build likely S–M
- **Risk**: LOW (documents only)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `ad6b760`, 2026-06-11

## Why this matters

Customers currently reach their appliance via an SSH tunnel or a
Tailscale-Funnel hostname (`*.ts.net`) — functional, but it reads as a science
project in a sales demo and is tracked as a real gap (project CLAUDE.md:
"Client-facing branded URL is tracked in MBOX-451"). The repo already contains
most of the raw material: a Funnel-fronted Caddy template and a
`provision-customer-dns.sh` script. The spike decides the topology and writes
the runbook-shaped design so the build is a config change, not an adventure.

## Current state (verified at planned-at SHA)

- `config/Caddyfile.funnel.template` — Caddy behind Tailscale Funnel
  (header comment, verbatim): "exposed via Tailscale Funnel (TLS terminated at
  Funnel, so Caddy serves plain HTTP here). basic_auth gates all paths…
  Then: funnel -> tailscale funnel --bg 8088". Funnel implies the public
  hostname is the tailnet's `*.ts.net` name — Funnel does **not** serve
  custom domains; that constraint shapes every option.
- `mailbox/scripts/provision-customer-dns.sh` — exists (read fully in
  Step 1; determine what DNS provider/API it drives and what names it mints).
- `mailbox/caddy/` — the on-box Caddy build/config used by compose (caddy
  service at `mailbox/docker-compose.yml:166`, MBOX-184 digest-pin comments).
- The Hermes dashboard is loopback-bound on `:9119` (project CLAUDE.md);
  the mailbox dashboard sits behind Caddy.
- Linear: MBOX-451 in the staqs workspace holds the product intent — if the
  `linear-staqs` MCP tools are available in your environment, read the issue
  and cite it; otherwise note it as unread input.

## Commands you will need

| Purpose | Command |
|---------|---------|
| Read DNS script | `cat mailbox/scripts/provision-customer-dns.sh` |
| Map ingress configs | `grep -rn "funnel\|ts.net\|cloudflare" config/ mailbox/caddy/ mailbox/scripts/ install/ provisioning/ --include="*.sh" --include="*.template" --include="Caddyfile*" -i \| head -30` |
| Read MBOX-451 (optional) | linear-staqs MCP `get_issue` if available |

## Scope

**In scope (deliverables)**:
- `docs/branded-url-design.v0.1.0.md` (create): options matrix, recommended
  topology, per-customer provisioning steps, security notes, build estimate.

**Out of scope**:
- Any config or code change; DNS changes; touching live boxes
- Certificate/key material of any kind in the doc (reference by mechanism,
  never by value)

## Git workflow

- Branch: `docs/branded-url-design`
- One commit: `docs(infra): branded client URL design (MBOX-451)`

## Steps

### Step 1: Inventory the existing ingress paths

Read the Funnel template, the caddy compose service + its config source in
`mailbox/caddy/`, `provision-customer-dns.sh`, and any Tailscale config under
`infra/acl`. Document the as-is: every way a browser currently reaches each
dashboard, with the auth gate each path crosses.

### Step 2: Options matrix

Evaluate at least these three against: custom-domain support, TLS issuance,
exposure surface, per-customer provisioning effort, dependency on customer
DNS cooperation:

1. **Cloudflare Tunnel** (cloudflared on the box → `mailbox.<customer>.com`):
   real custom domains, outbound-only connection, Cloudflare Access can
   replace/augment basic_auth. Check whether `provision-customer-dns.sh`
   already assumes Cloudflare — that's a strong signal.
2. **Tailscale Funnel + vanity redirect**: keep Funnel as transport; a
   branded domain 302s/CNAMEs to the ts.net name. Cheapest; the URL bar still
   shows ts.net after redirect (call out honestly).
3. **Direct Caddy with public DNS + Let's Encrypt** (port-forward or static
   IP at the customer site): no third-party tunnel, but inbound exposure and
   per-site network dependence.

### Step 3: Recommendation + provisioning runbook sketch

Pick one, justify in ≤1 page, then sketch the per-customer flow end to end
(mint DNS → install tunnel/cert → update Caddy site block → verify), naming
which repo files change (e.g., a new `config/Caddyfile.branded.template`, an
installer stage, env vars) and the build effort per piece. Include the
security delta: what becomes internet-reachable that wasn't, and how the
basic_auth/auth-gate story carries over (tie to plan 008's findings if
available).

## Done criteria

- [ ] `docs/branded-url-design.v0.1.0.md` exists: TL;DR, as-is ingress map
      with citations, 3-option matrix, recommendation, provisioning sketch,
      security delta, build estimate
- [ ] No code/config modified (`git status`)
- [ ] No secrets or live hostnames beyond what the repo already records
- [ ] `plans/README.md` status row updated

## STOP conditions

- `provision-customer-dns.sh` reveals a branded-URL implementation already
  half-built (e.g., it already mints customer subdomains for this purpose) —
  pivot the doc to "finish what exists" and say so.
- The ingress map can't be established from the repo (per-box state only) —
  list precisely what must be checked on a live box and stop.

## Maintenance notes

- The recommendation should become an ADR once the operator picks — this is
  infrastructure that locks in (`docs/decisions/`).
- Whichever option wins, the wizard's network-check page (plan 014) should
  eventually probe the branded URL — note the linkage.
