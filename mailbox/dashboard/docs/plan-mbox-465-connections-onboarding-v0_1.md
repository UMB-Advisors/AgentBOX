# MBOX-465 — Provider-aware onboarding on Connections/Keys (v0.1)

**Status:** plan / spec-first
**Parent:** MBOX-355 (multi-provider mail)
**Scope discipline:** smallest correct change. Touch ONLY files under `mailbox/dashboard`. No refactors of adjacent code, no renames, match existing file style.

## TL;DR

The connect + test-connection plumbing for **both** Microsoft 365 (Graph) and IMAP/SMTP **already exists and is shipped** (MBOX-357 IMAP, MBOX-358 Graph). `AccountsSettings.tsx` already swaps in `ImapConnectForm` / `GraphConnectForm` per selected provider, each with a working **Test connection** + **Save & connect** that blocks save on a failed probe (server 422 before any DB write; client only sets `saved` on `res.ok && payload.ok && mode==='save'`). So **AC1/AC2/AC3 plumbing is already satisfied** — the only true gap is **AC4**: a provider-keyed **onboarding-steps single-source-of-truth** plus an **inline walkthrough UI** that renders those steps (Azure app-registration for M365; per-provider app-password guidance for IMAP) next to the existing forms, generically, with no per-provider UI fork.

**Do NOT** add a new `/test` endpoint, a new connect orchestrator, SDK deps, or touch persistence — that re-implements the shipped seam and risks a second save-gate drifting from the 422 invariant.

## What already exists (verified, reuse verbatim — do not rebuild)

- **Test helpers** (dependency-light, never throw): `lib/mail/test-connection.ts` (IMAP LOGIN + SMTP AUTH raw `node:net`/`node:tls`), `lib/mail/test-graph-connection.ts` (app-only client-credentials token + inbox probe via global `fetch`). DR-56: do not upgrade to imapflow/nodemailer/@azure SDK.
- **Connect orchestrators**: `lib/mail/connect-imap.ts`, `lib/mail/connect-graph.ts` — one contract: probe -> `422` on fail (never persists) -> `mode:'test'` returns probe legs / `mode:'save'` persists encrypted secret. This is the save-blocks-on-failure enforcement point.
- **Settings API routes** (the Connections page targets these, `advanceOnboarding:false`): `app/api/accounts/imap/route.ts`, `app/api/accounts/microsoft/route.ts`. (Parallel onboarding-wizard routes under `/api/internal/onboarding/*-connect` exist too with `advanceOnboarding:true` — NOT our target; calling `setEmail` on a live box regresses onboarding.stage.)
- **Connect schemas** (snake_case operator surface): `lib/schemas/graph-connect.ts` (`mode,email,display_label?,tenant_id,client_id,client_secret,mailbox?`), `lib/schemas/imap-connect.ts` (`mode,email,display_label?,imap_host,imap_port=993,smtp_host,smtp_port=587,username,app_password`).
- **React forms** (Test/Save buttons, LegRow rendering): `app/onboarding/email-connect/GraphConnectForm.tsx`, `app/onboarding/email-connect/ImapConnectForm.tsx`. Already reused by `AccountsSettings.tsx` (lines ~339-352) via the `endpoint` prop with `showNextPrompt={false}` + `onSaved`.
- **SoT tuple**: `lib/types.ts:152` `MAIL_PROVIDERS = ['gmail','imap','microsoft'] as const` -> `MailProviderKind`. This tuple is CHECK-mirrored to migration 037 and asserted by `test/schema-invariants.test.ts` and is used as a zod enum. **Do NOT change its shape.** Add a sibling onboarding map keyed by `MailProviderKind` instead.

## Design decision (load-bearing)

Per explore findings, **do NOT mutate the `MAIL_PROVIDERS` tuple** to hang step data on it (it is shape-locked to the DB CHECK + zod enum). Instead add a **separate `Record<MailProviderKind, ProviderOnboarding>`** in a new file `lib/mail/onboarding-steps.ts`. `Record` keying gives compile-time exhaustiveness — that is the AC4 "no bespoke fork" guarantee: a new provider added to `MAIL_PROVIDERS` won't typecheck until it contributes an onboarding entry. Step copy + host/port defaults + Graph permission name live in **data**, not JSX, so a future scope change (e.g. `Mail.Read`) stays single-sourced.

