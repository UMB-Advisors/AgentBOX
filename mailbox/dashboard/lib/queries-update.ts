// MBOX-184 / MBOX-347 — Read-only "Update available" detection (the safe,
// non-destructive half of the OTA story).
//
// What it does: for each locally-built service it resolves the LATEST published
// image digest straight from the GHCR registry at runtime, and compares it to
// the digest of the image the corresponding container is ACTUALLY running. The
// result feeds a read-only /status panel — there is NO action here. The "Update
// now" button + pull→recreate→migrate→smoke→commit/rollback orchestration is a
// separate, deferred follow-up.
//
// MBOX-347 — why a runtime registry read (not a committed manifest file): GHCR
// is already a content-addressable, authoritative store of exactly this fact.
// The previous slice cached it in a committed deploy/image-manifest.json that a
// CI job wrote back to master with `[skip ci]` — re-deriving over git a fact the
// registry serves over HTTP, and pushing bot commits that made every local
// master drift (the MBOX-163 invisible-drift class). We now read the registry
// directly and cache the answer in-process with a short TTL so the /status panel
// does not hammer ghcr.io. No new credential: the GHCR manifest API issues an
// anonymous pull token for public images via ghcr.io/token.
//
// Why this is non-destructive: we only READ. The running digests come from the
// same MBOX-168 read-only docker.sock reader (GET /containers/json) — no new
// privileged bind, no docker writes. The registry read is plain HTTPS GET.
//
// Identity model — three cases per service, in priority order:
//   1. Running container's `Image` ref carries an @sha256 digest (GHCR
//      digest-pinned deploy). Compare that digest to the registry digest.
//      Equal → up_to_date. Differ → update_available.
//   2. Running container's `Image` ref is a tag-only LOCAL build (M1's
//      `docker compose up -d --build` path → `mailbox-mailbox-dashboard:latest`,
//      no digest). We CANNOT prove equality against a registry digest from a
//      local config id, so we report `local_build` (informational, not a false
//      "update available"). This keeps M1's current path honest.
//   3. Registry has no digest for the channel tag yet (nothing published, or a
//      transient registry miss) → `no_manifest`. Or the container isn't running
//      → `not_running`.
//
// Total-failure-safe contract: this helper NEVER throws. Registry unreachable /
// token denied / docker socket unreachable → a normalized result with a
// per-service `unknown`/`no_manifest` state and an overall reason. The /status
// surface relies on this (same contract as queries-orphans.ts / queries-docker.ts).

import https from 'node:https';

import { type DockerHttpClient, digestFromImageRef, listRunningContainers } from './queries-docker';

const DEFAULT_PROJECT_NAME = 'mailbox';
// GHCR requires a lowercase org path. The org is UMB-Advisors → lowercase. Keep
// in lockstep with .github/workflows/publish-images.yml IMAGE_NS.
const DEFAULT_REGISTRY_NS = 'umb-advisors';
// The channel tag the appliance tracks. publish-images.yml tags the default
// branch build `latest`; that is the digest the deploy flow pulls.
const DEFAULT_CHANNEL_TAG = 'latest';
const DEFAULT_REGISTRY_TIMEOUT_MS = 2500;
// In-process cache TTL so the /status panel does not hammer ghcr.io on every
// 30s page refresh. Short enough that a freshly-published release is visible
// within a minute.
const DEFAULT_REGISTRY_TTL_MS = 60_000;

/**
 * Total wall-clock ceiling a caller should give a single `checkUpdateAvailability`
 * race. Wider than the orphan check's 800ms because a cold-cache registry read
 * (anonymous token + manifest fetch, ~60s TTL) can take a few seconds on first
 * hit. Shared so the /status route handler and the /status page race the helper
 * on the same bound — a breach just degrades to a benign reason.
 */
export const OTA_CHECK_CEILING_MS = 6000;

// Accept header advertising the manifest media types GHCR can return. The
// image is multi-arch, so the registry returns an OCI image INDEX (a.k.a. the
// "fat" manifest list); its Docker-Content-Digest is the digest you pin with
// `image: <repo>@<digest>` and the same digest a digest-pinned multi-arch
// deploy reports. We deliberately do NOT request a single platform so the
// digest we compare is arch-agnostic (the ARM64-vs-index footgun the reviewers
// flagged for the execute-update slice).
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * Maps a service KEY (also the user-facing label + GHCR image name) to the
 * docker-compose SERVICE name it corresponds to. The compose service name is
 * what drives the running container name (`<project>-<service>-1`, or an
 * explicit container_name). Keep this in lockstep with the locally-built
 * services in docker-compose.yml and publish-images.yml's matrix.
 */
