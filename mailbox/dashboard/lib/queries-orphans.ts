// MBOX-168 — Detect orphan containers (running on the host but NOT
// declared in the appliance's docker-compose.yml).
//
// Why this exists: the DR-25 misdiagnosis burned ~4 agent runs hunting
// "the Jetson is undersized" when the actual cause was an orphan
// container hoarding 3.86 GiB of memory. The compose file is the source
// of truth for what SHOULD be running; anything else is by definition an
// orphan and is the operator's first stop on "why is the box slow."
//
// Data flow:
//   1. Read /app/repo/docker-compose.yml (the same bind mount MBOX-163
//      established for git-state) and parse it.
//   2. Compute expected container names from services.*: prefer
//      `services.<name>.container_name` when set, otherwise fall back to
//      docker compose's default pattern `<project>-<service>-1`.
//   3. List currently-running containers via the docker socket.
//   4. The set difference (running − expected) is the orphan set.
//
// Why we don't flag the reverse (expected names not running): that's a
// different problem class — a service exited or failed to start. It would
// be useful to surface, but blowing it into THIS stat would conflate two
// signals. Track separately if/when an issue is opened for it.
//
// Total-failure-safe contract: compose file missing → status='red' with a
// reason naming the failure. Docker socket unreachable → status='red'
// with the docker reason bubbled through. YAML parse error → status='red'
// with the parse error. Never throws.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { type DockerHttpClient, listRunningContainers } from './queries-docker';

const DEFAULT_REPO_MOUNT = '/app/repo';
const DEFAULT_COMPOSE_FILENAME = 'docker-compose.yml';
const DEFAULT_PROJECT_NAME = 'mailbox';

export type OrphanStatus = 'green' | 'red';

export interface OrphanResult {
  status: OrphanStatus;
  /** Number of orphan containers (running but not declared in compose). */
  orphan_count: number;
  /** Names of the orphan containers (so the UI can list them, not just count). */
  orphan_names: string[];
  /** Names docker-compose says SHOULD be running (for operator context). */
  expected_names: string[];
  reason: string | null;
}

export interface FindOrphanContainersOptions {
  /** Compose project name. Defaults to env COMPOSE_PROJECT_NAME or "mailbox". */
  projectName?: string;
  /**
   * Absolute path to the compose file. Defaults to
   * $MAILBOX_REPO_MOUNT/docker-compose.yml (i.e. /app/repo/docker-compose.yml
   * inside the container).
   */
  composePath?: string;
  /** Raw compose YAML; overrides composePath. Primarily for tests. */
  composeYaml?: string;
  /** Inject the docker http client for tests. */
  dockerHttpClient?: DockerHttpClient;
  /**
   * Pre-resolved running container list — bypasses the docker socket
   * entirely. Primarily for tests; production callers leave this unset.
   */
  runningContainers?: string[] | { unavailable: string };
  /** Per-docker-call timeout. Mirrors queries-docker default. */
  dockerTimeoutMs?: number;
}

function projectName(opts: FindOrphanContainersOptions): string {
  return opts.projectName ?? process.env.COMPOSE_PROJECT_NAME?.trim() ?? DEFAULT_PROJECT_NAME;
}

function composeFilePath(opts: FindOrphanContainersOptions): string {
  if (opts.composePath) return opts.composePath;
  const root = process.env.MAILBOX_REPO_MOUNT?.trim() || DEFAULT_REPO_MOUNT;
  return path.join(root, DEFAULT_COMPOSE_FILENAME);
}

function red(reason: string, expectedNames: string[] = []): OrphanResult {
  return {
    status: 'red',
    orphan_count: 0,
    orphan_names: [],
    expected_names: expectedNames,
    reason,
  };
}

/**
 * Compute expected container names from a parsed compose object.
 * Mirrors docker-compose's own naming rule:
 *   - If `services.<svc>.container_name` is set, use that verbatim.
 *   - Otherwise, default to `<project>-<svc>-1` (compose v2 with the
 *     project=mailbox prefix matches what's already running on M1).
 * Exported for direct unit testing.
 */
export function expectedContainerNames(
  compose: unknown,
  project: string,
): { ok: true; names: string[] } | { ok: false; reason: string } {
  if (!compose || typeof compose !== 'object') {
    return { ok: false, reason: 'compose file did not parse to an object' };
  }
  const services = (compose as Record<string, unknown>).services;
  if (!services || typeof services !== 'object') {
    return { ok: false, reason: 'compose file has no `services:` block' };
  }
  const names: string[] = [];
  for (const [svcName, svcDef] of Object.entries(services as Record<string, unknown>)) {
    if (!svcDef || typeof svcDef !== 'object') continue;
    const explicit = (svcDef as Record<string, unknown>).container_name;
    if (typeof explicit === 'string' && explicit.trim().length > 0) {
      names.push(explicit.trim());
    } else {
      names.push(`${project}-${svcName}-1`);
    }
  }
  return { ok: true, names };
}

/**
 * Read compose + ask docker; return the set difference as the orphan list.
 * Never throws.
 */
export async function findOrphanContainers(
  opts: FindOrphanContainersOptions = {},
): Promise<OrphanResult> {
  // Phase 1 — load compose YAML. opts.composeYaml short-circuits the read
  // for tests.
  let yamlText: string;
  if (opts.composeYaml !== undefined) {
    yamlText = opts.composeYaml;
  } else {
    const composePath = composeFilePath(opts);
    try {
      yamlText = await readFile(composePath, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return red(
          `compose file ${composePath} not present — is the host repo bind-mounted at $MAILBOX_REPO_MOUNT?`,
        );
      }
      return red(`failed to read compose file ${composePath}: ${e.message}`);
    }
  }

  // Phase 2 — parse YAML.
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    return red(`compose YAML parse failed: ${(err as Error).message}`);
  }

  const expected = expectedContainerNames(parsed, projectName(opts));
  if (!expected.ok) {
    return red(expected.reason);
  }
  const expectedNames = expected.names.sort();

  // Phase 3 — running containers. Tests can short-circuit either side.
  let runningNames: string[];
  if (opts.runningContainers !== undefined) {
    if (Array.isArray(opts.runningContainers)) {
      runningNames = opts.runningContainers;
    } else {
      return red(opts.runningContainers.unavailable, expectedNames);
    }
  } else {
    const list = await listRunningContainers({
      httpClient: opts.dockerHttpClient,
      timeoutMs: opts.dockerTimeoutMs,
    });
    if (!list.available) {
      return red(list.reason, expectedNames);
    }
    runningNames = list.containers.map((c) => c.name);
  }

  // Phase 4 — set difference. We intentionally do NOT flag expected names
  // that aren't running (see header comment); only the running-minus-
  // expected direction.
  const expectedSet = new Set(expectedNames);
  const orphans = runningNames.filter((n) => !expectedSet.has(n)).sort();

  if (orphans.length === 0) {
    return {
      status: 'green',
      orphan_count: 0,
      orphan_names: [],
      expected_names: expectedNames,
      reason: null,
    };
  }

  return {
    status: 'red',
    orphan_count: orphans.length,
    orphan_names: orphans,
    expected_names: expectedNames,
    reason: `${orphans.length} orphan container${
      orphans.length === 1 ? '' : 's'
    } running outside docker-compose.yml: ${orphans.join(', ')} — likely the "memory eaten by ghost process" failure class (see DR-25 misdiagnosis)`,
  };
}
