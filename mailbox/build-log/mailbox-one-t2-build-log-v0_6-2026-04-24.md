# MailBOX One — T2 Build Log

**Version:** v0.6
**Date:** 2026-04-23 → 2026-04-24 (extended session, into early Friday morning)
**Hardware:** NVIDIA Jetson Orin Nano 8GB Developer Kit Super
**JetPack:** 6.2 (L4T R36.5)
**Operator:** Dustin
**Supersedes:** v0.5 (same date)

---

## Headline

**Workflow #1 architecture proven end-to-end. Manual execution: classify + persist works.**
**Auto-scheduled trigger: blocked by tooling, not architecture.**

The MailBOX intake-classify pipeline runs the full chain successfully when triggered manually. One real test email made it from Gmail through Ollama (Qwen3-4B) classification into Postgres with a clean record. The remaining gap is automating the Gmail polling — a known n8n 2.0 bug, attempted workaround via downgrade to 1.x left a Gmail Trigger that can't find emails in test mode. To be diagnosed fresh next session.

This is meaningful progress: we now have a working blueprint of the pipeline shape and content flow. Tomorrow's task is purely operational — get the trigger to fire — not redesign anything.

---

## Status at a glance

| Component | State |
|---|---|
| Jetson + power/clocks/Ollama/Qwen3 | ✅ Unchanged from v0.5 — solid |
| HTTPS via Caddy + Let's Encrypt | ✅ Live, cert obtained, auto-renewing |
| Cloudflare DNS | ✅ Active for heronlabsinc.com (DNS migrated from GoDaddy) |
| n8n version | ⚠️ **Downgraded** from 2.14.2 → **1.123.35** mid-session |
| Gmail OAuth2 credential | ✅ Connected, scope `mail.google.com` granted |
| Postgres `inbox_messages` table | ✅ Created, one row from manual test, schema validated |
| Workflow architecture | ✅ All 5 nodes proven via manual execution in 2.x |
| Workflow current state in 1.x | ❌ **Needs rebuild** — JSON re-import failed (typeVersion mismatch) |
| Auto-scheduled trigger firing | ❌ **Open** — to be diagnosed next session |

---

## What we accomplished today

### Infrastructure phase fully closed

