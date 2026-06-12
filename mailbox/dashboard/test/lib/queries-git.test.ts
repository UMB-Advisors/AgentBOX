// MBOX-163 — Unit tests for getGitState().
//
// Convention follows test/lib/preflight-memory.test.ts + qdrant-health.test.ts:
// pure-function tests with deterministic injected dependencies. Production
// shells out to `git` via execFile; tests inject a `runner` mock so we don't
// spawn subprocesses or depend on the host filesystem layout.

import { describe, expect, it } from 'vitest';
import { type GitRunner, getGitState } from '@/lib/queries-git';

// Build a runner that maps git arg-prefix → response, with optional throws.
// Match is on the first arg AFTER the implicit `-C <repo>` (we don't see
// -C here because the injected runner is called without it — it's the
// default runner that prepends -C).
function buildRunner(map: Record<string, string | Error>): GitRunner {
  return async (args: string[]) => {
    const key = args.join(' ');
    for (const [prefix, value] of Object.entries(map)) {
      if (key.startsWith(prefix)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    throw new Error(`unhandled git call: ${key}`);
  };
}

const HAPPY_PATH = {
  'rev-parse HEAD': 'abc1234567890abcdef1234567890abcdef12345\n',
  'symbolic-ref --short HEAD': 'master\n',
  'rev-list --count origin/master..HEAD': '0\n',
  'rev-list --count HEAD..origin/master': '0\n',
  'status --porcelain': '',
  'show -s --format=%ct FETCH_HEAD': `${Math.floor(Date.now() / 1000) - 120}\n`, // ~2m ago
};

describe('getGitState — happy path', () => {
  it('returns full state on a clean master checkout', async () => {
    const r = await getGitState({
      runner: buildRunner(HAPPY_PATH),
      skipMountCheck: true,
    });

    expect(r.available).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.git_branch).toBe('master');
    expect(r.git_short_sha).toBe('abc1234');
    expect(r.git_full_sha).toBe('abc1234567890abcdef1234567890abcdef12345');
    expect(r.commits_behind_master).toBe(0);
    expect(r.commits_ahead_master).toBe(0);
    expect(r.dirty).toBe(false);
    expect(r.fetch_age_seconds).not.toBeNull();
    expect(r.fetch_age_seconds!).toBeGreaterThanOrEqual(120);
    expect(r.fetch_age_seconds!).toBeLessThan(130);
  });

  it('reports commits_behind/ahead when origin/master diverges', async () => {
    const r = await getGitState({
      runner: buildRunner({
        ...HAPPY_PATH,
        'rev-list --count origin/master..HEAD': '3\n', // 3 ahead
        'rev-list --count HEAD..origin/master': '19\n', // 19 behind (STAQPRO-336 scenario)
      }),
      skipMountCheck: true,
    });

    expect(r.commits_ahead_master).toBe(3);
    expect(r.commits_behind_master).toBe(19);
  });
});

describe('getGitState — dirty working tree', () => {
  it('flags dirty=true when porcelain emits any line', async () => {
    const r = await getGitState({
      runner: buildRunner({
        ...HAPPY_PATH,
        'status --porcelain': ' M dashboard/lib/queries-git.ts\n?? core-js-banners\n',
      }),
      skipMountCheck: true,
    });
    expect(r.available).toBe(true);
    expect(r.dirty).toBe(true);
  });

  it('flags dirty=false on empty porcelain', async () => {
    const r = await getGitState({
      runner: buildRunner({ ...HAPPY_PATH, 'status --porcelain': '' }),
      skipMountCheck: true,
    });
    expect(r.dirty).toBe(false);
  });
});

describe('getGitState — detached HEAD', () => {
  it('falls back to "HEAD detached at <short>" when symbolic-ref errors', async () => {
    const r = await getGitState({
      runner: buildRunner({
        ...HAPPY_PATH,
        'symbolic-ref --short HEAD': new Error('fatal: ref HEAD is not a symbolic ref'),
      }),
      skipMountCheck: true,
    });
    expect(r.available).toBe(true);
    expect(r.git_branch).toBe('HEAD detached at abc1234');
    expect(r.git_short_sha).toBe('abc1234');
  });
});

describe('getGitState — no origin/master', () => {
  it('returns null behind/ahead when rev-list errors (fresh clone, no fetch)', async () => {
    const r = await getGitState({
      runner: buildRunner({
        ...HAPPY_PATH,
        'rev-list --count origin/master..HEAD': new Error(
          "fatal: unknown revision 'origin/master'",
        ),
        'rev-list --count HEAD..origin/master': new Error(
          "fatal: unknown revision 'origin/master'",
        ),
      }),
      skipMountCheck: true,
    });
    expect(r.available).toBe(true);
    expect(r.commits_behind_master).toBeNull();
    expect(r.commits_ahead_master).toBeNull();
    expect(r.git_branch).toBe('master'); // branch resolution is independent
  });
});

describe('getGitState — FETCH_HEAD missing', () => {
  it('returns null fetch_age_seconds when git show on FETCH_HEAD fails', async () => {
    const r = await getGitState({
      runner: buildRunner({
        ...HAPPY_PATH,
        'show -s --format=%ct FETCH_HEAD': new Error(
          "fatal: ambiguous argument 'FETCH_HEAD': unknown revision",
        ),
      }),
      skipMountCheck: true,
    });
    expect(r.available).toBe(true);
    // With skipMountCheck=true the fs.stat fallback isn't attempted, so null.
    expect(r.fetch_age_seconds).toBeNull();
  });
});

describe('getGitState — repo mount absent', () => {
  it('returns available=false with a reason when mount is missing', async () => {
    // Real-fs path; pick a path that almost certainly doesn't exist.
    const r = await getGitState({
      repoPath: '/nonexistent/mbox-163-test-mount-/__never__',
    });
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/not present|not a directory|not a git repository/);
    expect(r.git_branch).toBeNull();
    expect(r.git_short_sha).toBeNull();
    expect(r.commits_behind_master).toBeNull();
  });

  it('reports "git binary not installed" when ENOENT comes from the binary itself', async () => {
    // Production fixture (MBOX-163 first M1 smoke 2026-05-24): the dashboard
    // image shipped without `git`, every call returned this shape, and the
    // pre-fix code mis-labelled it "not a git repository". The classifier
    // now distinguishes binary-missing vs repo-missing — keep the label
    // accurate so the operator knows to rebuild the image, not the mount.
    const enoent = Object.assign(new Error('spawn git ENOENT'), {
      code: 'ENOENT',
      syscall: 'spawn git',
      path: 'git',
    });
    const r = await getGitState({
      runner: buildRunner({ 'rev-parse HEAD': enoent }),
      skipMountCheck: true,
    });
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/git binary not installed/);
  });

  it('returns available=false when rev-parse errors with "not a git repository"', async () => {
    const r = await getGitState({
      runner: buildRunner({
        'rev-parse HEAD': new Error('fatal: not a git repository (or any parent up to mount /)'),
      }),
      skipMountCheck: true,
    });
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/not a git repository/);
  });
});

describe('getGitState — never throws', () => {
  it('catches unexpected rev-parse error and returns a populated reason', async () => {
    const r = await getGitState({
      runner: buildRunner({ 'rev-parse HEAD': new Error('something weird') }),
      skipMountCheck: true,
    });
    expect(r.available).toBe(false);
    expect(r.reason).toContain('something weird');
  });
});
