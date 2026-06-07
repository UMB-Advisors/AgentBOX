---
quick_task: 260518-vsx
ticket: STAQPRO-410
title: mDNS / Avahi discovery for first-boot LAN access
date: 2026-05-18
commits:
  - f93ba58: "feat(staqpro-410): add avahi service record + factory-bootstrap.sh"
  - f6a8217: "feat(staqpro-410): add Caddy LAN listener with tls internal for mailbox.local"
  - 94c75bd: "docs(staqpro-410): add §1.5 mDNS / Avahi discovery to provisioning runbook"
files_added:
  - config/avahi/mailbox.service
  - scripts/factory-bootstrap.sh
files_modified:
  - caddy/Caddyfile
  - .env.example
  - docker-compose.yml
  - docs/runbook/provisioning.v0.1.0.md
---

## What shipped

Three commits wire end-to-end LAN discovery for customer #3+ appliances. `scripts/factory-bootstrap.sh` (new, idempotent) installs `avahi-daemon` + `avahi-utils`, sets the system hostname to `mailbox`, drops `config/avahi/mailbox.service` (a new XML Avahi record advertising `_http._tcp` on port 443 with `path=/dashboard/queue`) into `/etc/avahi/services/`, and enables the daemon via systemd. The Caddyfile gains a `{$MAILBOX_LAN_HOSTNAME}` site block using `tls internal` (Caddy's local CA) that mirrors the existing public site's basic_auth gate and reverse-proxy handlers. Docker Compose passes `MAILBOX_LAN_HOSTNAME` through to the Caddy container with a `:-mailbox.local` default so M1/M2 pick it up without touching their `.env`. The provisioning runbook gains a new §1.5 covering the full first-boot discovery flow, Tailscale coexistence, and hostile-router fallback paths; version bumped to v0.2.0.

## Files added / changed

| File | Purpose |
|------|---------|
| `config/avahi/mailbox.service` | Avahi XML service definition; advertises `_http._tcp` on port 443 under the system hostname (`%h` = `mailbox`), with TXT records `path=/dashboard/queue` and `version=v1` |
| `scripts/factory-bootstrap.sh` | Post-flash setup script: installs avahi, sets hostname to `mailbox`, installs the service record, enables daemon; refuses to run on already-enrolled `mailboxN` appliances (tailscale safety gate); idempotent |
| `caddy/Caddyfile` | New `{$MAILBOX_LAN_HOSTNAME}` site block appended after the existing `{$DOMAIN}` block; `tls internal` + same `basic_auth` + same `handle` structure; existing block unchanged (pure addition) |
| `.env.example` | Documents `MAILBOX_LAN_HOSTNAME=mailbox.local` with v1/v2 semantics and STAQPRO-409 upgrade path note |
| `docker-compose.yml` | `caddy.environment` extended with `MAILBOX_LAN_HOSTNAME: ${MAILBOX_LAN_HOSTNAME:-mailbox.local}` |
| `docs/runbook/provisioning.v0.1.0.md` | New §1.5 between §1 and §2; version bumped v0.1.0 → v0.2.0 |

## Verification command

Run this from the workstation (on the same LAN as a freshly-bootstrapped customer-#3 appliance after `factory-bootstrap.sh` has run):

```bash
avahi-resolve -n mailbox.local
# expected: mailbox.local  192.168.50.x  (the appliance's LAN IP)
```

Confirm the Avahi service record is advertising correctly:

```bash
dig @224.0.0.251 -p 5353 mailbox.local
# expected: ANSWER section with the appliance IP within ~5s
```

On macOS (Bonjour built in):

```bash
ping mailbox.local
# expected: ping resolves without needing avahi-utils installed
```

To confirm the Caddy LAN listener provisioned its `tls internal` cert after `docker compose up -d`:

```bash
ssh mailbox3 "docker logs mailbox-caddy-1 2>&1 | grep -i 'local certificate\|managed certificate\|internal'"
```

## M1 / M2 inertness

The design keeps live customers unaffected:

- **factory-bootstrap.sh** aborts if `tailscale status` lists a `mailboxN` hostname, so it cannot accidentally rename M1 (`mailbox1`) or M2 (`mailbox2`). The check pattern is `grep -qE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+[[:space:]]+mailbox[0-9]'` against `tailscale status` output.
- **Caddyfile LAN block** listens on `{$MAILBOX_LAN_HOSTNAME}` which defaults to `mailbox.local` via the `docker-compose.yml` `:-mailbox.local` fallback. M1 and M2 do not run `avahi-daemon` and their hostnames remain `mailbox1`/`mailbox2`, so nothing on their LANs resolves `mailbox.local` to them. The block listens but serves no requests.

When deploying this branch to M1/M2 the only required action is `git pull && docker compose restart caddy` (Caddyfile is bind-mounted; no rebuild needed). No `.env` change required — the default kicks in automatically.

## v2 upgrade path

Once STAQPRO-409 (slug-stamping) lands `/etc/mailbox-customer`:

1. `factory-bootstrap.sh` reads `CUSTOMER_SLUG=$(cat /etc/mailbox-customer)` instead of hardcoding `mailbox`, sets hostname to `"${CUSTOMER_SLUG}"`.
2. On the appliance `.env`, set `MAILBOX_LAN_HOSTNAME="${CUSTOMER_SLUG}.local"` and `docker compose up -d caddy`.
3. Update `config/avahi/mailbox.service`'s `version=v1` TXT record to the live git SHA (or wire it from a build arg).
4. Re-run `factory-bootstrap.sh` to re-stamp the avahi record under the new slug.

The `MAILBOX_LAN_HOSTNAME` env var is the only seam that needs to change between v1 and v2 on the Caddy side.

## Followups and known limitations

**STAQPRO-202 status drift (discovered during this task).** The planner's notes flagged that `scripts/factory-bootstrap.sh` doesn't exist "despite STAQPRO-202 being marked Delivered in Linear." After reading `first-boot.sh` and `jetson-bootstrap-ssh.sh`, it's clear that neither contains avahi logic — `factory-bootstrap.sh` is a net-new file, and STAQPRO-202 (if it was marked Delivered) was either tracking a different scope or was marked prematurely. The file created here is the authoritative implementation.

**Two-appliance same-LAN collision (v1 known limitation).** If two customer-#3 appliances end up on the same LAN before STAQPRO-409 ships, both advertise `mailbox.local`. Avahi auto-appends `-2` on the second device, but this is not documented as supported behavior. The runbook §1.5.f captures this and points to STAQPRO-409.

**`caddy validate` with stub Cloudflare token.** The automated verify command in the plan (`caddy validate` against the full Caddyfile with `CLOUDFLARE_API_TOKEN=stub`) exits 1 because the Cloudflare DNS provider module makes a live API call during provisioning — not a parse error. The LAN block (`tls internal`) was validated independently in an isolated Caddyfile and passed "Valid configuration". The full Caddyfile structure is correct; the error is a Cloudflare runtime check, not a parse failure.

**`avahi-utils` not installed on the provisioner workstation by default.** On Ubuntu: `sudo apt-get install -y avahi-utils`. On macOS: Bonjour handles `.local` natively; `avahi-utils` is not needed.

**Tailscale `--accept-dns=false` edge case.** If an operator has applied the §2a local workaround (`tailscale set --accept-dns=false` + resolv.conf swap), avahi still works on the appliance side but the customer's workstation may need its own mDNS resolver configured. This is a workstation-side issue; the appliance behavior is unchanged. Documented in runbook §1.5.d.
