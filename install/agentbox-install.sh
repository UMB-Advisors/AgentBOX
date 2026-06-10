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
# Usage:   ./install/agentbox-install.sh [--prototype]
#   --prototype : bench mode — generate throwaway secrets instead of 1Password,
#                 and DO NOT decommission a co-resident hermesBOX/OpenClaw
#                 (stop-only, restorable). Production omits this flag.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # AgentBOX checkout (installer + Hermes wiring + vendored MailBOX stack)
PROTOTYPE=0; [ "${1:-}" = "--prototype" ] && PROTOTYPE=1
# The MailBOX stack is VENDORED in this monorepo at $REPO/mailbox (decision UMB-105:
# absorb MailBOX into AgentBOX — no external clone). STAGE 0.5 syncs it into place.
STACK_DIR="${STACK_DIR:-$HOME/mailbox}"                   # MailBOX stack runtime checkout on the box
HERMES_REF="${HERMES_REF:-927fa7a98}"                     # Hermes v0.15.1 pin — 0.16 enforces >=64K ctx which breaks local Qwen3-4B (DR: 2026-06-06)
DASHBOARD_IMAGE="${DASHBOARD_IMAGE:-}"                    # if set/preloaded, skip the from-source dashboard build (no GH token needed)
MAILBOX_FQDN="${MAILBOX_FQDN:-}"                          # tailnet FQDN for n8n/Funnel; blank on a bench/--prototype box
log(){ echo "[$(date -u +%H:%M:%S)] $*"; }
die(){ echo "FATAL: $*" >&2; exit 1; }
PSQL(){ docker exec -i mailbox-postgres-1 psql -U "${POSTGRES_USER:-mailbox}" -d "${POSTGRES_DB:-mailbox}" "$@"; }

# ── STAGE 0: preconditions + JP7.2 base prep ──────────────────────────────
log "STAGE 0 — preconditions + JP7.2 base prep"
command -v docker >/dev/null || die "docker not installed"
docker ps >/dev/null 2>&1 || die "cannot talk to docker as $USER — add to the 'docker' group and re-login: sudo usermod -aG docker $USER"
[ "$(df --output=avail -BG "$HOME" | tail -1 | tr -dc 0-9)" -ge 16 ] || die "need >=16GB free disk"
# JP7.2 / L4T r39: the nvidia container runtime ships but is frequently unregistered
# with the daemon (GPU containers then fail with "unknown runtime: nvidia").
if ! docker info 2>/dev/null | grep -qiE 'Runtimes:.*nvidia'; then
  if command -v nvidia-ctk >/dev/null; then
    log "  registering nvidia container runtime (nvidia-ctk) + restarting docker"
    sudo nvidia-ctk runtime configure --runtime=docker >/dev/null && sudo systemctl restart docker \
      || log "  WARN: nvidia runtime registration failed — GPU inference may be unavailable"
  else
    log "  WARN: nvidia runtime unregistered and nvidia-ctk absent — GPU inference unavailable"
  fi
fi

