# Plan 004: Add pytest coverage for the AgentBOX-custom Hermes backend

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ad6b760..HEAD -- hermes-agent-main/hermes-agent-main/hermes_cli/google_accounts.py hermes-agent-main/hermes-agent-main/hermes_cli/shopify_accounts.py hermes-agent-main/hermes-agent-main/hermes_cli/dashboard_auth/public_paths.py`
> On any mismatch with the excerpts below, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (tests must target the vendored fork, not upstream)
- **Depends on**: none (CI wiring for pytest is a follow-up — see Maintenance)
- **Category**: tests
- **Planned at**: commit `ad6b760`, 2026-06-11

## Why this matters

Seven Python files form the AgentBOX-custom dashboard backend (Google OAuth,
Shopify OAuth, the auth-gate public-paths allowlist). They hold customer OAuth
tokens and Shopify Admin keys, they're overwritten on every deploy, and this
exact file set **already broke production once** — per the comment in
`bin/lib/custom-backend-files.sh`: "a hand-maintained list silently dropped
dashboard_auth/public_paths.py … so the route 401'd even though web_server.py
defined it." Today these files have zero tests. This plan adds focused unit
tests for the pure/IO-light logic so regressions in token storage, email/shop
validation, and the public-paths allowlist are caught before a deploy.

## Current state

- The custom file set (derived from git in `bin/lib/custom-backend-files.sh`;
  diff base `9a8c7c0`): `config.py`, `dashboard_auth/public_paths.py`,
  `google_accounts.py`, `google_brief.py`, `google_people.py`,
  `shopify_accounts.py`, `web_server.py` — all under
  `hermes-agent-main/hermes-agent-main/hermes_cli/`.
- `google_accounts.py` function surface (line numbers at planned-at SHA):
  `client_secret_path` (78), `accounts_dir` (82), `load_client_config` (97),
  `build_auth_url` (119), `exchange_code` (142), `userinfo_email` (165 — has
  an email-format regex), `_token_record` (184), `_write_json_600` (212),
  `_account_file` (220 — validates email before building the path),
  `save_account` (226), `list_accounts` (250), `delete_account` (309),
  `all_credentials` (335).
- `shopify_accounts.py` surface: `valid_shop` (71), `normalize_shop` (76),
  `accounts_path` (93), `load_app_config` (100), `build_auth_url` (124),
  `exchange_code` (145), `_store_record` (175), `_write_json_600` (185).
- Test conventions in the vendored fork:
  - Tests live at `hermes-agent-main/hermes-agent-main/tests/hermes_cli/`
    (e.g., `test_atomic_json_write.py`), with `conftest.py` and
    `conftest_dashboard_auth.py` present in that directory.
  - Runner: pytest 9.x, configured in `pyproject.toml` (`[tool.pytest.ini_options]`,
    pytest-timeout 30s per test). Dev deps installed via `uv`.
- Token files are written `chmod 600` via `_write_json_600`; accounts are
  stored per-email under a home-relative dir resolved through `_home()` (74).

## Commands you will need

(Working directory: `hermes-agent-main/hermes-agent-main`.)

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install dev env | `uv sync --extra dev` (or `uv pip install -e ".[dev]"` — match what the repo's docs/CI use; check `pyproject.toml`) | exit 0 |
| Run new tests | `uv run pytest tests/hermes_cli/test_agentbox_google_accounts.py tests/hermes_cli/test_agentbox_shopify_accounts.py tests/hermes_cli/test_agentbox_public_paths.py -q` | all pass |
| Sanity (no collateral) | `uv run pytest tests/hermes_cli -q -k agentbox` | all pass |

## Scope

**In scope** (create only — modify nothing existing):
- `hermes-agent-main/hermes-agent-main/tests/hermes_cli/test_agentbox_google_accounts.py`
- `hermes-agent-main/hermes-agent-main/tests/hermes_cli/test_agentbox_shopify_accounts.py`
- `hermes-agent-main/hermes-agent-main/tests/hermes_cli/test_agentbox_public_paths.py`

**Out of scope**:
- All `hermes_cli/*.py` source — tests characterize current behavior; if a
  test exposes a bug, STOP and report.
- `web_server.py`, `google_brief.py`, `google_people.py` endpoint tests —
  these need a FastAPI test-client harness; deferred (Maintenance notes).
- Stock upstream tests; the upstream pin (`HERMES_REF=927fa7a98` constraint).

## Git workflow

- Branch: `test/agentbox-backend-pytests`
- One commit: `test(hermes_cli): cover AgentBOX custom backend (oauth storage, shop validation, public paths)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Read the three modules end to end

Read `google_accounts.py`, `shopify_accounts.py`,
`dashboard_auth/public_paths.py` fully. Identify how `_home()` resolves the
base directory (so tests can redirect it to `tmp_path` via monkeypatch — either
patch `_home` itself or the env var it reads). Note exactly what
`_token_record` keeps/drops from a token response.

**Verify**: `uv run python -c "from hermes_cli import google_accounts, shopify_accounts; from hermes_cli.dashboard_auth import public_paths; print('imports ok')"` → `imports ok`.

### Step 2: google_accounts tests (~8 cases)

In `test_agentbox_google_accounts.py`, with `_home` monkeypatched to
`tmp_path`:
1. `save_account` → `list_accounts` round-trip: record persisted, token file
   mode is `0o600` (`stat.S_IMODE(path.stat().st_mode) == 0o600`).
2. `_account_file` rejects invalid emails (path-traversal shapes like
   `../../etc/passwd`, empty string) — assert it raises / refuses per current
   behavior (characterize whatever it does; the assertion must encode that
   traversal cannot escape `accounts_dir()`).
3. `_token_record` preserves refresh/access tokens and email; no unexpected
   key passthrough of attacker-controlled extras (characterize current shape).
4. `build_auth_url` embeds the provided `state` and `redirect_uri` (parse with
   `urllib.parse`; assert exact query params).
5. `delete_account` removes the file and returns False for unknown email.
6. `userinfo_email` regex: valid email accepted, garbage rejected (mock the
   HTTP call — do NOT hit the network; patch the transport the function uses).
7. `client_configured` False on empty tmp home; True after writing a minimal
   client-secret file at `client_secret_path()`.
8. `_sync_legacy_mirror` (295) behavior with one account (characterize).

### Step 3: shopify_accounts tests (~5 cases)

1. `valid_shop` / `normalize_shop`: accepts `foo.myshopify.com`, normalizes
   bare `foo`, rejects shapes with slashes/spaces/uppercase-per-current-rules
   (read the implementation; encode the actual rules as assertions).
2. `_store_record` shape; `_write_json_600` file mode 0o600.
3. `build_auth_url` embeds shop, state, redirect_uri.
4. `load_app_config` missing-config behavior.
5. `accounts_path` lives under the monkeypatched home.

### Step 4: public_paths tests (~4 cases)

Read `dashboard_auth/public_paths.py` and characterize the allowlist:
1. The Google OAuth callback paths (`/api/google/auth/...`) ARE public.
2. A sensitive route (e.g., `/api/env/reveal`) is NOT public.
3. Prefix-confusion probes: a path like `/api/google/auth-evil` or
   `/assets-admin/x` must not match if the implementation is exact/segment
   based; if it DOES match, that's a real finding — STOP and report.
4. Root `/` and an arbitrary `/api/...` route are not public.

**Verify (steps 2–4)**: `uv run pytest tests/hermes_cli -q -k agentbox` → all pass.

## Test plan

(Steps 2–4 are the test plan. Model file structure on an existing small test,
e.g. `tests/hermes_cli/test_atomic_json_write.py`; use `tmp_path` +
`monkeypatch` fixtures, no network, no real `$HOME` writes.)

## Done criteria

- [ ] 3 new test files, ≥17 cases total, all passing via
      `uv run pytest tests/hermes_cli -q -k agentbox`
- [ ] No source file modified (`git status` shows only the 3 new test files)
- [ ] No test touches the real `$HOME` or the network (grep your tests for
      `requests.`/`httpx.`/`urllib.request` calls that aren't mocked)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The dev environment can't be built (`uv sync` fails) — report the error; do
  not pip-install globally.
- A characterization test reveals a security-relevant behavior (path traversal
  in `_account_file`, prefix-confusion in `public_paths`) — report it as a
  finding with the failing test as evidence; do not fix the source.
- `_home()` cannot be redirected without editing source — report the seam
  problem instead of monkeypatching `Path.home` globally in ways that break
  other tests.
- Existing upstream tests start failing after your changes (you broke shared
  conftest state).

## Maintenance notes

- Follow-up 1 (deferred): FastAPI TestClient suites for `web_server.py`'s
  `/api/google/*` and `/api/shopify/*` routes (OAuth state-cookie round trip,
  callback error handling) — needs the dashboard_auth conftest harness.
- Follow-up 2 (deferred): wire `uv run pytest tests/hermes_cli -k agentbox`
  into the root CI workflow from plan 001 as a third job (needs Python + uv
  setup actions; keep it scoped with `-k agentbox` so upstream's heavy suite
  doesn't run).
- These tests double as drift detection when bumping the Hermes pin: run them
  before/after any `HERMES_REF` change.
