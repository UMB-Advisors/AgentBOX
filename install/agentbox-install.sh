#!/usr/bin/env bash
# AgentBOX install — reproducible bring-up of the unified MailBOX + Hermes box.
#
# Codifies the validated 2026-05-31 prototype install (DR-63..66, addendum
# addendum-agentbox-solo-hermes-mailbox-v0_1). Idempotent + staged like
# first-boot.sh. The shippable-image enabler: clean Jetson -> green AgentBOX.
#
# What it does NOT do (intentional manual steps, prompted):
#   - mint provider/cloud secrets (pulled from 1Password)
#   - Gmail OAuth consent (browser, once per inbox)
#
# Usage:   ./scripts/agentbox-install.sh [--prototype]
#   --prototype : bench mode — generate throwaway secrets instead of 1Password,
#                 and DO NOT decommission a co-resident hermesBOX/OpenClaw
#                 (stop-only, restorable). Production omits this flag.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
PROTOTYPE=0; [ "${1:-}" = "--prototype" ] && PROTOTYPE=1
log(){ echo "[$(date -u +%H:%M:%S)] $*"; }
die(){ echo "FATAL: $*" >&2; exit 1; }
PSQL(){ docker exec -i mailbox-postgres-1 psql -U "${POSTGRES_USER:-mailbox}" -d "${POSTGRES_DB:-mailbox}" "$@"; }

# ── STAGE 0: preconditions ────────────────────────────────────────────────
log "STAGE 0 — preconditions"
command -v docker >/dev/null || die "docker not installed"
docker info 2>/dev/null | grep -qi nvidia || log "WARN: nvidia runtime not default — GPU inference may be unavailable"
[ "$(df --output=avail -BG "$REPO" | tail -1 | tr -dc 0-9)" -ge 16 ] || die "need >=16GB free disk"
git submodule update --init 2>/dev/null || log "WARN: submodule init skipped (vendor/thumbox-common needs auth; non-fatal for AgentBOX)"

# ── STAGE 1: secrets + .env (gate ON; DR-66 security model) ───────────────
log "STAGE 1 — secrets / .env"
if [ ! -f .env ]; then
  cp .env.example .env
  {
    echo ""; echo "# --- AgentBOX install $(date -u +%FT%TZ) ---"
    echo "POSTGRES_USER=mailbox"; echo "POSTGRES_DB=mailbox"
    echo "LOCAL_INFERENCE_RUNTIME=ollama"
    if [ "$PROTOTYPE" = 1 ]; then
      log "  --prototype: generating throwaway secrets (NOT for production)"
      echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
      echo "N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)"
      echo "MAILBOX_OAUTH_TOKEN_KEY=$(openssl rand -hex 32)"
      echo "MAILBOX_OAUTH_STATE_SECRET=$(openssl rand -hex 32)"
    else
      # Production: pull from 1Password (MailBOX vault). Never echo values.
      command -v op >/dev/null || die "1Password CLI 'op' required for production install (or use --prototype)"
      echo "POSTGRES_PASSWORD=$(op read 'op://MailBOX/agentbox/postgres_password')"
      echo "N8N_ENCRYPTION_KEY=$(op read 'op://MailBOX/agentbox/n8n_encryption_key')"
      echo "OLLAMA_CLOUD_API_KEY=$(op read 'op://MailBOX/agentbox/ollama_cloud_api_key')"
      echo "GITHUB_PACKAGES_TOKEN=$(op read 'op://MailBOX/agentbox/github_packages_token')"
      echo "MAILBOX_OAUTH_TOKEN_KEY=$(op read 'op://MailBOX/agentbox/oauth_token_key')"
      echo "MAILBOX_OAUTH_STATE_SECRET=$(op read 'op://MailBOX/agentbox/oauth_state_secret')"
    fi
    # GATE ON in production (no MAILBOX_LIVE_GATE_BYPASS). Prototype may set it.
    [ "$PROTOTYPE" = 1 ] && echo "MAILBOX_LIVE_GATE_BYPASS=1"
  } >> .env
  log "  .env created (gate $([ "$PROTOTYPE" = 1 ] && echo BYPASS-prototype || echo ON))"
