# Build Plan: Gmail Sync Sidecar Service (v1.0)

> **Created:** 2026-04-24
> **Version:** 1.0
> **ADR reference:** adr-008-gmail-sync-sidecar-v1.0.md
> **Spec sections:** §4.7 (FR-30, FR-31), §7.2, §7.3, §14 Phase 1 deliverable 2, NFR-7, NFR-8
> **Total tasks:** 9 across 4 batches
> **Estimated effort:** 8–14 hours
> **Target executor:** Claude Code (GSD mode)

---

## Prerequisites (must be true before Batch 1 starts)

- Postgres `postgres:16-alpine` running in the `mailbox` Compose stack with the `n8n` database accessible (Phase 1 deliverable 6 — already operational)
- n8n running and reachable at `http://n8n:5678` from inside the Compose network (Phase 1 deliverable 6 — already operational)
- Heron Labs Gmail account with API access enabled in Google Cloud Console; OAuth client credentials (client ID + secret) provisioned and stored in a secret file outside git
- Repo access to `https://github.com/ConsultingFuture4200/mailbox`, branch `master`, push permissions for the implementing developer
- Smoke test (`scripts/smoke-test.sh`) currently passes 6/6 — establishes a baseline for "does this change break anything"

---

## Constitution & Project Constraints to Respect

These are pulled directly from the active PRDs and addenda. Every task must comply.

- **DR-7 (deterministic, human-supervised pipeline).** No agentic behavior in the sync service. All branching is explicit. No autonomous self-modification.
- **NFR-5 (3-minute boot).** Sync service must reach `/health` returning 200 within 30s of container start.
- **NFR-7 (data residency).** Gmail message content is written only to local Postgres. The sync service never sends email content to any third-party except Gmail itself.
- **NFR-8 (graceful degradation).** When Gmail is unreachable or OAuth has lapsed, the service exposes that state via `/health` and continues to serve already-ingested data. It does not crash-loop.
- **Volume naming discipline.** Docker Compose prefixes volumes with the project name (`mailbox_*`). Any new named volumes follow this pattern.
- **Never install dev tooling on the appliance.** Build images on host or via CI; pull pre-built images on the Jetson. The `mailbox-gmail-sync` image must be a single `docker build` from the repo, no host-side compilation step.
- **Single COGS-conscious appliance.** Container memory budget: 200MB sustained ceiling. Image size budget: 250MB compressed.

---

## Candidate Task List

| # | Working Title | Spec Requirement(s) | Size | DD/CD/BR |
|---|--------------|---------------------|------|----------|
| 1.1 | Postgres schema + migration for sync service tables | ADR-008 schema | Trivial | L/L/H |
| 1.2 | FastAPI scaffolding + Dockerfile + Compose entry | §7.2 service topology | Small | L/M/H |
| 1.3 | Token storage module (encrypt/decrypt OAuth tokens) | NFR-7, ADR-008 | Small | M/M/H |
| 2.1 | OAuth flow endpoints (`/oauth/start`, `/oauth/callback`) + CLI bootstrap | FR-31, ADR-008 | Medium | M/M/H |
| 2.2 | Gmail History API poller (background task) | §7.3, NFR-2, NFR-8 | Medium | H/M/H |
| 2.3 | Send endpoint (`/send`) with RFC 5322 + threading headers | FR-31, ADR-008 | Medium | M/M/M |
| 3.1 | n8n consumer workflow (webhook → fetch → classify → draft → queue) | §14 Phase 1 deliverable 2 | Medium | M/H/H |
| 3.2 | Approval-to-send wiring (n8n → `POST /send`) | §14 Phase 1 deliverable 2 | Small | L/M/M |
| 4.1 | End-to-end Heron Labs validation harness + smoke-test additions | §14 Phase 1 exit criteria | Medium | M/H/L |

---

## Dependency Graph

```
Batch 1: Foundation (parallel)
  ├── Task 1.1: Schema + migration
  ├── Task 1.2: FastAPI scaffolding + Compose entry
  └── Task 1.3: Token storage module

Batch 2: Core sync service (depends on Batch 1)
  ├── Task 2.1: OAuth endpoints + CLI            (needs 1.1, 1.2, 1.3)
  ├── Task 2.2: History API poller               (needs 1.1, 1.2, 1.3)
  └── Task 2.3: Send endpoint                    (needs 1.1, 1.2, 1.3)

Batch 3: n8n integration (depends on Batch 2)
  ├── Task 3.1: Consumer workflow                (needs 2.2)
  └── Task 3.2: Approval-to-send wiring          (needs 2.3, 3.1)

Batch 4: Validation (depends on Batch 3)
  └── Task 4.1: Heron Labs E2E + smoke-test
```

Batch 2 tasks are independent of each other and can run in parallel agent sessions. Batch 3 tasks share an n8n workflow file and should be done sequentially.

---

## Batch 1: Foundation

### Task 1.1: Postgres Schema + Migration

**Batch:** 1
**Depends on:** none
**Produces:** SQL migration files for `oauth_tokens`, `gmail_messages`, `sync_state` tables
**Complexity:** DD: L | CD: L | BR: H (consumed by every downstream task)

**Context:**

ADR-008 specifies a three-table schema owned by `mailbox-gmail-sync`. n8n reads from `gmail_messages` but does not write to it. The sync service is the only writer to all three tables.

Per the project's established migration pattern (matching `migrations/002_create_skills_table.sql` from the learning loop work), migrations live in `migrations/` at the repo root, are SQL files, are idempotent, and have a paired `_down.sql`.

The `oauth_tokens` table stores encrypted tokens. The encryption key is loaded from `/etc/mailbox/keys/oauth.key` at service startup (created by the bootstrap step in Task 1.3). Even though the column is `BYTEA`, the schema does not enforce encryption — the application layer does.

The `gmail_messages` table mirrors fields from the Gmail API response. The `raw_payload` JSONB column retains the full response for debugging and for fields not extracted into top-level columns (attachments, headers beyond what we parse, etc.).

The `sync_state` table tracks per-account incremental sync cursors. `last_history_id` is the Gmail History API cursor.

