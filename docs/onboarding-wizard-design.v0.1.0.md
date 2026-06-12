# Onboarding Wizard Design — STAQPRO-152

**TL;DR.** Six wizard pages exist as annotated stubs with no real functionality.
The state machine beneath them (stages, transitions, DB contracts) is fully built
and tested. Two integration seams block the build: (1) Gmail OAuth lives in the
Hermes :9119 backend and must not stay there — the recommendation is to drive the
existing `mailbox/dashboard/lib/oauth/google.ts` code instead and write the token
to n8n's credential API; (2) the admin password must write a bcrypt hash into
`.env`, reload Caddy via its Admin API, then survive the gate it just enabled —
solved by exempting `/dashboard/onboarding/*` from `@protected` until password is
set. The server-component wrapper refactor required by plan-008's
`ONBOARDING_API_TOKEN` gate lands in Phase 3 (the password phase), which is when
the token gate first becomes activatable.

---

## 1. Current State

### 1.1 Wizard pages

All six pages are `'use client'` stubs that render a `<StepShell>` with placeholder
bullet copy. Every TODO tag references STAQPRO-152.

| Page | File | TODO line | What the comment says is needed |
|---|---|---|---|
| welcome | `app/onboarding/welcome/page.tsx:5` | 5 | Brand intro + appliance overview |
| password | `app/onboarding/password/page.tsx:5` | 5 | Wire to STAQPRO-131 admin password create + Caddy basic_auth provisioning |
| profile | `app/onboarding/profile/page.tsx:5` | 5 | Collect operator first name, brand, signoff seed → `mailbox.persona.statistical_markers` |
| network-check | `app/onboarding/network-check/page.tsx:5` | 5 | Live Caddy/Cloudflare cert health probe + LAN reachability widget |
| email-connect | `app/onboarding/email-connect/page.tsx:42` | 42 | Real Gmail OAuth flow + n8n credential handoff |
| complete | `app/onboarding/complete/page.tsx:6` | 6 | First-poll ETA countdown + link to `/dashboard/queue` + "you're live" email |

### 1.2 What is already built

**State machine** (`mailbox/dashboard/lib/onboarding/wizard-stages.ts`):

- `WIZARD_STEPS` array — six entries with `slug`, `title`, `intent`, `dbStage`, and `allowsBack`.
- DB stages: `pending_admin` (welcome + password share it), `pending_email` (profile + network-check share it), `ingesting`, `live`.
- `ALLOWED_TRANSITIONS` — adjacent pairs only; `isAllowedTransition()` exported.
- UX-only sub-steps (welcome→password, profile→network-check) are no-ops at the DB layer; the advance route handles them explicitly (`app/api/internal/onboarding/advance/route.ts`, lines 1–65).

**Internal routes** (all in `app/api/internal/onboarding/`):

- `advance/route.ts` — enforces ALLOWED_TRANSITIONS via Zod; 409 on skip/back/stale-from. Covered by Vitest DB-backed tests.
- `imap-connect/route.ts` — delegates to `lib/mail/connect-imap.ts` with `advanceOnboarding:true`; probe + persist; sets stage to `ingesting` on success (MBOX-357).
- `graph-connect/route.ts` — same pattern for Microsoft 365 / Graph (MBOX-358).

**StepNav** (`components/onboarding/StepNav.tsx` — `'use client'`): handles Next/Back, calls `advance` only when a DB transition is required, does a direct `router.push` for UX-only sub-steps.

**Layout** (`app/onboarding/layout.tsx`): async server component, reads DB stage, enforces live-gate (`MAILBOX_LIVE_GATE_BYPASS=1` for support bypass). Does not pass `currentSlug` down — each page's `<StepShell>` owns the indicator.

**Onboarding auth middleware** (`lib/middleware/onboarding-auth.ts`): header `x-onboarding-token` checked against env `ONBOARDING_API_TOKEN`. Currently inert when unset. **Cannot be enabled yet** — all wizard step components are `'use client'` with no server-component parent to thread the token prop (plan-008 finding from `fix/onboarding-route-auth`).

