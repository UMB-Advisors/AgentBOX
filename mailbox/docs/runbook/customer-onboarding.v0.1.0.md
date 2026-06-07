# MailBox Customer Onboarding Runbook v0.1.0

**Status:** DRAFT — authored for MBOX-182 (M5 "Customer config separation"). Not yet walked end-to-end against a live install; time-to-onboard target (< 2h) is unmeasured until then.

**Audience:** An operator (not necessarily Dustin) bringing one appliance from "freshly bootstrapped, no creds" to "live, smoke-passing." This is the *"what the human has to do that the script can't"* doc.

**Scope boundary — where this picks up:** `scripts/factory-bootstrap.sh` (MBOX-156, formerly STAQPRO-202/410) has already run on the appliance — Docker is installed, the stack image is present, mDNS/Avahi is up, and the box advertises `https://mailbox.local/`. The box is **up but inert**: no Gmail OAuth, no API keys, no basic_auth hash, no persona. This runbook fills in `.env`, wires the credentials a script cannot create, and verifies each step.

**Companions (reference, do not duplicate):**
- [`factory-flash.v0.1.0.md`](factory-flash.v0.1.0.md) — flashing the NVMe (upstream of this).
- [`provisioning.v0.1.0.md`](provisioning.v0.1.0.md) — the canonical white-glove provisioning runbook. This onboarding doc is the *config-and-credentials* slice; it **defers to provisioning §5 for DNS/Cloudflare, §7 for the deep Gmail OAuth detail, §8 for the smoke loop, and §9 for cloud-key allocation**. Where they overlap, provisioning.v0.1.0 is authoritative on procedure; this doc owns the per-`.env`-var checklist and the ordering.
- `.env.example` — the annotated source of truth for every variable referenced below.
- Root `CLAUDE.md` — "Conventions → .env escaping", "Caddy basic_auth rotation gotchas", "Per-customer subdomain pattern (NC-25)".

---

## Pre-flight (confirm the starting state)

