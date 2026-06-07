#!/usr/bin/env bash
# Regenerate dashboard/lib/db/schema.ts from the canonical mailbox schema.
#
# Bootstraps a throwaway postgres:17-alpine container, applies the CI-bootstrap
# snapshot at test/fixtures/schema.sql, runs kysely-codegen scoped to the
# mailbox schema, then tears the container down. Same Postgres path CI takes.
#
# Re-run after every schema migration that lands in test/fixtures/schema.sql.
# CI verifies drift via `npm run db:codegen:verify` (kysely-codegen --verify).

set -euo pipefail

PORT="${KYSELY_CODEGEN_PORT:-54329}"
NAME="kysely-codegen-tmp-$$"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

cleanup() { docker stop "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$NAME" -p "$PORT:5432" \
  -e POSTGRES_USER=mailbox \
  -e POSTGRES_PASSWORD=mailbox \
  -e POSTGRES_DB=mailbox \
  postgres:17-alpine >/dev/null

for i in $(seq 1 30); do
  if docker exec "$NAME" pg_isready -U mailbox -d mailbox >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker cp "$HERE/test/fixtures/schema.sql" "$NAME:/tmp/schema.sql"
docker exec "$NAME" psql -U mailbox -d mailbox -f /tmp/schema.sql -q >/dev/null

DATABASE_URL="postgres://mailbox:mailbox@localhost:$PORT/mailbox" \
  npx kysely-codegen \
    --dialect postgres \
    --default-schema mailbox \
    --include-pattern 'mailbox.*' \
    --numeric-parser string \
    --type-mapping '{"timestamp":"string","timestamptz":"string","date":"string"}' \
    --out-file "$HERE/lib/db/schema.ts" \
    --type-only-imports \
    "$@"