const MANIFEST_KEY_TO_COMPOSE_SERVICE: Record<string, string> = {
  'mailbox-dashboard': 'mailbox-dashboard',
  'mailbox-caddy': 'caddy',
};

/**
 * Explicit container_name overrides set in docker-compose.yml. When a service
 * declares `container_name`, docker uses it verbatim instead of the
 * `<project>-<service>-1` default. mailbox-dashboard sets one; caddy does not.
 */
const COMPOSE_CONTAINER_NAME_OVERRIDE: Record<string, string> = {
  'mailbox-dashboard': 'mailbox-dashboard',
};

/** The services we resolve registry digests for — the GHCR image basenames. */
const REGISTRY_SERVICES = ['mailbox-dashboard', 'mailbox-caddy'] as const;

export type ServiceUpdateState =
  | 'up_to_date'
  | 'update_available'
  | 'local_build'
  | 'no_manifest'
  | 'not_running'
  | 'unknown';

export interface ServiceUpdateStatus {
  /** Service key (also the user-facing service label). */
  service: string;
  state: ServiceUpdateState;
  /** Digest the registry says is the latest published image (sha256:… or null). */
  manifest_digest: string | null;
  /** Channel tag the digest was resolved from (e.g. "latest"), if any. */
  manifest_tag: string | null;
  /** Digest the running container is on, when derivable from its image ref. */
  running_digest: string | null;
  /** The raw image ref the container reports (for operator context). */
  running_image: string | null;
  /** Per-service human-readable explanation. */
  detail: string;
}

export interface UpdateAvailability {
  /** True when ANY service is in `update_available`. Drives the panel tone. */
  update_available: boolean;
  services: ServiceUpdateStatus[];
  /** Non-null when the whole check degraded (registry unreachable, docker down). */
  reason: string | null;
}

/**
 * Injectable registry client. Resolves the latest published manifest digest for
 * one image from GHCR. Default impl issues an anonymous pull token then a HEAD-
 * equivalent GET against the manifest endpoint and returns the
 * `Docker-Content-Digest` header. Tests inject a mock to drive the comparison
 * deterministically without network access — same convention as
 * queries-docker's DockerHttpClient.
 */
export type RegistryDigestClient = (
  image: string,
  tag: string,
  opts: { timeoutMs: number },
) => Promise<{ digest: string } | { error: string }>;

export interface CheckUpdateAvailabilityOptions {
  /** Compose project name. Defaults to env COMPOSE_PROJECT_NAME or "mailbox". */
  projectName?: string;
  /** GHCR org namespace. Defaults to env GHCR_NAMESPACE or "umb-advisors". */
  registryNamespace?: string;
  /** Channel tag to resolve. Defaults to env OTA_CHANNEL_TAG or "latest". */
  channelTag?: string;
  /** Inject the registry digest client for tests. */
  registryClient?: RegistryDigestClient;
  /**
   * Pre-resolved registry digests keyed by service — bypasses the network
   * entirely. `{ digest }` for a hit, `{ error }` to simulate a miss/failure,
   * omitted key → treated as no published digest. Primarily for tests.
   */
  registryDigests?: Record<string, { digest: string } | { error: string }>;
  /** Disable the in-process cache (tests, or a forced fresh read). */
  noCache?: boolean;
  /** Per-registry-call timeout. */
  registryTimeoutMs?: number;
  /** Inject the docker http client for tests. */
  dockerHttpClient?: DockerHttpClient;
  /**
   * Pre-resolved running containers — bypasses the docker socket entirely.
   * Primarily for tests; production callers leave this unset.
   */
  runningContainers?: Array<{ name: string; image: string }> | { unavailable: string };
  /** Per-docker-call timeout. Mirrors queries-docker default. */
  dockerTimeoutMs?: number;
}

function projectName(opts: CheckUpdateAvailabilityOptions): string {
  return opts.projectName ?? process.env.COMPOSE_PROJECT_NAME?.trim() ?? DEFAULT_PROJECT_NAME;
}

function registryNamespace(opts: CheckUpdateAvailabilityOptions): string {
  return opts.registryNamespace ?? process.env.GHCR_NAMESPACE?.trim() ?? DEFAULT_REGISTRY_NS;
}