**Dashboard `lib/oauth/google.ts`**: a complete server-side OAuth2 library — `exchangeCode()`, `getAccessToken()`, `revokeAtGoogle()`, and a `callbackUrl()` helper. Plain fetch, no Google client SDK. Already exercised against the live token endpoint by the settings/google connect flow.

**Hermes Google OAuth** (`hermes_cli/web_server.py:1492–1562`, `hermes_cli/google_accounts.py`): a parallel full-flow OAuth2 implementation — CSRF state cookie, saves tokens to `$HERMES_HOME/google_accounts/<email>.json`. This is the flow the Hermes dashboard settings tab uses today.

**Caddy** (`mailbox/caddy/Caddyfile`, `config/Caddyfile.funnel.template`):

- `@protected not path /mcp-server/* /healthz /assets/*` — basic_auth covers all other paths (Caddyfile lines 58–59, 121–122).
- Hash generated with `docker run --rm caddy:2 caddy hash-password --plaintext '<pw>'` (Caddyfile:32, `config/Caddyfile.funnel.template:7`).
- `MAILBOX_BASIC_AUTH_USER` + `MAILBOX_BASIC_AUTH_HASH` are env vars injected at container start; custom entrypoint (`mailbox/caddy/Dockerfile:8–11`) validates they are non-empty before starting Caddy (STAQPRO-239).
- Caddy Admin API is at `caddy:2019` inside the Compose network and supports hot-reload of config including `basic_auth` via `POST /load`.

### 1.3 The :9119 ungated-proxy risk (plan-008, branch `fix/onboarding-route-auth`)

The Hermes `:9119` dashboard proxies `/dashboard/{path:path}` to the mailbox dashboard with no auth gate (`hermes_cli/web_server.py:1903`). Its own auth middleware only gates `/api/*`. The wizard routes at `/dashboard/onboarding/*` are therefore accessible ungated to anyone who can reach :9119. Default: loopback-only. Risk surface: an operator who Tailscale-Funnels :9119 exposes all wizard routes without Caddy basic_auth. This is the reason `ONBOARDING_API_TOKEN` / `lib/middleware/onboarding-auth.ts` was introduced.

---

## 2. Seam Decisions

### Seam A — Gmail OAuth home

**Context.** Gmail OAuth for the onboarding wizard is unbuilt. The email-connect page (`app/onboarding/email-connect/page.tsx:42`) has a TODO and a comment describing the intent: OAuth dance → refresh token → n8n credential store. Two candidate implementations exist in the codebase today.

**Option A1 — Drive the existing Hermes backend.**

The wizard's email-connect page redirects to `:9119/api/google/auth/start`. Hermes stores the token in `$HERMES_HOME/google_accounts/<email>.json`. A separate API call then hands the refresh token to n8n's credential store. The Hermes flow is CSRF-protected (signed state cookie, `hermes_cli/web_server.py:1492–1562`) and handles the redirect-URI mismatch by reading `x-forwarded-host` (`hermes_cli/web_server.py:1480`).

*Pros:* Auth dance is already built. The brief side of the system reads from `google_accounts/` files today.

*Cons:*
- Two OAuth stacks for one box — refresh tokens duplicated across Hermes file store and n8n credential store. Re-consent (MBOX-460 precedent) must be coordinated across both.
- The callback at `:9119/api/google/auth/callback` sets a cookie scoped to `/api/google`; after it fires, control lands in the Hermes settings tab, not the wizard. Resuming the wizard requires a custom `next_url` parameter and cross-origin session plumbing.
- Hermes is pinned to v0.15.1 (`HERMES_REF=927fa7a98`); CLAUDE.md explicitly warns against bumping. Upstream OAuth behavior changes are blocked. (HISTORICAL: pin since bumped — agentbox2 runs upstream v0.16.0 (`agentbox2-v3`); gbrain ships as the `hermes_gbrain_provider` plugin from the sidecar repo.)
- The `:9119` ungated proxy (plan-008) means `auth/start` is reachable without Caddy basic_auth on Funneled boxes.

**Option A2 — Implement OAuth in the mailbox-dashboard (RECOMMENDED).**

A new server route `app/api/internal/onboarding/gmail-connect/route.ts` uses `lib/oauth/google.ts` to build the consent URL. The callback at `app/api/internal/onboarding/gmail-callback/route.ts` calls `exchangeCode()` from `lib/oauth/google.ts`, writes the refresh token to n8n's credential API, calls `advance` to set stage = `ingesting`, then redirects to `/onboarding/complete`.