- [ ] SSH to the appliance works (`ssh mailbox<N>` via Tailscale, or LAN IP).
- [ ] `docker compose ps` shows the stack present (services may be unhealthy until `.env` is filled — that's expected).
- [ ] `cat .env 2>/dev/null` — if no `.env` exists yet, create it from the template:
      ```bash
      cd ~/mailbox && cp .env.example .env
      ```
- [ ] You have access to the **1Password "MailBOX" vault** (or will create new items there as you generate secrets).

---

## Step 1 — Identify the appliance (`DOMAIN` + DNS)

The hostname both binds the box's public identity and is what Caddy serves.

- [ ] Decide the pattern (see provisioning.v0.1.0 §5):
      - **Shared Staqs subdomain** (default, customers 2+): `DOMAIN=<customer-slug>.mailbox.staqs.io`
      - **Customer-owned domain** (M1-style, grandfathered): `DOMAIN=mailbox.<customer-domain>`
- [ ] Create the Cloudflare A record → appliance LAN IP, **proxied=false**. Run from the *provisioner workstation*, not the Jetson (provisioning.v0.1.0 §5 / `scripts/provision-customer-dns.sh`):
      ```bash
      ./scripts/provision-customer-dns.sh --dry-run <customer-slug> <lan-ip>   # preview
      ./scripts/provision-customer-dns.sh <customer-slug> <lan-ip>             # create
      ```
- [ ] Set in the appliance `.env`:
      - `DOMAIN=` (the full resolved hostname)
      - `CADDY_EMAIL=` (Let's Encrypt account email for expiry warnings)
- [ ] **Verify** the record resolves:
      ```bash
      dig +short <DOMAIN>          # → the appliance LAN IP
      ```

---

## Step 2 — Secrets: Postgres, n8n key, Cloudflare token

- [ ] `POSTGRES_USER` / `POSTGRES_DB` — leave at `mailbox` unless the box is a clone with a different schema owner.
- [ ] `POSTGRES_PASSWORD` — generate and set:
      ```bash
      openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32
      ```
- [ ] `N8N_ENCRYPTION_KEY` — generate and set:
      ```bash
      openssl rand -hex 32
      ```
      Back this up in 1Password **now** — losing it orphans the Gmail OAuth credential you set in Step 4.
- [ ] `CLOUDFLARE_API_TOKEN` — scope **Zone → DNS → Edit on the one zone only** (never account-wide). Same token the provisioner used in Step 1.
- [ ] Store `POSTGRES_PASSWORD` in the 1Password `mailbox<N>` item; store the dashboard password (Step 3) in the `<DOMAIN>` item.
- [ ] **Verify** Postgres comes up clean:
      ```bash
      docker compose up -d postgres
      docker compose ps postgres        # → healthy
      ```

---

## Step 3 — Caddy basic_auth hash (`$$` escaping)

Gates `/dashboard/*` and the n8n editor behind one password.

- [ ] `MAILBOX_BASIC_AUTH_USER` — leave at `admin` unless the customer wants otherwise.
- [ ] Pick a strong password:
      ```bash
      openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 28
      ```
- [ ] Generate the bcrypt hash **non-interactively** (the `--plaintext` flag is REQUIRED without a TTY — piping `echo` returns empty):
      ```bash
      docker run --rm caddy:2 caddy hash-password --plaintext 'YOUR-PASSWORD'
      ```
- [ ] **Escape every `$` to `$$`** before pasting into `.env` (Compose truncates at the first un-escaped `$`):
      ```bash
      # given the hash above, produce the .env-safe value:
      echo '<paste-hash>' | sed 's/\$/\$\$/g'
      ```
      Set `MAILBOX_BASIC_AUTH_HASH=$$2a$$14$$...`
- [ ] Store the **plaintext** password in 1Password (`<DOMAIN>` item, username `admin`).
- [ ] **Verify** the container actually picked up the hash (use `up -d`, NOT `restart` — restart reuses the baked-in env):
      ```bash
      docker compose up -d caddy
      docker exec mailbox-caddy-1 sh -c 'echo ${MAILBOX_BASIC_AUTH_HASH:0:10}'
      # → first 10 chars should match your $$-unescaped hash (i.e. $2a$14$...)
      ```
      (Rotation later is automated by `bin/rotate-basic-auth` — see root CLAUDE.md.)

---

## Step 4 — Gmail OAuth (n8n credential)

The active ingress is n8n's Gmail Get + Gmail Reply nodes over OAuth (DR-22 killed Pub/Sub and IMAP). The refresh token lives in n8n's encrypted credential store — there is **no `.env` var for it**. See provisioning.v0.1.0 §7 for the deep walkthrough (watch registration / historyId is not used on the polling path).

- [ ] Open the n8n editor: `https://<DOMAIN>/` (basic_auth from Step 3).
- [ ] Create a **Gmail OAuth2** credential; complete the Google consent flow signed in as the **customer's mailbox**. This stores a refresh-token-bearing credential.
- [ ] On a **fresh install**, import the Postgres credential the MailBOX-Classify workflow references by hardcoded ID (`JFX4tvrffvKnTouV`) — fresh appliances need an explicit `n8n import:credentials` step or every classify fails silently:
      ```bash
      # see project memory: project_n8n_postgres_credential_gotcha
      docker exec mailbox-n8n-1 n8n import:credentials --input=<creds.json>
      ```
- [ ] Confirm the four `MailBOX*` workflows are present and point at the new Gmail + Postgres credentials.
- [ ] **Verify** the credential works — in the n8n editor, run the `Gmail Get` node once and confirm it returns recent messages without an auth error.

---

## Step 5 — Cloud drafting key (Ollama Cloud, or Anthropic alt)

Cloud route handles `escalate` / `unknown` / `confidence < 0.75`. See provisioning.v0.1.0 §9 for pooled-key allocation.

- [ ] `OLLAMA_CLOUD_API_KEY` — allocate a slot from the pooled UMB Ollama Cloud account and set it. This var **is** forwarded to the dashboard container.
- [ ] (Optional alt-cloud) `ANTHROPIC_API_KEY` — set only if the customer prefers Haiku 4.5. Also forwarded to the container.
- [ ] If you need to change the cloud base URL or model, note the **audit finding** below: `OLLAMA_CLOUD_BASE_URL` / `OLLAMA_CLOUD_MODEL` are NOT plumbed through compose — you must add them to the dashboard `environment:` block first. The defaults (`https://ollama.com`, `gpt-oss:120b`) are baked into `router.ts` and need no action for a standard install.
- [ ] Apply env to the dashboard (`up -d`, not `restart`):
      ```bash
      docker compose up -d mailbox-dashboard
      ```
- [ ] **Verify** the cloud route (after the pipeline is live, Step 8): an `escalate`/`unknown` email yields `drafts.draft_source='cloud'`, `drafts.model='gpt-oss:120b'`.

---

## Step 6 — Persona overrides (initial defaults + extraction)

Per-appliance persona is a prompt-layer override (no vertical lock-in) — `business_description`, `tone`, `signoff`, `operator_first_name`, `operator_brand`. Resolver: `dashboard/lib/drafting/persona.ts:getPersonaContext`, three-layer fallback per field (operator override → extraction-derived → hardcoded Heron Labs default). Related: STAQPRO-149 (settings UI), STAQPRO-153 (extraction from sent history), STAQPRO-195 (resolver).

- [ ] Set `MAILBOX_OPERATOR_EMAIL` in `.env` to the connected mailbox address (drives RAG H2 voice-priming; forwarded to the container). `docker compose up -d mailbox-dashboard` to apply.
- [ ] Open the persona settings UI: `https://<DOMAIN>/dashboard/settings/persona` (route: `dashboard/app/settings/persona/page.tsx`). Set the customer's `business_description`, tone, signoff, operator name/brand. Until set, drafts use the hardcoded Heron Labs defaults — fine for a first smoke, wrong for a real customer.
- [ ] (Optional) Trigger sent-history extraction to auto-populate persona fields (STAQPRO-153) via the persona refresh route (`dashboard/app/api/persona/refresh/route.ts`). Operator overrides always win over extraction.
- [ ] **Verify** the persona reads back: `GET https://<DOMAIN>/dashboard/api/persona` returns the values you set. (Dashboard runs under basePath `/dashboard` — include it when hand-probing.)

---

## Step 7 — Bring the full stack up + gate checks

- [ ] Run migrations and Qdrant bootstrap (idempotent profiles):
      ```bash
      docker compose --profile migrate run --rm mailbox-migrate
      docker compose --profile qdrant-bootstrap run --rm mailbox-qdrant-bootstrap
      ```
- [ ] Full-stack up:
      ```bash
      docker compose up -d --build --remove-orphans
      ```
- [ ] **n8n activation gate** — all four `MailBOX*` workflows must be `active=t` or the pipeline silently dark-classifies:
      ```bash
      docker compose --profile n8n-verify run --rm mailbox-n8n-verify   # exit 0 = green
      ```
      If any are inactive: toggle Active in the editor (or `n8n update:workflow --active=true --id=<id>`) then `docker compose restart n8n` (the CLI flag is a no-op without the restart).
- [ ] **Infra smoke** (GPU / Qdrant / Postgres — does NOT exercise the pipeline):
      ```bash
      ./scripts/smoke-test.sh        # Checks 1-5; exit 0 = pass
      ```

---

## Step 8 — Pipeline smoke (the real "is it live" test)

Mirrors provisioning.v0.1.0 §8. Proves: inbound email → queue → draft → approve → reply lands.

- [ ] Send a test email from a known external account (e.g. `provisioning-test@umbadvisors.com`) to the **customer's connected Gmail**.
- [ ] Wait ≤ 5 min (next Schedule trigger fire; the 30s/60s draft budget starts after that).
- [ ] **Verify** classification + draft in Postgres:
      ```bash
      docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -c \
        "SELECT classification, draft_source, status FROM mailbox.drafts ORDER BY created_at DESC LIMIT 5;"
      ```
- [ ] **Verify** the draft is visible at `https://<DOMAIN>/dashboard/queue`.
- [ ] Click **Approve**. Confirm the reply lands at the sender mailbox within ~30s.
- [ ] **Verify** final state: `status='sent'` for that draft.
- [ ] Record time-to-onboard (target < 2h, blank box → first live draft) — append the measured number to the MBOX-182 acceptance checklist.

---

## Handoff (after smoke passes)

- [ ] Share the `<DOMAIN>` 1Password item to the customer's 1Password account (do not email the password).
- [ ] Confirm the dashboard `/status` page shows **Classify lag** green ("caught up").
- [ ] Note any deviations from this runbook so v0.2.0 can absorb them.

---

## Audit findings (MBOX-182 — `.env.example` vs. actual config surface)

Verified 2026-05-22 by diffing `docker-compose.yml` `${...}` interpolations and the `mailbox-dashboard` `environment:` block, the Caddyfile `{env.*}`/`{$*}` reads, and `process.env.*` reads in `dashboard/lib` + `dashboard/app`, against `.env.example`. The dashboard runtime has **no dotenv loader** — it only sees keys that compose forwards into its `environment:` block.

### A. Vars compose expects but `.env.example` did not document (FIXED)

| Var | Status | Resolution |
|-----|--------|-----------|
| `LOCAL_INFERENCE_RUNTIME` | compose-interpolated, forwarded to dashboard, undocumented | Added to `.env.example` §3 Fleet defaults |
| `LLAMA_CPP_BASE_URL` | same | Added to `.env.example` §3 |
| `LLAMA_CPP_MODEL` | same | Added to `.env.example` §3 |

No Caddyfile env var is missing from `.env.example`.

### B. Documented in `.env.example` but a SILENT NO-OP in the container (FLAGGED, not auto-fixed)

These are read by `dashboard/lib` via `process.env` but are **not** forwarded by the `mailbox-dashboard` `environment:` block, so a value in `.env` has no runtime effect. They now carry an explicit `[NO-OP in container]` marker in `.env.example`. To make any of them tunable, add it to the dashboard `environment:` block in `docker-compose.yml` first.

- `OLLAMA_CLOUD_BASE_URL`, `OLLAMA_CLOUD_MODEL` — read in `lib/drafting/router.ts` (defaults `https://ollama.com`, `gpt-oss:120b`). The companion `OLLAMA_CLOUD_API_KEY` *is* forwarded, so the cloud route works on defaults; only base-URL/model overrides are dead.
- The RAG tunable block — `RAG_CLOUD_ROUTE_ENABLED`, `RAG_RETRIEVE_TOP_K`, `RAG_RETRIEVE_TOP_K_OUTBOUND`, `RAG_RETRIEVE_TOP_K_INBOUND`, `RAG_MIN_INBOUND_CHARS`, `RAG_MIN_SCORE`, `RAG_RETRIEVE_EXCLUDE_SAME_THREAD` — all read in `lib/rag/retrieve.ts`, none forwarded. They run on baked-in defaults today. Notably `RAG_CLOUD_ROUTE_ENABLED` cannot currently be turned on via `.env` alone.

**Recommendation (out of MBOX-182 scope — flag to a follow-up):** decide per-var whether to (a) plumb it through the dashboard `environment:` block so it becomes a real knob, or (b) treat it as a code constant and drop it from `.env.example`. The dozens of other `process.env.*` reads in `dashboard/lib`/`app` (KB_*, EMBED_*, THREAD_HISTORY_*, OPERATOR_*, STUCK_STUB_*, CLASSIFY_SWEEPER_*, etc.) are intentionally code-tunable internals and were never in `.env.example` — leave them as-is.

### C. Customer-specific values correctly isolated

All customer-binding values are in `.env` (none hardcoded in compose or workflow JSONs): `DOMAIN`, `CADDY_EMAIL`, `MAILBOX_OPERATOR_EMAIL`, `OLLAMA_IMAGE` (digest pin), the basic_auth pair, and all secrets. Gmail OAuth is correctly isolated to n8n's encrypted credential store (not an env var). Persona is per-appliance in `mailbox.persona`, set via UI/extraction — also not in `.env`. No isolation gaps found.

### D. Dead / not-the-active-path entries (kept, clearly labeled)

- IMAP/SMTP block — DR-22 settled on Gmail nodes; read by nothing in the live stack. Kept commented as emergency reference with a "read by nothing" label.
