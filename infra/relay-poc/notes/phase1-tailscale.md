# Phase 1 — tag:box enrollment of agentboxhonduras (MBOX-498)

**Applied:** 2026-07-09. **Target:** agentboxhonduras (device id `1195297404771952`,
node `n1VFZHSMLA11CNTRL`). **Tailnet:** tail377a9a (`consultingfutures@gmail.com`).

## What changed (ADDITIVE — production fleet policy preserved verbatim)

1. **ACL** (`POST /api/v2/tailnet/-/acl`, HTTP 200, fail-closed tests passed) — two additions
   only (see `prior-acl.hujson` vs `new-acl.hujson`):
   - `tagOwners += "tag:box": ["autogroup:admin"]`
   - `ssh += { action:accept, src:[autogroup:member], dst:[tag:box], users:[carlos, autogroup:nonroot] }`
     — the **anti-lockout rule**: without it, re-tagging severs SSH (user-owned `autogroup:self`
     rules stop applying to a tagged device, and nothing else grants `dst:tag:box`).
   - Network reachability to `tag:box` is already covered by the existing
     `autogroup:member → *:*` grant, so no new grant was needed.
2. **Device re-tag** — `POST /api/v2/device/1195297404771952/tags {"tags":["tag:box"]}` (HTTP 200).
   - **Deviation from the spec's method:** the spec called for `sudo tailscale up --authkey …
     --advertise-tags=tag:box` on the box. `carlos` has **no passwordless sudo** on honduras, so
     that path needed the physical console. The admin **device/tags API** achieves the same
     end-state (device carries `tag:box`) without sudo or console — cleaner and fully in-band.
   - A scoped `tag:box` auth key WAS minted (id `kLysYdzN9t11CNTRL`, non-reusable, preauthorized,
     1-day) per the spec, but the API re-tag made it unnecessary; it was **revoked** (`DELETE …/keys/…`,
     HTTP 200) and the staged key files removed from both machines. No key value in any committed file.

## Prior state (rollback baseline)
- `prior-acl.hujson` — the full policy before the change.
- `prior-box-state.txt` — honduras was **untagged** (`Self.Tags: None`), `RunSSH: True`,
  `AdvertiseTags: None`, **no Serve/Funnel config**, Hostname `agentboxhonduras`.

## Rollback procedure
1. **Un-tag the device:** `curl -X POST -H "Authorization: Bearer $TS_API_KEY" -H 'Content-Type: application/json' \
   --data '{"tags":[]}' https://api.tailscale.com/api/v2/device/1195297404771952/tags`.
   If the device then needs its user ownership restored, re-auth **at the honduras console**:
   `sudo tailscale up --reset --ssh --hostname=agentboxhonduras` (logs in as the user again).
2. **Restore the ACL:** re-POST `prior-acl.hujson` to `…/tailnet/-/acl` (removes the `tag:box`
   tagOwner + ssh rule; production `tag:mailbox`/`tag:fleet-worker` policy was never altered).

## Verification (post-re-tag)
- `Self.Tags: ['tag:box']` (via `tailscale status --json` over SSH).
- **Fresh SSH connects, exit 0** — the anti-lockout rule works; no lockout.
- Sidecar `:9200/healthz` → 200 (box health intact).
- `tailscale serve status` → "No serve config" — unchanged vs capture (baseline had none; no regression).