# ── STAGE 0.1: MAXN power mode + optional disk encryption (UMB-113) ─────────
# Ported from the legacy first-boot.sh (Stages 4–5), adapted for JP7.2/r39.
log "STAGE 0.1 — power mode + disk encryption"
# MAXN/Super Mode: on r39 the max mode is NAME=MAXN_SUPER (id 2), NOT id 0 (the
# r36 value). Detect the id by NAME from nvpmodel.conf (matches MAXN + MAXN_SUPER),
# set it, and persist via systemd (the conf default is a lower-wattage mode).
if command -v nvpmodel >/dev/null; then
  MAXN_ID="$(grep -oP '^< POWER_MODEL ID=\K[0-9]+(?= NAME=MAXN)' /etc/nvpmodel.conf 2>/dev/null | head -1 || true)"
  if [ -n "$MAXN_ID" ]; then
    if nvpmodel -q 2>/dev/null | grep -qi MAXN; then
      log "  power mode already MAXN (id $MAXN_ID)"
    else
      log "  setting MAXN power mode (nvpmodel -m $MAXN_ID)"
      sudo nvpmodel -m "$MAXN_ID" >/dev/null 2>&1 || log "  WARN: nvpmodel set failed"
    fi
    if [ ! -f /etc/systemd/system/set-maxn-power.service ]; then
      printf '[Unit]\nDescription=Set Jetson Orin to MAXN power mode\nAfter=multi-user.target\n\n[Service]\nType=oneshot\nExecStart=/usr/bin/nvpmodel -m %s\nRemainAfterExit=yes\n\n[Install]\nWantedBy=multi-user.target\n' "$MAXN_ID" \
        | sudo tee /etc/systemd/system/set-maxn-power.service >/dev/null \
        && sudo systemctl daemon-reload && sudo systemctl enable set-maxn-power.service >/dev/null 2>&1 \
        && log "  set-maxn-power.service enabled (persists across reboot)" \
        || log "  WARN: could not persist MAXN via systemd"
    fi
  else
    log "  WARN: MAXN mode id not found in /etc/nvpmodel.conf — set manually (nvpmodel -q --verbose)"
  fi
else
  log "  nvpmodel absent — skipping power mode (non-Jetson host?)"
fi
# LUKS encryption-at-rest (Jetson-native gen_luks.sh, OP-TEE/fTPM-bound).
# DESTRUCTIVE — runs only in production with DATA_PARTITION set AND the explicit
# LUKS_CONFIRM=ENCRYPT gate. Idempotent: skips a partition already LUKS.
if [ "$PROTOTYPE" = 1 ]; then
  log "  --prototype: skipping LUKS (bench)"
elif [ -z "${DATA_PARTITION:-}" ]; then
  log "  LUKS: DATA_PARTITION unset — skipping (set DATA_PARTITION=/dev/nvmeXnYpZ + LUKS_CONFIRM=ENCRYPT to enable)"
else
  [ -b "$DATA_PARTITION" ] || die "DATA_PARTITION=$DATA_PARTITION is not a block device"
  if sudo cryptsetup isLuks "$DATA_PARTITION" 2>/dev/null; then
    log "  LUKS: $DATA_PARTITION already encrypted — skipping"
  else
    [ "${LUKS_CONFIRM:-}" = "ENCRYPT" ] || die "refusing to encrypt $DATA_PARTITION without LUKS_CONFIRM=ENCRYPT (destructive)"
    command -v cryptsetup >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y -qq cryptsetup-bin tpm2-tools; }
    [ -f /usr/sbin/gen_luks.sh ] || sudo apt-get install -y -qq nvidia-l4t-security-utils || true
    [ -f /usr/sbin/gen_luks.sh ] || die "gen_luks.sh missing (nvidia-l4t-security-utils) — required for TPM-bound LUKS; see docs/agentbox-jp72-reproduction"
    [ -e /dev/tpm0 ] || [ -e /dev/tpmrm0 ] || log "  WARN: no TPM device — key binding may not work, continuing"
    log "  encrypting $DATA_PARTITION via gen_luks.sh (TPM-bound)…"
    sudo /usr/sbin/gen_luks.sh "$DATA_PARTITION" || die "gen_luks.sh failed"
    sudo cryptsetup luksDump "$DATA_PARTITION" >/dev/null || die "LUKS header not found after gen_luks"
    log "  LUKS applied to $DATA_PARTITION"
  fi
fi

# ── STAGE 0.2: Tailscale SSH — admin access for every box (default ON) ─────
# Every AgentBOX must be reachable from the tailnet admin WITHOUT per-box key
# management. Plain `tailscale up` does NOT enable the Tailscale SSH server, so
# enrolled boxes drifted into key-only/unreachable states (agentbox3, 2026-06 —
# admin had to chase the operator for a password). We force the SSH server on
# here so it's a property of the install, not of how the operator typed
# `tailscale up`. Idempotent; needs no re-auth (the node is already enrolled by
# the time the installer runs). The tailnet ACL must also grant the admin an
# `ssh` rule for the box's tag — see docs/runbook/provisioning.v0.1.0.md §2.
log "STAGE 0.2 — Tailscale SSH (admin access default)"
if command -v tailscale >/dev/null; then
  if tailscale status >/dev/null 2>&1; then
    if sudo tailscale set --ssh=true >/dev/null 2>&1; then
      log "  Tailscale SSH enabled (sudo tailscale set --ssh=true)"
    else
      log "  WARN: 'tailscale set --ssh=true' failed — enable manually: sudo tailscale up --ssh"
    fi
  else
    log "  WARN: tailscale not up yet — enroll with: sudo tailscale up --ssh --hostname=<box> (admin SSH won't work until then)"
  fi
