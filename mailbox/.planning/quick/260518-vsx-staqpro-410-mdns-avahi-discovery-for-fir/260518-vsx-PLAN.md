---
phase: quick-260518-vsx
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - scripts/factory-bootstrap.sh
  - config/avahi/mailbox.service
  - caddy/Caddyfile
  - .env.example
  - docs/runbook/provisioning.v0.1.0.md
autonomous: true
requirements:
  - STAQPRO-410

must_haves:
  truths:
    - "After running factory-bootstrap.sh on a fresh Jetson, `avahi-daemon` is installed, enabled, and serving an `_http._tcp` record advertising `mailbox.local` on port 443."
    - "From a workstation on the same LAN, `avahi-resolve -n mailbox.local` returns the appliance's LAN IPv4 address and `dig @224.0.0.251 -p 5353 mailbox.local` answers."
    - "Opening `https://mailbox.local/` in a browser on the same LAN reaches the dashboard queue (after accepting the Caddy local-CA cert warning) without the operator knowing the IP."
    - "The Caddyfile's new LAN listener does NOT break the existing public-hostname listener on M1 (`mailbox.heronlabsinc.com`) or M2 (`mailbox.staqs.io`) when this branch is later deployed."
    - "The provisioning runbook documents the mDNS-first first-boot UX, the Tailscale `--accept-dns` coexistence check, and the consumer-router-blocks-mDNS fallback path."
  artifacts:
    - path: "scripts/factory-bootstrap.sh"
      provides: "Post-flash setup script that installs avahi-daemon + drops the mailbox.service record + enables the daemon. Idempotent."
      contains: "apt-get install -y avahi-daemon"
    - path: "config/avahi/mailbox.service"
      provides: "Avahi service file template advertising _http._tcp on port 443 with TXT records path=/dashboard/queue and version=<git-sha>"
      contains: "_http._tcp"
    - path: "caddy/Caddyfile"
      provides: "LAN listener block serving `mailbox.local` (and `*.local` fallback) with `tls internal` (Caddy local CA) + same basic_auth gate"
      contains: "mailbox.local"
    - path: ".env.example"
      provides: "Documents MAILBOX_LAN_HOSTNAME with default `mailbox.local` and forward-compat note for v2 `<customer-slug>.local`"
      contains: "MAILBOX_LAN_HOSTNAME"
    - path: "docs/runbook/provisioning.v0.1.0.md"
      provides: "New section between §1 (Hardware bring-up) and §2 (Tailscale) covering mDNS-based first-boot discovery + fallback"
      contains: "mDNS / Avahi"
  key_links:
    - from: "scripts/factory-bootstrap.sh"
      to: "config/avahi/mailbox.service"
      via: "install -m 644 config/avahi/mailbox.service /etc/avahi/services/mailbox.service"
      pattern: "config/avahi/mailbox.service"
    - from: "caddy/Caddyfile"
      to: "mailbox-dashboard:3001"
      via: "reverse_proxy on the mailbox.local site block"
      pattern: "mailbox.local.*reverse_proxy mailbox-dashboard:3001"
    - from: "docs/runbook/provisioning.v0.1.0.md"
      to: "scripts/factory-bootstrap.sh"
      via: "runbook references the bootstrap script invocation"
      pattern: "factory-bootstrap.sh"
---

<objective>
Make a freshly-flashed Jetson appliance reachable at `https://mailbox.local/` on
the LAN within 30 seconds of plugging in the network cable — no SSH, no `arp -a`,
no router DHCP table lookup. This is the customer-#3 first-boot UX the
onboarding wizard (STAQPRO-152) depends on.

Three things ship in this plan:
1. `scripts/factory-bootstrap.sh` installs and enables `avahi-daemon` and drops
   a service record that advertises the dashboard over `_http._tcp` port 443.
2. The Caddyfile gains a `mailbox.local` site block that uses Caddy's internal
   CA (`tls internal`) for LAN HTTPS — no public DNS needed.