Reusable from `lib/oauth/google.ts` as-is:
- `exchangeCode(code)` — full auth-code exchange, returns `{ refreshToken, scope, accountEmail }` (`lib/oauth/google.ts` — verified present in indexed output).
- `callbackUrl()` — builds the redirect URI from env, already called by the settings flow.
- `revokeAtGoogle(refreshToken)` — available for disconnect/re-consent path.

*Pros:*
- Single token source of truth: n8n holds the refresh token; no duplication.
- All code stays within the mailbox-dashboard service boundary. Re-consent is a dashboard-only change.
- The callback is served through Caddy at `/dashboard/api/internal/onboarding/gmail-callback` — Caddy basic_auth covers it; Funneled :9119 does not expose it.
- `ONBOARDING_API_TOKEN` gate is enforceable because the callback and start routes are server components.

*Cons:*
- Must register `/dashboard/api/internal/onboarding/gmail-callback` in the GCP OAuth client's authorized redirect URIs — a one-time operator config step.
- Requires n8n credential API write (see open question O2 on credential ID convention).

**Recommendation: Option A2.** Eliminates token duplication, keeps the Caddy auth gate intact, avoids any dependency on the pinned Hermes version, and enables ONBOARDING_API_TOKEN enforcement. The reusable functions in `lib/oauth/google.ts` reduce net-new code to two route handlers plus one thin n8n credential write helper.

---

### Seam B — Admin password → Caddy

**Context.** The password page (`app/onboarding/password/page.tsx:5–9`) already documents the intent: collect password client-side, bcrypt-hash it, write `MAILBOX_BASIC_AUTH_HASH` to `.env`, trigger Caddy reload. The seam question is: who holds the hash and how does Caddy pick it up without dropping the wizard session?

**Mechanism options.**

**Option B1 — Host agent (Unix socket).**

A systemd service accepts `{hash, user}` over a local socket, writes `.env`, and runs `docker compose restart caddy`. The dashboard route calls the socket.

*Pros:* Clean privilege separation. Dashboard never touches `.env` or the Docker socket.

*Cons:* Requires a new systemd unit and shared-socket volume in docker-compose.yml. Container restart drops the wizard browser session (race condition: browser is mid-POST when restart fires).

**Option B2 — Dashboard writes `.env` + Caddy Admin API hot-reload (RECOMMENDED).**

The dashboard container mounts `.env` read-write (bind-mount, single file). After writing `MAILBOX_BASIC_AUTH_HASH`, it sends `POST http://caddy:2019/load` with the updated Caddyfile text. Caddy hot-reloads its config atomically.

*Pros:* No container restart — wizard session is never interrupted. Caddy's Admin API `POST /load` does hot-swap `basic_auth` credentials in Caddy 2 (the STAQPRO-239 entrypoint fail-fast fires only at startup, not on Admin API reloads). `caddy:2019` is reachable inside the Compose network without extra port exposure.

*Cons:* The dashboard container must mount `.env` read-write (small but real security surface). The Caddyfile template must be accessible inside the container at a known path.

**Recommendation: Option B2.** Hot-reload avoids the session-drop race. The `.env` bind-mount is a single-file mount, not a directory. The Caddyfile template is already a known path in the image.

**Bootstrapping order.**

Today `@protected not path /mcp-server/* /healthz /assets/*` gates everything else including `/dashboard/onboarding/*`. This means the wizard is blocked by basic_auth before the operator has set a password — a bootstrapping contradiction.

Recommended resolution: add `/dashboard/onboarding/*` to the `@protected` not-path list, activated only when `MAILBOX_BASIC_AUTH_HASH` is empty. The Caddy entrypoint already detects an empty hash to fail-fast (STAQPRO-239, `mailbox/caddy/Dockerfile:8–11`); extend this logic to write an "open" Caddyfile variant (with onboarding exempted) when the hash is empty, and the normal variant otherwise. The Admin API hot-reload at password-set time switches from the open to the locked variant in a single atomic operation.

**ONBOARDING_API_TOKEN + server-component wrapper (plan-008 requirement).**