else
  log "  WARN: tailscale not installed — install + enroll with --ssh (see docs/runbook/provisioning.v0.1.0.md §2)"
fi

# ── STAGE 0.5: MailBOX stack (VENDORED in this monorepo; sync into place) ──
# AgentBOX absorbs the MailBOX stack — it lives at $REPO/mailbox (no external
# clone). Sync the source-controlled stack into $STACK_DIR (the runtime
# checkout) and run every stack stage below inside it. (.env, docker-compose,
# dashboard/ schema+migrations, n8n/workflows all ship from the vendored stack.)
log "STAGE 0.5 — MailBOX stack (vendored: $REPO/mailbox -> $STACK_DIR)"
[ -f "$REPO/mailbox/docker-compose.yml" ] || die "vendored MailBOX stack missing at $REPO/mailbox"
# Carry a GITHUB_PACKAGES_TOKEN supplied via env or the AgentBOX .env into the stack .env.
ABX_TOKEN="${GITHUB_PACKAGES_TOKEN:-}"
[ -z "$ABX_TOKEN" ] && [ -f "$REPO/.env" ] && ABX_TOKEN="$(grep -m1 '^GITHUB_PACKAGES_TOKEN=' "$REPO/.env" | cut -d= -f2-)"
mkdir -p "$STACK_DIR"
# Sync vendored stack into the runtime dir. Preserve runtime state that is NOT
# source-controlled: .env (secrets), the applied override, docker volume data,
# and the re-downloadable GGUFs. rsync if available; cp -a fallback.
SYNC_EXCLUDES=(--exclude='.env' --exclude='.env.*.bak' --exclude='docker-compose.override.yml' --exclude='.git' --exclude='llama-cpp-models')
if command -v rsync >/dev/null; then
  rsync -a --delete "${SYNC_EXCLUDES[@]}" "$REPO/mailbox/" "$STACK_DIR/" || die "stack sync (rsync) failed"
else
  log "  rsync absent — using cp -a (no prune of stale files)"
  cp -a "$REPO/mailbox/." "$STACK_DIR/" || die "stack sync (cp) failed"
fi
cd "$STACK_DIR"   # ← all stack stages below run inside the runtime checkout
[ -f docker-compose.yml ] && [ -f .env.example ] || die "MailBOX stack incomplete at $STACK_DIR"

# AgentBOX compose override (loopback publishes for Hermes<->Ollama :11435 +
# dashboard :3001 iframe, plus n8n FQDN). Applied BEFORE STAGE 2 so Ollama is
# published from its first `up`. Authoritative copy lives in the AgentBOX repo.
if [ -f "$REPO/config/docker-compose.override.yml.template" ]; then
  sed "s#__MAILBOX_FQDN__#${MAILBOX_FQDN:-localhost}#g" \
    "$REPO/config/docker-compose.override.yml.template" > docker-compose.override.yml
  log "  applied docker-compose.override.yml (FQDN=${MAILBOX_FQDN:-localhost})"
fi

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
      [ -n "$ABX_TOKEN" ] && echo "GITHUB_PACKAGES_TOKEN=$ABX_TOKEN"   # carried from env/AgentBOX .env
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
# Dashboard image: build from source (needs a REAL GITHUB_PACKAGES_TOKEN for npm —
# the committed .env.example token is a placeholder), OR reuse a preloaded image
# (set DASHBOARD_IMAGE, or `docker save|load` mailbox-dashboard:local from another
# box). Offline / no-token installs must preload.
BUILD_FLAG="--build"
if [ -n "$DASHBOARD_IMAGE" ]; then
  export DASHBOARD_IMAGE; BUILD_FLAG=""; log "  using DASHBOARD_IMAGE=$DASHBOARD_IMAGE (skipping --build)"
