# Addendum — Self-serve Cloudflare URL setup from the dashboard

> **Created:** 2026-06-07
> **Amends:** Linear [MBOX-451](https://linear.app/staqs/issue/MBOX-451) — *Client-facing dashboard URL: branded, secure per-box access (Cloudflare Tunnel + Access)*
> **Related:** [MBOX-453](https://linear.app/staqs/issue/MBOX-453) (self-serve Shopify connector, same "no SSH" pattern), [MBOX-452](https://linear.app/staqs/issue/MBOX-452) (custom dashboard backend codified)
> **Status:** spec — no code yet, pending approval
> **Decision (this addendum):** credential model = **token-paste** (operator pre-creates the tunnel in Cloudflare, pastes the per-box token into the dashboard)

## TL;DR

MBOX-451 specs Cloudflare Tunnel + Access but provisions it **at install time**
(`install/agentbox-install.sh`, token as a CLI input). This addendum adds a
**self-serve path**: the operator pastes the per-box tunnel **token** into the
mailbox dashboard (`Settings → Integrations → Remote Access`), and AgentBOX
writes the `cloudflared` config and manages its systemd unit — no SSH, no shell.
The install-time path stays valid; this is an alternative entry point that reuses
the existing operator-settings + encrypted-secret storage already in the dashboard.

We deliberately do **not** put a Cloudflare API token on the box (the API-driven
option). The box only ever holds a single-purpose **tunnel token**, which can run
exactly one named tunnel and nothing else in the account.

## Why token-paste (not API-driven)

| | Token-paste (chosen) | API-driven |
|---|---|---|
| What the box holds | Per-box **tunnel token** (single tunnel, no account access) | Scoped **CF API token** (can mutate DNS/tunnels/Access) |
| Who creates tunnel + DNS + Access | Operator, once, in CF dashboard (or a central minting script) | AgentBOX, programmatically, per box |
| Blast radius if box is stolen/compromised | One tunnel; revoke the token, done | API token can be abused against the whole zone until revoked |
| Build size | Small — store token, template config, manage one systemd unit | Large — CF API client, DNS CNAME create, Access app create, idempotency, error states |
| Matches MBOX-451 | Yes ("tunnel token minted per client") | No (issue does not call for on-box API creds) |

API-driven (or the **hybrid** — token-paste + optional DNS-scoped token to
auto-create the subdomain) can be a follow-up if zero-touch DNS becomes a real
pain. Not now.

## Bootstrapping caveat (defines the UX, not a blocker)

The dashboard is **loopback-bound by design** (`:9119`). You cannot use the
public URL to set up the public URL. Therefore:

- This self-serve flow is for the **operator during first setup**, reached over
  **LAN, SSH tunnel, or Tailscale Funnel** (the existing access paths).
- The **branded Cloudflare URL is the output** — what you then hand the client.
- Tailscale Funnel stays as the internal/admin path; Cloudflare is the client path
  (answers one of MBOX-451's open questions in the affirmative).

## UX flow

`Settings → Integrations → Remote Access` (new sub-panel; Integrations tab and
`GoogleIntegrations.tsx` already exist — this sits alongside it).

1. **Status badge** at top: `Not configured` / `Connecting…` / `Live` (+ the
   public hostname as a click-to-open link when Live).
2. **Hostname** field — the branded URL the operator chose in Cloudflare
   (e.g. `heronlabs.agentbox.app`). Display-only mapping to `127.0.0.1:9119`.
3. **Tunnel token** field — paste target (secret input, write-only; never
   rendered back after save, mirroring how account-provider secrets are handled).
4. **Save & start** → writes config + token, enables/starts the `cloudflared`
   unit, polls health, flips the badge to Live.
5. **Stop / Remove** → disables the unit and clears the stored token.

## Components touched

| Layer | Change |
|---|---|
| Frontend | `app/settings/integrations/` — new `RemoteAccess.tsx` panel; wire into the Integrations section. No new top-level tab needed. |
| API route | `app/api/remote-access/` — `GET` status, `POST` configure (save token + hostname, start), `DELETE` teardown. |
| Settings store | `operator_settings` row for `remote_access.hostname` + `remote_access.enabled` (migration 038 pattern). |
| Secret store | Tunnel token stored via the existing encrypted-secret mechanism (migration 040 `account-provider-secret` pattern), **not** in plaintext settings. |
| Service mgmt | Render `cloudflared` config from hostname+token; manage `cloudflared-agentbox.service` (start/stop/status). See "Service mechanics". |
| Install path | `install/agentbox-install.sh` keeps the existing token-as-input path; both write the **same** config + unit so dashboard and installer converge. |

## Service mechanics (token-paste)

The token-paste model uses a **remotely-managed (token) tunnel**, so the on-box
config is minimal — the ingress mapping lives in the Cloudflare dashboard, the
box just runs the connector:

- Unit: `cloudflared-agentbox.service` → `cloudflared tunnel run --token <TOKEN>`.
- Token sourced from an env-file / secret the API route writes (not baked into the
  unit text); `0600`, root-owned.
- Ingress (`<hostname> → http://127.0.0.1:9119`) and the Access policy are
  configured **in Cloudflare** when the tunnel is created — outside the box.
- Health = `cloudflared` connection registered + `systemctl is-active`. The status
  endpoint reports both.

> **Privilege note:** the dashboard runs unprivileged; it cannot `systemctl`
> directly. Resolve via a tightly-scoped helper (a single `sudoers` entry for
> `systemctl {start,stop,status} cloudflared-agentbox.service`, or a small
> root-side agent the dashboard signals). **This is the main thing to nail in
> implementation** — pick the helper mechanism the box already uses for
> `hermes update` / service control and reuse it. Flag for design review.

## Phasing

1. **P1 — panel + storage + status (read-only-ish):** build the settings panel,
   secret storage, status endpoint. Tunnel still started by installer; dashboard
   shows state and lets you paste/replace the token. Lowest risk.
2. **P2 — start/stop from dashboard:** add the privileged service-control helper
   and wire Save & start / Stop. This is the real "setup from the dashboard."
3. **P3 — convergence + docs:** ensure installer and dashboard write identical
   config; document in the JP7.2 runbook (MBOX-451 acceptance criterion).

## Open questions (carried from MBOX-451 — still unresolved, block go-live not the build)

- **Domain:** `agentbox.app` vs a thUMBox domain; per-client subdomain naming.
- **Auth model:** Cloudflare Access OTP vs Google SSO vs static email allowlist.
- **CF account ownership/billing:** free tier likely sufficient at current scale.
- **Privileged service control:** which existing mechanism the dashboard reuses to
  `systemctl` the unit (see Service mechanics note).

## Acceptance criteria (extends MBOX-451)

- [ ] Operator can paste a per-box tunnel token + hostname in the dashboard and
      bring the tunnel **Live** without SSH.
- [ ] Tunnel token stored encrypted (migration-040 pattern), never rendered back.
- [ ] Status badge reflects real connector + unit state.
- [ ] Dashboard and `install/agentbox-install.sh` write the **same** config + unit.
- [ ] No Cloudflare **API** token is stored on the box.
- [ ] (Inherits all MBOX-451 criteria: per-client isolation via Access, stable
      Google OAuth callback against the branded URL, runbook docs.)

## Out of scope (this addendum)

- Programmatic DNS/Access creation (API-driven model).
- Choosing/registering the domain and Access policy (MBOX-451 open questions).
- Any change to the loopback-binding of the dashboard itself.
