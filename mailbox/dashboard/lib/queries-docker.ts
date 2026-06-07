// MBOX-168 — Read-only Docker API client over the host's Unix socket.
//
// Why this exists: /api/system/status needs to enumerate currently-running
// containers so it can cross-reference them against the compose file and
// surface orphans (containers running but NOT in docker-compose.yml — the
// 3.86 GiB DR-25 misdiagnosis class). One HTTP call to the Docker daemon
// over /var/run/docker.sock is the cheapest, dependency-free way to do
// that.
//
// Why raw http.request (not dockerode, not docker CLI):
//   - dockerode is ~1.5 MB and pulls in 30+ transitive deps. We need ONE
//     endpoint (`GET /containers/json`). Not worth the dep surface or the
//     attack surface — dockerode is one of the more frequent target of CVE
//     advisories due to its API breadth.
//   - The docker CLI requires a docker binary in the dashboard image.
//     Same incident class as MBOX-163 first M1 smoke (missing `git`
//     binary). raw http.request is "always installed" because Node ships
//     it.
//
// Why :ro on the bind mount (docker-compose.yml): operator intent. The
// Docker engine treats `:ro` as advisory only (it can still execute writes
// at the protocol level if it wants to); we never call write endpoints
// here and the helper is wired to fail-closed if anyone tries.
//
// Total-failure-safe contract: this helper NEVER throws. ENOENT (socket
// absent — running locally without docker), EACCES (perm denied), API
// error, timeout, or malformed JSON → all funnel through to a normalized
// `{ available: false, reason }` shape. The /status route relies on this.

import http from 'node:http';

const DEFAULT_SOCKET_PATH = '/var/run/docker.sock';
const DEFAULT_TIMEOUT_MS = 500;

/**
 * Injectable HTTP client. Default impl wraps `http.request` against the
 * Unix socket; tests inject a mock to drive the parser deterministically
 * without spawning a Docker daemon.
 */
export type DockerHttpClient = (
  path: string,
  opts: { timeoutMs: number },
) => Promise<{ statusCode: number; body: string }>;

export interface DockerContainer {
  /**
   * Real container name as Docker reports it, without the leading slash.
   * Docker's API returns names like ["/mailbox-dashboard"] — we strip the
   * slash so it matches user-facing names in docker-compose / docker ps.
   */
  name: string;
  /**
   * The image *reference* the container was started from, as Docker reports
   * it in the `Image` field. For a digest-pinned GHCR deploy this is
   * `ghcr.io/umb-advisors/mailbox-dashboard@sha256:…`; for M1's local-build
   * path it's a local tag like `mailbox-mailbox-dashboard:latest` (no digest).
   */
  image: string;
  state: string; // 'running' | 'exited' | …
}

/**
 * Extract the `@sha256:…` digest out of an image reference, if present.
 * `ghcr.io/umb-advisors/mailbox-dashboard@sha256:abc…` → `sha256:abc…`.
 * A tag-only ref (`mailbox-dashboard:latest`) → null. Exported for the
 * MBOX-184 update-availability comparison.
 */
export function digestFromImageRef(imageRef: string): string | null {
  const at = imageRef.lastIndexOf('@sha256:');
  if (at === -1) return null;
  return imageRef.slice(at + 1); // drop the '@', keep 'sha256:…'
}

export interface ListContainersOk {
  available: true;
  containers: DockerContainer[];
}

export interface ListContainersUnavailable {
  available: false;
  reason: string;
}

export type ListContainersResult = ListContainersOk | ListContainersUnavailable;

export interface ListRunningContainersOptions {
  /** Override the Unix socket path. Defaults to /var/run/docker.sock. */
  socketPath?: string;
  /** Override the per-request timeout. */
  timeoutMs?: number;
  /** Inject a mock HTTP client (used by tests). */
  httpClient?: DockerHttpClient;
}

function makeDefaultClient(socketPath: string): DockerHttpClient {
  return (path, opts) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          path,
          method: 'GET',
          // The Host header is required by some Docker daemon versions
          // even on Unix-socket transport. "localhost" is the conventional
          // placeholder.
          headers: { Host: 'localhost' },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            resolve({ statusCode: res.statusCode ?? 0, body });
          });
          res.on('error', reject);
        },
      );
      req.setTimeout(opts.timeoutMs, () => {
        req.destroy(new Error(`docker socket request timed out after ${opts.timeoutMs}ms`));
      });
      req.on('error', reject);
      req.end();
    });
}

function unavailable(reason: string): ListContainersUnavailable {
  return { available: false, reason };
}

function classifyError(err: unknown): string {
  if (!(err instanceof Error)) return `docker socket unreachable: ${String(err)}`;
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'ENOENT')
    return 'docker socket /var/run/docker.sock not present in dashboard container — add the bind mount in docker-compose.yml';
  if (e.code === 'EACCES')
    return 'docker socket present but permission denied — group docker missing on dashboard user';
  if (e.code === 'ECONNREFUSED') return 'docker socket refused connection — daemon not running';
  if ((e.message || '').includes('timed out')) return e.message;
  return `docker socket error: ${e.message || 'unknown'}`;
}

/**
 * GET /containers/json?filters={"status":["running"]} over the Docker
 * Unix socket. Returns a normalized list or an `available: false` row
 * with an operator-readable reason. Never throws.
 */
export async function listRunningContainers(
  opts: ListRunningContainersOptions = {},
): Promise<ListContainersResult> {
  const socketPath = opts.socketPath ?? DEFAULT_SOCKET_PATH;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = opts.httpClient ?? makeDefaultClient(socketPath);

  // The filters param is a JSON object. Docker's URL parser requires it
  // URL-encoded. Hard-code the encoded form so we don't have to ship
  // querystring/URL building for one constant.
  const filtersJson = '{"status":["running"]}';
  const path = `/containers/json?filters=${encodeURIComponent(filtersJson)}`;

  let res: { statusCode: number; body: string };
  try {
    res = await client(path, { timeoutMs });
  } catch (err) {
    return unavailable(classifyError(err));
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    return unavailable(`docker API returned HTTP ${res.statusCode}: ${res.body.slice(0, 200)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(res.body);
  } catch (err) {
    return unavailable(`docker API returned non-JSON body: ${(err as Error).message}`);
  }
  if (!Array.isArray(raw)) {
    return unavailable('docker API returned non-array container list');
  }

  const containers: DockerContainer[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const obj = c as Record<string, unknown>;
    const names = Array.isArray(obj.Names) ? (obj.Names as unknown[]) : [];
    // Docker reports names as ["/container-name"]; strip the leading "/".
    const name = typeof names[0] === 'string' ? (names[0] as string).replace(/^\//, '') : '';
    if (!name) continue;
    containers.push({
      name,
      image: typeof obj.Image === 'string' ? (obj.Image as string) : '',
      state: typeof obj.State === 'string' ? (obj.State as string) : '',
    });
  }

  return { available: true, containers };
}
