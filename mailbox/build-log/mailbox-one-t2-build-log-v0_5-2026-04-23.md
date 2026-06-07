# MailBOX One — T2 Build Log

**Version:** v0.5
**Date:** 2026-04-23 (fifth session, same day)
**Hardware:** NVIDIA Jetson Orin Nano 8GB Developer Kit Super
**JetPack:** 6.2 (L4T R36.5)
**Operator:** Dustin
**Supersedes:** v0.4 (same date)

---

## Status at a glance

**Phase: infrastructure closed, pipeline bring-up in progress.**

| Component | State | Notes |
|---|---|---|
| Jetson @ 192.168.1.45 | ✅ Reachable | SSH alias `mailbox` configured |
| Ollama + Qwen3-4B | ✅ 18.66 t/s, 100% GPU | Unchanged from v0.4 |
| Postgres | ✅ Healthy | Unchanged |
| Qdrant | ✅ Healthy | Unchanged |
| Dashboard | ✅ Healthy | Unchanged |
| **n8n** | ✅ **Recreated cleanly, healthy, logged in** | Volume wiped + owner re-created after encryption-key mismatch |
| n8n auth (secure cookie) | ✅ Disabled for HTTP-LAN access | `N8N_SECURE_COOKIE=false` in compose |
| n8n access hostname | ✅ `http://mailbox.heronlabsinc.com:5678` | Via hosts-file entry on main box and Jetson |
| Gmail OAuth2 client | 🟡 Created in GCP, not yet connected in n8n | Paused pending credential hygiene |
| Secrets file | ✅ Updated (IP, redirect URI, OAuth client, owner account) | Mirrored to main box |

**Blocker discovered + resolved:** n8n encryption-key mismatch crashed the service for ~14 hours. Recovered via volume wipe + owner re-creation.

**Security flag raised:** Operator pasted n8n owner password into chat. Password rotation requested; awaiting confirmation.

---

## Changes since v0.4

| Area | v0.4 → v0.5 |
|---|---|
| Jetson IP in artifacts | Corrected from 192.168.1.107 to **192.168.1.45** (per authoritative `ssh.md`) |
| n8n service | Healthy, empty → Crashed (encryption mismatch) → **Recreated, healthy, owner re-created** |
| n8n access protocol | IP-based → **Hostname-based via `/etc/hosts` entries** on main box and Jetson |
| OAuth2 client (Google Cloud) | Not started → **Created, redirect URI set to hostname** |
| Secure cookie setting | Default (enabled) → **Disabled** (`N8N_SECURE_COOKIE=false`) |
| BL-6 | Open → **Partially closed** (SSH resolved; `nano`/`vim` still missing) |
| New finding | — | **Gmail app passwords blocked in Workspace policy** → OAuth2 path adopted |

---

## Session 5 summary

Began Phase 02 kickoff (build first n8n workflow for email pipeline). Gmail app password path blocked by Workspace policy. Pivoted to OAuth2. Hit three cascading issues getting the OAuth2 credential connected:

1. Jetson IP in prior artifacts was wrong (192.168.1.107, should have been 192.168.1.45 per `ssh.md`).
2. Google Cloud Console rejects raw IPs and `.local` hostnames as redirect URIs — must be a public TLD.
3. n8n was crash-looping due to encryption-key mismatch stored in its volume from yesterday's setup.
4. After fixing n8n, it refused logins over HTTP with a secure-cookie error.

All four resolved. n8n is now accessible at the hostname, operator is logged in. OAuth2 completion and workflow-build deferred to next session due to operator pasting credentials into chat (rotation required first).

---

## Actions taken

### 1. IP address correction

Prior sessions referenced `192.168.1.107`. Authoritative source (`ssh.md` in project knowledge) specifies the Jetson is at `192.168.1.45` with an SSH alias `mailbox` configured on the main box via `~/.ssh/config`.

Corrected in `secrets-2026-04-23.md` on both machines:
```
sed -i 's/192\.168\.1\.107/192.168.1.45/g' ~/mailbox/secrets-2026-04-23.md   # on Jetson
sed -i 's/192\.168\.1\.107/192.168.1.45/g' ~/.secrets/mailbox/secrets-2026-04-23.md   # on main box
```

Build logs v0.1–v0.4 left unchanged (historical artifacts reflecting operator belief at time of authoring).

### 2. Gmail app password path abandoned