elif docker image inspect mailbox-dashboard:local >/dev/null 2>&1; then
  BUILD_FLAG=""; log "  using preloaded mailbox-dashboard:local (skipping --build)"
fi
docker compose up -d $BUILD_FLAG mailbox-dashboard n8n $CADDY
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

# ── STAGE 7: Hermes (v0.15.1 pin) + gbrain memory ─────────────────────────
# Native (not containerized). Codifies the validated JP7.2 sequence (2026-06-06).
# Idempotent: each step is guarded so re-runs converge.
log "STAGE 7 — Hermes + gbrain"
HH="$HOME/.hermes"; HBIN="$HOME/.local/bin/hermes"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

# 7.1 install hermes-agent if absent
if [ ! -x "$HBIN" ]; then
  log "  installing hermes-agent (non-interactive)"
  curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
    | bash -s -- --skip-setup || log "  WARN: hermes install returned non-zero"
fi
# 7.2 pin to HERMES_REF (0.15.1) — 0.16's >=64K ctx floor rejects the local Qwen3-4B
if [ -d "$HH/hermes-agent/.git" ]; then
  CUR=$(git -C "$HH/hermes-agent" rev-parse --short HEAD 2>/dev/null || echo none)
  if [ "$CUR" != "$HERMES_REF" ]; then
    log "  pinning Hermes to $HERMES_REF (was $CUR)"
    git -C "$HH/hermes-agent" fetch --tags origin >/dev/null 2>&1
    git -C "$HH/hermes-agent" checkout -f "$HERMES_REF" >/dev/null 2>&1 \
      && ( cd "$HH/hermes-agent" && uv sync >/dev/null 2>&1 ) || log "  WARN: Hermes pin/sync failed"
  fi
fi
# 7.3 config.yaml from the AgentBOX template (local Qwen3-4B @ :11435 + gbrain MCP + cloud fallback)
if [ -f "$REPO/config/hermes/config.yaml.template" ]; then
  [ -f "$HH/config.yaml" ] && cp "$HH/config.yaml" "$HH/config.yaml.pre-agentbox.bak"
  sed "s#__AGENTBOX_HOME__#$HOME#g" "$REPO/config/hermes/config.yaml.template" > "$HH/config.yaml"
  log "  hermes config.yaml installed (qwen3:4b-instruct via :11435)"
fi
# 7.4 gbrain: source (vendored copy if absent) + bun deps + global wrapper + fresh pglite brain
if [ ! -d "$HOME/gbrain-src" ] && [ -d "$REPO/gbrain-master/gbrain-master" ]; then
  log "  deploying gbrain-src from vendored AgentBOX copy"
  cp -r "$REPO/gbrain-master/gbrain-master" "$HOME/gbrain-src"
  ( cd "$HOME/gbrain-src" && command -v bun >/dev/null && bun install >/dev/null 2>&1 ) || log "  WARN: gbrain bun install failed"
fi
if [ -d "$HOME/gbrain-src" ] && command -v bun >/dev/null; then
  [ -x "$HOME/.bun/bin/gbrain" ] || { printf '#!/usr/bin/env bash\nexec bun "$HOME/gbrain-src/src/cli.ts" "$@"\n' > "$HOME/.bun/bin/gbrain"; chmod +x "$HOME/.bun/bin/gbrain"; }
  mkdir -p "$HOME/.hermesbox/.gbrain"
  [ -f "$HOME/.hermesbox/.gbrain/config.json" ] || sed "s#__AGENTBOX_HOME__#$HOME#g" \
    "$REPO/config/hermes/gbrain-config.json.template" > "$HOME/.hermesbox/.gbrain/config.json"
  # embeddings (nomic) live in the docker ollama from STAGE 4 (gbrain points at :11435)
  if [ ! -d "$HOME/.hermesbox/.gbrain/brain.pglite" ]; then
    log "  initializing fresh gbrain brain (pglite)"
    ( cd "$HOME/gbrain-src" && GBRAIN_HOME="$HOME/.hermesbox" bun src/cli.ts apply-migrations --yes --non-interactive >/dev/null 2>&1 ) \
      || log "  WARN: gbrain migrations non-zero (re-run: GBRAIN_HOME=~/.hermesbox gbrain apply-migrations --yes)"
  fi