The walkthrough copy aligns to the probe's existing failure-detail strings (e.g. Graph `403` -> "grant Mail.ReadWrite APPLICATION permission and admin consent") so a failed Test connection points the operator back to the right step. Mirror the read-only guide at `hermes-agent-main/.../microsoft-graph-app-registration.md` for portal navigation + the copy-Value-not-Secret-ID gotcha ONLY — the codebase is APP-ONLY `Mail.ReadWrite` reading one mailbox by UPN, NOT delegated Teams scopes; `test-graph-connection.ts` is the consent-model SoT.

## Contract (shared between A and B)

A new module `lib/mail/onboarding-steps.ts` exports the types + the keyed map. B imports them read-only.

```ts
// lib/mail/onboarding-steps.ts (owned by A)
import type { MailProviderKind } from '@/lib/types';

export type OnboardingMode = 'credentials' | 'oauth';

export interface OnboardingStep {
  title: string;
  body: string;
  href?: string;
  produces?: string[];   // connect-schema field names this step yields
}

export interface ImapPreset {
  provider: string;       // 'Gmail' | 'Fastmail' | 'Zoho' | 'Generic (cPanel/custom)'
  imap_host?: string;
  imap_port?: number;     // default 993
  smtp_host?: string;
  smtp_port?: number;     // 465 or 587
  steps: string[];        // app-password recipe, ordered
}

export interface ProviderOnboarding {
  label: string;
  summary: string;
  mode: OnboardingMode;
  connectPath?: string;   // '/api/accounts/microsoft' | '/api/accounts/imap'; undefined for oauth
  steps: OnboardingStep[];   // [] for oauth
  imapPresets?: ImapPreset[];
}

export const PROVIDER_ONBOARDING: Record<MailProviderKind, ProviderOnboarding> = {
  gmail: { /* mode:'oauth', steps:[], no connectPath */ },
  imap: { /* mode:'credentials', connectPath:'/api/accounts/imap', steps[...], imapPresets[...] */ },
  microsoft: { /* mode:'credentials', connectPath:'/api/accounts/microsoft', steps[...] */ },
} as const;
```

**Test-connection API contract (already shipped — B calls it via the existing forms, A owns the routes):**

- M365 `POST /api/accounts/microsoft`: body `{ mode:'test'|'save', email, display_label?, tenant_id, client_id, client_secret, mailbox? }` -> `200 { ok, token:{ok,detail}, mailbox:{ok,detail}, account_id? }` | `422 { ok:false, token, mailbox }` (never persists) | `400` (zod) | `500 { ok:false, error }`.
- IMAP `POST /api/accounts/imap`: body `{ mode, email, display_label?, imap_host, imap_port, smtp_host, smtp_port, username, app_password }` -> `200 { ok, imap:{ok,detail}, smtp:{ok,detail}, account_id? }` | `422 { ok:false, imap, smtp }` | `400` | `500`.

## Step content to encode (from explore reports)

