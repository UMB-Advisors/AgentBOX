# Deploying the MailBox One Dashboard to the T2 Appliance

This runbook walks through deploying the dashboard as a 7th container in the
existing Jetson compose stack at `/home/bob/mailbox/`. Reachable at
`https://mailbox.heronlabsinc.com/dashboard` when done.

> **Pre-reqs:** All steps run on the Jetson. Use Tailscale SSH
> (`tailscale ssh bob@mailbox1.tail377a9a.ts.net`) or any
> LAN-connected SSH session as `bob`.

---

## 1. Get the source onto the Jetson

Clone (or rsync) this repo to `/home/bob/mailbox/dashboard`. Either:

```bash
# Option A: clone (if you push this to a remote)
cd /home/bob/mailbox
git clone <url> dashboard

# Option B: rsync from the dev box (run on your dev box, not the Jetson)
rsync -avz --exclude node_modules --exclude .next --exclude .git \
  ~/Desktop/mailboxdashboard/ bob@192.168.1.45:/home/bob/mailbox/dashboard/
```

Verify on the Jetson:

```bash
ls /home/bob/mailbox/dashboard/Dockerfile
ls /home/bob/mailbox/n8n/workflows/MailBOX-Send.json
```

Both should exist.

---

## 2. Import the n8n workflows

See `n8n/workflows/README.md` for the full procedure (STAQPRO-139). TL;DR:

```bash
# From a workstation with ssh access to the target appliance:
SSH_HOST=jetson-dustin ./scripts/n8n-import-workflows.sh
```

This imports all 4 workflows: `MailBOX`, `MailBOX-Classify`, `MailBOX-Draft`,
`MailBOX-Send`.

Then on the target appliance:

1. Re-link credentials in the n8n UI for each imported workflow (credential
   IDs differ across appliances): Postgres on Load Draft / Mark Sent /
   Mark Failed; Gmail OAuth2 on Gmail Reply / Get many messages.
2. Activate `MailBOX` (schedule) and `MailBOX-Send` (webhook). Sub-workflows
   (`MailBOX-Classify`, `MailBOX-Draft`) **stay inactive**.
3. Restart n8n: `docker compose restart n8n`.
4. Smoke-test the send webhook:
   ```bash
   sudo docker exec -it mailbox-n8n-1 wget -qO- \
     --post-data='{"draft_id":999999}' \
     --header='Content-Type: application/json' \
     http://localhost:5678/webhook/mailbox-send
   ```
   Expect: `{"success":false,"error":"Draft not found...","draft_id":999999}`.

---

## 3. Add the dashboard service to compose

Edit `/home/bob/mailbox/docker-compose.yml`. Add the block from
`deploy/docker-compose.snippet.yml` under `services:`, alongside `postgres`,
`ollama`, `n8n`, `qdrant`, `caddy`.

(Inline copy of that snippet — paste verbatim, indented as part of `services:`):

```yaml
  mailbox-dashboard:
    build:
      context: ./dashboard
      dockerfile: Dockerfile
    container_name: mailbox-dashboard
    restart: unless-stopped
    environment:
      POSTGRES_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      N8N_WEBHOOK_URL: http://n8n:5678/webhook/mailbox-send
      NODE_ENV: production
      PORT: "3001"
    depends_on:
      postgres:
        condition: service_healthy
      n8n:
        condition: service_started
    networks:
      - default
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3001/dashboard/queue"]
      interval: 30s
      timeout: 10s
      retries: 3
```

Validate the YAML:

```bash
cd /home/bob/mailbox
sudo docker compose config | grep -A 2 'mailbox-dashboard:'
```

Should print the resolved service definition without errors.

---

## 4. Add the Caddy reverse-proxy block

Edit `/home/bob/mailbox/caddy/Caddyfile`. Inside the existing
`mailbox.heronlabsinc.com { ... }` site block, add the block from
`deploy/Caddyfile.snippet` **before** any catch-all `handle` that proxies n8n
at `/`:

```caddy
	handle /dashboard/* {
		reverse_proxy mailbox-dashboard:3001
	}
```

Why `handle` (not `handle_path`): the Next.js app is built with
`basePath=/dashboard`, so it expects to receive the full prefixed path. A
`handle_path` strip would break `/_next/static/*` asset loading.

---

## 5. Build and start the dashboard

From `/home/bob/mailbox`:

```bash
sudo docker compose build mailbox-dashboard
```

First build downloads `node:20-alpine` and runs `npm ci` + `npm run build`.
Expect 3-6 minutes on the Jetson. Subsequent rebuilds are much faster
(layer cache).

Start it:

```bash
sudo docker compose up -d mailbox-dashboard
```

Watch logs until it serves:

```bash
sudo docker logs -f mailbox-dashboard
```

Look for `▲ Next.js 14.2.35 - Local: http://0.0.0.0:3001`. Press Ctrl-C to stop following.

---

## 6. Reload Caddy

```bash
sudo docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

If reload fails (typo in Caddyfile), Caddy keeps the old config running. Fix
and re-reload.

---

## 7. Verify

**Inside the container** (basic liveness):

```bash
sudo docker exec mailbox-dashboard wget -qO- http://localhost:3001/dashboard/queue | head -20
```

Should return HTML containing `<title>MailBox One</title>`.

**From your phone or laptop browser:**

<https://mailbox.heronlabsinc.com/dashboard>  → 307 redirect → `/dashboard/queue` → renders the queue.

If you have a `pending` draft in `mailbox.drafts`, it appears as a card. Tap it
to expand. Click **Approve** to send a real Gmail reply.

---

## 8. Production hardening checklist (per Pitfall #9)

- [ ] Confirm `postgres` service in compose does **not** publish port 5432 to
      the host. (Container-network-only.)
- [ ] Confirm `n8n` service does **not** publish port 5678 to the host either —
      only Caddy faces the public network.
- [ ] If you temporarily exposed 5432 for dev, remove the `ports:` block now.

---

## Updating later

```bash
# On the dev box: rsync new code
rsync -avz --exclude node_modules --exclude .next --exclude .git \
  ~/Desktop/mailboxdashboard/ bob@192.168.1.45:/home/bob/mailbox/dashboard/

# On the Jetson:
cd /home/bob/mailbox
sudo docker compose build mailbox-dashboard
sudo docker compose up -d mailbox-dashboard
```

Caddy doesn't need a restart for app updates (only Caddyfile changes).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `502 Bad Gateway` from Caddy | Container not yet healthy | `docker logs mailbox-dashboard` — wait for "Local: http://..." line |
| `404` at `/dashboard/queue` from browser | Caddy `handle` block placed after a catch-all | Move the `handle /dashboard/*` block ABOVE the `/` proxy |
| Dashboard renders but assets 404 | basePath mismatch — image was built without `BASE_PATH=/dashboard` | Rebuild: `docker compose build --no-cache mailbox-dashboard` |
| Approve returns 502 | n8n webhook unreachable | Confirm `MailBOX-Send` workflow is **Active** in n8n; check `N8N_WEBHOOK_URL` env in compose |
| Empty queue on first load but data exists in DB | wrong POSTGRES_URL | `docker exec mailbox-dashboard env \| grep POSTGRES_URL` and compare to `~/.env` |
| Container restarts on boot loop | healthcheck failing — `/dashboard/queue` errors out | `docker logs mailbox-dashboard --tail 100` to see the request error |