Heron Labs Workspace policy does not expose app-password generation to users. Could have toggled `admin.google.com → Security → Access and data control → Less secure apps` to unlock, but app passwords are a deprecated legacy mechanism being phased out by Google. Chose OAuth2 instead — the strategically correct path.

### 3. Google Cloud OAuth2 client created

- Project: heron-mailbox (or equivalent) in Google Cloud Console
- Gmail API enabled
- OAuth consent screen: Internal user type (limits to heronlabsinc.com users)
- OAuth client type: Web application
- Client name: `n8n-mailbox-one`

Redirect URI initially set to `http://192.168.1.45:5678/rest/oauth2-credential/callback`, rejected by Google:
> Invalid Redirect: must end with a public top-level domain (such as .com or .org). Invalid Redirect: must use a domain that is a valid top private domain.

**Resolution:** Hosts-file entries on both machines mapping `mailbox.heronlabsinc.com` → `192.168.1.45`. This lets Google accept the redirect (TLD is valid) while resolution stays local-only.

```
# Main box (local resolution for accessing n8n)
echo "192.168.1.45 mailbox.heronlabsinc.com" | sudo tee -a /etc/hosts

# Jetson (local resolution for n8n's outbound OAuth callbacks)
ssh mailbox 'sudo sh -c "echo \"127.0.0.1 mailbox.heronlabsinc.com\" >> /etc/hosts"'
```

Updated Google Cloud OAuth client redirect URI to: `http://mailbox.heronlabsinc.com:5678/rest/oauth2-credential/callback`.

Client ID and Client Secret generated and saved to secrets file.

**Trade-off accepted:** hosts-file approach works only for these two machines. Any future device needing n8n access (phone, another laptop) will need its own hosts entry OR we move to DNS A-record approach (subdomain → private IP) when we have ~5 minutes at the DNS registrar. Tracked as future concern; not blocking.

### 4. n8n encryption-key crash recovery

Attempted to access n8n at `http://mailbox.heronlabsinc.com:5678` — connection refused. Investigation:

- `sudo docker compose ps`: n8n showed `Restarting (1) Less than a second ago` (crash loop)
- Logs showed: `Error: Mismatching encryption keys. The encryption key in the settings file /home/node/.n8n/config does not match the N8N_ENCRYPTION_KEY env var.`

**Root cause:** When we set `N8N_ENCRYPTION_KEY` in v0.4, n8n had already booted once without it. On that first boot, n8n auto-generated a random key and stored it in `/home/node/.n8n/config` (the settings file, inside the `mailbox_n8n_data` volume). When we then recreated the container with a different key in the env var, n8n detected the mismatch and refused to start — correct behavior, protects against accidentally invalidating encrypted credentials.

**Lesson:** "Zero credentials in `credentials_entity`" is not the same as "zero encrypted state." n8n encrypts its own settings-file key identifier too. Setting `N8N_ENCRYPTION_KEY` is only safe *before* n8n's first boot, not after.

**Recovery — volume wipe (Path B from diagnosis):**

```
ssh mailbox 'cd ~/mailbox && sudo docker compose down n8n'
ssh mailbox 'sudo docker volume rm mailbox_n8n_data'
ssh mailbox 'cd ~/mailbox && sudo docker compose up -d n8n'
```

Chosen over in-place key replacement (Path A) because:
- Zero workflows, zero credentials, zero data to preserve
- Re-creating owner account = 30s
- Results in n8n generating settings file with correct env-var key from moment zero — no drift possible
- Avoids establishing a pattern of hand-editing container internal state

n8n came up healthy in ~20s. Port 5678 published correctly.

### 5. Secure cookie error resolved

First attempt to log in via `http://mailbox.heronlabsinc.com:5678` returned:
> Your n8n server is configured to use a secure cookie, however you are either visiting this via an insecure URL, or using Safari.

n8n's default (2.x series) sets auth cookies with the `Secure` flag, which browsers reject over plain HTTP. Correct long-term answer is TLS via reverse proxy; correct short-term answer for LAN-only dev is disabling the flag.

Edit applied:

```
ssh mailbox
cd ~/mailbox
sudo cp docker-compose.yml docker-compose.yml.backup-2026-04-23
sudo sed -i '/N8N_PROTOCOL: http/a\      N8N_SECURE_COOKIE: "false"' docker-compose.yml
sudo docker compose up -d n8n
```

