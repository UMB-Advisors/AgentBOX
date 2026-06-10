# MailBox Provisioning Runbook v0.2.0

**Revision history:**
- v0.2.0 (2026-05-18): added §1.5 mDNS / Avahi discovery (STAQPRO-410) — mDNS-first first-boot UX, Tailscale coexistence, hostile-router fallback

**Status:** SKELETON — fill during 2026-05-02 walkthrough on customer #1 appliance, validate by reproducing on customer #2 (gates M3).

**Audience:** Whoever is provisioning a new MailBox appliance from a freshly-flashed Jetson + a customer's empty Google + DNS accounts. Assumes Dustin or successor.

**Tracks:** STAQPRO-163. Parent: STAQPRO-159 (M2 — 2nd-appliance readiness).

---

## How to use this doc

- Each section maps to one item in the STAQPRO-163 scope checklist.
- `TODO:` markers are walkthrough capture points — record the **exact command you'd type tonight**, not the tidied-up version.
- `OPEN Q:` markers are decisions/lookups that need a real answer before v1.0.0.
- `STALE:` markers are scope items the issue inherited from pre-DR-22 architecture; verify with Eric whether to drop or rewrite.
- Bump file version on revision: patch for typos, minor for added sections, major for structural rewrite.

## Pre-flight inventory (before touching the Jetson)

Collect from the customer **before** the unit ships:

- [ ] Domain to use (e.g. `mailbox.<customer>.com`) and DNS provider (Cloudflare assumed)
- [ ] Cloudflare API token (DNS-01 scope only — see §5)
- [ ] Google Workspace admin able to grant Gmail OAuth scopes
- [ ] Customer GCP project ID + billing contact (only relevant if §4 is reinstated; see STALE flag)
- [ ] Pooled UMB Anthropic API key allocation slot (Glue Co-managed)
- [ ] Tailscale invite delivered + accepted (for `mailboxN` enrollment)

`TODO:` Lift this into a customer-onboarding form (links to STAQPRO-164 sub-task "Customer GCP/DNS pre-flight").

---

## 1. Hardware bring-up

**Goal:** Jetson Orin Nano Super powered, JetPack 6.2.x installed, NVMe partitioned, Docker + nvidia-container-toolkit working, GPU passthrough verified.

- [ ] Flash JetPack 6.2.x via SDK Manager (host PC required; not scriptable)
- [ ] Install M.2 NVMe (500GB target per PRD §3.5)
- [ ] Partition NVMe — `p1` boot/EFI, `p2` rootfs, `p3` swap, `p4` data (LUKS-encrypted)
- [ ] Run `scripts/first-boot.sh` (existing, see `Install Guide/Install.md`)
- [ ] Install Docker via JetsonHacks `install_nvidia_docker.sh` (NOT `docker-ce` — breaks NVIDIA runtime)
- [ ] `nvidia-ctk runtime configure --runtime=docker`
- [ ] Verify GPU passthrough: `docker run --rm --runtime nvidia nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi`
- [ ] Confirm 25W power envelope under load (PRD §3.5) — `tegrastats` while Ollama loaded

`TODO:` Capture exact NVMe partition commands run on customer #1 (parted? sgdisk?). Existing `Install Guide/Install.md` covers flash + first-boot but stops short of the partition step.

`TODO:` Decide whether SDK Manager flashing stays manual or whether we ship pre-flashed eMMC images to customers.

---

## 1.5 mDNS / Avahi discovery (STAQPRO-410)

**Goal:** After this step, a customer on the same LAN can open `https://mailbox.local/` in any browser and reach the dashboard. No SSH, no IP lookup. Required for the onboarding wizard (STAQPRO-152) to be usable by non-technical customers.

Run this step AFTER `jetson-bootstrap-ssh.sh` and BEFORE the Tailscale `tailscale up` in §2. Idempotent — safe to re-run.

### a. Run factory-bootstrap.sh

    sudo bash ./scripts/factory-bootstrap.sh

This installs `avahi-daemon` + `avahi-utils`, sets the system hostname to `mailbox` (so avahi advertises as `mailbox.local`), drops the service record into `/etc/avahi/services/mailbox.service`, and enables the daemon via systemd.

**Safety gate:** The script refuses to run if `tailscale status` shows the host already enrolled under a `mailboxN` name (e.g. `mailbox1`, `mailbox2`). This protects M1 and M2 from accidental re-bootstrap. factory-bootstrap.sh is for **customer #3+ fresh appliances only**.