- BL-1 closed (not feasible as specified — dustynv/ollama 0.18.4-r36.4 tag never published)
- BL-2 closed (jetson_clocks.service persistent across reboots)
- BL-3 closed (model inventory deduped to canonical `qwen3:4b` only)
- BL-4 closed (compose file/`.env` drift reconciled — `OLLAMA_IMAGE` override removed)
- BL-5 closed as unreachable without custom build (BL-7)
- BL-9 closed (Gmail OAuth2 credential successfully connected)
- BL-10 closed (DNS migrated to Cloudflare; hosts-file workaround retired)
- BL-11 closed (Caddy reverse proxy with Let's Encrypt cert)
- BL-12 closed (HTTPS unblocks restricted Gmail OAuth2 scopes)

### Phase 1 deliverable progress

| # | PRD Phase 1 Deliverable | Status |
|---|---|---|
| 1 | Assembled appliance running full stack | ✅ Done |
| 2 | End-to-end IMAP→classify→draft→queue pipeline | 🟡 **IMAP→classify proven in manual mode**, draft/queue pending |
| 3 | Local model classification > 80% accuracy | 🟡 Pipeline exists, evaluation set TBD |
| 4 | Cloud API draft generation | ❌ Next session |
| 5 | RAG pipeline with email history | ❌ |
| 6 | Dashboard approval queue | ❌ |

---

## The full arc, in order

### Phase A: Gmail OAuth2 wall-banging (~3 hours)

1. App password path blocked by Workspace policy
2. OAuth2 path chosen
3. GCP project + OAuth client created
4. Redirect URI rejected (raw IPs / `.local` blocked by Google as of recent policy)
5. Hosts-file workaround applied — `mailbox.heronlabsinc.com → 192.168.1.45`
6. n8n encryption-key mismatch crashed the n8n container (set after first boot, settings file had old auto-generated key)
7. n8n volume wiped + owner re-created
8. Secure-cookie error on HTTP login → `N8N_SECURE_COOKIE: false`
9. OAuth scope rejected — Google requires HTTPS for `gmail.modify` / `mail.google.com` scopes (new 2025 policy)
10. Decision: real TLS via Caddy + Cloudflare DNS-01 challenge
11. DNS migration GoDaddy → Cloudflare (GoDaddy API restricted to 10+ domain accounts)
12. Caddy added to compose stack with custom build (Cloudflare DNS plugin baked in via `xcaddy`)
13. Let's Encrypt cert issued in ~9 seconds via DNS-01
14. n8n compose updated for HTTPS; `N8N_SECURE_COOKIE` reverted to true
15. Hosts-file workarounds removed (real DNS now resolves)
16. Google Cloud OAuth client redirect URI updated to `https://mailbox.heronlabsinc.com/rest/oauth2-credential/callback`
17. **Gmail OAuth2 credential connected successfully**

### Phase B: First workflow (~2 hours)

18. Created `inbox_messages` table in Postgres `mailbox` schema (table created in `mailbox` schema not `public` — n8n configured accordingly)
19. Built 5-node workflow: Gmail Trigger → Extract Fields → Classify (Ollama HTTP) → Merge Classification (Set) → Store in DB (Postgres)
20. Iterated through real-world data shape discoveries:
    - Gmail Trigger pre-flattens headers and parses addresses (not raw Gmail API shape)
    - `from`/`to` are objects with `value[0].address` for clean email
    - `date` is ISO-8601 (no epoch conversion needed)
    - Body lives at `text` not `body` or `snippet`
21. Hit and resolved JSON body escaping in HTTP Request node — `JSON.stringify(...)` wrapper around prompt template handles newlines/quotes from email body
22. Hit and resolved Postgres `id=0` issue by switching from Insert operation to Execute Query with explicit column list + `ON CONFLICT DO NOTHING`
23. **End-to-end manual execution succeeded:** test email 001 classified as `test` (confidence 1.0), persisted to Postgres with all 12 fields populated

### Phase C: The publish/scheduling rabbit hole (~2 hours)

24. Workflow set to "Active" in UI but scheduled polling never fired — only manual executions
25. Investigation: n8n 2.0 introduced separate "draft" vs "published" version model, distinct from the active toggle
26. Database confirmed: workflow `active: t`, `activeVersionId` populated, but `workflow_history` showed only `autosaved: t` rows — no real published version
27. Pressed Publish in UI multiple times — green indicator appeared but DB state didn't change to indicate a published (non-autosaved) version
28. Web search confirmed multiple community reports of identical symptom in n8n 2.0 (workflow active + manual works + scheduled never fires)
29. Decision: downgrade to n8n 1.x (simpler active-toggle model that predates the bug)

### Phase D: n8n downgrade (~1 hour)

30. Backed up compose file + Postgres database dump
31. Updated compose `n8nio/n8n:2.14.2 → n8nio/n8n:1.123.35`
32. Pull + recreate succeeded; n8n 1.123.35 started cleanly
33. **n8n 1.x rejected the existing workflow** — `Cannot read properties of undefined (reading 'execute')` activation error, looped infinitely with retries
34. Root cause: typeVersions in JSON export are 2.x-only (Set 3.4, HTTP Request 4.4, Postgres 2.6, Gmail Trigger 1.3) — 1.x doesn't support these node versions
35. Deleted broken workflow record from `workflow_entity` table
36. n8n restart became clean
37. Started rebuilding nodes from scratch in 1.x UI
38. Gmail Trigger added with credential + label filter — but **test step returns "No Gmail data found"** despite label having an unread email

---

## The remaining problem (carried to next session)

Gmail Trigger in n8n 1.123.35 cannot find emails in test mode despite:
- ✅ OAuth2 credential connected (survived the downgrade)
- ✅ `MailBOX-Test` label exists in Gmail with 1 unread email
- ✅ Filter set to label ID `Label_8977764561344666399`
- ✅ Simplify off

**Hypotheses for next session (in order to investigate):**

1. **Stale internal cursor state** — Gmail Trigger tracks "last seen message ID" per workflow per credential. Downgrade may have left a 2.x-shaped cursor in static_data that 1.x can't parse. **First thing to try:** delete the workflow + credential entirely and recreate from scratch. Re-OAuth from zero.

2. **Credential token state** — OAuth tokens may need a refresh that 1.x's UI doesn't expose. Test by creating a regular Gmail action node (not trigger) and trying to fetch a single message; if that fails, the credential is the issue.

3. **n8n cursor in workflow static_data** — query `SELECT static_data FROM workflow_entity` (after rebuild). If there's leftover state pointing at a message ID past current inbox, clearing it should reset the trigger.

4. **Label ID format change between 1.x and 2.x** — possible the Gmail API node in 1.x expects label names without the `Label_` prefix or uses different field for ID vs name lookup.

---

## Decisions this session (Decision Records)

| ID | Decision | Type | Rationale |
|---|---|---|---|
| BL-D5 | OAuth2 over IMAP+app-password for Gmail | Strategic | App passwords blocked by Workspace policy; OAuth2 is Google's supported path |
| BL-D6 | DNS migration GoDaddy → Cloudflare | Tactical | GoDaddy API restricted; Cloudflare DNS-01 for ACME is the gold standard |
| BL-D7 | Caddy reverse proxy + Let's Encrypt for production HTTPS | Strategic | Required by Google for sensitive Gmail scopes; right answer for shipping anyway |
| BL-D8 | Real DNS A-record over hosts-file (`mailbox.heronlabsinc.com`) | Tactical | Hosts-file was a temporary workaround during initial OAuth client setup; replaced once Cloudflare migration complete |
| BL-D9 | Postgres tables in `mailbox` schema, not `public` | Tactical | Default search_path for user `mailbox` puts `mailbox` schema first; cleaner namespace separation; documented in n8n connection config |
| BL-D10 | `id=0` Postgres bug solved via Execute Query (raw SQL) over Insert operation | Tactical | More explicit, removes ambiguity about which fields n8n sends; enables `ON CONFLICT DO NOTHING` for idempotent re-runs |
| BL-D11 | Downgrade n8n 2.14.2 → 1.123.35 | Strategic | n8n 2.0 publish/scheduling bug confirmed via community reports; 1.x has simpler model that fits single-tenant appliance |
| BL-D12 | Workflow JSON not re-importable across major n8n versions | Constraint | typeVersion incompatibility means workflows are tied to the n8n major version they were built in. Implication for MailBOX One: pin the n8n image version at the appliance level, treat workflow JSONs as version-specific |

---

## Open items going forward

| ID | Item | Priority | Notes |
|---|---|---|---|
| BL-13 | **(new)** Gmail Trigger in 1.x not finding emails in test mode | **High — blocker** | Investigate hypotheses 1–4 above. First action: rebuild credential from scratch. |
| BL-14 | **(new)** Rebuild MailBOX workflow in 1.x (5 nodes) | High | After BL-13 unblocks, rebuild Nodes 2–5. Reference: this session's chat history + saved `MailBOX.json` (use as semantic reference, not direct import). |
| BL-15 | **(new)** Decide n8n version pin strategy for T2 production | Medium | If 1.x stays, pin to `1.123.35` exactly in compose. Document in technical PRD. Add note that n8n major upgrades require workflow re-creation. |
| BL-16 | **(new)** `N8N_PROXY_HOPS=1` env var to silence X-Forwarded-For warnings | Low | Cosmetic only; n8n's rate limiter complaining about Caddy's headers. Not functionally broken. |
| BL-7 | Custom jetson-containers Ollama build | Low | Unchanged from v0.5 |
| BL-6 | Editor in T2 base image provisioning | Low | Documentation item, not this-appliance |

**Closed earlier in v0.6:** BL-1, BL-2, BL-4, BL-5 (in v0.2-v0.4); BL-9, BL-10, BL-11, BL-12 (this session, infrastructure phase fully done).

---

## What's preserved on disk

- `~/mailbox/docker-compose.yml` — current production config (n8n 1.123.35, Caddy added)
- `~/mailbox/docker-compose.yml.backup-pre-n8n-downgrade-*` — pre-downgrade snapshot
- `~/mailbox/docker-compose.yml.backup-pre-caddy-*` — pre-Caddy snapshot
- `~/mailbox/.env` — runtime env including N8N_ENCRYPTION_KEY, CLOUDFLARE_API_TOKEN
- `~/mailbox/.env.backup-*` — multiple safety backups
- `~/mailbox/caddy/Caddyfile` — Caddy config
- `~/mailbox/caddy/Dockerfile` — Caddy image build with cloudflare plugin
- `~/mailbox/secrets-2026-04-23.md` — credential documentation
- `~/mailbox/backups/mailbox-db-pre-downgrade-*.sql` — DB dump before downgrade
- `~/mailbox/backups/MailBOX-workflow-pre-downgrade-*.json` — exported workflow (n8n 2.x format, won't re-import to 1.x)
- `MailBOX.json` (separately saved, attached in chat) — same workflow export, semantic reference

On main box:
- `~/.secrets/mailbox/secrets-2026-04-23.md` — mirrored secrets

---

## Postgres state at session end

- `inbox_messages` table exists in `mailbox` schema with 14 columns + 2 indexes
- Contains 1 row: test email 001, classified as `test` with confidence 1.000
- This row is the proof-of-concept — full pipeline ran successfully end-to-end (manual mode, in n8n 2.x)

---

## Next-session kickoff plan

**Total estimated time: 60-90 min** if BL-13 yields to standard troubleshooting.

### Step 1 — Five-min sanity check

```
ssh mailbox
sudo docker compose ps
sudo docker logs --tail 20 mailbox-n8n-1
sudo docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -c "SELECT id, subject, classification FROM mailbox.inbox_messages ORDER BY id;"
```

Expect: 5 healthy containers, n8n 1.123.35 running, 1 row in inbox_messages from yesterday.

### Step 2 — BL-13 diagnosis (Gmail Trigger empty results)

Order of investigation:

1. **Minimal test workflow** — create a brand new workflow with just Gmail Trigger → no-op. See if test step finds emails. If yes → issue is workflow-state-specific. If no → credential or n8n-1.x-Gmail-node issue.
2. **Test credential outside trigger** — add a regular Gmail (not Trigger) node, action: "Get many messages." Run with same label filter. If this works, the credential is fine and the trigger node specifically is broken.
3. **Recreate credential from scratch** — delete Gmail OAuth2 credential, create new one (same Client ID/Secret), re-OAuth. If credential token state was bad, this fixes it.
4. **Reset Gmail Trigger cursor** — `UPDATE workflow_entity SET "staticData" = NULL WHERE id = '<new-workflow-id>';` then restart trigger.

Likely fix is one of these. If none work after 30 min, re-evaluate (back to n8n 2.x with Schedule-Trigger-calls-subworkflow pattern? Stay on 1.x and use IMAP node instead of Gmail node?).

### Step 3 — BL-14 rebuild workflow once trigger works

Reference: the 5-node spec from chat session ~step 22-23 of v0.6 timeline. All field expressions documented in chat. Rebuild in 1.x UI in this order:

1. Gmail Trigger (already started, finish config)
2. Set node `Extract Fields` — 8 fields, no `=` prefix on names
3. HTTP Request `Classify` — Specify Body: Using JSON, with `JSON.stringify(...)` wrapper
4. Set node `Merge Classification` — 12 fields, `$('Extract Fields').item.json.X` syntax for prior-node refs
5. Postgres `Store in DB` — Execute Query operation with `ON CONFLICT DO NOTHING`

Truncate `inbox_messages` for clean test:
```
sudo docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -c "TRUNCATE mailbox.inbox_messages RESTART IDENTITY;"
```

### Step 4 — Validate auto-trigger works

```
# After save + activate, wait 2-3 min
sudo docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -c "SELECT id, status, mode, \"startedAt\" FROM execution_entity ORDER BY \"startedAt\" DESC LIMIT 5;"
sudo docker exec mailbox-postgres-1 psql -U mailbox -d mailbox -c "SELECT id, subject, classification FROM mailbox.inbox_messages;"
```

**Success criteria:** at least one execution with `mode = trigger` AND a new row corresponds to a fresh test email.

### Step 5 — Lock in + plan ahead

If Steps 1–4 succeed: workflow #1 closed. Move to drafting workflow #2 (LLM-driven response generation for `action_required` classified emails).

If Step 4 still shows only manual executions even after 1.x rebuild: this is genuinely a Gmail Trigger / scheduling issue at the n8n level, not a workflow design issue. Decision needed: either accept manual triggers, switch to IMAP-based polling, or escalate to n8n's bug tracker.

---

## T2 production baseline (unchanged)

| Spec | Value |
|---|---|
| Generation rate | 18.66 t/s |
| GPU offload | 100% |
| Inference runtime | `ollama/ollama:latest` + Qwen3-4B Q4_K_M |
| Per-email latency estimate | 5–17s (100–300 output tokens) |
| n8n version | **1.123.35** (downgraded; pin recommended) |
| Public TLS | mailbox.heronlabsinc.com via Caddy + Let's Encrypt |
| DNS | Cloudflare-hosted |

---

## Reflections

This session went deeper than expected. The pattern "everything looks like it should work, then doesn't, then unwinds three layers down to find a tooling bug" repeated three times today — Gmail app passwords (Workspace policy), Gmail OAuth scopes (HTTPS requirement), n8n publishing (2.0 bug). Each one was a real wall, not a misconfiguration.

The wins are real: the entire HTTPS+OAuth+TLS stack is now legitimate production-quality, not workaround-quality. The classify pipeline is architecturally proven. We have one clean test row in Postgres that demonstrates end-to-end success.

The lesson worth carrying forward: for MailBOX One's hardware appliance model, **pin every component version explicitly** in the compose file. The n8n 2.0 surprise wouldn't have happened if Phase 02's first action was "lock the n8n image to a specific known-good tag." Add this to the technical PRD's appliance provisioning checklist.

---

## Related artifacts

- Build log v0.5: `mailbox-one-t2-build-log-v0_5-2026-04-23.md`
- Build log v0.4 (and earlier): chronologically prior infrastructure work
- Technical PRD: `thumbox-technical-prd-v2_1-2026-04-16.md` — **needs amendment**: pin n8n version, document downgrade pattern, document HTTPS/Cloudflare stack
- Business PRD: `thumbox-business-prd-v2_1-2026-04-16.md`
- Saved workflow JSON (2.x format, reference only): `MailBOX.json`
- Cloudflare zone: heronlabsinc.com — DNS migrated this session
- Google Cloud project: heron-mailbox (or similar) — OAuth client `n8n-mailbox-one`
