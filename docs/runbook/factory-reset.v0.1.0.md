# Factory Reset — Manual Wipe Checklist

**Version:** 0.1.0
**Tracks:** MBOX-180 (M5 — Production Box). Companion to `scripts/factory-reset.sh` and `scripts/factory-bootstrap.sh`.
**Audience:** appliance operator (Dustin / Glue Co) with `sudo` shell on the box.

> **TL;DR** — `scripts/factory-reset.sh` automates everything below. This runbook
> is the **manual fallback** for when the script breaks, plus the authoritative
> wipe checklist that the script is verified against. Run the script first;
> fall back to these steps only if it fails partway.

---

## When to use this

1. **Customer churn** — the appliance comes back and must be redeployed to the
   next customer without leaking the prior customer's email corpus, drafts,
   classification log, RAG vectors, n8n credentials, or basic_auth secrets.
2. **OS-rebuild validation** — re-flash the box and replay bootstrap to prove it
   returns to a known-good state.

This is the most destructive operation in the repo. There is no undo.

---

## Preferred path: the script

```bash
# Always preview first — touches nothing, prints the full blast radius:
sudo bash ./scripts/factory-reset.sh --dry-run

# Non-interactive (e.g. scripted retirement):
sudo RESET=YES_I_AM_SURE bash ./scripts/factory-reset.sh

# Interactive (type WIPE at the prompt):
sudo bash ./scripts/factory-reset.sh
```

Flags:

| Flag | Effect |
|------|--------|
| `--dry-run` | Print blast radius, exit 0, touch nothing. |
| `--no-bootstrap` | Skip the final `factory-bootstrap.sh` re-run. |
| `--keep-host-identity` | Data-plane scrub only — leave Tailscale + SSH host keys intact. |

Production safety: the script refuses to run on a known-production host
(`mailbox1`, `mailbox2`, or any `mailboxN` tailnet identity). To deliberately
reset a listed host, set `RESET_ALLOW_PROD=1`. Override the prod list with
`RESET_PROD_HOSTS="..."`.

**Test path (per MBOX-180 acceptance):** run against customer #1's box only
**after** customer #2 is live, so #1 is not the sole working reference. Until
then, exercise it against the dev/staging compose.

---

## Manual fallback — step by step

Run from inside the repo root on the appliance. Each step is idempotent.

### 1. Stop the compose stack

```bash
cd ~/mailbox
docker compose down --remove-orphans
```

Do **not** add `-v` — that nukes every volume including `mailbox_ollama_models`
(multi-GB model weights you do not want to re-pull). Volumes are removed
surgically in step 2.

### 2. Remove the sensitive named volumes

```bash
for v in mailbox_postgres_data mailbox_qdrant_data mailbox_n8n_data \
         mailbox_caddy_data mailbox_kb_uploads; do
  docker volume inspect "$v" >/dev/null 2>&1 && docker volume rm "$v"
done
```

| Volume | What it holds | Why wipe |
|--------|---------------|----------|
| `mailbox_postgres_data` | all customer email, drafts, classification log, state transitions | core customer corpus |
| `mailbox_qdrant_data` | RAG vector corpus (inbound + outbound embeddings) | sensitive per CLAUDE.md Constraints (no corpus leaves the box) |
| `mailbox_n8n_data` | n8n encrypted credentials (Gmail OAuth refresh token, Postgres creds) | prevents the next customer inheriting the old Gmail auth |
| `mailbox_caddy_data` | Caddy ACME account + issued TLS cert | forces a fresh cert under the next customer's hostname |
| `mailbox_kb_uploads` | operator-uploaded KB source bytes (STAQPRO-148) | customer-specific knowledge base |

**Preserved on purpose:** `mailbox_ollama_models` (model weights, no customer
data) and `mailbox_caddy_config` (runtime config snapshot, no secrets).

> Volume names are the runtime (project-prefixed) form. If the compose project
> name was overridden, confirm the actual names with `docker volume ls` and
> substitute accordingly.

### 3. Reset `.env`

```bash
cd ~/mailbox
mv .env ".env.old.$(date +%Y%m%d-%H%M%S)"   # archive the old one
cp .env.example .env
```

The archived `.env.old.*` still contains the **old basic_auth hash and API
keys** — delete it once the box is confirmed reset, or it defeats the wipe.

### 4. Clear shell history

```bash
: > ~/.bash_history
sudo sh -c ': > /root/.bash_history'
history -c
```

### 5. Vacuum journal logs

```bash
sudo journalctl --rotate
sudo journalctl --vacuum-time=1s
```

### 6. Tailscale identity rotation

```bash
sudo tailscale logout
```

The operator must re-auth (`sudo tailscale up`) after reset to issue a fresh
node identity. The read/send Gmail quotas are unrelated; this only affects
tailnet membership.

### 7. Regenerate SSH host keys

```bash
sudo rm -f /etc/ssh/ssh_host_*
sudo ssh-keygen -A
sudo systemctl restart ssh   # or sshd, depending on the unit name
```

Fingerprints change. Every workstation that connects must drop the stale entry:
`ssh-keygen -R <host>`. Your current SSH session survives the restart.

### 8. Re-run factory-bootstrap

```bash
sudo bash ./scripts/factory-bootstrap.sh
```

This is the proof the box came back to a known-good state — it re-establishes
the mDNS host identity (`mailbox.local`) and the avahi service record.

---

## Post-reset checklist (operator)

- [ ] Re-auth Tailscale: `sudo tailscale up` → approve in the admin console.
- [ ] Refresh `known_hosts` on each connecting workstation: `ssh-keygen -R <host>`.
- [ ] Re-fill `.env` secrets: basic_auth hash (`bin/rotate-basic-auth`),
      `CLOUDFLARE_API_TOKEN`, model API keys, `DOMAIN`.
- [ ] Delete the archived `.env.old.*` once reset is confirmed (it holds old secrets).
- [ ] Bring the stack up: `docker compose up -d --build --remove-orphans`.
- [ ] Verify volumes are fresh: `docker volume ls | grep mailbox_`.
- [ ] Run guided onboarding to repopulate the per-appliance persona.

---

## Acceptance check (MBOX-180)

After reset + bootstrap, the appliance should be indistinguishable — modulo
customer-specific config — from a freshly flashed box:

- No rows in `mailbox.drafts`, `mailbox.inbox_messages`, `mailbox.classification_log`.
- Qdrant `email_messages` collection empty (or absent until re-bootstrap).
- n8n has no stored credentials.
- `.env` matches `.env.example` (no real secrets).
- New TLS cert issued on first `caddy` boot under the new hostname.
- New SSH host-key fingerprints; box logged out of the old tailnet identity.
