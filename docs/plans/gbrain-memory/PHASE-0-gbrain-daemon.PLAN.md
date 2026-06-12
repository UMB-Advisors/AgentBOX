# PHASE 0 — gBrain Postgres Daemon on agentbox2

**Parent:** `docs/hermes-gbrain-memory-integration-prd.v0.1.0.md`
**Goal:** One concurrency-safe gBrain brain, served as a daemon, that every surface (hermes provider, cron, dashboard) can share. Removes the PGLite single-writer constraint and per-call `bun` cold starts.
**Target host:** agentbox2 (`UMB@100.127.2.54`), 8 GB Jetson Orin.

## Locked decisions (from PRD §6)

- **D1 Cutover:** Fresh Postgres brain populated via `gbrain export` → `import`. After import validates, flip gBrain's *default config* to the postgres engine so CLI **and** daemon read the same brain. PGLite data dir is frozen in place as a read-only rollback (retain ≥2 weeks).
- **D3 Scoping:** Single workspace; **tags** are the entity boundary (`entity:yes`, `entity:heron`, …). Three auth clients: `hermes-interactive` (read,write), `hermes-cron` (read), `dashboard` (read).

## Tasks

1. **Preflight & backup**
   - Record brain stats (page/embedding counts) via `gbrain status`/`report`.
   - `gbrain export` to a dated archive + tar the PGLite data dir. Copy archive off the brain path.
   - Verify free disk and RAM headroom (box is RAM-tight; do nothing else heavy during this phase).
2. **Postgres target**
   - Prefer the existing on-box Postgres (`mailbox-postgres-1` container) — create role + database `gbrain`.
   - **Gate:** agentbox2's brain embeds via ollama `nomic-embed-text` at **768-dim** (per box recon — config `~/.hermesbox/.gbrain/config.json`); confirm the postgres image has (or can add) `pgvector` and size columns `vector(768)`. If not available → **Contingency C1**: run the official `pgvector/pgvector` image as a small dedicated container on a loopback port.
3. **Configure + import**
   - Point gBrain config at the postgres engine (`engine: postgres`, conn string via env, never hardcoded).
   - `gbrain apply-migrations` (or `init`) then `import` the Phase-0 export. Validate counts match preflight.
4. **Daemon**
   - systemd **user** unit `gbrain-serve.service`: `gbrain serve` (HTTP mode), loopback-bound port (e.g. `127.0.0.1:9131`), `Restart=on-failure`, env file for conn string + auth.
   - `gbrain auth register-client` for the three clients in D3; store tokens in `~/.hermes/.env` (`GBRAIN_SERVE_URL`, `GBRAIN_API_TOKEN` for interactive; cron/dashboard tokens under their own names).
5. **Verify (exit criteria)**
   - Concurrent ops: a `recall` and a `capture` issued simultaneously both succeed (no single-writer error).
   - Counts in postgres brain == preflight counts.
   - Dashboard Home digest still renders (CLI path now reads postgres via the flipped default config).
   - Existing blog-job custom tools still `capture` successfully.
   - Unit survives `systemctl --user restart` and box reboot ordering (After=network, before hermes-gateway not required).

## Rollback

Flip gBrain config back to the PGLite engine (frozen dir untouched), stop `gbrain-serve.service`. No hermes config references the daemon until Phase 1 deploy, so rollback is config-only.

## Out of scope

Any hermes-side change (Phase 1), entity tag backfill (Phase 5), cron scheduler change (Phase 3).
