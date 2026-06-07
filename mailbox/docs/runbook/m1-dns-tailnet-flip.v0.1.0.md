# M1 DNS A-record flip — public hostname → tailnet IP (STAQPRO-238)

> **Version:** v0.1.0
> **Status:** READY TO EXECUTE — needs Heron Labs zone access
> **Owner:** Customer-#1 zone admin (heronlabsinc.com Cloudflare account)
> **Audience:** The operator with Cloudflare DNS edit rights for `heronlabsinc.com`. Not Claude — Claude has no zone access.
> **Mirrors:** STAQPRO-237 (customer-#2, executed 2026-05-07) — the same approach, different zone owner.
>
> Executes the M1 half of the off-LAN-access fix. Customer-#2 (`mailbox.staqs.io`) was flipped to tailnet IP `100.120.102.45` during Session 2; this runbook does the M1 equivalent.

---

## TL;DR

Change one DNS A record. Five-minute job. No appliance-side change required.

```
hostname:  mailbox.heronlabsinc.com
TYPE:      A
OLD value: 192.168.50.179        ← M1 LAN IP (non-routable from off-LAN)
NEW value: 100.65.9.2            ← M1 tailnet IP (CGNAT, routable through Tailscale)
TTL:       Auto / 60s
Proxy:     OFF (DNS-only, gray cloud)
```

After the flip, anyone with the Tailscale app on the `consultingfutures@gmail.com` tailnet can reach `https://mailbox.heronlabsinc.com/dashboard/queue` from anywhere on Earth. Off-tailnet visitors still can't (privacy posture unchanged).

---

## Why

`mailbox.heronlabsinc.com` currently resolves to `192.168.50.179`, which is M1's router-LAN IP. Off-LAN clients (Eric's phone on cellular, his laptop at the office, anyone outside the Heron Labs WiFi) can't reach that IP — it's RFC1918 private space. Result: dashboard works from inside Heron Labs, fails from anywhere else.

**The fix**: point the public DNS record at M1's Tailscale CGNAT IP (`100.65.9.2`). The Tailscale daemon on each tailnet-joined client recognizes CGNAT IPs and transparently routes them through the Tailscale tunnel. The operator gets the dashboard from anywhere; off-tailnet visitors still see a non-routable IP and the connection fails (which is the right privacy posture).

This was already done for customer-#2 on 2026-05-07: `mailbox.staqs.io` now resolves to `100.120.102.45` (M2 tailnet IP). Same approach, same outcome. M1 was not flipped at the time because `heronlabsinc.com` is in a different Cloudflare account and the customer-#2 install operator (Bob) doesn't have edit rights.

---

## Pre-conditions

Before executing:

1. **Cloudflare access**: you have edit rights on the `heronlabsinc.com` zone. If you can sign in to the Cloudflare dashboard and navigate to **DNS** → `heronlabsinc.com`, you have what you need.
2. **Tailscale enrollment**: the operator who will use the dashboard has Tailscale installed and is signed in to the `consultingfutures@gmail.com` tailnet (MagicDNS suffix `tail377a9a.ts.net`). If you can `ping mailbox1.tail377a9a.ts.net` from your laptop, you're enrolled.
3. **TLS cert is unaffected**: Caddy's TLS cert was issued via Cloudflare DNS-01 challenge and binds to the hostname, not the IP. Flipping the A record does not invalidate the cert.

If any pre-condition fails, stop and resolve before proceeding.

---

## Procedure

### Step 1 — capture current state (baseline for rollback)

```bash
# From any workstation:
dig +short mailbox.heronlabsinc.com
# Expected output (current state): 192.168.50.179
```

Write this down. If anything goes wrong, this is the value to restore.

### Step 2 — verify the new target IP

```bash
# Sanity-check that 100.65.9.2 actually IS M1's tailnet IP:
tailscale status | grep mailbox1
# Expected: mailbox1 ... 100.65.9.2 ...
```

If your Tailscale shows a different IP for `mailbox1`, **stop** — the IP in this runbook may be stale. Use the IP your Tailscale reports.

### Step 3 — make the change in Cloudflare

1. Sign in to https://dash.cloudflare.com
2. Select the `heronlabsinc.com` zone
3. Navigate to **DNS** → **Records**
4. Find the existing `A` record for `mailbox.heronlabsinc.com`
5. Click **Edit**
6. Change the value from `192.168.50.179` → `100.65.9.2`
7. Verify **Proxy status** is OFF (gray cloud, "DNS only"). It is critical that this stays OFF — Cloudflare's proxy can't route to a CGNAT IP and would break the dashboard.
8. Save

### Step 4 — verify propagation (≤2 min)

```bash
# From the workstation:
dig +short mailbox.heronlabsinc.com
# Expected: 100.65.9.2

# From outside the LAN (e.g., your phone on cellular, or a VPN-off laptop):
nslookup mailbox.heronlabsinc.com
# Expected: 100.65.9.2
```

If `dig` still returns the old IP after 2 minutes, your local resolver is caching. `sudo systemd-resolve --flush-caches` (Linux) or wait the TTL out.

### Step 5 — verify access from a tailnet-enrolled device

```bash
# From a tailnet-enrolled device (workstation, phone with Tailscale app):
curl -sI https://mailbox.heronlabsinc.com/dashboard/queue | head -5
# Expected:
#   HTTP/2 401
#   www-authenticate: Basic realm="restricted"
#   server: Caddy
```

A 401 with WWW-Authenticate proves: TLS handshake worked, DNS resolves to a routable IP, Caddy is gating the path. Sign in with your dashboard creds and confirm the queue loads.

### Step 6 — verify off-tailnet access fails (privacy check)

```bash
# From an OFF-tailnet device (turn Tailscale off, or use a phone without the app):
curl -m 5 -sI https://mailbox.heronlabsinc.com/dashboard/queue
# Expected: timeout or "no route to host"
```

This confirms the privacy posture: the dashboard is reachable only via the tailnet. Off-tailnet visitors see a non-routable IP and the connection fails before any TLS / auth surface exposure.

If off-tailnet access succeeds, **stop and investigate** — something is misconfigured.

---

## Rollback

If anything breaks:

1. Edit the A record back to `192.168.50.179`
2. Wait ≤2 min for propagation
3. Verify `dig +short mailbox.heronlabsinc.com` returns the original IP
4. Verify dashboard works from inside the Heron Labs LAN

The appliance itself does not change — only the DNS record. So rollback is purely a DNS edit. No appliance state to restore.

---

## Out of scope

- Changing M1's appliance config (none required)
- Changing M1's docker-compose (none required)
- Changing the TLS cert (it's hostname-bound, not IP-bound — flipping the A record does not invalidate it)
- Changing M2 (already flipped 2026-05-07)
- Tailscale setup — assumed complete

## Linear

- **STAQPRO-238** — this runbook satisfies the open task. After execution, update the Linear ticket with: (a) confirmation `dig` returns `100.65.9.2`, (b) confirmation off-tailnet access fails, (c) move to Done.

## Sources

- M1 hardware deltas + tailnet IP table: root `CLAUDE.md` "Tailscale access" section
- M2 precedent (customer-#2): `docs/plan-jetson-02-install-automation-v0_2-2026-05-05.md` Session 2 → "Tailnet IP DNS pivot (separate from STAQPRO-237)"
- Cloudflare DNS docs: https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/