**Objective:** Create idempotent UP and DOWN migrations for the three tables, with the indexes specified in ADR-008.

**Requirements:**

1. Migration file `migrations/003_create_gmail_sync_tables.sql` (UP) creates `oauth_tokens`, `gmail_messages`, `sync_state` with columns and constraints exactly as specified in ADR-008's "Postgres Schema" section.
2. Use `CREATE TABLE IF NOT EXISTS` — running twice must not fail.
3. Use `gen_random_uuid()` for UUID defaults (Postgres 16 native).
4. Create indexes:
   - `idx_gmail_messages_thread` on `gmail_messages(gmail_thread_id)`
   - `idx_gmail_messages_unnotified` on `gmail_messages(ingested_at) WHERE notified_at IS NULL` (partial index for the polling-to-notify queue)
   - `idx_oauth_tokens_provider_email` on `oauth_tokens(provider, account_email)` — already implied by the UNIQUE constraint, but make it explicit for query planner hints
5. Migration file `migrations/003_create_gmail_sync_tables_down.sql` drops all three tables and indexes in reverse dependency order.
6. Add a migration runner invocation to the existing migration script (look in `scripts/` — match whatever pattern `002_create_skills_table.sql` uses).

**Acceptance Criteria:**

- [ ] Running `psql -f migrations/003_create_gmail_sync_tables.sql` against a clean Postgres 16 instance succeeds with no errors
- [ ] Running the same migration twice succeeds (idempotent)
- [ ] `\d oauth_tokens`, `\d gmail_messages`, `\d sync_state` all show the columns from the ADR
- [ ] `\di` shows the three indexes
- [ ] Insert with invalid `provider` value (e.g., `'icloud'`) is rejected by the CHECK constraint
- [ ] DOWN migration runs cleanly and leaves no residual indexes or tables

**Files:**
- `migrations/003_create_gmail_sync_tables.sql` (UP)
- `migrations/003_create_gmail_sync_tables_down.sql` (DOWN)

**Anti-Requirements:**
- Do NOT modify the existing `n8n` schema or any tables created by n8n itself
- Do NOT modify the `skills` table or any migration from the learning loop work
- Do NOT add foreign keys to n8n-owned tables (n8n owns its schema; cross-schema FKs become brittle on n8n version upgrades)

---

### Task 1.2: FastAPI Scaffolding + Dockerfile + Compose Entry

**Batch:** 1
**Depends on:** none
**Produces:** A runnable but empty `mailbox-gmail-sync` container that exposes `/health` and is wired into the Compose stack
**Complexity:** DD: L | CD: M | BR: H (foundation for all subsequent endpoints)

**Context:**

The sync service is a Python 3.12 FastAPI application running in a Docker container in the existing `mailbox` Compose stack. It's a sidecar to n8n: same network, same Postgres, separate concerns.

The image budget is 250MB compressed. Use `python:3.12-slim-bookworm` as the base. Use `uv` for dependency management (faster than pip in CI, smaller layer cache). The runtime memory budget is 200MB sustained.

The service must expose `GET /health` returning JSON: `{"status": "ok", "version": "<git_sha>", "last_successful_poll": "<iso8601 or null>", "oauth_status": "ok|expired|missing"}`. For this scaffolding task, return placeholder values — `last_successful_poll: null`, `oauth_status: "missing"`. Real values come in Tasks 2.1 and 2.2.

The Compose entry must:
- Name the service `gmail-sync` (short, consistent with other services like `qdrant`, `ollama`)
- Use the image tag `mailbox-gmail-sync:latest` (built locally from `services/gmail-sync/Dockerfile`)
- Depend on `postgres` with `condition: service_healthy`
- Mount `/etc/mailbox/keys/` read-only for the OAuth encryption key
- Restart policy: `unless-stopped`
- Expose port 8080 internally; do not publish to host (n8n reaches it via Docker network DNS)
- Set environment variables: `DATABASE_URL`, `OAUTH_KEY_PATH=/etc/mailbox/keys/oauth.key`, `LOG_LEVEL=INFO`, `POLL_INTERVAL_SECONDS=30`

The Dockerfile must produce an image where the entrypoint is `uvicorn app.main:app --host 0.0.0.0 --port 8080` and that runs as a non-root user.

**Objective:** Stand up a runnable, healthy, empty `gmail-sync` container in the Compose stack.

**Requirements:**

1. Create directory `services/gmail-sync/` at repo root with structure:
   ```
   services/gmail-sync/
     pyproject.toml
     Dockerfile
     .dockerignore
     app/
       __init__.py
       main.py           # FastAPI app + /health endpoint
       config.py         # Settings via pydantic-settings
       db.py             # asyncpg pool factory
   ```