else
  log "  MANUAL: gbrain not set up (need bun + ~/gbrain-src) — see docs/agentbox-jp72-reproduction"
fi
# 7.5 build + install the dashboard web dist (the :9119 service runs --skip-build).
# Prefer the vendored CUSTOM web (Carbon reskin, Settings→Google page); fall back
# to the stock build only if the custom build is unavailable/fails. web_dist is a
# gitignored build artifact, so it must be built here — it never ships in the repo.
ABX_HERMES="$REPO/hermes-agent-main/hermes-agent-main"
INSTALL_CLI="$HH/hermes-agent/hermes_cli"
if [ -d "$ABX_HERMES/web" ] && command -v npm >/dev/null; then
  log "  building AgentBOX custom web bundle (vendored; ~minutes)"
  if ( cd "$ABX_HERMES/web" && { [ -f package-lock.json ] && npm ci || npm install; } >/tmp/abx-webbuild.log 2>&1 \
        && npm run build >>/tmp/abx-webbuild.log 2>&1 ) && [ -d "$ABX_HERMES/hermes_cli/web_dist" ]; then
    mkdir -p "$INSTALL_CLI"
    [ -d "$INSTALL_CLI/web_dist" ] && cp -a "$INSTALL_CLI/web_dist" "$INSTALL_CLI/web_dist.stock-$(date -u +%Y%m%d-%H%M%S)" 2>/dev/null || true
    if command -v rsync >/dev/null; then rsync -a --delete "$ABX_HERMES/hermes_cli/web_dist/" "$INSTALL_CLI/web_dist/"
    else rm -rf "$INSTALL_CLI/web_dist"; cp -a "$ABX_HERMES/hermes_cli/web_dist" "$INSTALL_CLI/web_dist"; fi
    log "  installed AgentBOX custom web_dist"
  else
    log "  WARN: custom web build failed (see /tmp/abx-webbuild.log) — will fall back to stock build"
  fi
fi
if [ -x "$HBIN" ] && [ ! -d "$INSTALL_CLI/web_dist" ]; then
  log "  building stock hermes dashboard web dist (one-time; ~minutes)"
  timeout 360 "$HBIN" dashboard --host 127.0.0.1 --port 9119 --no-open >/tmp/hermes-webbuild.log 2>&1 &
  for i in $(seq 1 80); do [ -d "$INSTALL_CLI/web_dist" ] && break; sleep 3; done
  "$HBIN" dashboard --stop >/dev/null 2>&1 || true
  [ -d "$INSTALL_CLI/web_dist" ] && log "  web_dist built (stock)" || log "  WARN: web_dist not built — see /tmp/hermes-webbuild.log"
fi