else
  log "  .env exists — leaving it (edit manually to rotate secrets)"
fi
grep -q '^GITHUB_PACKAGES_TOKEN=..*' .env || die "GITHUB_PACKAGES_TOKEN required (dashboard build). Set in .env."

# ── STAGE 2: base services + single ollama (DR-64) ────────────────────────
log "STAGE 2 — postgres + qdrant + ollama (one ollama, DR-64)"
docker compose up -d postgres qdrant ollama
for i in $(seq 1 30); do docker exec mailbox-postgres-1 pg_isready -U mailbox >/dev/null 2>&1 && break; sleep 2; done

# ── STAGE 3: canonical DB bootstrap ───────────────────────────────────────
# The numbered migrations are incremental on a base the init-db mount does NOT
# create (00-schemas.sql = CREATE SCHEMA only). Canonical path: apply the
# CI-verified full schema (kysely-codegen SoT), mark migrations applied, set
# search_path. Idempotent: skip if drafts already exists.
log "STAGE 3 — DB schema"
if PSQL -tAc "select to_regclass('mailbox.drafts') is not null" 2>/dev/null | grep -q t; then
  log "  mailbox.drafts present — schema already bootstrapped, skipping"
else
  log "  applying canonical schema (dashboard/test/fixtures/schema.sql)"
  PSQL -c "DROP SCHEMA IF EXISTS mailbox CASCADE;" >/dev/null
  PSQL -v ON_ERROR_STOP=1 < dashboard/test/fixtures/schema.sql >/dev/null || die "schema apply failed"
  for f in dashboard/migrations/*.sql; do
    echo "INSERT INTO mailbox.migrations(version) VALUES ('$(basename "$f" .sql)') ON CONFLICT DO NOTHING;"
  done | PSQL >/dev/null
  PSQL -c "ALTER DATABASE ${POSTGRES_DB:-mailbox} SET search_path TO mailbox, public;" >/dev/null
  log "  schema applied; $(ls dashboard/migrations/*.sql | wc -l) migrations marked; search_path set"
fi

# ── STAGE 4: models (single ollama, DR-18 + DR-64) ────────────────────────
log "STAGE 4 — models (qwen3:4b-ctx4k + nomic-embed-text)"
ML=$(docker exec mailbox-ollama-1 ollama list 2>/dev/null || true)
echo "$ML" | grep -q nomic-embed-text || docker exec mailbox-ollama-1 ollama pull nomic-embed-text:v1.5
if ! echo "$ML" | grep -q 'qwen3:4b-ctx4k'; then
  docker exec mailbox-ollama-1 ollama pull qwen3:4b-instruct
  printf 'FROM qwen3:4b-instruct\nPARAMETER num_ctx 4096\n' \
    | docker exec -i mailbox-ollama-1 sh -c 'cat >/tmp/Modelfile && ollama create qwen3:4b-ctx4k -f /tmp/Modelfile'
fi
docker exec mailbox-ollama-1 ollama list

# ── STAGE 5: stack up (dashboard, n8n, caddy) ─────────────────────────────
log "STAGE 5 — full stack up"
CADDY="caddy"
if [ "$PROTOTYPE" = 1 ]; then CADDY=""; log "  --prototype: skipping caddy (LAN/tailnet only; no DNS/TLS creds)"; fi
docker compose up -d --build mailbox-dashboard n8n $CADDY
docker compose --profile qdrant-bootstrap run --rm mailbox-qdrant-bootstrap || log "  (qdrant bootstrap non-fatal)"

# ── STAGE 6: n8n credential + workflows + activate ────────────────────────
# Fresh n8n has no credentials; the workflows hard-reference the Postgres
# credential id JFX4tvrffvKnTouV. Create it with that exact id, import the 4
# core workflows (ids preserved incl sub-workflow refs), activate each by id
# (n8n dropped update:workflow --all), restart (CLI activation is a no-op until
# restart). Validated working on the prototype 2026-05-31.
log "STAGE 6 — n8n credential + workflows"
PGPW=$(grep '^POSTGRES_PASSWORD=' .env | tail -1 | cut -d= -f2-)
umask 077; CJ=$(mktemp)
printf '[{"id":"JFX4tvrffvKnTouV","name":"MailBox Postgres","type":"postgres","data":{"host":"postgres","database":"%s","user":"%s","password":"%s","port":5432,"ssl":"disable","allowUnauthorizedCerts":false}}]' \
  "${POSTGRES_DB:-mailbox}" "${POSTGRES_USER:-mailbox}" "$PGPW" > "$CJ"
docker cp "$CJ" mailbox-n8n-1:/tmp/creds.json >/dev/null
docker exec mailbox-n8n-1 n8n import:credentials --input=/tmp/creds.json >/dev/null 2>&1 && log "  Postgres credential imported (JFX4tvrffvKnTouV)"
docker exec mailbox-n8n-1 rm -f /tmp/creds.json; rm -f "$CJ"
for w in MailBOX MailBOX-Classify MailBOX-Draft MailBOX-Send; do
  [ -f "n8n/workflows/$w.json" ] || { log "  WARN: n8n/workflows/$w.json missing"; continue; }
  docker cp "n8n/workflows/$w.json" "mailbox-n8n-1:/tmp/$w.json" >/dev/null
  docker exec mailbox-n8n-1 n8n import:workflow --input="/tmp/$w.json" >/dev/null 2>&1 && log "  imported $w"
  docker exec mailbox-n8n-1 rm -f "/tmp/$w.json"
done
for id in $(docker exec mailbox-postgres-1 psql -U "${POSTGRES_USER:-mailbox}" -d "${POSTGRES_DB:-mailbox}" -tAc "select id from public.workflow_entity" 2>/dev/null); do
  docker exec mailbox-n8n-1 n8n update:workflow --active=true --id="$id" >/dev/null 2>&1 \
    || docker exec mailbox-n8n-1 n8n publish:workflow --id="$id" >/dev/null 2>&1 || true
done
docker compose restart n8n >/dev/null 2>&1; sleep 10
docker compose --profile n8n-verify run --rm mailbox-n8n-verify || log "  WARN: n8n-verify non-zero — check workflow activation"
log "  NOTE: live Gmail triage needs Gmail OAuth (MANUAL browser consent, per inbox) — not bench-automatable."

# ── STAGE 7: Hermes client-mode + gbrain at the shared ollama (DR-63/64) ──
log "STAGE 7 — Hermes + gbrain"
if command -v hermes >/dev/null || [ -x "$HOME/.local/bin/hermes" ]; then
  log "  Hermes present. MANUAL: confirm client-mode (no local weights):"
  log "    hermes doctor ; ollama ps   # must show ONLY nomic + qwen3, nothing Hermes-pulled"
  log "  DR-64: repoint gbrain at the shared dockerized ollama (publish ollama 11434"
  log "    to host or set gbrain base_urls.ollama to it) and retire the standalone host ollama."
else
  log "  MANUAL: install hermes-agent (uv venv, ~/.hermes) in client-mode + wire gbrain MCP."
fi

# ── STAGE 8: boot-to-ready (SM-100) ───────────────────────────────────────
log "STAGE 8 — boot-to-ready"
log "  compose 'restart: unless-stopped' covers the stack on reboot."
log "  MANUAL (production): install an 'agentbox.target' systemd unit that brings the"
log "  compose stack + Hermes up at boot; validate cold boot -> healthy <= 5 min (SM-100)."

# ── STAGE 9: verify ───────────────────────────────────────────────────────
log "STAGE 9 — verify"
docker compose ps --format '{{.Name}}\t{{.Status}}'
PSQL -tAc "select 'drafts:'||(to_regclass('mailbox.drafts') is not null)::text;"
log "AgentBOX install complete. Smokes: inject inbound -> draft appears; 'hermes -z' replies;"
log "re-run the SM-97 spike (spike-hermes-mailbox/12-worstcase-turn.sh) to spot-check the envelope."