**M365 (BYO Azure, app-only client-credentials):**
1. Go to entra.microsoft.com as a tenant admin -> Identity -> Applications -> App registrations. (href: https://entra.microsoft.com)
2. New registration -> name "AgentBOX Mailbox", Single tenant, Redirect URI blank -> Register.
3. Overview: copy Directory (tenant) ID -> **tenant_id**; Application (client) ID -> **client_id**.
4. Certificates & secrets -> New client secret (expiry 6-24mo) -> copy the **Value** column (shown once — NOT the Secret ID) -> **client_secret**.
5. API permissions -> Add -> Microsoft Graph -> **Application** permissions -> **Mail.ReadWrite** (Application, not Delegated).
6. Grant admin consent for your tenant (Status turns green; skipping -> 403 Forbidden on test).
7. Mailbox field = the email/UPN the app reads (blank = the email above) -> **mailbox**.
8. Test connection (mints app-only token + reads inbox; Save stays disabled until it passes).
9. Save & connect (secret encrypted, never shown).
   Error map: bad secret/app id -> re-copy Value (4)/Client ID (3); tenant -> re-check Tenant ID (3); 403 -> admin consent (6) or permission not APPLICATION (5); mailbox not found -> UPN (7) wrong/unlicensed. Permission name lives in data so a `Mail.Read` change is single-sourced.

**IMAP/SMTP generic steps:** generate app password -> email/username -> IMAP host+port (993 TLS) -> SMTP host+port (465 TLS or 587 STARTTLS) -> username (usually full email) -> paste app password -> Test (both legs must pass) -> Save & connect.

**IMAP presets:**
- Gmail: imap.gmail.com:993 / smtp.gmail.com:587 (or 465). 2-Step ON -> myaccount.google.com/apppasswords (Mail, Other), 16-char. Label as the OAuth-fallback (Gmail normally uses native OAuth).
- Fastmail: imap.fastmail.com:993 / smtp.fastmail.com:465 (or 587). Settings -> Privacy & Security -> Integrations -> New app password (Mail IMAP/POP/SMTP).
- Zoho: imap.zoho.com:993 / smtp.zoho.com:465 (or 587), region host variants (.eu/.in/.com.au). Enable Settings -> Mail Accounts -> IMAP Access; accounts.zoho.com -> Security -> App Passwords; 2FA required.
- Generic (cPanel/custom): host/port from the provider's mail-client page; prefer SSL 993/465.

## Implementation split

### Implementer A — DATA + API + CONTENT (runs first, commits first)

Owns:
- `lib/mail/onboarding-steps.ts` — **new**. The `OnboardingMode`/`OnboardingStep`/`ImapPreset`/`ProviderOnboarding` types + `PROVIDER_ONBOARDING` `Record<MailProviderKind, ...>` map with the full M365 + IMAP step content above. `gmail` = `{mode:'oauth', steps:[]}`; `imap`/`microsoft` carry steps + connectPath + (imap) presets.
- `test/onboarding-steps.test.ts` — **new** vitest. Assert: (a) every `MailProviderKind` in `MAIL_PROVIDERS` has a `PROVIDER_ONBOARDING` entry (Record exhaustiveness at runtime); (b) every `mode:'credentials'` entry has a `connectPath` and `steps.length > 0`; (c) `mode:'oauth'` entries have `steps.length === 0` and no `connectPath`; (d) each step has non-empty `title` + `body`; (e) microsoft has a step that `produces` `client_secret` and one that mentions admin consent; imap has at least one `imapPreset`. No DB needed — pure data test, runs green without `TEST_POSTGRES_URL`.

A does NOT touch the API routes/schemas/orchestrators/helpers — they already exist and satisfy the contract; A only confirms the routes' response shape matches the contract block above (read-only verification) and points the config's `connectPath` at the existing `/api/accounts/{microsoft,imap}` routes. If any route response shape diverges from the contract, fix it in the route file (A owns `app/api/accounts/*/route.ts`), otherwise leave untouched.

A's owned files (disjoint from B):
- `lib/mail/onboarding-steps.ts`
- `test/onboarding-steps.test.ts`
- `app/api/accounts/microsoft/route.ts` (verify-only; edit only if response shape drifts from contract)
- `app/api/accounts/imap/route.ts` (verify-only; edit only if response shape drifts from contract)

### Implementer B — UI (runs after A commits; imports A's exports)

Owns:
- `app/settings/accounts/ProviderOnboarding.tsx` — **new** component. Props `{ provider: MailProviderKind }`. Reads `PROVIDER_ONBOARDING[provider]` from `@/lib/mail/onboarding-steps`. Renders generically (no per-provider branch in the steps renderer): the `summary`, an ordered list of `steps` (title + body, optional `href` link, optional "-> fills: <produces>" hint), and for IMAP the `imapPresets` (collapsible per-provider host/port + app-password recipe). For `mode:'oauth'` (gmail) render the summary copy only (no steps). Match the existing Tailwind token classes in `AccountsSettings.tsx` (`font-mono text-[11px] uppercase tracking-wider text-ink-dim`, `rounded-sm border border-border bg-bg-panel`, etc.).
- `app/settings/accounts/AccountsSettings.tsx` — wire it in. Insert `<ProviderOnboarding provider={provider} />` INSIDE the add-card (the `space-y-3 rounded-sm border ...` div), AFTER the Provider `<select>` label (~line 337) and BEFORE the `provider === 'imap' ? ... : provider === 'microsoft' ? ... : ...` ternary (~line 339). The steps render ABOVE the existing `ImapConnectForm` / `GraphConnectForm`, gated by the SAME `provider` state — no new fork. The forms already provide Test connection + save-blocks-on-failure; B adds NO new API call.

B's owned files (disjoint from A):
- `app/settings/accounts/ProviderOnboarding.tsx`
- `app/settings/accounts/AccountsSettings.tsx`

### Disjointness

A owns `lib/mail/onboarding-steps.ts`, `test/onboarding-steps.test.ts`, `app/api/accounts/{microsoft,imap}/route.ts`. B owns `app/settings/accounts/ProviderOnboarding.tsx`, `app/settings/accounts/AccountsSettings.tsx`. No shared file. B imports A's `PROVIDER_ONBOARDING` + types (A commits first).

## Acceptance-criteria mapping

| AC | Met by |
|---|---|
| 1. M365 net-new from UI, Azure walkthrough inline | B's `ProviderOnboarding` steps (M365) above the existing `GraphConnectForm` (-> `/api/accounts/microsoft`); no DB access |
| 2. IMAP net-new, app-password guidance inline | B's `ProviderOnboarding` steps + `imapPresets` above `ImapConnectForm` (-> `/api/accounts/imap`) |
| 3. Test connection against live creds, blocks save on failure | **Already shipped**: `connect-{graph,imap}.ts` return 422 pre-persist; forms only `saved` on `res.ok && payload.ok && mode==='save'`. Reused unchanged. |
| 4. Steps sourced from provider SoT, new provider contributes steps no fork | A's `PROVIDER_ONBOARDING` `Record<MailProviderKind,...>` (compile-time exhaustive) + B's generic renderer |

## Test plan

- **A's vitest** (`test/onboarding-steps.test.ts`, `npm test`): pure-data assertions listed under Implementer A — Record exhaustiveness over `MAIL_PROVIDERS`, mode/connectPath/steps invariants, M365 produces-`client_secret` + admin-consent presence, IMAP preset presence. Runs green with no DB.
- **Gates**: `npm run typecheck` (Record exhaustiveness fails the build if a `MailProviderKind` lacks an entry — the AC4 guarantee), `npm run lint` (biome), `npm test`.
- **Manual (verify-work)**: on the Connections page, select Microsoft -> inline Azure steps render above the Graph form; a deliberately-wrong client_secret -> Test connection shows a red leg and Save is blocked (no row inserted). Select IMAP -> app-password presets render; bad app_password -> 422, no persist. Select Gmail -> summary only, no steps, existing bare register row unchanged.

## Risks / guardrails

- **Scope trap**: do not add a standalone `/api/accounts/*/test` endpoint or a second orchestrator — `test` is a `mode` on the existing connect routes; duplicating it creates a second save-gate that can drift from the 422 invariant.
- **Two routes per provider by design**: settings (`/api/accounts/*`, `advanceOnboarding:false`) vs onboarding (`/api/internal/onboarding/*-connect`, `advanceOnboarding:true`). Connections page is the SETTINGS surface -> `connectPath` MUST point at `/api/accounts/*`. (Note `ImapConnectForm` DEFAULTS to the onboarding route, so `AccountsSettings` passes `endpoint="/api/accounts/imap"` explicitly — keep that.)
- **Do not change `MAIL_PROVIDERS` shape** (CHECK-mirrored + zod enum + schema-invariants test) — use the separate Record.
- **M365 is app-only**, not delegated Teams. Mirror the guide for navigation + Value-not-Secret-ID only; `test-graph-connection.ts` is the consent SoT. Keep `Mail.ReadWrite` permission name in data.
- **Snake_case operator surface** (`tenant_id`, `app_password`) — connect schemas are snake_case; `connect-graph.ts` translates to camelCase internally. Surface only snake_case in step copy.
- **No persistence work** — `createImapAccount`/`createMicrosoftAccount` + `encryptToken` already handle `provider_config` / `provider_secret_enc` (migrations 037/040). MBOX-465 touches none of it.
- **Don't promise live sync** in copy — transport I/O still throws NotImplementedYet (DR-56 unresolved); Test-connection probes are independent and DO work, so AC3 holds today. n8n owns operational poll/send.