# ── STAGE 7.6: AgentBOX custom dashboard BACKEND overlay (DR: 2026-06-06) ──
# STAGE 7 installs/pins STOCK upstream hermes. Stock has NO /api/google/* or
# /api/shopify/* routes (so "Connect Google account" 404s), and its auth allowlist
# doesn't cover the OAuth callbacks. Overlay the AgentBOX-custom backend — the *.py
# under hermes_cli/ that diverge from the stock import (web_server.py, the
# google_*/shopify_* helpers, dashboard_auth/public_paths.py). The file set is the
# shared SoT in bin/lib/custom-backend-files.sh (git-derived, so new custom modules
# are picked up automatically). MUST run after 7.2 — a re-pin / `hermes update`
# reverts the working tree to stock; re-running this installer re-applies the overlay.
log "STAGE 7.6 — AgentBOX custom dashboard backend"
if [ -f "$REPO/bin/lib/custom-backend-files.sh" ] && [ -d "$ABX_HERMES/hermes_cli" ] && [ -d "$INSTALL_CLI" ]; then
  . "$REPO/bin/lib/custom-backend-files.sh"
  PYBIN="$HH/hermes-agent/venv/bin/python3"; [ -x "$PYBIN" ] || PYBIN="python3"
  OVTS="$(date -u +%Y%m%d-%H%M%S)"; n=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    src="$ABX_HERMES/hermes_cli/$f"; dst="$INSTALL_CLI/$f"
    [ -f "$src" ] || { log "  WARN: custom file missing in repo: $f"; continue; }
    "$PYBIN" -m py_compile "$src" 2>/dev/null || { log "  WARN: py_compile failed: $f — skipping"; continue; }
    mkdir -p "$(dirname "$dst")"
    [ -f "$dst" ] && cp -a "$dst" "$dst.stock-$OVTS" 2>/dev/null || true
    cp -a "$src" "$dst"; n=$((n+1))
  done < <(abx_custom_backend_files "$ABX_HERMES")
  log "  overlaid $n custom backend files onto $INSTALL_CLI"
  # If the dashboard service is already running (re-run / hermes update repair),
  # restart so the overlay takes effect now. On a first install STAGE 8 starts it.
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  systemctl --user restart hermes-dashboard.service >/dev/null 2>&1 || true
else
  log "  WARN: custom backend overlay skipped (missing bin/lib/custom-backend-files.sh or install dir) — run bin/deploy-dashboard.sh"
fi

# ── STAGE 8: boot-to-ready systemd (SM-100) ───────────────────────────────
# Install the AgentBOX user units: agentbox.service (compose orchestrator) +
# hermes-dashboard.service (:9119) + hermes-gateway.service (messaging gateway).
# Enable linger so they start at boot headless.
log "STAGE 8 — boot-to-ready (systemd)"
if [ -d "$REPO/systemd" ]; then
  mkdir -p "$HOME/.config/systemd/user"
  cp "$REPO/systemd/"*.service "$HOME/.config/systemd/user/"
  sudo loginctl enable-linger "$USER" >/dev/null 2>&1 || log "  WARN: enable-linger failed (units won't start until login)"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable --now agentbox.service hermes-dashboard.service hermes-gateway.service 2>/dev/null \
    && log "  agentbox + hermes-dashboard (:9119) + hermes-gateway enabled" \
    || log "  WARN: could not enable user units in this session — run: systemctl --user enable --now agentbox.service hermes-dashboard.service hermes-gateway.service"
else
  log "  WARN: $REPO/systemd not found — boot units not installed"
fi

# ── STAGE 9: verify ───────────────────────────────────────────────────────
log "STAGE 9 — verify"
docker compose ps --format '{{.Name}}\t{{.Status}}'
PSQL -tAc "select 'drafts:'||(to_regclass('mailbox.drafts') is not null)::text;"
# Custom dashboard backend live? /api/google/auth/start is an AgentBOX-only route
# (3xx redirect to Google). Stock backend lacks it -> 401/404 = overlay didn't take.
sleep 3
PYBIN="$HH/hermes-agent/venv/bin/python3"; [ -x "$PYBIN" ] || PYBIN="python3"
GCODE="$("$PYBIN" -c "import http.client as h; c=h.HTTPConnection('127.0.0.1',9119,timeout=10); c.request('GET','/api/google/auth/start'); print(c.getresponse().status)" 2>/dev/null || echo ERR)"
case "$GCODE" in
  301|302|303|307|308|200) log "  custom backend OK — /api/google/auth/start -> $GCODE" ;;
  *) log "  WARN: custom backend NOT live (/api/google/auth/start -> $GCODE). Google connect will 404. Re-run STAGE 7.6 or: bin/deploy-dashboard.sh" ;;
esac
log "AgentBOX install complete. Smokes: inject inbound -> draft appears; 'hermes -z' replies;"
log "re-run the SM-97 spike (spike-hermes-mailbox/12-worstcase-turn.sh) to spot-check the envelope."
