# gbrain-ingest

Phase-2 ingestion pipelines for the agentbox2 gbrain memory layer. Pulls
mailbox email threads, CRM contacts, and recent Google Drive docs into
per-entity gbrain sources so hermes memory recall has real knowledge to
draw on.

Runs ON the box (`UMB@agentbox2`) with stock python3 (stdlib + PyYAML,
which is already installed). No psycopg2, no pip installs: DB reads go
through `docker exec mailbox-postgres-1 psql` (read-only SELECTs), gbrain
writes go through the local wrapper CLI (`~/.local/bin/gbrain capture`,
which upserts via put_page), LLM calls hit the local ollama.

## Layout

| File | What |
|---|---|
| `entity_map.yaml` | Canonical 11 entity slugs, account map, CRM company map, domain heuristics, classifier + summarizer config |
| `attribution.py` | 5-rung attribution ladder, pure function, no I/O |
| `common.py` | Shared I/O: entity-map loader, psql-via-docker, gbrain capture, ollama, watermarks |
| `ingest_contacts.py` | crm_contacts -> one contact page per contact, plain fact sentences |
| `ingest_email.py` | inbox_messages -> one page PER THREAD, qwen3 summary, watermark-incremental |
| `ingest_drive.py` | recent Google Docs per connected account -> distilled pages |
| `systemd/` | user units: email 15min, contacts daily, drive daily, dream nightly |
| `tests/test_attribution.py` | ladder unit tests (`uv run --with pytest --with pyyaml -- pytest tests/`) |

## Attribution ladder (write-time, first match wins)

1. **Account provenance** — `dustin@heronlabsinc.com` -> `heron`,
   `dustin@umbadvisors.com` -> `umb`.
2. **CRM contact match** — participant email found in `crm_contacts.emails`
   -> company -> entity (via `companies:` in entity_map).
3. **Domain heuristics** — participant domain in `domains:` map (generic
   providers like gmail.com never match).
4. **LLM classifier** — local `qwen3:4b-instruct` (ollama :11435) over
   subject+snippet; accepted only at confidence >= 0.6.
5. **Default** — `consultingfutures@gmail.com` -> `personal`; anything
   else unresolved -> `unsorted`.

Sources are the recall boundary; tags (`entity:<slug>`, `account:<x>`) are
decoration only. No `visibility` frontmatter is written: gbrain (≤0.41.x)
ignores page-frontmatter visibility — facts extracted from pages default
to `private` regardless, and the `query` op (hermes recall path) has no
world/private filter — so the earlier `visibility: world` stamp was a
no-op, and a latent exposure if a future gbrain starts honoring it.

## Deploy to the box

```sh
scp -r gbrain-ingest UMB@100.127.2.54:~/
ssh UMB@100.127.2.54
mkdir -p ~/.config/systemd/user
cp ~/gbrain-ingest/systemd/* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now gbrain-ingest-email.timer \
    gbrain-ingest-contacts.timer gbrain-ingest-drive.timer gbrain-dream.timer
```

All jobs share `flock /tmp/gbrain-ingest.lock` so at most ONE LLM consumer
runs at a time (8GB box constraint).

## Backfill (first run)

Always dry-run first; back up the gbrain postgres before any bulk write
(`docker exec gbrain-postgres pg_dumpall ... | gzip > ~/backups/...`).

```sh
cd ~/gbrain-ingest
python3 ingest_contacts.py --dry-run | sort | uniq -c   # check entity split
python3 ingest_contacts.py                              # 765 contacts, no LLM

python3 ingest_email.py --backfill --dry-run            # check attribution
python3 ingest_email.py --backfill                      # 1 qwen3 call/thread, serial

python3 ingest_drive.py --dry-run
python3 ingest_drive.py --limit 25                      # per account
```

Re-running anything is safe: slugs are stable
(`contacts/<id>-<name>`, `email/<thread_id>`, `drive/<name>-<idhash>`)
and `gbrain capture` upserts by slug.

## Watermarks

`~/.hermes/gbrain-ingest/email.watermark` holds the max `received_at`
processed. The timer run only rebuilds threads with newer messages (a new
message refreshes its whole thread page). On any write error the watermark
is NOT advanced, so the next run retries.

- Reset / full re-ingest: `python3 ingest_email.py --backfill`
- Ingest from a point: `python3 ingest_email.py --since '2026-06-01T00:00:00Z'`

## Adding an entity

1. Create the source on the box (CLI only — the HTTP MCP clients lack the
   `sources_admin` scope): `gbrain sources add <slug> --name "<Display>"`,
   then `gbrain sources federate <slug>`.
2. Extend the hermes read client's `federated_read` list to include it
   (`gbrain auth register-client ... --federated-read ...`).
3. Add the slug under `entities:` in `entity_map.yaml`, plus any
   `companies:` / `domains:` / `accounts:` rules that should resolve to it.
   Quote YAML-boolean-ish slugs (see `"yes"`).
4. Run the tests: `uv run --with pytest --with pyyaml -- pytest tests/`.

## Troubleshooting

- `psql failed` — the mailbox container must be up; never restart it, just
  wait/check `docker ps`.
- ollama timeouts — summaries degrade to snippets and the classifier rung
  is skipped; pages still get written (attribution falls to rung 5).
  Check `curl http://127.0.0.1:11435/api/tags`.
- `gbrain capture: source not registered` — create the source (above).
- Logs: `journalctl --user -u gbrain-ingest-email.service -n 50`.