The refactor — thin async server-component page wrappers reading `process.env.ONBOARDING_API_TOKEN` and passing an `onboardingToken` prop to child `'use client'` components — must land in **Phase 3 (this phase)**. Reasons:

1. Phase 3 introduces the first new server route (`admin-password`) that needs to enforce the token check.
2. After the password is set, an operator who has Funneled :9119 should be able to enable `ONBOARDING_API_TOKEN` to gate the remaining wizard steps.
3. Phases 1 and 2 pages (welcome, profile) are purely client-side with no sensitive API calls — gating them with the token before Phase 3 adds complexity with no security benefit.

Files that need the server-component wrapper (all refactored in Phase 3):
- `app/onboarding/password/page.tsx` (Phase 3 primary)
- `app/onboarding/welcome/page.tsx`
- `app/onboarding/profile/page.tsx`
- `app/onboarding/network-check/page.tsx`
- `app/onboarding/email-connect/page.tsx` (prop plumbing established here; full OAuth build is Phase 4)
- `app/onboarding/complete/page.tsx`

Plus the `onboardingToken` prop plumbed through:
- `components/onboarding/StepNav.tsx`
- `components/onboarding/ImapConnectForm.tsx`
- `components/onboarding/GraphConnectForm.tsx`

---

## 3. Phased Build Plan

### Phase 1 — Copy, chrome, and complete page

**Effort:** S

**What ships:** Real content for welcome and complete pages. One new API route for system status.

| File | Change |
|---|---|
| `app/onboarding/welcome/page.tsx` | Replace placeholder copy with brand intro (appliance name, 10-minute promise, step list). Remove TODO. |
| `app/onboarding/complete/page.tsx` | Poll new `/api/system/status` endpoint for n8n next-run ETA; render countdown + queue link + success state. Remove TODO. |
| `app/api/system/status/route.ts` (new) | Read n8n workflow `nextRunAt` via n8n REST API; return `{ nextRunMs, workflowActive }`. |

**Exit criteria:** Welcome renders real brand copy with no stub text. Complete page shows a live countdown or "~5 min" fallback when n8n API is unreachable. `git diff --name-only` touches only these three files.

**Test approach:** Vitest route unit test — mock n8n REST API responses, assert status response shape.

**Risk:** Low. No new auth surface.

---

### Phase 2 — Profile persistence

**Effort:** S

**What ships:** Profile form collects operator identity and persists it to `mailbox.persona.statistical_markers`.

| File | Change |
|---|---|
| `app/onboarding/profile/page.tsx` | Add `<ProfileForm>` component. On submit: POST to `/api/persona/settings`. Remove TODO. |
| `components/onboarding/ProfileForm.tsx` (new) | `'use client'` form — first name, brand, signoff. Success → StepNav advances. |
| `app/api/persona/settings/route.ts` | If not yet built: create; accept `{ firstName, brand, signoff }`, write to `mailbox.persona.statistical_markers`. |

**Exit criteria:** Profile values persist to DB. StepNav advances to network-check. Existing persona resolver (STAQPRO-195) reads the new values on first draft.

**Test approach:** Route unit test — mock DB pool, assert `statistical_markers` written with correct keys.

**Risk:** Low. Route exists (partially) or is net-new with no external dependencies.

---

### Phase 3 — Admin password + Caddy seam + server-component wrapper refactor

**Effort:** M

**What ships:** Password form working end-to-end. Caddy reloads with new credentials via Admin API. All wizard pages converted to server-component wrappers (plan-008 refactor). `ONBOARDING_API_TOKEN` gate becomes activatable.

