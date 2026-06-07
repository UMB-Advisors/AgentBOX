// MBOX-349 — unit tests for the OTA "Update now" state machine
// (lib/ota/update.ts:runOtaUpdate).
//
// Convention follows test/lib/queries-git.test.ts: pure-state-machine tests
// with deterministic injected dependencies. Production shells out to docker /
// git / smoke via the OtaShell interface; tests inject a mock shell so we
// NEVER spawn a subprocess or touch a real appliance. The audit persistence
// is injected via hooks so the DB is never touched either — we assert the
// recorded started/terminal transitions against an in-memory log.

import { describe, expect, it, vi } from 'vitest';
import { type OtaResult, type OtaShell, type OtaUpdateHooks, runOtaUpdate } from '@/lib/ota/update';

// A shell whose four forward steps + rollback each resolve, unless overridden
// to reject. `calls` records the step order so we can assert the orchestrator
// stops at the first failure and only then attempts rollback.
function buildShell(overrides: Partial<Record<keyof OtaShell, Error>> = {}): {
  shell: OtaShell;
  calls: string[];
} {
  const calls: string[] = [];
  const step = (name: keyof OtaShell) => async (): Promise<void> => {
    calls.push(name);
    const err = overrides[name];
    if (err) throw err;
  };
  return {
    calls,
    shell: {
      pull: step('pull'),
      recreate: step('recreate'),
      migrate: step('migrate'),
      smoke: step('smoke'),
      rollback: step('rollback'),
    },
  };
}

// In-memory audit hooks. Records the 'started' insert and the terminal write
// so tests assert exactly one of each, in order, with the right result.
function buildHooks(): {
  hooks: OtaUpdateHooks;
  started: Array<{ from: string | null; to: string | null }>;
  finished: Array<{ id: number; result: OtaResult; detail: string }>;
} {
  const started: Array<{ from: string | null; to: string | null }> = [];
  const finished: Array<{ id: number; result: OtaResult; detail: string }> = [];
  return {
    started,
    finished,
    hooks: {
      recordStarted: async (from, to) => {
        started.push({ from, to });
        return 42; // deterministic attempt id
      },
      recordFinished: async (id, result, detail) => {
        finished.push({ id, result, detail });
      },
    },
  };
}

const INPUT = { fromDigest: 'sha256:old', toDigest: 'sha256:new' };

describe('runOtaUpdate — happy path', () => {
  it('walks pull → recreate → migrate → smoke and records succeeded', async () => {
    const { shell, calls } = buildShell();
    const { hooks, started, finished } = buildHooks();

    const outcome = await runOtaUpdate(shell, INPUT, hooks);

    expect(calls).toEqual(['pull', 'recreate', 'migrate', 'smoke']);
    expect(outcome.result).toBe('succeeded');
    expect(outcome.failed_step).toBeNull();
    expect(outcome.attempt_id).toBe(42);

    // Exactly one started + one terminal audit write, with the digests echoed.
    expect(started).toEqual([{ from: 'sha256:old', to: 'sha256:new' }]);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ id: 42, result: 'succeeded' });
  });

  it('does NOT call rollback on a clean run', async () => {
    const { shell, calls } = buildShell();
    const { hooks } = buildHooks();
    await runOtaUpdate(shell, INPUT, hooks);
    expect(calls).not.toContain('rollback');
  });
});

describe('runOtaUpdate — forward step failures roll back', () => {
  it.each<keyof OtaShell>([
    'pull',
    'recreate',
    'migrate',
    'smoke',
  ])('rolls back when %s fails and records rolled_back', async (failing) => {
    const { shell, calls } = buildShell({ [failing]: new Error(`${failing} boom`) });
    const { hooks, finished } = buildHooks();

    const outcome = await runOtaUpdate(shell, INPUT, hooks);

    expect(outcome.result).toBe('rolled_back');
    expect(outcome.failed_step).toBe(failing);
    // Rollback was attempted, and it's the LAST call.
    expect(calls[calls.length - 1]).toBe('rollback');
    // No forward step runs after the failing one.
    const idxFail = calls.indexOf(failing);
    const forwardAfter = calls.slice(idxFail + 1).filter((c) => c !== 'rollback');
    expect(forwardAfter).toEqual([]);
    expect(finished[0]).toMatchObject({ id: 42, result: 'rolled_back' });
    expect(finished[0].detail).toContain(`${failing} failed`);
  });

  it('smoke failure is the post-update health gate that triggers rollback', async () => {
    const { shell, calls } = buildShell({ smoke: new Error('smoke: draft never landed') });
    const { hooks } = buildHooks();
    const outcome = await runOtaUpdate(shell, INPUT, hooks);
    expect(outcome.result).toBe('rolled_back');
    expect(outcome.failed_step).toBe('smoke');
    // Forward steps all ran (smoke is last) before rollback.
    expect(calls).toEqual(['pull', 'recreate', 'migrate', 'smoke', 'rollback']);
  });
});

describe('runOtaUpdate — rollback itself failing escalates to failed', () => {
  it('records failed when both a forward step AND rollback throw', async () => {
    const { shell } = buildShell({
      migrate: new Error('migrate exploded'),
      rollback: new Error('rollback also exploded'),
    });
    const { hooks, finished } = buildHooks();

    const outcome = await runOtaUpdate(shell, INPUT, hooks);

    expect(outcome.result).toBe('failed');
    expect(outcome.failed_step).toBe('migrate');
    expect(finished[0]).toMatchObject({ id: 42, result: 'failed' });
    expect(finished[0].detail).toContain('ROLLBACK FAILED');
  });
});

describe('runOtaUpdate — never throws (total-failure-safe)', () => {
  it('resolves to an outcome even when every shell step throws', async () => {
    const { shell } = buildShell({
      pull: new Error('pull dead'),
      rollback: new Error('rollback dead'),
    });
    const { hooks } = buildHooks();
    await expect(runOtaUpdate(shell, INPUT, hooks)).resolves.toMatchObject({
      result: 'failed',
      failed_step: 'pull',
    });
  });

  it('records the started attempt before any shell call', async () => {
    const order: string[] = [];
    const shell: OtaShell = {
      pull: async () => {
        order.push('pull');
      },
      recreate: async () => {
        order.push('recreate');
      },
      migrate: async () => {
        order.push('migrate');
      },
      smoke: async () => {
        order.push('smoke');
      },
      rollback: async () => {
        order.push('rollback');
      },
    };
    const hooks: OtaUpdateHooks = {
      recordStarted: async () => {
        order.push('recordStarted');
        return 7;
      },
      recordFinished: vi.fn(async () => {
        order.push('recordFinished');
      }),
    };
    await runOtaUpdate(shell, INPUT, hooks);
    expect(order[0]).toBe('recordStarted');
    expect(order[order.length - 1]).toBe('recordFinished');
  });
});