3. The provisioning runbook gains a new §1.5 section documenting the
   discovery flow, the Tailscale `--accept-dns` coexistence check, and the
   hostile-router fallback (`avahi-resolve` from the workstation, or the
   router's DHCP table).

v1 ships with a single static `mailbox.local` hostname. v2 (once
STAQPRO-409 slug-stamping lands `/etc/mailbox-customer`) will swap to
`<customer-slug>.local`. The `MAILBOX_LAN_HOSTNAME` env var is the seam.

Output: customer #3 plugs in the box, opens Safari, types `mailbox.local`,
accepts a one-time cert warning, lands on the onboarding wizard.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@.planning/STATE.md
@caddy/Caddyfile
@docker-compose.yml
@scripts/jetson-bootstrap-ssh.sh
@docs/runbook/provisioning.v0.1.0.md
@.env.example

<interfaces>
<!-- Key facts the executor must use. Do NOT re-derive these. -->

Caddy site-block pattern (from caddy/Caddyfile lines 16-87):
- Global block at the top owns `email {$CADDY_EMAIL}`. Keep that as-is.
- Existing public site is `{$DOMAIN} { ... }` with `tls { dns cloudflare ... }`,
  basic_auth on `@protected not path /mcp-server/* /healthz /assets/*`,
  `handle /dashboard/*` → `reverse_proxy mailbox-dashboard:3001`,
  `handle` (catch-all) → `reverse_proxy n8n:5678`.
- The new LAN site block must mirror the SAME basic_auth + handle structure
  so LAN visitors aren't surprised by missing auth. Only the TLS line and
  the site address differ: `tls internal` instead of the Cloudflare DNS-01
  block.

Docker Compose caddy service (docker-compose.yml lines 142-160):
- `ports: - 80:80, - 443:443` already bound. The LAN listener piggybacks
  on the existing 443 binding — Caddy multiplexes site blocks by SNI/Host.
  No docker-compose.yml changes required.
- caddy.environment passes through DOMAIN, CADDY_EMAIL, CLOUDFLARE_API_TOKEN,
  MAILBOX_BASIC_AUTH_USER, MAILBOX_BASIC_AUTH_HASH. Add MAILBOX_LAN_HOSTNAME
  to this list so the Caddyfile can read it as `{env.MAILBOX_LAN_HOSTNAME}`.

Avahi service file shape (Debian/Ubuntu standard, /etc/avahi/services/*.service):
- XML; DTD is `avahi-service.dtd`.
- `<service-group><name replace-wildcards="yes">...</name><service><type>_http._tcp</type><port>443</port><txt-record>path=/dashboard/queue</txt-record></service></service-group>`
- Avahi watches /etc/avahi/services/ and reloads on file change — no daemon
  restart needed after dropping a new .service file.

Existing bootstrap script pattern (scripts/jetson-bootstrap-ssh.sh):
- Idempotent. `dpkg -s <pkg>` guard before `apt-get install`. `systemctl enable --now`.
- Requires `sudo`. Echoes `[N/M] step description` per step.
- factory-bootstrap.sh should follow the same conventions.

Tailscale coexistence (existing runbook §2a, STAQPRO-228):
- Tailscale's MagicDNS does NOT use mDNS — it's a unicast resolver at
  100.100.100.100. They coexist cleanly: tailnet hostnames resolve via
  100.100.100.100, `*.local` resolves via avahi-daemon on the LAN multicast
  group. `tailscale set --accept-dns=true` (the recommended state) does not
  hijack `.local`.
- The only failure mode to document: if an operator has run the §2a workaround
  (`--accept-dns=false` + the resolv.conf symlink swap), avahi still works
  but the customer's workstation may need its OWN resolver configured. This
  is a customer-side issue, not appliance-side.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Avahi service template + factory-bootstrap.sh</name>
  <files>config/avahi/mailbox.service, scripts/factory-bootstrap.sh</files>
  <action>
    Create the two host-side artifacts that make the appliance announce itself
    on the LAN.

    **1a. `config/avahi/mailbox.service`** — Avahi service definition.
    XML conforming to the avahi DTD. Single `_http._tcp` service on port 443.
    TXT records: `path=/dashboard/queue` and `version=v1`
    (the version string is a static placeholder for v1 — wiring it to the
    live git SHA is deferred to v2 alongside slug-stamping). Use
    `<name replace-wildcards="yes">%h</name>` so the service is announced
    under the host's mDNS hostname (which factory-bootstrap.sh sets to
    `mailbox` — see 1b). Header comment names STAQPRO-410 and explains
    why port 443 (Caddy LAN listener with `tls internal`) and not 3001.

    Content:
    ```xml
    <?xml version="1.0" standalone='no'?>
    <!DOCTYPE service-group SYSTEM "avahi-service.dtd">
    <!--
      MailBox Zero — appliance discovery record (STAQPRO-410).
      Advertises the dashboard over mDNS so a workstation on the same LAN
      can reach https://mailbox.local/ without knowing the appliance IP.

      Port 443 (not 3001): traffic is fronted by the Caddy LAN listener
      configured in caddy/Caddyfile, which terminates TLS via Caddy's
      internal CA and reverse-proxies to mailbox-dashboard:3001.

      v2 (after STAQPRO-409 slug-stamping): replace the static "v1" TXT
      record with the live git SHA, and swap the mDNS hostname from
      "mailbox" to "<customer-slug>" so two appliances on the same LAN
      don't collide.
    -->
    <service-group>
      <name replace-wildcards="yes">%h</name>
      <service>
        <type>_http._tcp</type>
        <port>443</port>
        <txt-record>path=/dashboard/queue</txt-record>
        <txt-record>version=v1</txt-record>
      </service>
    </service-group>
    ```

    **1b. `scripts/factory-bootstrap.sh`** — post-flash setup script.
    New file, executable (`chmod +x`). Follows the same conventions as
    `scripts/jetson-bootstrap-ssh.sh`: bash strict mode, sudo gate,
    idempotent step counter, dpkg guard before apt install. Steps:

    1. Install `avahi-daemon` and `avahi-utils` (the latter gives
       `avahi-resolve` for ops verification). Skip if already installed.
    2. Set the system hostname to `mailbox` via `hostnamectl set-hostname mailbox`.
       This is what `%h` in the service file expands to and what becomes
       `mailbox.local`. Guard: only run if current hostname is NOT already
       `mailbox` (idempotency + don't clobber a customer-renamed box).
       Note in script comment: v2 reads `/etc/mailbox-customer` (STAQPRO-409)
       to set this dynamically.
    3. `install -m 644 -o root -g root /home/$SUDO_USER/mailbox/config/avahi/mailbox.service /etc/avahi/services/mailbox.service`
       — the repo file is the source of truth; the system path is a copy.
       avahi-daemon picks it up automatically on the next inotify event.
    4. `systemctl enable --now avahi-daemon`.
    5. Print verification commands the operator should run from their
       workstation: `avahi-resolve -n mailbox.local`, `dig @224.0.0.251
       -p 5353 mailbox.local`.

    Script header: explain it's run ONCE after `jetson-bootstrap-ssh.sh`
    on a freshly-flashed appliance, before `docker compose up -d`. State
    explicitly that this script must NOT be run on customer #1 (M1) or
    customer #2 (M2) — they're already operational and switching their
    hostname to `mailbox` would break their existing tailnet identity
    (`mailbox1` / `mailbox2`) and the per-customer DNS records that point
    at their public domains. The script is for customer #3+ only. Add a
    safety check: refuse to run if `tailscale status` shows the host already
    enrolled under a `mailboxN` name (`grep -E '^[0-9.]+\s+mailbox[0-9]' &&
    abort with "this box looks like an already-deployed appliance; refusing
    to re-bootstrap"`).

    Make the script executable (`chmod +x scripts/factory-bootstrap.sh`).
  </action>
  <verify>
    <automated>bash -n scripts/factory-bootstrap.sh && test -x scripts/factory-bootstrap.sh && xmllint --noout config/avahi/mailbox.service 2>/dev/null || python3 -c "import xml.etree.ElementTree as ET; ET.parse('config/avahi/mailbox.service')"</automated>
  </verify>
  <done>
    Both files exist. factory-bootstrap.sh passes `bash -n` and is executable.
    config/avahi/mailbox.service is valid XML with one `_http._tcp` service on
    port 443 and the two TXT records. Script header explicitly excludes M1/M2
    and includes the tailscale-already-enrolled safety check.
  </done>
</task>

<task type="auto">
  <name>Task 2: Caddy LAN listener with `tls internal`</name>
  <files>caddy/Caddyfile, .env.example, docker-compose.yml</files>
  <action>
    Add a second site block to `caddy/Caddyfile` that serves the LAN
    hostname over HTTPS using Caddy's internal CA. The block mirrors the
    existing public site's basic_auth gate and reverse-proxy handlers
    so LAN visitors aren't surprised by missing auth.

    **2a. `caddy/Caddyfile`** — append a new site block AFTER the closing
    `}` of the existing `{$DOMAIN} { ... }` block (line 87). Use the env
    var `{$MAILBOX_LAN_HOSTNAME}` so customers can override (v2 will set
    this to `<customer-slug>.local` from STAQPRO-409 slug-stamping; v1
    defaults to `mailbox.local`).

    The new block:

    ```
    # ── LAN discovery listener (STAQPRO-410) ────────────────────────────
    # Reached via mDNS at `mailbox.local` (or whatever MAILBOX_LAN_HOSTNAME
    # is set to). The avahi-daemon record in /etc/avahi/services/mailbox.service
    # advertises this host on the LAN multicast group.
    #
    # TLS: `tls internal` uses Caddy's local CA. Browsers will show a
    # one-time cert warning until the operator imports Caddy's root cert,
    # or until v2 wires `mkcert -install` into factory-bootstrap.sh. This
    # is acceptable for the first-boot onboarding flow — the customer is
    # standing next to the box, not navigating a phishing page.
    #
    # Coexistence: this block has its own site address, so Caddy serves
    # both the public hostname ({$DOMAIN}) and the LAN hostname on the
    # same :443 binding. SNI routing handles the split.
    #
    # M1 / M2 inertness: when this branch deploys to M1/M2 (mailbox.heronlabsinc.com
    # / mailbox.staqs.io), MAILBOX_LAN_HOSTNAME defaults to `mailbox.local`.
    # M1/M2 do not run avahi-daemon (their hostnames stay `mailbox1`/`mailbox2`,
    # and factory-bootstrap.sh refuses to run on them) so this site block
    # is dormant — nothing on the LAN resolves `mailbox.local` to either
    # appliance. The block listens but answers no one. This is the
    # designed-inert behavior the plan promises.
    {$MAILBOX_LAN_HOSTNAME} {
      tls internal

      @protected not path /mcp-server/* /healthz /assets/*
      basic_auth @protected {
        {env.MAILBOX_BASIC_AUTH_USER} {env.MAILBOX_BASIC_AUTH_HASH}
      }

      redir /dashboard /dashboard/queue 308
      redir / /dashboard/queue 308

      handle /dashboard/* {
        reverse_proxy mailbox-dashboard:3001
      }

      handle {
        reverse_proxy n8n:5678
      }
    }
    ```

    **2b. `.env.example`** — add `MAILBOX_LAN_HOSTNAME` with default
    `mailbox.local` and a comment explaining v1/v2 semantics. Place it in
    the Caddy section, immediately after the `DOMAIN=` block.

    Content to add:
    ```
    # LAN-side hostname for mDNS discovery (STAQPRO-410). Caddy serves this
    # over its internal CA so a customer on the same LAN can reach the
    # dashboard at `https://mailbox.local/` during first-boot onboarding
    # without knowing the appliance IP.
    #
    # v1 (now): static `mailbox.local`. If two appliances are on the same
    # LAN this will collide — document the DHCP-table fallback in the
    # runbook.
    # v2 (after STAQPRO-409 slug-stamping): set this to
    # `<customer-slug>.local` so two appliances coexist.
    MAILBOX_LAN_HOSTNAME=mailbox.local
    ```

    **2c. `docker-compose.yml`** — extend the `caddy.environment` block
    (lines 151-156) so the new env var reaches the container. Add:
    ```
          MAILBOX_LAN_HOSTNAME: ${MAILBOX_LAN_HOSTNAME:-mailbox.local}
    ```

    The `:-mailbox.local` default ensures existing deployments (M1/M2)
    that haven't added this to their `.env` still parse the Caddyfile
    cleanly — Caddy doesn't crash on an empty site address because the
    env-substitution default kicks in.

    Do NOT modify the caddy service's `ports:` block or add a network
    declaration — the existing 443 binding multiplexes both site blocks
    by SNI.
  </action>
  <verify>
    <automated>docker run --rm -v "$(pwd)/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" -e DOMAIN=mailbox.example.com -e MAILBOX_LAN_HOSTNAME=mailbox.local -e CADDY_EMAIL=ops@example.com -e CLOUDFLARE_API_TOKEN=stub -e MAILBOX_BASIC_AUTH_USER=admin -e MAILBOX_BASIC_AUTH_HASH='$$2a$$10$$stub' caddy:2 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile</automated>
  </verify>
  <done>
    `caddy validate` succeeds against the modified Caddyfile with both env
    vars set. `.env.example` documents `MAILBOX_LAN_HOSTNAME` with the v1/v2
    note. `docker-compose.yml` passes the env var through to the caddy
    container with a `mailbox.local` default. Existing `{$DOMAIN}` block is
    UNCHANGED (verify with `git diff caddy/Caddyfile` — only additions, no
    edits to lines 1-87).
  </done>
</task>

<task type="auto">
  <name>Task 3: Provisioning runbook update (mDNS first-boot section + fallbacks)</name>
  <files>docs/runbook/provisioning.v0.1.0.md</files>
  <action>
    Insert a new section `## 1.5 mDNS / Avahi discovery (STAQPRO-410)`
    between §1 (Hardware bring-up) and §2 (Tailscale enrollment) in
    `docs/runbook/provisioning.v0.1.0.md`. This positions discovery setup
    as part of the post-flash sequence, before any Tailscale or Docker
    work.

    The section must cover:

    **a. What this gives you.** One-paragraph framing: "After this step,
    a customer on the same LAN can open `https://mailbox.local/` in any
    browser and reach the dashboard. No SSH, no IP lookup. Required for
    the onboarding wizard (STAQPRO-152) to be usable by non-technical
    customers."

    **b. Running factory-bootstrap.sh.** Single command:

        sudo bash ./scripts/factory-bootstrap.sh

    State: this comes AFTER `jetson-bootstrap-ssh.sh` and BEFORE the
    Tailscale `tailscale up` in §2. Idempotent — safe to re-run.

    **c. Verification from the workstation** (on the same LAN as the
    appliance):

        avahi-resolve -n mailbox.local
        # → mailbox.local  192.168.50.x

        dig @224.0.0.251 -p 5353 mailbox.local
        # → ANSWER section with the appliance IP

    If `avahi-resolve` is not installed on the workstation:
    `sudo apt-get install -y avahi-utils` (Ubuntu/Debian) or
    `brew install avahi` (macOS — though macOS resolves `.local` natively
    via Bonjour, no extra install needed; just `ping mailbox.local`).

    **d. Browser first-touch.** Open `https://mailbox.local/` in Safari or
    Chrome. Expect a one-time cert warning (Caddy local CA). Click
    "Proceed anyway" / "Show Details → visit this website". After auth
    prompt (basic_auth credentials from 1Password vault), the dashboard
    queue loads.

    **e. Tailscale `--accept-dns` coexistence.** Tailscale's MagicDNS is a
    unicast resolver at 100.100.100.100; it does NOT use mDNS multicast.
    The default `--accept-dns=true` does not hijack `.local` — avahi and
    Tailscale resolve different namespaces cleanly. **Verification on the
    appliance after running `tailscale up` in §2:**

        avahi-resolve -n mailbox.local      # must still answer
        getent hosts mailbox1.tail377a9a.ts.net   # tailnet name still resolves

    If `.local` stops resolving after Tailscale enrollment, the
    workstation has an unusual DNS config (e.g. `nss-mdns` disabled, or
    a corporate DNS suffix overriding `.local`). Not an appliance bug.

    **f. Hostile-router fallback.** Some consumer routers and most
    VLAN-segmented enterprise networks block mDNS multicast across
    subnets. If `avahi-resolve` from the workstation returns "Failed to
    resolve host name `mailbox.local`: Timeout reached", fall through to:

    1. **Router DHCP table.** Log into the customer's router admin UI,
       find the Jetson by MAC OUI (`4c:bb:47` NVIDIA or `3c:6d:66` ASUSTek
       — see CLAUDE.md "Hardware deltas").
    2. **arp -a from a host already on the LAN.** During the white-glove
       install, Dustin is already SSH'd into the box — `ip -o -4 addr
       show scope global` on the appliance prints the IP. Dictate that
       to the customer.
    3. **Plug a laptop directly into the appliance** via the spare
       ethernet port and use the workstation→Jetson direct-LAN profile
       documented in CLAUDE.md "Deployment Target" (10.42.0.0/24).

    **g. Why static `mailbox.local` for v1.** Single appliance per
    customer site = no collision risk. If a customer ends up with two
    appliances on one LAN before STAQPRO-409 (slug-stamping) lands, the
    second one gets `mailbox-2.local` automatically (avahi appends a
    suffix on conflict), but the runbook should not promise that — call
    STAQPRO-409 out as the proper fix.

    `TODO:` After STAQPRO-409 ships, replace `mailbox.local` references in
    this section with `<customer-slug>.local` and add a note about
    re-running `factory-bootstrap.sh` to re-stamp the avahi record.

    Bump the runbook version from `v0.1.0` to `v0.2.0` in the title +
    frontmatter — this is a "minor: added section" change per the
    runbook's own versioning convention. Add a one-line entry to the
    document's revision history (or create one at the top if absent).
  </action>
  <verify>
    <automated>grep -q "mDNS / Avahi discovery" docs/runbook/provisioning.v0.1.0.md && grep -q "avahi-resolve -n mailbox.local" docs/runbook/provisioning.v0.1.0.md && grep -q "Hostile-router fallback" docs/runbook/provisioning.v0.1.0.md && grep -q "v0.2.0" docs/runbook/provisioning.v0.1.0.md</automated>
  </verify>
  <done>
    The runbook has a new §1.5 between §1 and §2 covering: framing,
    factory-bootstrap.sh invocation, workstation verification commands,
    browser first-touch flow, Tailscale coexistence check, and the
    hostile-router fallback (DHCP table, arp -a, direct-LAN). Title +
    frontmatter bumped to v0.2.0. The TODO for STAQPRO-409 slug-stamping
    is captured inline.
  </done>
</task>

</tasks>

<verification>
End-to-end (manual, on a freshly-flashed customer-#3 Jetson when one exists):
1. Flash Jetson, run `jetson-bootstrap-ssh.sh`, run `factory-bootstrap.sh`.
2. Plug into customer LAN.
3. From workstation on same LAN: `avahi-resolve -n mailbox.local` returns the
   appliance IP within ~5s.
4. `docker compose up -d` brings up Caddy with both site blocks; check
   `docker logs mailbox-caddy-1 | grep "local certificate authority"`
   confirms `tls internal` cert was provisioned.
5. Browser → `https://mailbox.local/` → cert warning → accept → basic_auth
   prompt → dashboard queue.
6. Reboot appliance. After cold boot, step 3 still works (systemd-managed
   avahi-daemon survives).

In-branch (CI / automated, runs now):
- Task 1: `bash -n scripts/factory-bootstrap.sh` + XML well-formed check on
  the avahi service file.
- Task 2: `caddy validate` against the modified Caddyfile with both env vars
  stubbed.
- Task 3: `grep` checks confirm the new section landed with the right
  headings + content markers + version bump.

M1/M2 inertness check (do NOT run on M1/M2 boxes — verify by inspection
only):
- factory-bootstrap.sh has the tailscale-already-enrolled abort.
- Caddyfile's new site block listens on `{$MAILBOX_LAN_HOSTNAME}` which
  defaults to `mailbox.local`; M1/M2 don't run avahi, so nothing on their
  LANs resolves `mailbox.local` to them. The site block is dormant.
</verification>

<success_criteria>
- `scripts/factory-bootstrap.sh` exists, is executable, passes `bash -n`, and
  refuses to run on M1/M2 (tailscale-already-enrolled abort).
- `config/avahi/mailbox.service` is valid XML advertising `_http._tcp` on
  port 443 with `path=/dashboard/queue` and `version=v1` TXT records.
- `caddy/Caddyfile` passes `caddy validate` with both `DOMAIN` and
  `MAILBOX_LAN_HOSTNAME` env vars set. The existing public site block
  (lines 1-87) is unchanged.
- `.env.example` documents `MAILBOX_LAN_HOSTNAME=mailbox.local` with v1/v2
  semantics.
- `docker-compose.yml` passes `MAILBOX_LAN_HOSTNAME` through to the caddy
  container with `:-mailbox.local` default.
- `docs/runbook/provisioning.v0.1.0.md` has a new §1.5 covering mDNS
  discovery, Tailscale coexistence, and the hostile-router fallback;
  version bumped to v0.2.0.
- Three atomic commits land on `feat/staqpro-410-mdns-avahi` (one per task)
  and the working tree is clean after each.
</success_criteria>

<output>
After completion, create `.planning/quick/260518-vsx-staqpro-410-mdns-avahi-discovery-for-fir/260518-vsx-SUMMARY.md`
covering: what shipped, the M1/M2 inertness design (dormant LAN site block,
factory-bootstrap.sh refuses to run), the v2 upgrade path (STAQPRO-409
slug-stamping replaces `mailbox.local` with `<customer-slug>.local` and the
static `version=v1` TXT record with the live git SHA), and any deviations
from the ticket's acceptance criteria.
</output>