| File | Change |
|---|---|
| `app/onboarding/password/page.tsx` | Convert to async server-component wrapper; read `ONBOARDING_API_TOKEN`; render `<PasswordForm onboardingToken={token} />`. Remove TODO. |
| `components/onboarding/PasswordForm.tsx` (new) | `'use client'` — username + password + confirm inputs. On submit: POST to `admin-password` route with `x-onboarding-token` header. Success → StepNav advances. |
| `app/api/internal/onboarding/admin-password/route.ts` (new) | Validates token via `lib/middleware/onboarding-auth.ts`. bcrypt-hashes password at cost 14 (Caddy-compatible `$2a$` format). Writes `MAILBOX_BASIC_AUTH_USER` + `MAILBOX_BASIC_AUTH_HASH` to `.env` bind-mount. POSTs updated Caddyfile text to `caddy:2019/load`. Returns 204 on success. |
| `components/onboarding/StepNav.tsx` | Accept optional `onboardingToken?: string` prop; include as `x-onboarding-token` header on `advance` POST. |
| `components/onboarding/ImapConnectForm.tsx` | Accept optional `onboardingToken?: string` prop; pass to API calls. |
| `components/onboarding/GraphConnectForm.tsx` | Accept optional `onboardingToken?: string` prop; pass to API calls. |
| `app/onboarding/welcome/page.tsx` | Convert to server-component wrapper; pass `onboardingToken` prop. |
| `app/onboarding/profile/page.tsx` | Convert to server-component wrapper; pass `onboardingToken` prop. |
| `app/onboarding/network-check/page.tsx` | Convert to server-component wrapper; pass `onboardingToken` prop. |
| `app/onboarding/email-connect/page.tsx` | Convert to server-component wrapper; pass `onboardingToken` prop (OAuth build is Phase 4). |
| `app/onboarding/complete/page.tsx` | Convert to server-component wrapper; pass `onboardingToken` prop. |
| `mailbox/caddy/Caddyfile` + entrypoint | Add `/dashboard/onboarding/*` to `@protected` not-path exemption list when `MAILBOX_BASIC_AUTH_HASH` is empty (bootstrap open mode). Admin API reload at password-set time switches to locked variant. |

**Exit criteria:** Password form sets credentials; Caddy hot-reloads without session drop; subsequent page loads require basic_auth. `ONBOARDING_API_TOKEN` can be set in `.env` to activate the token gate on wizard routes. All existing `advance` route tests pass. `StepNav` with token prop passes `x-onboarding-token` header.

**Test approach:**
- Unit: `admin-password` route — mock bcrypt, mock `caddy:2019/load`, mock `.env` write, assert 204.
- Integration smoke: Caddy Admin API call format validated against Caddy 2 `/load` JSON schema in a local docker test.

**Risk:** Medium. Caddy Admin API hot-reload of `basic_auth` must be verified against the actual custom Caddy build (which includes the Cloudflare DNS module — `mailbox/caddy/Dockerfile:2–3`). The entrypoint fail-fast only fires at startup, but confirm the Admin API hot-reload path bypasses it entirely.

---

### Phase 4 — Gmail OAuth + n8n credential handoff

**Effort:** M

**What ships:** Gmail tab of email-connect page working end-to-end. Token written to n8n credential store. Stage advances to `ingesting`.

| File | Change |
|---|---|
| `app/api/internal/onboarding/gmail-connect/route.ts` (new) | Server route — validates `onboardingToken`; calls `callbackUrl()` + `buildAuthUrl()` equivalents from `lib/oauth/google.ts`; returns `{ consentUrl }`. |
| `app/api/internal/onboarding/gmail-callback/route.ts` (new) | Receives `code` from Google. Calls `exchangeCode(code)` from `lib/oauth/google.ts`. Calls `writeGmailCredential()` (see below). Calls `advance` to set stage = `ingesting`. Redirects to `/onboarding/complete`. |
| `lib/n8n/credentials.ts` (new) | `writeGmailCredential(refreshToken, email)` — `PATCH /api/v1/credentials/:id` on n8n REST API. Credential ID read from `N8N_GMAIL_CREDENTIAL_ID` env var. |
| `components/onboarding/GmailConnectButton.tsx` (new) | `'use client'` — fetches consent URL from `gmail-connect`, redirects browser to Google. Handles error states. |
| `app/onboarding/email-connect/page.tsx` | Wire Gmail tab to `<GmailConnectButton>`. Remove TODO. |

**Operator pre-req:** GCP OAuth client must have `/dashboard/api/internal/onboarding/gmail-callback` added to authorized redirect URIs before Phase 4 can be tested end-to-end.

**Exit criteria:** Gmail OAuth completes in the wizard (not Hermes settings tab). Refresh token appears in n8n credential store under `N8N_GMAIL_CREDENTIAL_ID`. n8n's Gmail polling workflow runs on next trigger without re-auth. Stage transitions to `ingesting` then `live`.

