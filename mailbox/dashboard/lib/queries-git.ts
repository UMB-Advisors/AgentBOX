// MBOX-163 — Surface the live git state of the mounted appliance repo on
// /api/system/status so operators (and agents on other Claude sessions) can
// verify the box is actually on the branch they think before issuing
// `git pull` / `docker compose up`.
//
// Background: STAQPRO-336 — M1 sat on `worktree-staqpro-360` at `198e105`
// for 36 hours with local `master` 19 commits behind origin. A `git pull`
// in that state was a no-op (different branch). Eric burned a rebuild
// before noticing. Without a way to inspect appliance git state from off
// the box, the only diagnostic was an SSH session.
//
// Bind mount: the host repo is mounted read-only at $MAILBOX_REPO_MOUNT
// (default `/app/repo`) — see docker-compose.yml `mailbox-dashboard.volumes`.
// `:ro` means we MUST NEVER attempt a git write; all callers here are
// strictly read-only plumbing commands.
//
// Subprocess safety: we use `execFile` (not `exec`) with `-C <repo>` so
// the path is a positional arg, not shell-interpolated. The repo path
// comes from env at module load time, so even a malicious `MAILBOX_REPO_MOUNT`
// would land as an execFile arg, not a shell token.

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface GitState {
  available: boolean; // false → repo mount missing / not a git repo / git unavailable
  git_branch: string | null; // 'master' | 'HEAD detached at <short>'
  git_short_sha: string | null;
  git_full_sha: string | null;
  commits_behind_master: number | null; // origin/master..HEAD distance; null if no upstream
  commits_ahead_master: number | null; // HEAD..origin/master distance; null if no upstream
  fetch_age_seconds: number | null; // null if FETCH_HEAD missing (never fetched)
  dirty: boolean | null; // any uncommitted local changes; null if unavailable
  reason: string | null; // populated when available=false
}

// Injectable git runner — accepts (args[]) and returns stdout. Default
// invokes git via execFile bound to the configured repo path. Tests inject
// a mock to assert behavior without spawning subprocesses.
export type GitRunner = (args: string[]) => Promise<string>;

const DEFAULT_REPO_MOUNT = '/app/repo';
const GIT_TIMEOUT_MS = 400; // per-call cap; outer Promise.race caps the helper as a whole

function repoMount(): string {
  return process.env.MAILBOX_REPO_MOUNT?.trim() || DEFAULT_REPO_MOUNT;
}

function makeDefaultRunner(repo: string): GitRunner {
  return async (args: string[]) => {
    // `-c safe.directory=<repo>` short-circuits git 2.35+'s UID-mismatch
    // refusal ("fatal: detected dubious ownership"). Container runs as
    // nextjs uid 1001; M1 host repo is owned by bob uid 1000. Caught on
    // PR #150 M1 smoke 2026-05-24. -c is per-invocation, never writes
    // config — safe for the :ro bind mount model.
    const { stdout } = await execFileP(
      'git',
      ['-c', `safe.directory=${repo}`, '-C', repo, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      },
    );
    return stdout;
  };
}

const UNAVAILABLE_BASE: Omit<GitState, 'reason'> = {
  available: false,
  git_branch: null,
  git_short_sha: null,
  git_full_sha: null,
  commits_behind_master: null,
  commits_ahead_master: null,
  fetch_age_seconds: null,
  dirty: null,
};

function unavailable(reason: string): GitState {
  return { ...UNAVAILABLE_BASE, reason };
}

// Classify the "I can't run git here" failure modes so we can degrade
// with an accurate operator-readable reason instead of always reporting
// "not a git repository" (which hid the real cause during MBOX-163 first
// M1 smoke 2026-05-24 — the dashboard image was missing the `git` binary
// entirely, but the message said the repo wasn't a git repo).
type GitUnavailable =
  | { kind: 'binary_missing' } // execFile couldn't find `git` on PATH
  | { kind: 'not_a_repo' } // dir exists but git refuses (no .git)
  | { kind: 'path_missing' } // repo path doesn't exist (caught earlier by stat usually)
  | null; // not an unavailability — bubble as-is

function classifyUnavailable(err: unknown): GitUnavailable {
  if (!(err instanceof Error)) return null;
  const e = err as NodeJS.ErrnoException & { syscall?: string; path?: string };
  if (e.code === 'ENOENT') {
    // Node's execFile ENOENT sets `path` to the binary name and `syscall`
    // to `'spawn <binary>'` when the binary itself is missing; the message
    // also starts with `'spawn git ENOENT'` in that case. Match all three
    // shapes so tests that fixture only the message still classify.
    if (
      e.path === 'git' ||
      e.syscall === 'spawn git' ||
      (e.message || '').startsWith('spawn git ENOENT')
    ) {
      return { kind: 'binary_missing' };
    }
    return { kind: 'path_missing' };
  }
  const msg = e.message || '';
  if (msg.includes('not a git repository')) return { kind: 'not_a_repo' };
  if (msg.includes('does not exist')) return { kind: 'path_missing' };
  return null;
}

interface GetGitStateOptions {
  runner?: GitRunner;
  repoPath?: string;
  // Skip the up-front mount existence stat. Tests that inject a runner don't
  // need a real on-disk directory.
  skipMountCheck?: boolean;
}

/**
 * Read the appliance's live git state. Total-failure-safe: never throws.
 * Caller (route handler) wraps in Promise.race with a timeout — see
 * dashboard/app/api/system/status/route.ts.
 */
