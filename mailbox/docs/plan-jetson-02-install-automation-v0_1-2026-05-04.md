# MailBOX Customer #2 — Jetson `mailbox-jetson-02` Install Automation Plan

> **Target spec version:** Phase 1 / M3 — Customer #2 onboarding
> **Plan version:** v0.1
> **Created:** 2026-05-04
> **Owner:** Dustin (UMB Group)
> **Audience:** Claude Code, running interactively on the operator's workstation (`bob@bob-TB250-BTC`) with SSH reach into the new Jetson
> **Status:** READY TO EXECUTE
>
> **Source Linear tickets** (read these first if context is missing):
> - [STAQPRO-174](https://linear.app/staqs/issue/STAQPRO-174) — Hardware procurement & imaging (parent task list)
> - [STAQPRO-202](https://linear.app/staqs/issue/STAQPRO-202) — `scripts/factory-bootstrap.sh` (DELIVERED — the automation backbone)
> - [STAQPRO-201](https://linear.app/staqs/issue/STAQPRO-201) — GUI purge / headless baseline (DELIVERED, runbook in PR #47)
> - [STAQPRO-163](https://linear.app/staqs/issue/STAQPRO-163) — Provisioning runbook (DELIVERED, PR #1)
> - [STAQPRO-175](https://linear.app/staqs/issue/STAQPRO-175) — DNS + Cloudflare pre-flight
> - [STAQPRO-177](https://linear.app/staqs/issue/STAQPRO-177) — Install session + first end-to-end cycle (verification gates live here)
> - [STAQPRO-228](https://linear.app/staqs/issue/STAQPRO-228) — Tailscale MagicDNS gotcha (MUST pre-empt)
> - [STAQPRO-226](https://linear.app/staqs/issue/STAQPRO-226) — Gmail rate-limit bootstrap mode (MUST pre-empt)

---

## 0. Plan philosophy

This plan is structured as **idempotent phases** that Claude Code executes top-to-bottom. Every phase has:

- A **goal** (one sentence)
- **Pre-conditions** (what must already be true)
- **Commands** (verbatim, copy-paste ready)
- **Verification** (a check that decides "go to next phase" vs "stop and report")
- **Known gotchas** (failure modes already seen in customer #1 / Heron Labs build)

**If any verification step fails, Claude Code halts and reports.** Do not paper over a failure to "continue the plan." Customer #2 is the first cross-business validation; silent dark-classified inboxes are the #1 risk (see STAQPRO-181 and the n8n active-flag gotcha codified in `CLAUDE.md`).

The two phases marked **HUMAN-IN-LOOP** require interactive consent (Tailscale auth code, Gmail OAuth, Cloudflare token paste). Claude Code prompts and waits.

---

## 1. Pre-flight (workstation-side)

### Goal
Confirm the operator's workstation has everything needed to drive the remote install before the Jetson is even powered on.

### Pre-conditions
- New Jetson Orin Nano Super 8GB sitting on the desk, NVMe installed (per project hardware spec — Samsung 980 500GB)
- Operator (Dustin) has sudo on the workstation
- `gh` CLI authenticated as `consultingfuture4200`
- Customer #2 domain `futurecompounds.com` already in Cloudflare under operator control

### Commands

```bash
# 1.1 Verify SDK Manager presence (needed for JetPack 6.2 flash)
which sdkmanager || echo "MISSING — install from https://developer.nvidia.com/sdk-manager"

# 1.2 Verify gh auth and repo access
gh auth status
gh repo view UMB-Advisors/mailbox --json name,defaultBranchRef

# 1.3 Pull latest mailbox repo to workstation (reference copy)
cd ~/repos
[ -d mailbox ] || git clone https://github.com/UMB-Advisors/mailbox.git
cd mailbox && git checkout master && git pull

# 1.4 Confirm factory-bootstrap.sh exists (STAQPRO-202 deliverable)
test -x scripts/factory-bootstrap.sh && echo "factory-bootstrap OK" || echo "MISSING — STAQPRO-202 not delivered"

# 1.5 Confirm headless baseline runbook exists (STAQPRO-201 deliverable)
test -f docs/runbook/headless-appliance-baseline.md && echo "headless runbook OK" || echo "MISSING — STAQPRO-201 not merged"

# 1.6 Confirm provisioning runbook exists (STAQPRO-163 deliverable)
ls docs/runbook/provisioning*.md
```

### Verification
All six commands return success markers. If `factory-bootstrap.sh` is missing, **stop** — the rest of this plan presumes it exists. Re-check the `master` branch on `UMB-Advisors/mailbox`.

---

## 2. Hardware: NVMe + power-on

### Goal
Bring the Jetson up to a state where SDK Manager can flash it.

### Commands

This phase is mechanical. Claude Code prints the steps and waits for human confirmation:

1. NVMe SSD installed in M.2 Key M slot (Samsung 980 500GB per `thumbox-technical-prd-v2_1-2026-04-16.md` §3.2).
2. Wi-Fi antennas attached to SMA connectors.
3. Ethernet cable plugged into the workstation's `jetson-direct` port (the same internet-sharing path used for `mailbox-jetson-01` at `10.42.0.2` — the new unit will share this path during flash, then move to its bring-up LAN at the operator location).
4. Jumper J50 set to **recovery mode** (pin 1+2) so SDK Manager can flash. Refer to NVIDIA's Orin Nano Developer Kit Carrier Board guide.
5. Power supply connected last; LED shows recovery state.
6. Confirm the workstation sees the Jetson over USB: `lsusb | grep -i nvidia` returns `NVIDIA Corp. APX`.

### Verification
`lsusb` shows the Jetson in APX (recovery) mode. Halt if not.

---

## 3. Flash JetPack 6.2 (L4T r36.4)

### Goal
Land a clean JetPack 6.2 install on the new Jetson's NVMe.

### Approach choice
Per [STAQPRO-225](https://linear.app/staqs/issue/STAQPRO-225), **customer #2 stays on the existing post-flash purge baseline** — same as customer #1. Headless-from-flash (Approach A or B in STAQPRO-225) is M5 / customer #3+. Don't innovate here.

### Commands

```bash
# 3.1 Launch SDK Manager (interactive — Claude Code prompts the human)
sdkmanager
```

**Human-in-loop SDK Manager checklist:**

- Target hardware: **Jetson Orin Nano 8GB Developer Kit (Super)**
- Target OS: **JetPack 6.2** (L4T r36.4)
- Storage device: **NVMe** (NOT eMMC)
- Super Mode: **enabled** — required for the 40 TOPS / 25W envelope (project hardware spec §3.5)
- Components: full default install. We'll purge GNOME post-flash via STAQPRO-201's runbook (see Phase 5).
- Pre-config the operator account during the flash:
  - **Username:** `mailbox`  *(see note below — different from customer #1's `bob`)*
  - **Hostname:** `mailbox-jetson-02`
  - **Password:** generate a 32-char random + store in operator's password manager. Claude Code records the username + hostname; the password stays out of any committed file.

> **Username choice rationale.** Customer #1 (Heron Labs) uses `bob@10.42.0.2` for legacy workstation reasons. Customer #2 should normalize to `mailbox` so the appliance username is uniform across customers #2+. This anticipates the M5 factory-bootstrap convention. Update `~/.ssh/config` accordingly in Phase 4.

### Verification
SDK Manager exits with "All components installed successfully." Jetson boots through to the gdm3 login screen on its own monitor (or auto-login if SDK Manager configured it). LED green, no recovery jumper.

**Move J50 jumper back to default (pin 2+3) and reboot once before continuing.**

---

## 4. First-boot networking + SSH key trust

### Goal
Get from "Jetson on the network" to "Claude Code can SSH in passwordless."

### Pre-conditions
- Jetson powered up, on the LAN, ethernet cable connected. (At first run: workstation `jetson-direct` ethernet — same as customer #1. Will move to operator-location LAN in Phase 8.)

### Commands

```bash
# 4.1 Discover the Jetson's IP on the workstation-shared subnet (10.42.0.0/24)
nmap -p 22 --open 10.42.0.0/24 -oG - | grep -E '10\.42\.0\.[0-9]+' | grep -v '10.42.0.1'
# Should return one new host. For customer #1 this was 10.42.0.2; for customer #2 it
# will be a different DHCP lease — capture it as JETSON02_IP.

# 4.2 Add an SSH alias for the new box
JETSON02_IP="10.42.0.X"  # replace with the IP from 4.1
cat >> ~/.ssh/config <<EOF

Host mailbox-jetson-02
    HostName ${JETSON02_IP}
    User mailbox
    IdentityFile ~/.ssh/id_ed25519
EOF

# 4.3 Push the existing workstation SSH key (the same id_ed25519 used for mailbox-jetson-01)
ssh-copy-id mailbox-jetson-02
# Prompts once for the password set in Phase 3.

# 4.4 Verify passwordless
ssh mailbox-jetson-02 'hostname && whoami && cat /etc/nv_tegra_release | head -1'
# Expect: mailbox-jetson-02, mailbox, R36 (release), REVISION: 4.x ...
```

### Verification
Step 4.4 returns the expected three lines without prompting for a password. If the L4T release is not `R36 / REVISION: 4.x`, the flash didn't land JetPack 6.2 — restart from Phase 3.

### Known gotcha
The Jetson's LAN IP is DHCP. Reserve a MAC binding on the bring-up LAN router (per `ssh.md` operating note) once you move it to the operator location in Phase 8.

---

## 5. Apply STAQPRO-201 headless baseline (purge GNOME)

### Goal
Reclaim ~300–500 MB of resident RAM by purging the GNOME stack. This is the OOM headroom that complements STAQPRO-206's Ollama tuning, and it's the *first* infrastructure step before model pulls because models eat exactly that headroom.

### Pre-conditions
- Customer #2 has not yet done a first MailBOX cycle. **Per STAQPRO-201's acceptance criteria, the GUI purge is supposed to follow customer #2's first cycle, not precede it.** For a brand-new, never-onboarded Jetson there is no first cycle to protect — the spec's ordering exists to protect *existing* customers from blast radius. We can purge now.

### Commands

Drive these via the existing runbook attached to PR #47 (`docs/runbook/headless-appliance-baseline.md`). The canonical sequence:

```bash
ssh mailbox-jetson-02 << 'EOF'
sudo systemctl set-default multi-user.target
sudo systemctl disable --now gdm3
sudo apt purge -y gnome-shell 'gnome-session*' gdm3 'yaru-theme-*' ibus ibus-data \
    ubuntu-desktop ubuntu-desktop-minimal
sudo apt autoremove --purge -y
sudo reboot
EOF

# Wait for reboot (60–90s)
sleep 90
until ssh -o ConnectTimeout=5 mailbox-jetson-02 'echo up' 2>/dev/null; do
    echo "waiting for jetson-02..."
    sleep 5
done
```

### Verification

```bash
ssh mailbox-jetson-02 << 'EOF'
systemctl get-default                                         # multi-user.target
systemctl is-active gdm3 || echo "gdm3 disabled — OK"
free -h | grep Mem                                            # baseline RAM, capture
df -h /                                                       # disk free, capture
EOF
```

Capture `free -h` output for the STAQPRO-201 acceptance comment ("RAM / disk / boot-time delta posted in comments").

---

## 6. Pre-empt STAQPRO-228: Tailscale DNS upstream BEFORE enrolling

### Goal
Avoid the MagicDNS upstream-resolver SERVFAIL footgun documented in STAQPRO-228 *before* the Jetson hits the tailnet, not after.

### Why this phase exists
STAQPRO-228 was discovered post-purge on customer #1: tailscaled took ownership of `/etc/resolv.conf`, MagicDNS proxy had no upstream nameservers, and `apt update` + n8n's Gmail node both broke. Customer #1 was workaround-mitigated. Customer #2 should land in a state where the workaround isn't needed.

### Step 6.1 — Tailnet admin DNS settings (HUMAN-IN-LOOP, browser)

Operator visits <https://login.tailscale.com/admin/dns> and confirms:

- **Global nameservers** include `1.1.1.1` and `8.8.8.8` (or operator's preferred upstream)
- **Override local DNS** is the operator's preference, but `accept-dns=true` will work either way as long as upstreams are set

If those entries already exist (likely after fixing customer #1), Claude Code skips this step and notes "tailnet DNS already configured."

### Verification
Claude Code prints a one-liner the operator runs in a separate terminal to confirm:

```bash
# Run from the workstation (already on the tailnet)
dig @100.100.100.100 ports.ubuntu.com +short
# Expect: actual IPs, not SERVFAIL
```

If SERVFAIL: stop, fix the tailnet admin settings, retry.

---

## 7. Tailscale enrollment + repo clone

### Goal
Put the Jetson on the tailnet as `mailbox-jetson-02`, tagged `tag:mailbox`. Clone the repo into the operator's home dir.

### Commands

```bash
ssh mailbox-jetson-02 << 'EOF'
# 7.1 Install Tailscale (uses the official one-liner)
curl -fsSL https://tailscale.com/install.sh | sh
EOF

# 7.2 Bring Tailscale up — HUMAN-IN-LOOP for auth URL
ssh -t mailbox-jetson-02 \
    'sudo tailscale up --hostname=mailbox-jetson-02 --advertise-tags=tag:mailbox --accept-dns=true'
# Tailscale prints a https://login.tailscale.com/a/... URL.
# Operator opens it in browser, authenticates to consultingfutures@ tailnet, approves.

# 7.3 Verify Tailscale state + DNS resolution post-enrollment
ssh mailbox-jetson-02 << 'EOF'
tailscale status | head -5
getent hosts www.googleapis.com >/dev/null && echo "DNS: googleapis OK" || echo "DNS: BROKEN"
getent hosts ports.ubuntu.com >/dev/null && echo "DNS: ubuntu OK" || echo "DNS: BROKEN"
EOF

# 7.4 Clone the repo
ssh mailbox-jetson-02 << 'EOF'
cd ~
[ -d mailbox ] && rm -rf mailbox  # idempotent fresh clone for a new appliance
git clone https://github.com/UMB-Advisors/mailbox.git
cd mailbox && git log -1 --oneline
EOF
```

### Verification
- `tailscale status` shows `mailbox-jetson-02` as the local node, online
- Both DNS checks return "OK". If either says "BROKEN", **stop** and apply the STAQPRO-228 workaround from §6, then re-verify
- `git log -1 --oneline` shows a recent commit on `master`

### Known gotcha
If `tailscale up` hangs, the operator may be on a captive-portal LAN. Tailscale auth needs outbound 443 to `*.tailscale.com`. Check workstation internet first.

---

## 8. Run `scripts/factory-bootstrap.sh`

### Goal
Execute the STAQPRO-202 deliverable that codifies the rest of the install. This is the single most important phase — everything before this was setup, everything after this is customer-specific configuration.

### Commands

```bash
ssh mailbox-jetson-02 << 'EOF'
cd ~/mailbox
bash scripts/factory-bootstrap.sh 2>&1 | tee /tmp/bootstrap-$(date +%Y%m%d-%H%M%S).log
EOF
```

### What the script does (from STAQPRO-202)

1. **Pre-flight** — confirms L4T r36.4, aborts if mismatch
2. **Docker** — JetsonHacks `install_nvidia_docker.sh` (NOT docker-ce; per `CLAUDE.md` "What NOT to Use")
3. **GPU smoke** — `docker run --rm --runtime nvidia nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi`
4. **Repo state** — confirms `~/mailbox/` checked out
5. **Env scaffolding** — copies `.env.example` → `.env` if missing (NEVER overwrites existing)
6. **Compose up** — `docker compose up -d --remove-orphans`
7. **Migrations** — `docker compose --profile migrate run mailbox-migrate`
8. **Qdrant bootstrap** — `docker compose --profile qdrant-bootstrap run mailbox-qdrant-bootstrap`
9. **Ollama models** — `qwen3:4b-ctx4k` (DR-18 Modelfile) + `nomic-embed-text:v1.5`
10. **Workflow JSON import** — imports `MailBOX`, `MailBOX-Classify`, `MailBOX-Draft`, `MailBOX-Send` (without credentials — those come in Phase 10)
11. **Health verify** — polls 6 service health endpoints

### Verification
Last lines of the bootstrap log read "All 6 services healthy." If anything fails, the log line points at the failed phase. Do not edit `factory-bootstrap.sh` from this plan — file an issue against STAQPRO-202 instead.

### Known gotcha
On a clean install the Ollama model pulls take 10–20 min on the bring-up LAN bandwidth. The script reports progress; do not Ctrl-C.

---

## 9. Pre-empt STAQPRO-226: Gmail bootstrap mode

### Goal
Prevent Gmail's 250-units/sec rate limit from torching customer #2's first cycle on a fresh inbox.

### Status of STAQPRO-226
**Not yet shipped** as of 2026-05-04. Customer #2 install is its forcing function. Two options:

### Option A — STAQPRO-226 lands before this install (preferred)
If a PR has merged that adds the `mailbox.gmail_state.bootstrap_complete` column + the n8n `limit=50` gate, Phase 9 is a no-op. Confirm with:

```bash
ssh mailbox-jetson-02 << 'EOF'
docker exec mailbox-postgres-1 psql \
    -U $(grep ^POSTGRES_USER /home/mailbox/mailbox/.env | cut -d= -f2-) \
    -d $(grep ^POSTGRES_DB /home/mailbox/mailbox/.env | cut -d= -f2-) \
    -c "\d mailbox.gmail_state" | grep bootstrap_complete && echo "STAQPRO-226 SHIPPED"
EOF
```

### Option B — manual gate on the n8n workflow (fallback)
If STAQPRO-226 has NOT shipped, Claude Code applies a one-time edit before live-gate flips:

1. SSH into the Jetson, open the n8n editor at `https://mailbox.futurecompounds.com/n8n` (after Phase 11 Caddy is up — circular dep noted)
2. In the `MailBOX` workflow, edit the `Gmail Get` node: set `limit` to 50 (instead of 1000)
3. Add a `Wait` node after Gmail Get with 1.5s pacing
4. Save; toggle the workflow back to active (per Phase 12 verification)
5. After the first complete cycle returns 0 unread, revert `limit` to 1000

Track Option B as a manual TODO in the install report and link to STAQPRO-226. Option A should land soon enough that Option B is a one-customer measure.

### Verification
Either: query confirms `bootstrap_complete` column exists, OR install report has a TODO referencing STAQPRO-226 manual workaround.

---

## 10. DNS + Cloudflare pre-flight (STAQPRO-175)

### Goal
Set up `mailbox.futurecompounds.com` → Jetson LAN IP, and a min-scope Cloudflare API token so Caddy can issue the DNS-01 challenge cert.

### Commands

```bash
# 10.1 — Cloudflare API token (HUMAN-IN-LOOP, browser)
# Operator visits https://dash.cloudflare.com/profile/api-tokens
# Creates a custom token:
#   - Permissions: Zone → DNS → Edit (only)
#   - Zone Resources: Include → Specific zone → futurecompounds.com
#   - TTL: 1 year
# Pastes the token to Claude Code's stdin (DO NOT log it).

# 10.2 — DNS A record (HUMAN-IN-LOOP, Cloudflare dashboard)
# Add A record:
#   Name: mailbox
#   IPv4: <bring-up location LAN IP — placeholder for Phase 8 move>
#   Proxy: DNS only (grey cloud) — Caddy needs direct access for the cert challenge
# For the imaging phase the IP is 10.42.0.X (workstation-shared). When the unit
# moves to the operator location, update this record to the new LAN IP.
# The "public DNS A record returning a private IP" is intentional per STAQPRO-175
# — the appliance is LAN+Tailscale reachable, not public-internet reachable.

# 10.3 — Land the token in the customer-#2 .env
ssh mailbox-jetson-02 << 'EOF'
cd ~/mailbox
# ENV scaffolding from factory-bootstrap.sh already produced .env from .env.example.
# Update three keys for customer #2:
sed -i 's|^DOMAIN=.*|DOMAIN=mailbox.futurecompounds.com|' .env
sed -i 's|^CLOUDFLARE_API_TOKEN=.*|CLOUDFLARE_API_TOKEN=<paste-token-here>|' .env
sed -i 's|^CADDY_EMAIL=.*|CADDY_EMAIL=dustin@umbadvisors.com|' .env
EOF
```

> Claude Code prompts for the token at runtime. The token never appears in this plan, in shell history (`HISTCONTROL=ignorespace` + leading space), or in any committed file.

### Verification

```bash
# 10.4 Restart Caddy so it picks up the new domain + token
ssh mailbox-jetson-02 'cd ~/mailbox && docker compose restart caddy && sleep 30 && docker compose logs --tail=50 caddy'
# Expect: "obtained certificate" log line for mailbox.futurecompounds.com

# 10.5 Hit the dashboard from the workstation (over tailnet OR LAN)
curl -fsS -o /dev/null -w "%{http_code}\n" -u admin:<basic-auth-pw> \
    https://mailbox.futurecompounds.com/dashboard/queue
# Expect: 200
```

### Known gotcha
Cloudflare DNS-01 sometimes fails the first cert issuance if the A record was created moments before; propagation. Retry `docker compose restart caddy` after 60s if the first attempt fails. STAQPRO-161 ensured `/webhook/*` is no longer a basic_auth bypass — confirm by hitting `/webhook/anything` and expecting a 401 challenge.

---

## 11. Smoke-test pre-customer

### Goal
Run a stub end-to-end through the n8n workflow chain *without* customer Gmail, just to prove the local stack is correct.

### Commands

```bash
ssh mailbox-jetson-02 << 'EOF'
cd ~/mailbox
docker compose ps --format json | jq -r '.[] | "\(.Name)\t\(.State)\t\(.Health)"'
# Expect: 6 services, all "running" + "healthy"
EOF

# 11.2 Ollama model warm
ssh mailbox-jetson-02 'curl -s http://localhost:11434/api/generate -d "{\"model\":\"qwen3:4b-ctx4k\",\"prompt\":\"hello\",\"stream\":false}" | jq -r .response | head -c 80'
# Expect: a coherent few-token response

# 11.3 Postgres reachable + migrations applied
ssh mailbox-jetson-02 << 'EOF'
docker exec mailbox-postgres-1 psql \
    -U $(grep ^POSTGRES_USER /home/mailbox/mailbox/.env | cut -d= -f2-) \
    -d $(grep ^POSTGRES_DB /home/mailbox/mailbox/.env | cut -d= -f2-) \
    -c "\dt mailbox.*" | head -30
EOF
# Expect: drafts, gmail_state, classifications, etc. — schema present
```

### Verification
All three checks pass. If Ollama returns nothing, the model failed to pull — re-run `ollama pull qwen3:4b-ctx4k` from `factory-bootstrap.sh`'s phase 9.

---

## 12. n8n workflow active-flag verification (CLAUDE.md footgun)

### Goal
Apply the gate that prevented STAQPRO-181's 12-hour dark-classified inbox on customer #1.

### Why this phase exists
On a fresh appliance every workflow imports as `active=false`. `factory-bootstrap.sh` imports them but does not toggle. This is the single most-cited footgun in `CLAUDE.md` for new installs.

### Commands

```bash
# 12.1 Run the verification one-liner from CLAUDE.md
ssh mailbox-jetson-02 "docker exec mailbox-postgres-1 psql \
    -U \$(grep ^POSTGRES_USER /home/mailbox/mailbox/.env | cut -d= -f2-) \
    -d \$(grep ^POSTGRES_DB /home/mailbox/mailbox/.env | cut -d= -f2-) \
    -c \"SELECT name, active FROM workflow_entity WHERE name LIKE 'MailBOX%' ORDER BY name;\""
```

### Verification
All four rows (`MailBOX`, `MailBOX-Classify`, `MailBOX-Draft`, `MailBOX-Send`) report `active = t`.

### Remediation if any are `f`

```bash
# Option A — n8n CLI inside the container
ssh mailbox-jetson-02 'docker exec mailbox-n8n-1 n8n update:workflow --active=true --id=<id>'
# (repeat for each inactive workflow id)
ssh mailbox-jetson-02 'cd ~/mailbox && docker compose restart n8n'

# Option B — toggle in the n8n editor at https://mailbox.futurecompounds.com/n8n
# (manual — operator opens browser, flips each workflow to active)

# Re-run 12.1 to confirm.
```

### **HALT condition**
**Do not advance to Phase 13** until the verification one-liner shows all four workflows `active=t`. Skipping this is the failure mode that produced 12h of dark inbox on Heron Labs.

---

## 13. Gmail OAuth (HUMAN-IN-LOOP)

### Goal
Wire the Future Compounds operator's Gmail account into n8n.

### Pre-condition
Customer #2 needs its own per-customer OAuth client until [STAQPRO-197](https://linear.app/staqs/issue/STAQPRO-197) (shared Staqs OAuth client) lands. Per STAQPRO-177's pre-launch verification gate #1.

### Commands

```bash
# 13.1 — Provision OAuth client (HUMAN-IN-LOOP, browser, GCP Console)
# Operator visits https://console.cloud.google.com/apis/credentials
# Project: futurecompounds-gmail (create if absent)
# Enable Gmail API.
# Create OAuth 2.0 Client ID:
#   - Application type: Web application
#   - Authorized redirect URIs: https://mailbox.futurecompounds.com/n8n/rest/oauth2-credential/callback
# Capture client_id + client_secret.
# Operator will see "unverified app" warning during consent flow — expected, per STAQPRO-177.

# 13.2 Land OAuth credentials in n8n via the editor (HUMAN-IN-LOOP)
# - Open https://mailbox.futurecompounds.com/n8n
# - Settings → Credentials → New → Gmail OAuth2 API
# - Paste client_id + client_secret
# - Click "Connect my account"
# - Sign in as the Future Compounds operator email (NOT the Heron Labs email)
# - Approve scopes (Gmail read + send + modify)
```

### Verification
Inside n8n, open the `MailBOX` workflow → Gmail Get node → confirm credential dropdown shows the new `Gmail OAuth2 API` credential. Test the node with "Execute Node" — should return a sample list of recent threads.

---

## 14. Persona + sender-rules configuration

### Goal
Customer #2 needs its own persona, distinct from Heron Labs. STAQPRO-177 calls this out as the cross-business validation point.

### Commands

```bash
# 14.1 Open the dashboard onboarding wizard
# https://mailbox.futurecompounds.com/dashboard/onboarding
# Operator walks through:
#   - Operator name + role (Future Compounds–specific)
#   - Tone preferences (likely different from Heron Labs)
#   - Sender rules (counterparty domains common at Future Compounds)
#   - Sign-off template
```

### Verification
After saving, query Postgres to confirm a persona row exists for customer #2:

```bash
ssh mailbox-jetson-02 << 'EOF'
docker exec mailbox-postgres-1 psql \
    -U $(grep ^POSTGRES_USER /home/mailbox/mailbox/.env | cut -d= -f2-) \
    -d $(grep ^POSTGRES_DB /home/mailbox/mailbox/.env | cut -d= -f2-) \
    -c "SELECT id, length(statistical_markers::text), updated_at FROM mailbox.personas ORDER BY updated_at DESC LIMIT 3;"
EOF
```

---

## 15. RAG backfill (STAQPRO-193) BEFORE live-gate

### Goal
Seed the Future Compounds corpus before the live gate so the first cycles have retrieval context. Per STAQPRO-177: "*Future Compounds will start from a small/empty corpus; STAQPRO-193-style backfill should run before live-gate flips*."

### Commands

```bash
# 15.1 Run the backfill — exact invocation depends on STAQPRO-193's deliverable.
# Default expected:
ssh mailbox-jetson-02 'cd ~/mailbox && docker compose --profile backfill run mailbox-backfill --days=30'
# This pulls the last 30 days of Sent + Inbox into Postgres + Qdrant for RAG retrieval.
```

### Verification

```bash
ssh mailbox-jetson-02 << 'EOF'
docker exec mailbox-postgres-1 psql \
    -U $(grep ^POSTGRES_USER /home/mailbox/mailbox/.env | cut -d= -f2-) \
    -d $(grep ^POSTGRES_DB /home/mailbox/mailbox/.env | cut -d= -f2-) \
    -c "SELECT count(*) FROM mailbox.messages;"
EOF
# Expect: count > 0 (likely 50–500 depending on Future Compounds inbox volume)
```

If STAQPRO-193 hasn't shipped, document this as a known cold-start condition in the install report. The first ~10 cycles will draft without retrieval context; quality will compound as new mail accumulates.

---

## 16. Live-gate flip (HUMAN-IN-LOOP — final consent)

### Goal
Turn on real-mail processing. This is the only step in the plan that should give the operator pause.

### Pre-conditions
**All prior phases verified.** Specifically:

- Phase 12: All four `MailBOX*` workflows `active=t`
- Phase 9: Gmail bootstrap mode enabled (Option A or B)
- Phase 13: Gmail OAuth wired and node-test passes
- Phase 14: Persona row exists with non-trivial `statistical_markers`
- Phase 15: RAG backfill complete (or known-omitted with a TODO)

### Command

```bash
ssh mailbox-jetson-02 << 'EOF'
cd ~/mailbox
sed -i 's|^MAILBOX_LIVE_GATE_BYPASS=.*|MAILBOX_LIVE_GATE_BYPASS=0|' .env
docker compose up -d  # picks up the env change for n8n
EOF
```

### Verification — first cycle observation

For the next 5 minutes:

```bash
# 16.1 Tail n8n executions
ssh mailbox-jetson-02 'cd ~/mailbox && docker compose logs -f n8n' &

# 16.2 Watch dashboard queue
# Open https://mailbox.futurecompounds.com/dashboard/queue in browser.
# Expect: real Future Compounds emails appear, classified, drafted.
```

### Acceptance — first end-to-end cycle (per STAQPRO-177)
- One real Gmail message ingested
- Classified
- Drafted
- Operator approves the draft via dashboard
- Gmail Reply lands in the operator's Sent folder

If anything in this loop fails, **flip the live gate back** (`MAILBOX_LIVE_GATE_BYPASS=1`) and report the failure point — do not let a partial loop run unattended.

---

## 17. Constraint baseline measurement (STAQPRO-177 acceptance gate)

### Goal
Capture cold-boot time + sustained power as the reference measurement. CLAUDE.md targets: `<3 min cold boot`, `<25W sustained`. STAQPRO-177 acceptance criteria require these as posted comments.

### Commands

```bash
# 17.1 Cold boot — full power cycle measurement
ssh mailbox-jetson-02 'sudo reboot' && \
    BOOT_START=$(date +%s) && \
    sleep 60 && \
    until ssh -o ConnectTimeout=5 mailbox-jetson-02 'docker compose -f ~/mailbox/docker-compose.yml ps --format json | jq -e "all(.[]; .Health == \"healthy\")"' 2>/dev/null; do
        sleep 5
    done && \
    BOOT_END=$(date +%s) && \
    echo "Cold boot to all-healthy: $((BOOT_END - BOOT_START))s"
# Target: < 180s

# 17.2 Sustained power during a classify cycle
ssh mailbox-jetson-02 'tegrastats --interval 5000 --logfile /tmp/tegrastats.log &
    sleep 60
    pkill tegrastats
    grep -oP "VDD_IN \K[0-9]+" /tmp/tegrastats.log | awk "{ sum += \$1; n++ } END { print \"Avg VDD_IN: \" sum/n \"mW\" }"'
# Target: < 25000 mW
```

### Verification
Both numbers captured. Claude Code formats them into the install report.

---

## 18. Post-install report + Linear updates

### Goal
Close the loop on every Linear ticket the install touched, with measurements.

### Output artifact
Claude Code writes `/home/claude/work/install-report-customer2-v0_1-2026-05-04.md` containing:

- All measurements (cold boot, power, RAM delta from §5, model pull times, total install elapsed)
- Confirmations for each STAQPRO-177 acceptance criterion
- Any TODOs (e.g., STAQPRO-226 fallback Option B, STAQPRO-193 cold-start)
- Tailscale node URL + dashboard URL for handoff

### Linear updates Claude Code performs

```text
STAQPRO-174 — flip status to In Progress at start of plan, Delivered at end.
              Comment with: bootstrap log path, hostname, Tailscale node URL, time-to-image.
STAQPRO-201 — comment with RAM/disk/boot-time deltas measured in §5 and §17.
STAQPRO-228 — comment confirming tailnet DNS settings verified working on box #2.
STAQPRO-177 — flip to In Progress when §13 starts, Delivered when §17 measurements posted.
              Comment with: cold boot ms, sustained power mW, persona statistical_markers length.
STAQPRO-226 — if Option B fallback used, comment "customer #2 install used manual gate";
              if Option A, no comment needed.
```

---

## 19. Halt conditions & rollback

Claude Code halts and prompts the operator if **any** of these are true at the listed verification step:

| Phase | Halt condition | Rollback action |
|------|---------------|-----------------|
| 1 | Workstation deps missing | Operator installs SDK Manager / re-auths gh |
| 3 | SDK Manager flash fails | Re-jumper to recovery, retry |
| 4 | SSH passwordless fails after `ssh-copy-id` | Verify Phase 3 username pre-config |
| 6 | DNS check returns SERVFAIL | Tailnet admin must add upstream nameservers |
| 7 | Tailscale auth times out | Check workstation outbound 443 to tailscale.com |
| 8 | `factory-bootstrap.sh` reports a failed phase | File issue against STAQPRO-202; do not edit script ad hoc |
| 10 | Caddy cert issuance fails twice | Verify Cloudflare token scope + DNS A record propagation |
| 12 | Any `MailBOX*` workflow is `active=f` | Toggle and re-verify before Phase 13 — non-negotiable |
| 13 | Gmail node test returns 0 threads | Re-check OAuth scopes, persona email match |
| 16 | First cycle drafts but Gmail Reply fails | Live-gate back to bypass=1, diagnose Gmail Send node creds |

A clean rollback to "Jetson is bricked, back to Phase 3" is `sudo systemctl set-default graphical.target && sudo apt install ubuntu-desktop && reboot` — but the path is rare. Most failures rollback by reverting the most-recent `.env` edit and `docker compose up -d`.

---

## 20. Out of scope for this plan

- Customer #1 (Heron Labs) is not touched. Any STAQPRO-201 or STAQPRO-228 sequencing on customer #1 is a separate scheduled window per those tickets.
- STAQPRO-225 (flash-time headless variant) — Approach A/B testing is M5, customer #3+. Customer #2 stays on the post-flash purge baseline.
- Multi-pack orchestration (STAQPRO-172) — N/A, this is a MailBOX-only install.
- Receptionbox or any other BOX pack — out of scope, this is MailBOX customer #2 only.
- Any change to `scripts/factory-bootstrap.sh` — file an issue against STAQPRO-202 and let it land in `master` first.

---

## 21. Plan version history

| Version | Date | Author | Change |
|---------|------|--------|--------|
| v0.1 | 2026-05-04 | Dustin (with Claude) | Initial plan, derived from Linear M3 cluster (STAQPRO-163, 174, 175, 177, 201, 202, 225, 226, 228) |