function channelTag(opts: CheckUpdateAvailabilityOptions): string {
  return opts.channelTag ?? process.env.OTA_CHANNEL_TAG?.trim() ?? DEFAULT_CHANNEL_TAG;
}

function degraded(reason: string): UpdateAvailability {
  return { update_available: false, services: [], reason };
}

/**
 * Compute the container name docker-compose would assign to a service: an
 * explicit container_name override when set, otherwise the
 * `<project>-<service>-1` default. Exported for direct unit testing.
 */
export function expectedContainerName(serviceKey: string, project: string): string | null {
  const composeService = MANIFEST_KEY_TO_COMPOSE_SERVICE[serviceKey];
  if (!composeService) return null;
  const override = COMPOSE_CONTAINER_NAME_OVERRIDE[serviceKey];
  if (override) return override;
  return `${project}-${composeService}-1`;
}

// ---------------------------------------------------------------------------
// Default GHCR registry client — anonymous-token manifest read.
// ---------------------------------------------------------------------------

interface CacheEntry {
  at: number;
  result: { digest: string } | { error: string };
}
// Module-scoped cache keyed by `${namespace}/${image}:${tag}`. Short TTL.
const registryCache = new Map<string, CacheEntry>();

function httpsGetJson(
  options: https.RequestOptions,
  timeoutMs: number,
): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`ghcr request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Default registry client: obtain an anonymous pull token from ghcr.io/token,
 * then GET the manifest and return its Docker-Content-Digest. Never throws —
 * any failure funnels into `{ error }`.
 */
const defaultRegistryClient: RegistryDigestClient = async (image, tag, { timeoutMs }) => {
  const repo = image; // already namespaced by the caller, e.g. umb-advisors/mailbox-dashboard
  // 1. Anonymous pull token. GHCR's token endpoint mints a bearer for the
  //    `repository:<repo>:pull` scope without credentials for public images.
  let token: string;
  try {
    const tokenRes = await httpsGetJson(
      {
        hostname: 'ghcr.io',
        path: `/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${repo}:pull`)}`,
        method: 'GET',
        headers: { 'User-Agent': 'mailbox-ota-check' },
      },
      timeoutMs,
    );
    if (tokenRes.statusCode < 200 || tokenRes.statusCode >= 300) {
      return { error: `ghcr token endpoint returned HTTP ${tokenRes.statusCode}` };
    }
    const parsed = JSON.parse(tokenRes.body) as { token?: string };
    if (!parsed.token) return { error: 'ghcr token endpoint returned no token' };
    token = parsed.token;
  } catch (err) {
    return { error: `ghcr token fetch failed: ${(err as Error).message}` };
  }

  // 2. Manifest read. We only need the Docker-Content-Digest header, but GHCR
  //    only sets it on a GET/HEAD that resolves to a concrete manifest, so we
  //    issue a GET and discard the body.
  try {
    const manRes = await httpsGetJson(
      {
        hostname: 'ghcr.io',
        path: `/v2/${repo}/manifests/${encodeURIComponent(tag)}`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: MANIFEST_ACCEPT,
          'User-Agent': 'mailbox-ota-check',
        },
      },
      timeoutMs,
    );
    if (manRes.statusCode === 404) {
      return { error: 'not_published' };
    }
    if (manRes.statusCode < 200 || manRes.statusCode >= 300) {
      return { error: `ghcr manifest read returned HTTP ${manRes.statusCode}` };
    }
    const header = manRes.headers['docker-content-digest'];
    const digest = Array.isArray(header) ? header[0] : header;
    if (!digest || !/^sha256:[0-9a-f]+$/.test(digest)) {
      return { error: 'ghcr manifest read returned no Docker-Content-Digest header' };
    }
    return { digest };
  } catch (err) {
    return { error: `ghcr manifest read failed: ${(err as Error).message}` };
  }
};

/**
 * Resolve one service's latest registry digest, honoring the injected
 * pre-resolved map / client and the in-process TTL cache.
 */
async function resolveRegistryDigest(
  service: string,
  opts: CheckUpdateAvailabilityOptions,
): Promise<{ digest: string } | { error: string }> {
  if (opts.registryDigests) {
    return opts.registryDigests[service] ?? { error: 'not_published' };
  }
  const ns = registryNamespace(opts);
  const tag = channelTag(opts);
  const repo = `${ns}/${service}`;
  const cacheKey = `${repo}:${tag}`;
  const ttl = DEFAULT_REGISTRY_TTL_MS;

  if (!opts.noCache) {
    const hit = registryCache.get(cacheKey);
    if (hit && Date.now() - hit.at < ttl) {
      return hit.result;
    }
  }

  const client = opts.registryClient ?? defaultRegistryClient;
  const timeoutMs = opts.registryTimeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS;
  const result = await client(repo, tag, { timeoutMs });

  if (!opts.noCache) {
    registryCache.set(cacheKey, { at: Date.now(), result });
  }
  return result;
}