The `N8N_SECURE_COOKIE: "false"` line is now in the compose file, not `.env` — intentional. Security-posture toggles belong in the compose spec so they're visible on every review. Credentials belong in `.env`.

### 6. Owner account created

Operator logged in successfully at `http://mailbox.heronlabsinc.com:5678` and created the owner account. Credentials saved to secrets file.

### 7. Security incident (minor) — credential posted in chat

Operator pasted the n8n owner password into this chat session. Flagged to operator immediately. Password rotation requested before any further work.

**Why this matters even though the password was minor:**
- Chat history is persisted in operator's Claude conversation history
- Any screen recording / clipboard history / backup that captures this conversation captures the password
- "LAN-only" is a posture, not an access-control mechanism; anyone with LAN access who gets the password has full n8n control

**Mitigation:** rotate n8n owner password, save new value locally only, proceed without sharing it anywhere.

**Going-forward rule:** credentials never go in chat. If any help request seems to require a real credential to respond to, the request is phrased wrong and an alternative path exists.

---

## Decisions this session

| ID | Decision | Type | Rationale |
|---|---|---|---|
| BL-D1 | OAuth2 over app password for Gmail | Strategic | App passwords deprecated; OAuth2 is Google's supported path; better LTV |
| BL-D2 | Hosts-file entries over DNS A-record for LAN-only hostname | Tactical | 5 min setup vs 30 min incl. DNS propagation; sufficient for 2-machine operator; upgradable later without refactoring |
| BL-D3 | Disable `N8N_SECURE_COOKIE` rather than add TLS reverse proxy | Tactical | Single-tenant LAN appliance; TLS adds 30+ min of Caddy/Traefik config; not justified for current scope |
| BL-D4 | Nuke `mailbox_n8n_data` volume rather than hand-edit settings file | Tactical | Zero data loss (empty n8n); cleaner final state; avoids hand-edit precedent |

---

## Open items (carried to v0.6)

| ID | Item | Priority | Notes |
|---|---|---|---|
| BL-3 | Dedupe 3 Qwen3-4B variants | **High** | Gate before first n8n workflow hardcodes a model tag. |
| BL-6 | `nano` / `vim` in T2 base image provisioning | Low | SSH resolved in v0.4; editor still missing on this unit. Add to T2 provisioning checklist. `vi` is installed and works as fallback. |
| BL-7 | Custom jetson-containers build for current Ollama | Low | Unchanged from v0.4. |
| **BL-8** | **(new)** Rotate n8n owner password | **High — blocker** | Blocks all further n8n work this session. Operator to rotate + save new value to secrets file. |
| **BL-9** | **(new)** Complete Gmail OAuth2 credential in n8n | High | Next step once BL-8 is cleared. Connect credential, verify "Account connected" state. |
| **BL-10** | **(new)** Decide DNS A-record vs. permanent hosts-file strategy for `mailbox.heronlabsinc.com` | Low | Hosts file works for current scope. DNS A-record is the right long-term answer. Defer until a third device needs access. |
| **BL-11** | **(new)** Add TLS reverse proxy in front of n8n (Caddy or Traefik) | Low — future | Current `N8N_SECURE_COOKIE=false` is acceptable for LAN-only dev. Revisit when hardening for customer shipment. |

---

## What Phase 02 actually requires (so next session has a clear runway)

Per PRD Phase 1 Business Deliverables (the ones that must exist before Phase 2 Beta):

| # | Deliverable | Status |
|---|---|---|
| 1 | Assembled appliance running full stack | ✅ Done |
| 2 | End-to-end email pipeline (IMAP → classify → draft → queue) | ❌ Not started — next |
| 3 | Local model classification > 80% accuracy | ❌ Pending workflow |
| 4 | Cloud API draft generation (7/10 complex emails sendable) | ❌ Pending workflow |
| 5 | RAG pipeline with email history | ❌ Pending workflow |
| 6 | Dashboard approval queue with approve/edit/reject → SMTP send | ❌ Pending workflow |

Note: PRD uses "Phase 1" for prototype and "Phase 2" for beta. Our shorthand for "next session's work" is deliverables #2–6 above.

---

## Next-session kickoff sequence

Assumes operator rotated the n8n owner password (BL-8) and has the new one saved locally.