**Test approach:** Route unit tests — mock Google token endpoint (`exchangeCode`), mock n8n credential API, assert credential PATCH called with correct body shape, assert `advance` called with `{ from: 'pending_email', to: 'ingesting' }`.

**Risk:** Medium. Depends on O2 (n8n credential ID convention) being resolved before implementation. If the credential ID is not pre-provisioned, a lookup-by-name step is needed, which adds one more n8n API call.

---

### Phase 5 — Network-check probes

**Effort:** S

**What ships:** network-check page makes live probes and reports structured pass/fail with remediation hints.

| File | Change |
|---|---|
| `app/api/internal/onboarding/network-check/route.ts` (new) | Run probe set: (a) `caddy:2019/config` — Caddy admin API alive; (b) HTTPS GET to `process.env.DOMAIN` — public cert reachable; (c) HTTPS GET to `https://oauth2.googleapis.com/token` — Gmail API endpoint reachable; (d) GET to Anthropic / Ollama base URL — cloud drafter reachable. Return `{ checks: [{name, pass, hint}] }`. |
| `components/onboarding/NetworkCheckPanel.tsx` (new) | `'use client'` — renders probe results as pass/fail list with inline remediation text (distinct hints for DNS-not-propagated, ACME-challenge-failed, etc.). Retry button. |
| `app/onboarding/network-check/page.tsx` | Wire `<NetworkCheckPanel>`. Remove TODO. |

**Exit criteria:** Each probe shows status. DNS-not-propagated and ACME-failed cases return distinct `hint` strings. Retry re-runs all probes. LAN-only mode (see O4) probe set is configurable.

**Test approach:** Route unit tests — mock fetch for each external endpoint; assert structured response; assert distinct hints per failure mode.

**Risk:** Low. Pure read-only probes, no state changes.

---

## 4. Open Questions (operator decisions required)

**O1 — Brand assets for welcome page.** What appliance name is customer-facing ("MailBox One", "AgentBOX", something else)? Is there a logo or wordmark to embed, or should Phase 1 ship with the current text-only design system?

**O2 — n8n credential ID convention.** The Gmail credential the polling workflow references — is it a fixed UUID provisioned at install time (installer pre-creates it via n8n REST API), or resolved by name (`WHERE name = 'Gmail Operator'`)? This determines whether `lib/n8n/credentials.ts` PATCHes a known env-var ID (simpler, requires installer pre-create) or does a GET-by-name first (more flexible, one extra n8n API round-trip). Phase 4 cannot ship without this decision.

**O3 — IMAP / Microsoft 365 as v1 or fast-follow.** The `imap-connect` and `graph-connect` routes are built (MBOX-357, MBOX-358) and the email-connect page already has a tab switcher with `ImapConnectForm` rendering. Can v1 ship Gmail-only with IMAP/Graph as a fast-follow, or does IMAP need to work at Phase 4 launch? This affects Phase 4 scope and test surface.

**O4 — Offline / LAN-only mode for network-check.** The Phase 5 probes include a public-hostname HTTPS check. Does the appliance need to support a fully-offline LAN mode where the public cert probe is skipped or auto-passes? The LAN Caddyfile block (`{$MAILBOX_LAN_HOSTNAME}`) uses `tls internal` — the public cert probe would report a failure in that mode even on a healthy box.

**O5 — `ONBOARDING_API_TOKEN` activation policy.** The token gate is inert until `ONBOARDING_API_TOKEN` is set. Should the installer auto-generate a random token and write it to `.env` (always-on for production installs), or leave it as an optional operator hardening step? Auto-generation means the deploy script must propagate the token to any re-flash or appliance migration. This affects the Phase 3 installer change scope.

**O6 — "You're live" email sender.** The complete page comment (`app/onboarding/complete/page.tsx:6`) references a one-time "you're live" email to confirm the send path works. Which outbound credential does this use: the operator's Gmail account (connected in Phase 4), or a Staqs-owned transactional address? If operator Gmail, the Phase 4 token handoff must complete before the complete-page email send can work, which means Phase 1's complete-page design should stub the email step as a Phase 4 dependency.