2. `pyproject.toml` declares dependencies: `fastapi`, `uvicorn[standard]`, `pydantic-settings`, `asyncpg`, `httpx`, `google-auth`, `google-auth-oauthlib`, `google-api-python-client`, `cryptography`. Pin to current stable major versions.
3. `Dockerfile` uses multi-stage build: builder stage installs deps via `uv pip install`, runtime stage copies only `/app` and the venv. Final image runs as user `appuser` (uid 1001).
4. `.dockerignore` excludes `__pycache__`, `.pytest_cache`, `.venv`, `tests/`, `*.md`.
5. `app/main.py` exposes `GET /health` returning the JSON shape above with placeholder values.
6. `app/config.py` defines a `Settings` class (pydantic-settings) reading the env vars listed in Context.
7. `app/db.py` provides an `async def get_pool()` returning a singleton `asyncpg` pool. Health endpoint uses the pool to run `SELECT 1` — if the query fails, `/health` returns status 503 with `{"status": "degraded", ...}`.
8. Update `docker-compose.yml` to add the `gmail-sync` service per the Context spec.
9. Add a build step to `scripts/build-images.sh` (or create the script if it doesn't exist) that builds the image with tag `mailbox-gmail-sync:latest` and the git SHA as a label.

**Acceptance Criteria:**

- [ ] `docker compose build gmail-sync` succeeds
- [ ] Final image size is < 250MB compressed (`docker images mailbox-gmail-sync:latest`)
- [ ] `docker compose up -d gmail-sync` starts the container; container is healthy within 30s
- [ ] `docker exec mailbox-gmail-sync-1 ps aux` shows the process running as `appuser`, not root
- [ ] From inside another Compose container: `curl http://gmail-sync:8080/health` returns 200 with the expected JSON shape
- [ ] When Postgres is stopped, `/health` returns 503 within 5s (no hangs)
- [ ] Memory usage at idle is < 80MB (`docker stats`)
- [ ] `scripts/smoke-test.sh` still passes 6/6 after this change (existing checks unchanged); add a 7th check that asserts `gmail-sync /health` returns 200

**Files:**
- `services/gmail-sync/pyproject.toml`
- `services/gmail-sync/Dockerfile`
- `services/gmail-sync/.dockerignore`
- `services/gmail-sync/app/__init__.py`
- `services/gmail-sync/app/main.py`
- `services/gmail-sync/app/config.py`
- `services/gmail-sync/app/db.py`
- `docker-compose.yml` (modify — add `gmail-sync` service)
- `scripts/build-images.sh` (create or modify)
- `scripts/smoke-test.sh` (modify — add gmail-sync check)

**Anti-Requirements:**
- Do NOT add Gmail API logic in this task — endpoints come in Batch 2
- Do NOT publish port 8080 to the host — internal-only
- Do NOT install build tools in the runtime image (use multi-stage)
- Do NOT use `latest` tags for base images in the Dockerfile — pin to specific digests where practical

---

### Task 1.3: Token Storage Module

**Batch:** 1
**Depends on:** none (Task 1.1's schema is referenced but the module is testable in isolation)
**Produces:** A Python module that encrypts/decrypts OAuth tokens with a key from disk, plus a CLI command to generate the key
**Complexity:** DD: M | CD: M | BR: H (every OAuth flow uses this)

**Context:**

OAuth tokens are stored encrypted in `oauth_tokens.access_token` and `oauth_tokens.refresh_token` (BYTEA columns). The encryption key is a 32-byte symmetric key in `/etc/mailbox/keys/oauth.key`, mode 0400, owned by the appliance.

Per ADR-008 OQ-1, this is an appliance-wide key for v1.0. Key derivation from a customer password is a future hardening pass and out of scope for this build.

Use `cryptography.fernet.Fernet` for symmetric encryption. Fernet handles versioning, IV generation, and authentication; the alternative (raw AES-GCM) is more error-prone and the throughput difference is irrelevant at OAuth-token scale.

The CLI command `python -m app.cli generate-key` creates the key file if it doesn't exist, refuses to overwrite if it does (with an explicit `--force` flag), and prints a one-line success message including the file path. This command runs once during appliance provisioning (host-side, not from inside the container) — it's how the key gets written to the bind-mounted directory before the container starts.

**Objective:** Provide a small, well-tested module for token encryption + a CLI for one-time key generation.

**Requirements:**

1. Create `app/tokens.py` with:
   - `class TokenStore` taking a `pathlib.Path` to the key file in its constructor
   - Method `encrypt(plaintext: str) -> bytes`
   - Method `decrypt(ciphertext: bytes) -> str`
   - Constructor raises `FileNotFoundError` if the key file is missing, `PermissionError` if mode is not 0400 or 0600, `ValueError` if key is not 32 bytes after base64 decode
2. Create `app/cli.py` with a `generate-key` command:
   - Default path: `/etc/mailbox/keys/oauth.key`
   - Refuses to overwrite without `--force`
   - Writes the key with mode 0400
   - Uses `Fernet.generate_key()` (returns 32 bytes base64-encoded; Fernet expects this format)
3. Update `app/db.py` (or create a new helper) so that the existing pool factory exposes a function to load a `TokenStore` instance from `Settings.OAUTH_KEY_PATH`. The TokenStore is a singleton — initialized once at app startup.
4. Add unit tests in `services/gmail-sync/tests/test_tokens.py`:
   - Round-trip: encrypt then decrypt returns the original string
   - Decrypting bad ciphertext raises a clear exception
   - Missing key file raises FileNotFoundError
   - Mode-too-loose key file raises PermissionError
5. Update `pyproject.toml` to declare `pytest` and `pytest-asyncio` as dev dependencies.
6. Add a Make-style entry to `scripts/build-images.sh` or a new `scripts/test-gmail-sync.sh` that runs `pytest services/gmail-sync/tests/`.

**Acceptance Criteria:**

- [ ] `python -m app.cli generate-key --path /tmp/test.key` creates a key file with mode 0400
- [ ] Running it twice without `--force` exits non-zero with an error message
- [ ] Running it twice with `--force` overwrites the key
- [ ] All unit tests in `tests/test_tokens.py` pass
- [ ] `TokenStore` round-trip test: `decrypt(encrypt("hello")) == "hello"` for 100 random strings of varying length
- [ ] Decrypting a tampered ciphertext (flip one bit) raises `cryptography.fernet.InvalidToken`

**Files:**
- `services/gmail-sync/app/tokens.py`
- `services/gmail-sync/app/cli.py`
- `services/gmail-sync/tests/__init__.py`
- `services/gmail-sync/tests/test_tokens.py`
- `services/gmail-sync/pyproject.toml` (modify — add pytest deps)
- `scripts/test-gmail-sync.sh` (create)

**Anti-Requirements:**
- Do NOT log token plaintext or ciphertext at any log level
- Do NOT use a key shorter than what Fernet expects (32 bytes base64-encoded → 44 characters including padding)
- Do NOT roll a custom encryption scheme

---

## Batch 2: Core Sync Service

### Task 2.1: OAuth Flow Endpoints + CLI Bootstrap

**Batch:** 2
**Depends on:** 1.1 (schema), 1.2 (FastAPI app), 1.3 (token store)
**Produces:** OAuth start/callback endpoints + a CLI command for headless bootstrap
**Complexity:** DD: M | CD: M | BR: H (every other endpoint depends on having tokens stored)

**Context:**

Per FR-31, customers connect their Gmail account during onboarding. The flow is:

1. Customer clicks "Connect Gmail" in the dashboard
2. Dashboard hits `POST /oauth/start` on the sync service → returns a Google consent URL
3. Customer is redirected to Google, consents, and is redirected back to a callback URL
4. The callback URL is `POST /oauth/callback` on the sync service, which exchanges the auth code for tokens, encrypts them, and writes to `oauth_tokens`
5. Sync service immediately starts polling that account

For Phase 1 / Heron Labs validation, there is no dashboard onboarding UI yet. So we also need a CLI bootstrap command that runs on the developer's host machine, prints the consent URL, accepts the auth code on stdin, and writes tokens to the appliance's database. This is the path the Heron Labs validation will use.

The OAuth scopes required (minimal):
- `https://www.googleapis.com/auth/gmail.readonly` (read messages, history)
- `https://www.googleapis.com/auth/gmail.send` (send and create drafts)
- `https://www.googleapis.com/auth/gmail.modify` (apply labels)

OAuth client credentials (client_id, client_secret) are loaded from `/etc/mailbox/keys/google_oauth_client.json` (downloaded from Google Cloud Console during appliance provisioning).

**Objective:** Implement the OAuth2 authorization-code flow end-to-end, with both an HTTP path (for dashboard integration) and a CLI path (for headless bootstrap during validation).

**Requirements:**

1. Create `app/oauth.py` with:
   - `def build_flow(redirect_uri: str) -> google_auth_oauthlib.flow.Flow` — constructs the OAuth Flow object with the right scopes and client config
   - `async def store_tokens(account_email: str, credentials, pool, token_store) -> None` — encrypts tokens, upserts into `oauth_tokens` (UNIQUE constraint on `(provider, account_email)` handles re-auth)
   - `async def load_credentials(account_email: str, pool, token_store) -> google.oauth2.credentials.Credentials | None` — loads encrypted tokens, returns refreshed Credentials object (refresh on the fly if needed)
2. Add endpoints in `app/main.py`:
   - `POST /oauth/start` body: `{"account_email": "..."}` → returns `{"consent_url": "..."}`
   - `POST /oauth/callback` body: `{"code": "...", "state": "..."}` → exchanges code, calls `store_tokens`, returns `{"status": "ok", "account_email": "..."}`
3. The `state` parameter must be a signed value containing the `account_email` so the callback can verify it. Use `itsdangerous` for signing (already widely used by FastAPI ecosystem).
4. Update `app/cli.py` to add a `bootstrap-oauth` command:
   - Args: `--account-email`, `--client-secrets-file` (default `/etc/mailbox/keys/google_oauth_client.json`)
   - Runs the OAuth flow with `redirect_uri="urn:ietf:wg:oauth:2.0:oob"` (out-of-band — Google deprecated this for new OAuth clients in 2022, so for the Heron Labs case use a manual loopback redirect with a one-shot HTTP server on `http://localhost:8765/callback`)
   - Connects to the appliance Postgres directly (configured via `DATABASE_URL` env var)
   - Encrypts and stores tokens using the same code path as the HTTP endpoint
5. Update `/health` to query `oauth_tokens` and report `oauth_status`:
   - `"missing"` — no row for any account
   - `"ok"` — at least one row exists and refresh_token is present
   - `"expired"` — row exists but `token_expiry` is in the past AND refresh attempt failed in the last poll cycle (this last condition wired up in Task 2.2)
6. Add tests in `tests/test_oauth.py` mocking the Google client. Cover:
   - `build_flow` returns a Flow with the expected scopes
   - `store_tokens` upserts correctly (run twice with same email → only one row)
   - `load_credentials` returns None for missing account
   - State-signing roundtrip works

**Acceptance Criteria:**

- [ ] `python -m app.cli bootstrap-oauth --account-email ops@heronlabs.com` against the Heron Labs Google project produces a consent URL, captures the redirect, and writes a row to `oauth_tokens`
- [ ] After bootstrap, `curl http://gmail-sync:8080/health` returns `oauth_status: "ok"`
- [ ] Re-running bootstrap with the same email replaces the existing row (no duplicate-key error)
- [ ] `POST /oauth/start` with a valid email returns a URL containing `accounts.google.com/o/oauth2/auth`
- [ ] `POST /oauth/callback` with a tampered `state` returns 400
- [ ] All unit tests in `tests/test_oauth.py` pass
- [ ] No plaintext tokens appear in the database (`SELECT access_token FROM oauth_tokens` returns BYTEA, not readable text)

**Files:**
- `services/gmail-sync/app/oauth.py`
- `services/gmail-sync/app/main.py` (modify — add endpoints)
- `services/gmail-sync/app/cli.py` (modify — add bootstrap command)
- `services/gmail-sync/tests/test_oauth.py`
- `services/gmail-sync/pyproject.toml` (modify — add `itsdangerous`)

**Anti-Requirements:**
- Do NOT request OAuth scopes beyond the three listed (principle of least privilege; scope creep makes Google's OAuth review harder)
- Do NOT log the auth code, access token, or refresh token at any log level
- Do NOT add a session/cookie layer to the sync service — it has no UI and no logged-in users; the dashboard will handle that
- Do NOT use the deprecated OOB redirect for new dashboard flows — only the headless CLI bootstrap, and only as a temporary measure for Heron Labs validation

---

### Task 2.2: Gmail History API Poller

**Batch:** 2
**Depends on:** 1.1, 1.2, 1.3 (and reuses oauth from 2.1 once running, but doesn't import from it)
**Produces:** A background task that polls Gmail every 30s, writes new messages to Postgres, fires webhooks to n8n
**Complexity:** DD: H | CD: M | BR: H (this is the heart of the service)

**Context:**

The Gmail History API supports incremental sync: given a `historyId`, return all changes since that ID. This is dramatically more efficient than full-list polling and avoids quota issues at scale.

Polling strategy:
- On startup: for each account in `oauth_tokens`, load `sync_state.last_history_id`. If no row exists, do a one-time `users.messages.list` to seed the cursor with the most recent message's history ID, then write `sync_state` row.
- Every `POLL_INTERVAL_SECONDS` (default 30): for each account, call `users.history.list(startHistoryId=last_history_id)`. For each new `messageAdded` entry, fetch the full message via `users.messages.get(format="full")`, parse, and INSERT into `gmail_messages`. Update `sync_state.last_history_id` to the maximum history ID seen.
- After each successful insert, POST to `http://n8n:5678/webhook/gmail-new-message` with `{"message_id": "<our_uuid>", "gmail_message_id": "...", "account_email": "..."}`. On 200, update `gmail_messages.notified_at`.
- On webhook failure: leave `notified_at` NULL; the next poll cycle's "unnotified" sweep retries.

Error handling per NFR-8:
- Token refresh failure → mark `oauth_status` as `"expired"` in `/health`, increment `consecutive_failures`, do not crash
- Gmail API 429 (quota) → exponential backoff with jitter, max wait 5 min
- Gmail API 5xx → retry once, then skip this poll cycle
- Network unreachable → `consecutive_failures++`, skip cycle, log at WARN

The poller runs as an asyncio task started in FastAPI's `lifespan` context manager. On shutdown, it cancels gracefully.

Per DR-7, the poller is fully deterministic. No "smart" polling intervals based on inferred user behavior. Fixed cadence, fixed retry, fixed backoff.

**Objective:** Implement the Gmail History API poller as a background asyncio task that maintains `gmail_messages` and `sync_state`, and notifies n8n.

**Requirements:**

1. Create `app/poller.py` with:
   - `class GmailPoller` taking `(pool, token_store, settings)` in constructor
   - `async def start() -> None` — starts the background loop
   - `async def stop() -> None` — cancels the task gracefully
   - `async def poll_once(account_email) -> PollResult` — single poll cycle for one account, exposed for testing and the `/sync/now` endpoint
2. Create `app/gmail_client.py` with thin wrappers around `googleapiclient.discovery.build("gmail", "v1", credentials=...)`:
   - `async def list_history(creds, start_history_id) -> dict`
   - `async def get_message(creds, message_id) -> dict`
   - `async def get_profile(creds) -> dict` (for seeding)
   - All wrappers run the synchronous Google client calls in a thread pool via `asyncio.to_thread()`
3. Create `app/parser.py` with `def parse_gmail_message(payload: dict) -> ParsedMessage` (pydantic model). Extracts `from`, `to`, `cc`, `subject`, `body_text`, `body_html`, `internal_date`, `labels`, `thread_id`. Handles MIME multipart correctly.
4. Add endpoint `POST /sync/now` body: `{"account_email": "..."}` → triggers a single poll cycle for that account, returns the result. Useful for the smoke test and dashboard.
5. Wire the poller into `app/main.py` lifespan:
   ```python
   @asynccontextmanager
   async def lifespan(app):
       app.state.poller = GmailPoller(pool, token_store, settings)
       await app.state.poller.start()
       yield
       await app.state.poller.stop()
   ```
6. Update `/health` to read poller's `last_successful_poll_at` from `sync_state` and include it in the response.
7. Add tests in `tests/test_poller.py` and `tests/test_parser.py`:
   - Parser handles a sample multipart Gmail message correctly (use a fixture in `tests/fixtures/gmail_message_sample.json`)
   - Poller skips already-ingested messages (idempotency on `gmail_message_id` UNIQUE constraint)
   - Poller updates `sync_state.last_history_id` to the max history ID across the batch
   - Mock Gmail client tests for 429, 5xx, network error paths
   - Webhook failure → `notified_at` stays NULL

**Acceptance Criteria:**

- [ ] After OAuth bootstrap (Task 2.1) for the Heron Labs inbox, the poller starts and within 60s seeds `sync_state.last_history_id`
- [ ] Sending a fresh email to the Heron Labs inbox results in a row in `gmail_messages` within 60s (one poll cycle + processing)
- [ ] The same fresh email triggers a `POST` to `http://n8n:5678/webhook/gmail-new-message` (verify by adding a test webhook endpoint or inspecting n8n logs)
- [ ] After webhook fires, `gmail_messages.notified_at` is set
- [ ] Stopping n8n → next email is ingested but `notified_at` stays NULL; restarting n8n → next poll cycle re-fires the webhook for unnotified messages
- [ ] Killing the gmail-sync container mid-poll → on restart, no duplicate `gmail_messages` rows (UNIQUE constraint enforces this)
- [ ] All unit tests in `tests/test_poller.py` and `tests/test_parser.py` pass
- [ ] Memory usage during sustained polling stays under 200MB (`docker stats` over 1 hour)

**Files:**
- `services/gmail-sync/app/poller.py`
- `services/gmail-sync/app/gmail_client.py`
- `services/gmail-sync/app/parser.py`
- `services/gmail-sync/app/main.py` (modify — lifespan + `/sync/now`)
- `services/gmail-sync/tests/test_poller.py`
- `services/gmail-sync/tests/test_parser.py`
- `services/gmail-sync/tests/fixtures/gmail_message_sample.json`

**Anti-Requirements:**
- Do NOT add adaptive polling intervals (DR-7: deterministic over agentic)
- Do NOT use Gmail Pub/Sub push notifications (requires public endpoint, incompatible with on-prem appliance)
- Do NOT silently retry indefinitely on errors — log every failure, expose state via `/health`
- Do NOT block the FastAPI event loop with synchronous Google client calls — always use `asyncio.to_thread`

---

### Task 2.3: Send Endpoint

**Batch:** 2
**Depends on:** 1.1, 1.2, 1.3 (uses oauth from 2.1)
**Produces:** `POST /send` endpoint that assembles a proper RFC 5322 message and sends via Gmail API
**Complexity:** DD: M | CD: M | BR: M (the only outbound write to Gmail)

**Context:**

When a draft is approved (FR-16), n8n posts to `POST /send` on the sync service with `{"account_email", "to", "cc", "subject", "body_text", "body_html", "thread_id", "in_reply_to"}`. The sync service:

1. Loads OAuth credentials for the account
2. Assembles an RFC 5322 message with proper `References` and `In-Reply-To` headers (so Gmail threads the reply correctly)
3. Calls `users.messages.send` with `threadId=<thread_id>`
4. Returns `{"gmail_message_id": "...", "thread_id": "..."}`

Threading rules (specific because Gmail is finicky):
- If `in_reply_to` is provided, set both `In-Reply-To: <message-id>` and `References: <message-id>` headers
- If the original message had a `References` chain, append the in-reply-to to it (cap at 10 message IDs to avoid header bloat)
- Always include the matching `threadId` in the API call

For Phase 1, support text-only and simple text+html (no attachments). Attachments come in Phase 1.5.

**Objective:** Implement `POST /send` end-to-end, with correct threading.

**Requirements:**

1. Create `app/sender.py` with:
   - `def build_mime_message(req: SendRequest, original_message: dict | None) -> email.message.EmailMessage` — assembles MIME with correct headers
   - `async def send_message(creds, mime_msg, thread_id) -> dict` — base64url-encodes the raw bytes, calls Gmail API
2. Add endpoint `POST /send` in `app/main.py`. Request body (pydantic model `SendRequest`):
   ```python
   class SendRequest(BaseModel):
       account_email: EmailStr
       to: list[EmailStr]
       cc: list[EmailStr] = []
       subject: str
       body_text: str
       body_html: str | None = None
       thread_id: str | None = None
       in_reply_to: str | None = None  # Gmail message ID we're replying to
   ```
3. If `in_reply_to` is set, fetch the original message from `gmail_messages` to get its `Message-ID` header and existing `References` chain (look in `raw_payload.headers`).
4. Validate: at least one recipient, subject not empty, body_text not empty.
5. Return `{"gmail_message_id": "...", "thread_id": "...", "sent_at": "<iso8601>"}`.
6. On Gmail API error: return 502 with the Gmail error message; do not retry (n8n owns retry policy at the workflow level).
7. Tests in `tests/test_sender.py`:
   - MIME message has correct `In-Reply-To` and `References` when replying
   - `References` chain is capped at 10
   - text+html message is multipart/alternative
   - text-only message is plain text/plain (no multipart)
   - Validation rejects empty `to`, empty subject, empty body

**Acceptance Criteria:**

- [ ] After OAuth bootstrap, `curl -X POST http://gmail-sync:8080/send -d '{"account_email":"ops@heronlabs.com","to":["dustin@umb.test"],"subject":"test","body_text":"hello"}'` results in a real email landing in dustin@umb.test
- [ ] Sending a reply with `in_reply_to` set produces a properly-threaded message in Gmail (verify visually in Gmail UI)
- [ ] Response includes `gmail_message_id` returned by the API
- [ ] Validation errors (missing `to`, empty subject) return 422 with clear error messages
- [ ] All unit tests in `tests/test_sender.py` pass

**Files:**
- `services/gmail-sync/app/sender.py`
- `services/gmail-sync/app/main.py` (modify — add `/send`)
- `services/gmail-sync/tests/test_sender.py`

**Anti-Requirements:**
- Do NOT support attachments in this task (Phase 1.5 scope)
- Do NOT implement retry logic — n8n owns workflow-level retry
- Do NOT log message body content at INFO level (PII; use DEBUG only and ensure DEBUG is off in production)
- Do NOT expose `/send` to the host network — internal Compose network only

---

## Batch 3: n8n Integration

### Task 3.1: n8n Consumer Workflow

**Batch:** 3
**Depends on:** 2.2 (poller is firing webhooks)
**Produces:** An n8n workflow JSON that reacts to the gmail-sync webhook, fetches the message, classifies, drafts, and writes to the approval queue
**Complexity:** DD: M | CD: H | BR: H (this is the Phase 1 deliverable 2 workflow)

**Context:**

This workflow replaces what would have been the n8n Gmail-node-based pipeline. It is provider-agnostic by design: the only Gmail-specific touchpoint is the webhook URL and the table name (`gmail_messages`). Future Outlook/IMAP support adds parallel workflows or a unified table view, without modifying this workflow's classify/draft/queue logic.

Per DR-1 and §13's maintainability risk, target < 20 nodes.

Workflow shape:
```
Webhook trigger (POST /webhook/gmail-new-message)
  → Postgres: SELECT message from gmail_messages by id
  → Code Node: classify (call Ollama /api/chat, qwen3:4b, with classification prompt)
  → IF: classification in {spam, marketing} → Postgres: UPDATE labels → end
  → IF: classification == escalate → Postgres: INSERT into approval_queue with status='escalated' → end
  → Code Node: assemble draft prompt (system prompt + persona + RAG retrieval + email body)
  → HTTP: Ollama /api/chat for draft generation
  → Postgres: INSERT into approval_queue (draft, original_message_id, classification, confidence)
  → Postgres: UPDATE gmail_messages.notified_at = now() (idempotency marker)
```

For Phase 1 this uses the v1.0 binary routing (cloud vs local) per the §7.4 routing table. Speculative decoding (DR-6) is Phase 2.

The classification and draft generation prompts are not invented in this task — they should use the existing prompts from the prior n8n workflow if they exist, or be created with placeholder prompts marked `# TODO: replace with prod prompt before Heron validation`. (If no prior prompts exist, this task explicitly notes that prompt engineering is a follow-up — don't block on it.)

The approval_queue table schema is assumed to exist from Phase 1 deliverable 6. If it does not, this task creates a minimal one matching the §7.7.1 learning loop's expectations (columns: `id`, `gmail_message_id`, `original_email_text`, `generated_draft`, `classification`, `confidence`, `status`, `created_at`, `customer_action`).

**Objective:** Build the n8n workflow that reacts to gmail-sync webhooks and produces approval queue entries.

**Requirements:**

1. Create `workflows/gmail-inbound-pipeline.json` — exportable n8n workflow.
2. Webhook node path: `/webhook/gmail-new-message`. Method: POST. Authentication: header-based shared secret (env var `GMAIL_WEBHOOK_SECRET` on both sides).
3. Postgres node: `SELECT * FROM gmail_messages WHERE id = $1` using the message_id from the webhook payload.
4. Classification Code Node: assemble prompt from email subject + body_text, POST to `http://ollama:11434/api/chat`, parse classification + confidence.
5. Routing IF nodes per the §7.4 table. For Phase 1, route everything that's not `escalate`/`spam`/`marketing` to local model drafting (cloud routing comes in Phase 2).
6. Draft generation Code Node + HTTP Request to Ollama. Token budget enforcement: max 800 tokens output.
7. Postgres INSERT into `approval_queue` with the draft.
8. Postgres UPDATE `gmail_messages.notified_at = now()` at the very end (only after successful queue insert).
9. Error handling: any node failure → log to n8n's execution log + write a row to a `pipeline_errors` table for the dashboard to surface. Do not retry the workflow automatically.
10. Workflow JSON must be importable via n8n's REST API (`POST /api/v1/workflows`).
11. If the `approval_queue` table does not exist yet, create migration `migrations/004_create_approval_queue_if_missing.sql` with the schema described in Context.

**Acceptance Criteria:**

- [ ] Workflow imports into n8n without errors
- [ ] Sending a fresh email to the Heron Labs inbox → within 60s, a row appears in `approval_queue` with a non-empty draft
- [ ] Classification routing works: a "thanks for your reply" email (likely spam/marketing in tone) gets archived, not drafted
- [ ] Workflow has < 20 nodes
- [ ] Workflow is exportable as JSON < 100KB
- [ ] Tampered webhook (wrong secret) → 401 from the webhook node
- [ ] Killing Ollama mid-workflow → row appears in `pipeline_errors`, no crash

**Files:**
- `workflows/gmail-inbound-pipeline.json`
- `migrations/004_create_approval_queue_if_missing.sql` (only if approval_queue does not already exist)
- `docs/gmail-inbound-pipeline.md` — node-by-node documentation

**Anti-Requirements:**
- Do NOT use n8n's built-in Gmail node (the whole point of this work)
- Do NOT use n8n's AI Agent node — explicit HTTP requests to Ollama only (debuggability)
- Do NOT block on prompt engineering quality — this is a wiring task; prompt tuning is a separate effort
- Do NOT modify the `gmail_messages` schema (it's owned by gmail-sync)

---

### Task 3.2: Approval-to-Send Wiring

**Batch:** 3
**Depends on:** 2.3 (`/send` endpoint), 3.1 (workflow scaffolding)
**Produces:** A second n8n workflow (or sub-workflow) that reacts to "approve" actions in the approval queue and POSTs to gmail-sync `/send`
**Complexity:** DD: L | CD: M | BR: M

**Context:**

When the customer approves a draft in the dashboard, the dashboard updates `approval_queue.customer_action = 'approve'`. This workflow polls (or is triggered by) those updates and sends the email via the sync service.

Polling vs trigger: prefer a Postgres-triggered approach using n8n's database trigger node if available; fall back to 30s polling if not. Document both options.

Workflow shape:
```
Trigger: approval_queue rows where customer_action='approve' AND sent_at IS NULL
  → Postgres: SELECT message details (joined with gmail_messages for thread_id, in_reply_to)
  → HTTP: POST to http://gmail-sync:8080/send
  → IF: response 200 → Postgres: UPDATE approval_queue SET sent_at=now(), gmail_sent_message_id=...
  → IF: response error → Postgres: UPDATE approval_queue SET customer_action='send_failed', error_msg=...
```

**Objective:** Wire approved drafts through to gmail-sync `/send`.

**Requirements:**

1. Create `workflows/approval-to-send.json`.
2. Trigger every 30s via Schedule node (Phase 1; upgrade to Postgres trigger in a future task).
3. Query: `SELECT a.*, m.gmail_thread_id, m.gmail_message_id FROM approval_queue a JOIN gmail_messages m ON a.gmail_message_id = m.id WHERE a.customer_action = 'approve' AND a.sent_at IS NULL ORDER BY a.created_at LIMIT 10`.
4. For each row: HTTP POST to `http://gmail-sync:8080/send` with the assembled payload.
5. On success: `UPDATE approval_queue SET sent_at = now(), gmail_sent_message_id = $1 WHERE id = $2`.
6. On failure (non-2xx): `UPDATE approval_queue SET customer_action = 'send_failed', error_msg = $1 WHERE id = $2`. Do not retry automatically.
7. Workflow JSON < 50KB, < 10 nodes.

**Acceptance Criteria:**

- [ ] Manually setting `customer_action = 'approve'` on an `approval_queue` row → within 60s, an email is sent and the row's `sent_at` is populated
- [ ] Stopping gmail-sync → next approval gets `customer_action = 'send_failed'` with a clear error_msg
- [ ] Threaded reply lands in the original Gmail thread (visual check in Gmail)
- [ ] Workflow does not double-send (idempotency on `sent_at IS NULL` filter)

**Files:**
- `workflows/approval-to-send.json`
- `docs/approval-to-send.md`

**Anti-Requirements:**
- Do NOT add automatic retry — failures need human attention via the dashboard
- Do NOT hardcode the gmail-sync URL — use n8n credential or env var

---

## Batch 4: Validation

### Task 4.1: Heron Labs E2E Validation Harness + Smoke Test

**Batch:** 4
**Depends on:** all of Batch 3
**Produces:** An automated end-to-end test against the Heron Labs inbox + smoke-test additions
**Complexity:** DD: M | CD: H | BR: L

**Context:**

This task closes the loop on Phase 1 deliverable 2. The success criterion is: a fresh email sent to the Heron Labs inbox flows through ingestion → classification → drafting → approval queue → (after manual approval) → reply lands in the original sender's inbox, fully threaded.

The harness uses a separate test Gmail account (`umb-tester@gmail.com` or equivalent) to send the test email and to verify the reply lands. It can run from a developer machine or CI; for Phase 1 it runs on demand from the developer's laptop.

The harness is written in Python (matches the gmail-sync stack) and lives under `tests/e2e/`.

**Objective:** Build an automated E2E test and extend the smoke test to cover the full sync→classify→draft→approve→send loop.

**Requirements:**

1. Create `tests/e2e/test_full_loop.py` with:
   - Setup: send a test email from `umb-tester@gmail.com` to `ops@heronlabs.com` with a unique subject (UUID-based)
   - Wait up to 90s for a row in `gmail_messages` matching the subject
   - Wait up to 90s for a row in `approval_queue` referencing that message
   - Programmatically set `customer_action = 'approve'` on the row (simulating dashboard approval)
   - Wait up to 90s for `sent_at` to be populated
   - Verify the reply landed in `umb-tester@gmail.com`'s inbox (via IMAP fetch on that account; same Gmail API or simple imaplib)
   - Verify the reply has the correct `In-Reply-To` header pointing to the original test email
2. Add a smoke-test script `scripts/smoke-test-e2e.sh` that runs `tests/e2e/test_full_loop.py` and reports pass/fail.
3. Update the existing `scripts/smoke-test.sh` (which currently passes 6/6) to add new gmail-sync-specific checks:
   - gmail-sync container is running
   - `/health` returns 200 with `oauth_status: "ok"` and a recent `last_successful_poll_at` (< 2 min old)
   - `gmail_messages` has at least one row (sanity check that polling has worked at least once)
4. Document the harness in `docs/e2e-validation.md`: how to run it, prerequisites, expected runtime (~5 min), and how to interpret failures.

**Acceptance Criteria:**

- [ ] `pytest tests/e2e/test_full_loop.py` passes when run against a fully-provisioned dev appliance
- [ ] Total test runtime < 7 minutes
- [ ] Test cleans up after itself (deletes the test email from both inboxes, deletes the `approval_queue` row)
- [ ] `scripts/smoke-test.sh` passes with the new checks (8/8 or 9/9 depending on additions)
- [ ] Documentation lets a fresh developer reproduce the test from scratch

**Files:**
- `tests/e2e/__init__.py`
- `tests/e2e/test_full_loop.py`
- `tests/e2e/conftest.py` (fixtures: IMAP connections, test account credentials from env)
- `scripts/smoke-test-e2e.sh`
- `scripts/smoke-test.sh` (modify — add new checks)
- `docs/e2e-validation.md`

**Anti-Requirements:**
- Do NOT use real customer email accounts in the test — only Heron Labs and the dedicated `umb-tester@gmail.com`
- Do NOT skip cleanup on failure — leftover test rows pollute future runs
- Do NOT make the test depend on specific draft content (drafts are model-generated and will vary) — assert structural properties (non-empty, headers correct) only

---

## Risk Register

| Risk | Probability | Impact | Mitigation | Affected Tasks |
|------|-------------|--------|------------|----------------|
| Google OAuth verification process delays Heron Labs validation | Medium | High — blocks Phase 1 deliverable 2 | Use Google's "Testing" mode (max 100 test users) for Phase 1; production verification is a Phase 2 work item. The Heron Labs account is added as a test user. | 2.1 |
| Gmail API quota limits exceeded during polling | Low | Medium | Default quota (1B units/day) is far above any realistic polling load. Mitigation: log quota cost per call; alert if daily usage > 10% of quota. | 2.2 |
| Token refresh edge cases (Google revokes refresh token after 6 months of inactivity) | Low | Medium | NFR-8: `/health` exposes oauth_status; dashboard surfaces re-auth prompt. Out of scope for v1.0 — log and surface, don't auto-fix. | 2.1, 2.2 |
| n8n workflow becomes hard to debug despite the simplification | Medium | Low — scope is bounded by < 20 nodes | Document each node in `docs/gmail-inbound-pipeline.md`. Export the workflow JSON to git on every change for diffability. | 3.1 |
| Threading headers wrong → replies land in fresh threads instead of the original | Medium | Medium — embarrassing customer-visible failure | Task 2.3 has explicit threading test cases; Task 4.1 verifies `In-Reply-To` programmatically. | 2.3, 4.1 |
| Container memory creeps above 200MB under sustained polling | Low | Low | `docker stats` baseline in Task 1.2 acceptance criteria; revisit if observed in Heron Labs validation. | 1.2, 2.2 |

---

## Spec Sections Implemented

- **§4.7 FR-31** — Gmail OAuth handled by sync service: Tasks 2.1, 1.3
- **§7.2** — `gmail-sync` added to service topology: Task 1.2
- **§7.3** — Ingest pipeline replaced by sync service → Postgres → n8n webhook: Tasks 2.2, 3.1
- **§14 Phase 1 Deliverable 2** — IMAP→classify→draft→queue pipeline: Tasks 3.1, 3.2 (and validated by 4.1)
- **NFR-7** — Email content stored only on the local appliance: Task 1.1 (schema constraint)
- **NFR-8** — Graceful degradation when Gmail unreachable: Task 2.2 (poller error handling), Task 1.2 (`/health` semantics)

---

## Submission Notes for Claude Code

- Branch: create `feature/gmail-sync-sidecar` from `master`
- One PR per batch, in order. Each PR's description references this build plan and the ADR.
- After each batch, post a status update with: tasks completed, acceptance criteria met (with evidence), any deviations from the plan, and any newly-discovered `NEEDS_CLARIFICATION` items.
- All migrations get a UP and DOWN; do not deploy a migration without its rollback.
- Do not start Batch 4 until Batches 2 and 3 are merged and the smoke test passes on the dev Jetson at `192.168.1.45`.

---

## Open Questions for Dustin (resolve before Batch 2)

- **OQ-1:** Confirm OAuth client credentials file location on the dev Jetson — `/etc/mailbox/keys/google_oauth_client.json` or somewhere else?
- **OQ-2:** Is there an existing prompt for classification/drafting from the prior n8n workflow that Task 3.1 should reuse? If yes, paste it. If no, Task 3.1 ships with placeholder prompts and prompt engineering is a separate ticket.
- **OQ-3:** Does the `approval_queue` table already exist (Phase 1 deliverable 6), or does Task 3.1 need to create it via migration `004_*`?