### b. Verify from the workstation (on the same LAN as the appliance)

    avahi-resolve -n mailbox.local
    # → mailbox.local  192.168.50.x

    dig @224.0.0.251 -p 5353 mailbox.local
    # → ANSWER section with the appliance IP

If `avahi-resolve` is not installed on the workstation:
- **Ubuntu/Debian:** `sudo apt-get install -y avahi-utils`
- **macOS:** Bonjour is built in — just `ping mailbox.local` (no extra install needed; Safari and Chrome resolve `.local` natively)

### c. Browser first-touch

Open `https://mailbox.local/` in Safari or Chrome. Expect a **one-time cert warning** — Caddy's local CA issued the certificate, which is not in the OS trust store by default. Click "Proceed anyway" / "Show Details → visit this website" (Chrome) or "Show Details → visit this website" (Safari). After the basic_auth prompt (credentials from the 1Password MailBOX vault), the dashboard queue loads.

The cert warning appears once per browser profile. Subsequent visits go straight to the dashboard.

### d. Tailscale `--accept-dns` coexistence

Tailscale's MagicDNS is a **unicast** resolver at `100.100.100.100`. It does not use mDNS multicast. The default `--accept-dns=true` does not hijack `.local` — avahi and Tailscale resolve different namespaces cleanly.

**Verify on the appliance after running `tailscale up` in §2:**

    avahi-resolve -n mailbox.local      # must still answer
    getent hosts mailbox1.tail377a9a.ts.net   # tailnet name still resolves

If `.local` stops resolving after Tailscale enrollment, the issue is on the workstation side (e.g. `nss-mdns` disabled, or a corporate DNS config overriding `.local`). The appliance is not the problem.

### e. Hostile-router fallback

Some consumer routers and most VLAN-segmented enterprise networks block mDNS multicast across subnets. If `avahi-resolve` from the workstation returns `"Failed to resolve host name mailbox.local: Timeout reached"`, fall through to:

1. **Router DHCP table.** Log into the customer's router admin UI and find the Jetson by MAC OUI (`4c:bb:47` = NVIDIA Ethernet PHY, `3c:6d:66` = ASUSTek — see CLAUDE.md "Hardware deltas").
2. **`ip addr` on the appliance.** During white-glove install, Dustin is already SSH'd in — `ip -o -4 addr show scope global` prints the IP. Dictate that to the customer.
3. **Direct-LAN cable.** Plug a laptop directly into the appliance's spare ethernet port and use the workstation→Jetson direct-LAN profile documented in CLAUDE.md "Deployment Target" (`10.42.0.0/24`).

### f. Why static `mailbox.local` for v1

One appliance per customer site = no collision risk in practice. Avahi auto-appends a numeric suffix on conflict (`mailbox-2.local`), but don't promise that to customers as the supported path — STAQPRO-409 (slug-stamping) is the proper fix.

`TODO:` After STAQPRO-409 ships, replace `mailbox.local` references in this section with `<customer-slug>.local` and add a note about re-running `factory-bootstrap.sh` to re-stamp the avahi record. Update `MAILBOX_LAN_HOSTNAME` in `.env` on the appliance at the same time.

---

## 2. Tailscale enrollment

**Goal:** Appliance reachable over the `consultingfutures@gmail.com` tailnet at a predictable hostname.

