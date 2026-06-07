#!/bin/sh
# caddy/entrypoint.sh — fail-fast guard for the appliance Caddy container.
#
# STAQPRO-239: surfaced 2026-05-08 customer-#2 install. If
# MAILBOX_BASIC_AUTH_HASH is empty, Caddy's `basic_auth` directive matches
# nothing and the dashboard / n8n editor end up effectively unauthenticated
# at the public edge. The failure mode is silent: the container reports
# healthy, the listeners come up, the public surface answers — but
# /dashboard/queue and the n8n editor are reachable without credentials.
#
# A second related footgun: `docker compose restart caddy` does NOT re-read
# .env. So an operator who notices an empty hash in their .env, fills it,
# and runs `restart` keeps the OLD empty hash in the container's env and
# the public surface stays unauthenticated. Only `docker compose up -d` (or
# stop+start) re-reads .env. We surface that in the error message.
#
# This wrapper validates env BEFORE handing off to the upstream caddy CMD,
# so any mode of container start (up -d, restart, restart-after-host-reboot,
# etc.) is gated on the hash being non-empty and bcrypt-shaped.
#
# Healthy invocations cost a few hundred microseconds and one process exec.

set -eu

if [ -z "${MAILBOX_BASIC_AUTH_USER:-}" ]; then
    cat >&2 <<'EOF'
FATAL: MAILBOX_BASIC_AUTH_USER is empty.

Caddy refuses to start without a basic_auth username. Set in .env, then:

  docker compose up -d caddy

Note: 'docker compose restart caddy' does NOT re-read .env — use 'up -d'
or 'stop' + 'start' to apply env changes.
EOF
    exit 1
fi

if [ -z "${MAILBOX_BASIC_AUTH_HASH:-}" ]; then
    cat >&2 <<'EOF'
FATAL: MAILBOX_BASIC_AUTH_HASH is empty.

Caddy refuses to start without a basic_auth hash — leaving the dashboard
and n8n editor exposed at the public edge would silently break the
appliance security model (STAQPRO-131).

Generate a hash:
  docker run --rm caddy:2 caddy hash-password

Set in .env (escape every $ as $$ — Docker Compose treats $ as variable
expansion and silently truncates values mid-hash):
  MAILBOX_BASIC_AUTH_HASH=$$2a$$14$$abcdef...

Then bring Caddy up via:
  docker compose up -d caddy

NOT 'docker compose restart caddy' — restart does NOT re-read .env, so a
hash you just added will be ignored by a restarted container and Caddy
will keep failing this check.
EOF
    exit 1
fi

# Sanity-check bcrypt shape. If the hash made it through .env unescaped,
# Docker Compose's $-truncation may have left the operator with something
# like "2a14abcdef..." (no $ delimiters) — the basic_auth match would
# fail closed (good), but the operator would be staring at "why is the
# password not working" with no hint. Surface the unescaped-$ trap here.
case "${MAILBOX_BASIC_AUTH_HASH}" in
    \$2a\$*|\$2b\$*|\$2y\$*) ;;
    *)
        cat >&2 <<EOF
FATAL: MAILBOX_BASIC_AUTH_HASH does not look like a bcrypt hash.

Got (first 12 chars): $(echo "${MAILBOX_BASIC_AUTH_HASH}" | cut -c1-12)...

Expected format: \$2a\$XX\$... (or \$2b\$ / \$2y\$).

Common cause: forgot to escape \$ as \$\$ in .env. Docker Compose treats
\$ as variable expansion and silently strips the leading dollar sign and
everything up to the next valid character, leaving a corrupt hash.

Fix: in .env, double every \$ in the hash. Example:
  WRONG:  MAILBOX_BASIC_AUTH_HASH=\$2a\$14\$abc...
  RIGHT:  MAILBOX_BASIC_AUTH_HASH=\$\$2a\$\$14\$\$abc...

Then re-up:
  docker compose up -d caddy
EOF
        exit 1
        ;;
esac

# Hand off to upstream caddy with the original CMD.
exec "$@"
