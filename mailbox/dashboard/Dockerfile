# Multi-stage build for Next.js 14 standalone output.
# Builds natively on whatever arch you build on — on the Jetson (ARM64) this
# produces an ARM64 image. node:20-alpine has multi-arch manifests.

# ---- Stage 1: deps ----------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
# Auth for @umb-advisors/* packages from GitHub Packages. Build-arg
# expands at install time via .npmrc's ${GITHUB_PACKAGES_TOKEN} reference.
# Token never lands in any image layer (env var is consumed during `npm ci`).
ARG GITHUB_PACKAGES_TOKEN
ENV GITHUB_PACKAGES_TOKEN=${GITHUB_PACKAGES_TOKEN}
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund

# ---- Stage 2: builder -------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Bake the production base path into the build (Next.js reads basePath at build).
# NEXT_PUBLIC_* envs are inlined into the client bundle so client-side fetch
# calls in QueueClient.tsx etc. include the /dashboard prefix and don't fall
# through Caddy's catch-all to n8n (→ 404 on approve/reject/edit/retry).
ENV BASE_PATH=/dashboard
ENV NEXT_PUBLIC_BASE_PATH=/dashboard
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ---- Stage 3: runner --------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

# git: required by dashboard/lib/queries-git.ts (MBOX-163) for reading the
# read-only repo bind-mount at /app/repo. Without it, every git_state call
# returns available=false with a misleading "not a git repository" reason
# (caught on M1 smoke 2026-05-24 after PR #148 first deploy).
RUN apk add --no-cache git \
 && addgroup -S -g 1001 nodejs \
 && adduser -S -u 1001 -G nodejs nextjs

# Public assets (favicon etc.) — present even if .gitkeep-only.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Standalone output — bundles a minimal node_modules and server.js.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Operator scripts (one-shot tools): rag-backfill, classify-backfill, etc.
# Run via `docker exec mailbox-dashboard npx tsx scripts/<name>.ts`.
# `tsx` auto-installs on first invocation; runtime deps (pg, etc.) are
# already traced into the standalone node_modules.
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts

# Operator scripts import from `../lib/...` (e.g. lib/rag/embed,
# lib/rag/qdrant, lib/rag/excerpt). Next.js standalone bundles these
# into the route handlers but doesn't ship them as standalone files —
# we have to copy the lib/ source separately for tsx to resolve.
# Fixed in this commit; before it, `docker exec ... npx tsx scripts/rag-backfill.ts`
# died with "Cannot find module '../lib/rag/embed'" (gap surfaced
# 2026-05-08 during M2 Phase 13.5 follow-up).
# Lib code is already trusted (it's what server.js runs); copying the
# TypeScript source adds ~few-MB image bloat and zero runtime risk.
COPY --from=builder --chown=nextjs:nodejs /app/lib ./lib

# STAQPRO-148 — pre-create the KB upload dir with nextjs:nodejs ownership so
# the named volume (mailbox_kb_uploads in compose) inherits the right owner
# on first mount. Docker initializes empty named volumes from the image's
# pre-existing contents at the mount path, including ownership. Without
# this, the volume gets root-owned and the runtime user (nextjs, uid 1001)
# gets EACCES on writeKbFile. Fixed by hand on Bob 2026-05-02 via
# `docker exec -u 0 mailbox-dashboard chown -R nextjs:nodejs /var/lib/mailbox/kb`;
# this Dockerfile change makes future appliances bootstrap correctly.
RUN mkdir -p /var/lib/mailbox/kb \
 && chown -R nextjs:nodejs /var/lib/mailbox

USER nextjs
EXPOSE 3001

CMD ["node", "server.js"]