**Naming convention:** `mailboxN` (e.g. `mailbox1` is customer #1 / Heron Labs).

- [ ] `curl -fsSL https://tailscale.com/install.sh | sh`
- [ ] `sudo tailscale up --ssh --hostname=mailboxN`  ← **`--ssh` is mandatory** (see §2b)
- [ ] Approve device in admin console; assign tag `tag:mailbox-appliance`
- [ ] Verify MagicDNS: `tailscale ping mailboxN.tail377a9a.ts.net` from workstation
- [ ] Verify admin reach: `ssh <unix-user>@mailboxN` from the workstation lands a shell
- [ ] Document local SSH alias addition for ops team

### 2a. DNS sanity (STAQPRO-228)

**Before declaring the appliance ready for `docker compose up`**, verify public DNS works. Tailscaled takes ownership of `/etc/resolv.conf` and points it at the MagicDNS proxy (`100.100.100.100`). If the tailnet admin has not configured **Global nameservers** in [https://login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns), every public-hostname lookup returns SERVFAIL — `apt update`, Docker registry pulls, n8n's `Gmail Reply` node, and Ollama Cloud all break with `EAI_AGAIN` / "Temporary failure in name resolution". The MagicDNS proxy itself works; it just has nothing to forward to.

- [ ] On the appliance, verify both names resolve:

      getent hosts ports.ubuntu.com
      getent hosts www.googleapis.com

  Both must return an IP. If either is empty, DNS is broken — do not proceed.

- [ ] If broken, fix at the tailnet admin level (preferred — restores MagicDNS for the whole tailnet):

  1. In [https://login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns), add **Global nameservers** (e.g. `1.1.1.1` + `8.8.8.8`)
  2. On the appliance: `sudo tailscale set --accept-dns=true` (or wait for the daemon to re-pull DNS config)
  3. Re-run the `getent hosts ...` checks above

- [ ] If the admin-console fix isn't an option in the moment (e.g. tailnet owner unreachable during a customer-site install), apply the **local workaround** to unblock the install — this disables MagicDNS resolution **on this appliance only**; tailnet hostnames still resolve from the operator's workstation:

      sudo tailscale set --accept-dns=false
      sudo ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
      sudo systemctl restart systemd-resolved
      # if docker is already up, refresh container resolvers:
      docker compose restart n8n

  After the admin-console fix lands, revert with `sudo tailscale set --accept-dns=true` and confirm `dig @100.100.100.100 ports.ubuntu.com` returns an answer.

### 2b. Admin SSH access (Tailscale SSH is the standard)

**Decision (2026-06-10, supersedes the prior open question):** admin shell access to every
appliance is **Tailscale SSH**, not per-box `~/.ssh/authorized_keys`. Authorized-key copying
doesn't scale across the fleet and silently fails closed — agentbox3 was enrolled with a plain
`tailscale up` (no `--ssh`) and the admin had no way in without chasing the flashing operator
for a password. Tailscale SSH makes access a property of tailnet identity + ACL, centrally
managed, revocable, and key-free.

Two halves — **both** are required, or `ssh <user>@mailboxN` falls through to OpenSSH and
prompts for a password the admin doesn't have:

1. **Node side (automated).** `install/agentbox-install.sh` STAGE 0.2 runs
   `sudo tailscale set --ssh=true` on every install, so the SSH server is on regardless of how
   the operator typed `tailscale up`. The `--ssh` flag in the §2 enrollment command does the
   same at first enrollment; keep it. Factory-reset re-auth also keeps `--ssh`.

2. **Tailnet side (one-time, admin console).** The tailnet policy must carry an `ssh` rule
   granting the admin the unix accounts the appliances expose (`bob`, `mailbox`). Add once to
   the ACL at [login.tailscale.com/admin/acls](https://login.tailscale.com/admin/acls):

   ```jsonc
   "ssh": [
     {
       "action": "accept",
       "src":    ["autogroup:admin"],
       "dst":    ["tag:mailbox-appliance", "tag:mailbox"],
       "users":  ["bob", "mailbox", "autogroup:nonroot"]
     }
   ]
   ```

   Without this rule, `tailscale set --ssh=true` on the box is a no-op for the admin.

**ACL tags:** all appliances share `tag:mailbox-appliance` (legacy boxes also carry `tag:mailbox`).
No per-box ACL group — fleet-wide grants via the shared tag are the intent. Per-box isolation,
if ever needed, is a future change, not the default.

`OPEN Q:` `iptables v1.8.7 (legacy): unknown option "--restore-mark"` shows up in `journalctl -u tailscaled` on JetPack 6.2 (STAQPRO-228 side-observation). Known iptables/tailscaled mismatch; **does not** affect DNS in practice, and the daemon recovers via the legacy code path. File a follow-up issue if a customer ever traces a tailnet connectivity problem back to it — otherwise leave alone.

---

## 3. Docker Compose stack bring-up

**Goal:** All 8 services healthy with version pins per CLAUDE.md "Service topology" table.

Services (per CLAUDE.md): `postgres`, `qdrant`, `ollama`, `n8n` (2.14.2 — upgraded 2026-05-01 per STAQPRO-181, supersedes DR-17), `caddy`, `mailbox-dashboard`, `mailbox-migrate`. Operator shell access is via Tailscale SSH only — `ttyd` was removed 2026-05-01 per STAQPRO-126/182.

- [ ] `git clone https://github.com/UMB-Advisors/mailbox.git ~/mailbox`
- [ ] Copy `.env.example` → `.env`, fill secrets (see §4–§9 for each)
- [ ] `docker compose --profile migrate run --rm mailbox-migrate` (run migrations before app boot)
- [ ] `docker compose up -d --remove-orphans`
- [ ] `docker compose ps` — all services Healthy or Up
- [ ] Pull models inside Ollama container: `qwen3:4b-ctx4k` (custom 4096 ctx Modelfile per DR-18) + `nomic-embed-text:v1.5`
- [ ] n8n: import workflow JSONs (`n8n/MailBOX*.json`) + activate parent workflow only

`TODO:` Capture the exact Modelfile used to build `qwen3:4b-ctx4k` from `qwen3:4b`. Should live in `n8n/` or a new `models/` dir.

`TODO:` Document n8n credential setup — Postgres + Gmail OAuth + Ollama + Anthropic. Credentials go through n8n UI; capture screenshots or step list.

`TODO:` Activation gotcha — CLAUDE.md notes that sub-workflows invoked via `executeWorkflowTrigger` should have `active: false`. Capture the activation matrix (parent active, sub-workflows inactive).

---

## 4. Customer GCP project (Pub/Sub + OIDC + billing)

**`STALE:`** Original scope assumed Pub/Sub push ingress. **DR-22 KILLED 2026-04-30** — current ingress is Schedule trigger (5 min) + Gmail Get polling. No Pub/Sub topic, no OIDC service account, no public webhook for Gmail to push to.

**Decision required before writing v0.2.0:** drop this section entirely, or keep a thin GCP-project section just for the Anthropic billing alarm precedent? Default = drop; revisit if we ever re-introduce push.

If section is dropped, redirect §4 of the scope checklist into §9 (Anthropic key provisioning) and §10 (handoff/monitoring).

`OPEN Q:` Confirm with Eric that GCP project is no longer customer-side dependency. If true, this also simplifies pre-flight inventory.

---

## 5. Customer DNS + Cloudflare API token

**Goal:** appliance hostname resolves to the appliance's LAN IP; Caddy can complete DNS-01 challenge against the parent Cloudflare zone.

**Two patterns are supported** (decided in NC-25 / **STAQPRO-183**, 2026-05-13):

### Pattern A — Shared Staqs subdomain (customer 3+, default for new appliances)

Hostname: `<customer-slug>.mailbox.<MAILBOX_SHARED_DOMAIN>` → appliance LAN IP. One Staqs-owned parent zone covers all appliances on this pattern; the customer never touches DNS.

- [ ] On the provisioner workstation, set in `.env`:
      - `CLOUDFLARE_API_TOKEN` — Zone → DNS → Edit on the parent zone only
      - `CLOUDFLARE_ZONE_ID` — from CF dashboard → zone overview → right sidebar
      - `MAILBOX_SHARED_DOMAIN` — `staqs.io` (Staqs-owned shared root, locked in for NC-25)
- [ ] Dry-run first to confirm hostname assembly + zone-cover check:
      ```bash
      ./scripts/provision-customer-dns.sh --dry-run <customer-slug> <lan-ip>
      ```
- [ ] Create the record (idempotent — safe to re-run):
      ```bash
      ./scripts/provision-customer-dns.sh <customer-slug> <lan-ip>
      ```
- [ ] Script enforces: `proxied=false` (DNS-01 + LAN-IP requirement), TTL 60s, slug matches `^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$`. See script header for full env/exit-code docs.
- [ ] On the appliance, set in `.env`:
      - `DOMAIN=<customer-slug>.mailbox.<MAILBOX_SHARED_DOMAIN>` (the full hostname)
      - `CLOUDFLARE_API_TOKEN` — same token as the provisioner (Caddy uses it for DNS-01 cert solving and renewal)

### Pattern B — Customer-owned domain (M1 grandfathered)

Hostname: `mailbox.<customer-domain>` (e.g. `mailbox.heronlabsinc.com`). Customer keeps their own Cloudflare zone and issues us a scoped token. Use ONLY for legacy / explicit customer-owned-domain requests; default for new appliances is Pattern A.

- [ ] Customer creates `CLOUDFLARE_API_TOKEN` (Zone → DNS → Edit on their zone)
- [ ] Customer creates the A record manually (or via the same provisioning script if they hand us zone ID + token)
- [ ] A record points at appliance LAN IP, **proxied=off**

### Common to both patterns

- [ ] Cloudflare API token scope: **Zone → DNS → Edit** on the specific zone only (NEVER account-wide). One leaked appliance token must not be able to walk the whole CF account.
- [ ] Record `proxied=false` (orange cloud OFF). Proxied mode breaks DNS-01 and hides the LAN IP.

**Why DNS-01:** appliance lives behind the customer's NAT; HTTP-01 challenge would require an inbound public port (it doesn't have one). DNS-01 runs entirely against the Cloudflare API, so a LAN-only appliance can still get and renew a valid Let's Encrypt cert.

`TODO:` Record exact Cloudflare token-create UI clicks for Pattern A (token templates change; screenshot once and version).

`MAILBOX_SHARED_DOMAIN` is `staqs.io` — locked in for NC-25 (STAQPRO-183). Zone provisioning + scoped Cloudflare token issuance for `staqs.io` are tracked in the NC-25 live cutover follow-up issue.

---

## 6. Caddy bring-up + cert issuance

**Goal:** `https://<domain>/dashboard/queue` returns 200 (with basic_auth) using a valid Let's Encrypt cert via DNS-01.

- [ ] `Caddyfile` populated with customer domain
- [ ] `MAILBOX_BASIC_AUTH_HASH` set in `.env` — **escape every `$` to `$$`** (CLAUDE.md `.env` escaping note; bcrypt hash silently truncates otherwise)
- [ ] `docker compose up -d caddy`
- [ ] Tail logs for cert acquisition: `docker logs caddy -f` — look for "certificate obtained successfully"
- [ ] Verify from workstation: `curl -u user:pass https://<domain>/dashboard/queue` → 200
- [ ] Verify auth gate works on **all paths** including `/webhook/*` (STAQPRO-161 closed the bypass; regression-check it on every appliance)

`TODO:` First-cert-issuance can take 60–120s. Document expected log lines so a customer-side install session doesn't panic at the 30s mark.

`TODO:` Document cert renewal failure mode (Risk R1 in project description; tracked under STAQPRO-166).

---

## 7. Gmail OAuth + watch registration + historyId bootstrap

**Goal:** n8n's Gmail credential is authorized; the polling Schedule trigger picks up new mail every 5 min.

**`STALE:`** Original scope said "watch registration + historyId bootstrap." Those are the Gmail Push API artifacts that DR-22 retired. Current architecture is **Schedule trigger (5 min) + Gmail Get** — no `users.watch()` call, no historyId tracking. Replace this section with:

- [ ] Customer Workspace admin grants OAuth scopes to our Cloud project's OAuth client (scopes: `gmail.readonly`, `gmail.send`, `gmail.modify` — verify against current node)
- [ ] In n8n UI → Credentials → Gmail OAuth2 → "Connect" → complete OAuth dance
- [ ] Test credential against `Gmail Get` node — fetches latest 1 message
- [ ] Activate parent `MailBOX` workflow (Schedule trigger fires every 5 min)
- [ ] Verify first poll cycle: `docker logs n8n --tail 100` shows successful Gmail Get
- [ ] Empty-cycle behavior — CLAUDE.md notes `Insert Inbox (skip dupes)` with no Gmail returns produces an empty `$json` that fires `Run Classify Sub` once; harmless `Load Inbox Row` error is expected on idle 5-min cycles

`OPEN Q:` OAuth client — single Glue Co OAuth client used across customers, or per-customer client?

`TODO:` Document Google's "verified app" status of our OAuth client. Affects whether each new customer sees a scary "unverified" warning during consent.

---

## 8. Smoke test: full pipeline loop

**Goal:** Send a real email to the customer's connected inbox, see it appear in the approval queue, approve it, see the reply land in the original sender's inbox.

Steps:
- [ ] Send test email from a known external account (e.g. `provisioning-test@umbadvisors.com`) to the customer's connected Gmail
- [ ] Wait ≤ 5 min (next Schedule trigger fire)
- [ ] Verify in Postgres: `SELECT classification, draft_source, status FROM mailbox.drafts ORDER BY created_at DESC LIMIT 5;`
- [ ] Verify in dashboard: draft visible at `https://<domain>/dashboard/queue`
- [ ] Click Approve
- [ ] Verify reply received at sender mailbox within ~30s
- [ ] Verify final state: `status='sent'` in `mailbox.drafts`

Latency budget reminders (PRD §3.5): inbound → draft in queue ≤ 30s local / ≤ 60s cloud. **Note:** Schedule polling adds up to 5 min wait before the 30s/60s budget starts.

`TODO:` Build a `scripts/provisioning-smoke.sh` that automates the Postgres assertion. Existing `scripts/smoke-test.sh` is infra-only per CLAUDE.md, doesn't exercise the pipeline (STAQPRO-133 will close the deeper test gap).

---

## 9. Anthropic key provisioning (pooled UMB key)

**Goal:** Cloud-route drafts work. Currently default cloud path is **Ollama Cloud `gpt-oss:120b`** (per 2026-04-30 pivot superseding DR-23). Anthropic Haiku 4.5 is config-ready alt-cloud.

- [ ] Allocate appliance an `OLLAMA_CLOUD_API_KEY` slot from the pooled UMB Ollama Cloud account
- [ ] Set `OLLAMA_CLOUD_API_KEY` and `OLLAMA_CLOUD_MODEL=gpt-oss:120b` in `.env`
- [ ] (Optional alt-cloud) Set `ANTHROPIC_API_KEY` if customer prefers Haiku — currently commented out in `.env.example`
- [ ] Restart `mailbox-dashboard` so the draft route picks up env
- [ ] Verify cloud route: send an email matching `CLOUD_CATEGORIES` (`escalate`, `unknown`) and confirm `drafts.draft_source='cloud'`, `drafts.model='gpt-oss:120b'`

`TODO:` Billing model — customer is billed via Glue Co at cost + 20% per PRD. Document the meter source (assume `dashboard/app/api/system/status/route.ts` cloud spend meter from STAQPRO-146 covers display, but billing extraction TBD).

`OPEN Q:` Per-customer key isolation vs pooled key with usage tagging — current state is pooled; do we ever need per-customer for chargeback clarity?

---

## 10. Handoff checklist

**Goal:** Customer knows what they have, what they see, and what to do when something looks wrong. Glue Co knows what we monitor.

### What the customer sees / can do
- [ ] Approval queue URL + basic auth credentials (delivered out-of-band, e.g. 1Password vault share)
- [ ] How to approve / reject / edit a draft
- [ ] How to escalate (Slack channel? Email? Phone?)
- [ ] Expected polling cadence (5 min) — sets expectation that draft appearance isn't instant
- [ ] What "spam_marketing" classification does (silently drops — they won't see it)

### What we (Glue Co) monitor
- [ ] Tailscale device shows online
- [ ] `docker compose ps` all-green check (frequency: TBD, see STAQPRO-166 risk owners)
- [ ] Cert renewal status (Risk R1)
- [ ] Anthropic / Ollama Cloud spend (STAQPRO-146 status page surfaces this)
- [ ] Postgres free space + `mailbox.drafts` row count growth
- [ ] Classification accuracy spot-checks — sample N drafts/week, judge correctness

### Documentation to deliver to customer
- [ ] Operator quick-start (1-page PDF — TBD)
- [ ] Privacy guarantee statement (per PRD: all email content stays local)
- [ ] Support contact + SLA expectations

`TODO:` Decide who carries the pager for which signal. Most of these tie back to STAQPRO-166 (risk/SM owners). Cross-link the runbook to that issue's eventual owner table.

`OPEN Q:` SLA — what's the customer-facing response-time commitment? Not in PRD §3.5.

---

## Appendices

### A. Time-to-provision target

Per STAQPRO-163 acceptance criteria, this is a baseline metric to record on first-reproduction.

`TODO:` Stopwatch the customer #2 install. Capture wall-clock total + per-section subtotals. Bake the number into v0.2.0.

### B. Reference docs

- `Install Guide/Install.md` — flash + first-boot script (covers part of §1)
- `CLAUDE.md` "Service topology" table — service version pins
- `.env.example` — secret inventory
- `docker-compose.yml` — service definitions
- PRD §3.5 — power, latency, boot-time budgets
- DR-17 (n8n pin) — **superseded 2026-05-01 by STAQPRO-181 upgrade to 2.14.2**; DR-18 (Qwen3-4B 4k ctx), DR-22 (Pub/Sub KILLED), DR-24 (Next.js dashboard) — see CLAUDE.md "Active decision records"

### C. Known gotchas (CLAUDE.md "Conventions" lift-and-shift)

- `.env` bcrypt hashes need `$` → `$$` escaping
- n8n sub-workflows that run via `executeWorkflowTrigger` should be `active: false`
- `docker compose restart caddy` for config changes — NOT `caddy reload` (admin API stale-config trap)
- Empty 5-min poll cycles produce a benign `Load Inbox Row` error — don't panic