export async function getGitState(opts: GetGitStateOptions = {}): Promise<GitState> {
  const repo = opts.repoPath ?? repoMount();
  const runner = opts.runner ?? makeDefaultRunner(repo);

  // Phase 1 — confirm the repo mount is present + is a git repo. Bail early
  // (and cheaply) if it isn't, with an operator-readable reason.
  if (!opts.skipMountCheck) {
    try {
      const s = await stat(repo);
      if (!s.isDirectory()) {
        return unavailable(`repo mount ${repo} is not a directory`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return unavailable(`repo mount ${repo} not present`);
      }
      return unavailable(`repo mount ${repo} stat failed: ${(err as Error).message}`);
    }
  }

  // Phase 2 — resolve HEAD. `git rev-parse HEAD` is the cheapest "is this
  // a git repo?" probe; if it fails we degrade to unavailable rather than
  // letting downstream calls all fail in parallel.
  let fullSha: string;
  try {
    fullSha = (await runner(['rev-parse', 'HEAD'])).trim();
  } catch (err) {
    const cls = classifyUnavailable(err);
    if (cls?.kind === 'binary_missing') {
      return unavailable('git binary not installed in dashboard container');
    }
    if (cls?.kind === 'not_a_repo') {
      return unavailable(`${repo} is not a git repository`);
    }
    if (cls?.kind === 'path_missing') {
      return unavailable(`${repo} not present`);
    }
    return unavailable(`git rev-parse HEAD failed: ${(err as Error).message}`);
  }
  const shortSha = fullSha.slice(0, 7);

  // Phase 3 — branch. `symbolic-ref --short HEAD` returns non-zero on a
  // detached HEAD; the spec wants 'HEAD detached at <short>' for that case.
  let branch: string;
  try {
    branch = (await runner(['symbolic-ref', '--short', 'HEAD'])).trim();
  } catch {
    branch = `HEAD detached at ${shortSha}`;
  }

  // Phase 4 — independent reads in parallel (each is small + already
  // bounded by GIT_TIMEOUT_MS). settle-all so a single failure doesn't
  // poison the rest.
  //
  // Naming: `aheadRes` holds the `origin/master..HEAD` rev-list (commits we
  // have that origin doesn't = "ahead"), `behindRes` holds the
  // `HEAD..origin/master` rev-list (commits origin has that we don't =
  // "behind"). Keep these aligned with the rev-list args — flipping them is
  // exactly the STAQPRO-336 misreport class this ticket fixes.
  const [aheadRes, behindRes, dirtyRes, fetchAtRes] = await Promise.allSettled([
    runner(['rev-list', '--count', 'origin/master..HEAD']),
    runner(['rev-list', '--count', 'HEAD..origin/master']),
    runner(['status', '--porcelain']),
    // FETCH_HEAD timestamp via `git show -s --format=%ct FETCH_HEAD`
    // (commit-time of the fetched ref). Stable across coreutils/BSD `stat`
    // differences. Falls back to fs.stat on .git/FETCH_HEAD if git can't
    // resolve it (some FETCH_HEAD lines aren't a commit ref).
    runner(['show', '-s', '--format=%ct', 'FETCH_HEAD']),
  ]);

  // Both behind and ahead become null together if origin/master is missing
  // (rev-list errors → PromiseSettled rejection → parseRevCount returns null).
  const aheadCount = parseRevCount(aheadRes);
  const behindCount = parseRevCount(behindRes);

  const dirty = dirtyRes.status === 'fulfilled' ? dirtyRes.value.length > 0 : null;

  let fetchAgeSeconds: number | null = null;
  if (fetchAtRes.status === 'fulfilled') {
    const ts = Number.parseInt(fetchAtRes.value.trim(), 10);
    if (Number.isFinite(ts) && ts > 0) {
      fetchAgeSeconds = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    }
  } else if (!opts.skipMountCheck) {
    // Fallback: stat .git/FETCH_HEAD mtime directly. Only attempted when we
    // know the mount is real (skipMountCheck=false means we already stat'd).
    try {
      const s = await stat(path.join(repo, '.git', 'FETCH_HEAD'));
      fetchAgeSeconds = Math.max(0, Math.floor((Date.now() - s.mtimeMs) / 1000));
    } catch {
      fetchAgeSeconds = null;
    }
  }

  return {
    available: true,
    git_branch: branch,
    git_short_sha: shortSha,
    git_full_sha: fullSha,
    commits_behind_master: behindCount,
    commits_ahead_master: aheadCount,
    fetch_age_seconds: fetchAgeSeconds,
    dirty,
    reason: null,
  };
}

function parseRevCount(res: PromiseSettledResult<string>): number | null {
  if (res.status !== 'fulfilled') return null; // origin/master missing → null
  const n = Number.parseInt(res.value.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// MBOX-163 — helper used by route + status page callers to bound the
// helper at the caller layer (the helper itself is total-failure-safe but
// only inner subprocess timeouts; a hung filesystem stat would still
// hang). Race the real call against a timeout; on either branch we
// clearTimeout the loser so we don't leave a pending timer dangling for
// up to `timeoutMs` after the response is sent. Returns a degraded
// GitState on timeout/error rather than throwing.
export async function getGitStateWithTimeout(timeoutMs: number): Promise<GitState> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      getGitState().catch(
        (err): GitState => unavailable(`git_state error: ${(err as Error).message}`),
      ),
      new Promise<GitState>((resolve) => {
        timer = setTimeout(() => resolve(unavailable('git_state timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