1. **BL-3 — dedupe Qwen3-4B variants** (10 min)
   ```
   ssh mailbox 'sudo docker exec mailbox-ollama-1 ollama show qwen3:4b --modelfile'
   ssh mailbox 'sudo docker exec mailbox-ollama-1 ollama show qwen3-mailbox:latest --modelfile'
   ssh mailbox 'sudo docker exec mailbox-ollama-1 ollama show "hf.co/Qwen/Qwen3-4B-GGUF:Q4_K_M" --modelfile'
   ```
   Diff. Pick canonical (likely `qwen3:4b`). Delete the other two:
   ```
   ssh mailbox 'sudo docker exec mailbox-ollama-1 ollama rm qwen3-mailbox:latest'
   ssh mailbox 'sudo docker exec mailbox-ollama-1 ollama rm "hf.co/Qwen/Qwen3-4B-GGUF:Q4_K_M"'
   ```

2. **BL-9 — complete Gmail OAuth2 in n8n** (10 min)
   - Open `http://mailbox.heronlabsinc.com:5678`
   - Credentials → Create new → Gmail OAuth2 API
   - Paste Client ID + Client Secret from secrets file
   - Click Connect my account, grant access, verify "Account connected"

3. **Gmail-side test surface setup** (10 min)
   - In Gmail UI: create label `MailBOX-Test`
   - Optional filter: subject contains `[mailbox-test]` → apply label, skip inbox
   - Verify by sending yourself a test email and confirming it lands in the label

4. **Build first n8n workflow: IMAP → parse → log** (45 min)
   - New workflow in n8n
   - Gmail Trigger node (Gmail OAuth2 credential, label filter = `MailBOX-Test`, poll every 5 min initially)
   - Set node → extract fields we care about (from, to, subject, body, message-id, received date)
   - Postgres node → INSERT into a new `inbox_messages` table (schema TBD in workflow build)
   - Save workflow, activate, send test email, verify row in Postgres

5. **Conventions document** (stub created during or after step 4)
   - Ollama URL inside compose network: `http://ollama:11434`
   - Postgres: `postgres:5432`, user/db `mailbox`
   - Qdrant: `http://qdrant:6333`
   - Canonical model tag: `qwen3:4b` (post-BL-3)
   - Gmail label surface: `MailBOX-Test`
   - Classification output schema (TBD)

Any pipeline latency measurements captured in step 4 onward sit on a stable 18.66 t/s baseline that will not shift.

---

## Session log

| Time (PDT) | Event |
|---|---|
| ~morning | IP correction via `ssh.md` review |
| ~morning | Gmail app password blocked; OAuth2 path chosen |
| ~morning | GCP project + OAuth client created |
| ~morning | Redirect URI rejected by Google (raw IP); hosts-file workaround applied |
| ~afternoon | n8n crash-loop discovered; encryption-key mismatch diagnosed |
| ~afternoon | `mailbox_n8n_data` volume wiped; n8n recreated, healthy |
| ~afternoon | Secure-cookie error resolved via `N8N_SECURE_COOKIE=false` |
| ~afternoon | Owner account created |
| ~afternoon | Credential-in-chat incident flagged; rotation requested |
| ~afternoon | Build log v0.5 authored |

---

## T2 production baseline (unchanged from v0.4)

| Spec | Value |
|---|---|
| Generation rate | 18.66 t/s |
| GPU offload | 100% |
| Power mode | MAXN_SUPER (persistent via `jetson_clocks.service`) |
| Inference runtime | `ollama/ollama:latest` + Qwen3-4B Q4_K_M |
| Per-email latency estimate | 5–17s (100–300 output tokens) |

---

## Related artifacts

- Build log v0.4: `mailbox-one-t2-build-log-v0_4-2026-04-23.md`
- Build log v0.3: `mailbox-one-t2-build-log-v0_3-2026-04-23.md`
- Build log v0.2: `mailbox-one-t2-build-log-v0_2-2026-04-23.md`
- Build log v0.1: `mailbox-one-t2-build-log-v0_1-2026-04-23.md`
- Technical PRD: `thumbox-technical-prd-v2_1-2026-04-16.md`
- Business PRD: `thumbox-business-prd-v2_1-2026-04-16.md`
- SSH reference: `ssh.md` (authoritative for Jetson IP + SSH config)
- Secrets (Jetson): `/home/bob/mailbox/secrets-2026-04-23.md`
- Secrets (main box): `~/.secrets/mailbox/secrets-2026-04-23.md`
- Compose: `/home/bob/mailbox/docker-compose.yml` (with `docker-compose.yml.backup-2026-04-23`)
- Compose env: `/home/bob/mailbox/.env`