/**
 * Resolve the latest registry digests + the running container digests; return
 * the per-service comparison. Never throws.
 */
export async function checkUpdateAvailability(
  opts: CheckUpdateAvailabilityOptions = {},
): Promise<UpdateAvailability> {
  // Phase 1 — running containers, keyed by name. Tests can short-circuit.
  let running: Array<{ name: string; image: string }>;
  if (opts.runningContainers !== undefined) {
    if (Array.isArray(opts.runningContainers)) {
      running = opts.runningContainers;
    } else {
      return degraded(opts.runningContainers.unavailable);
    }
  } else {
    const list = await listRunningContainers({
      httpClient: opts.dockerHttpClient,
      timeoutMs: opts.dockerTimeoutMs,
    });
    if (!list.available) {
      return degraded(list.reason);
    }
    running = list.containers;
  }
  const byName = new Map(running.map((c) => [c.name, c]));

  // Phase 2 — per-service comparison. Resolve registry digests in parallel.
  const project = projectName(opts);
  const tag = channelTag(opts);
  const resolved = await Promise.all(
    REGISTRY_SERVICES.map(async (service) => ({
      service,
      registry: await resolveRegistryDigest(service, opts),
    })),
  );

  const services: ServiceUpdateStatus[] = [];
  let anyUpdate = false;

  for (const { service, registry } of resolved) {
    const manifestDigest = 'digest' in registry ? registry.digest : null;
    const manifestTag = manifestDigest ? tag : null;
    const containerName = expectedContainerName(service, project);
    const container = containerName ? byName.get(containerName) : undefined;
    const runningImage = container?.image ?? null;
    const runningDigest = runningImage ? digestFromImageRef(runningImage) : null;

    let state: ServiceUpdateState;
    let detail: string;

    if (manifestDigest === null) {
      // No published digest in the registry: nothing published yet, a 404 on
      // the channel tag, or a transient registry/token failure. Either way we
      // can't assert an update — surface as no_manifest with the reason.
      state = 'no_manifest';
      const why = 'error' in registry ? registry.error : 'unknown';
      detail =
        why === 'not_published'
          ? 'no published image for this channel tag in GHCR yet'
          : `could not resolve latest digest from GHCR (${why})`;
    } else if (!container) {
      state = 'not_running';
      detail = containerName
        ? `expected container ${containerName} is not running`
        : `no compose-service mapping for service ${service}`;
    } else if (runningDigest === null) {
      // Tag-only local build (M1's `up -d --build` path). We can't prove
      // equality against a registry digest, so report local_build — NOT a
      // false update_available.
      state = 'local_build';
      detail = `running a local build (${runningImage}) — not GHCR digest-pinned, so update comparison is N/A`;
    } else if (runningDigest === manifestDigest) {
      state = 'up_to_date';
      detail = 'running the latest published digest';
    } else {
      state = 'update_available';
      detail = `running ${shortDigest(runningDigest)} → latest published is ${shortDigest(manifestDigest)}`;
      anyUpdate = true;
    }

    services.push({
      service,
      state,
      manifest_digest: manifestDigest,
      manifest_tag: manifestTag,
      running_digest: runningDigest,
      running_image: runningImage,
      detail,
    });
  }

  return { update_available: anyUpdate, services, reason: null };
}

/**
 * `sha256:abc123def…` → `abc123d` (7 hex chars after the algo prefix), for
 * compact UI rendering. Exported so the page can render short forms without
 * re-implementing the slice. Returns the input unchanged if it isn't a
 * recognizable `sha256:` digest.
 */
export function shortDigest(digest: string | null): string {
  if (!digest) return '—';
  const m = /^sha256:([0-9a-f]+)$/.exec(digest);
  if (!m) return digest;
  return m[1].slice(0, 7);
}

/**
 * Clear the in-process registry digest cache. Exported for tests so a forced
 * fresh read is deterministic between cases.
 */
export function __clearRegistryCache(): void {
  registryCache.clear();
}
