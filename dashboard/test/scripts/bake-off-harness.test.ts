// dashboard/test/scripts/bake-off-harness.test.ts
//
// MBOX-113 — regression tests for the harness CLI safety guards:
//   1. `assertJsonlNotClobbered` refuses to truncate a prior run's JSONL on
//      a --run-tag collision (and only allows it under --overwrite).
//
// Uses a real temp dir (no fs mocking) — the guard is a thin `access()`
// wrapper, so an on-disk fixture is the cheapest faithful exercise.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertJsonlNotClobbered } from '@/scripts/bake-off-harness';

describe('assertJsonlNotClobbered — MBOX-113', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bake-off-clobber-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is a no-op when the output file does not exist', async () => {
    const p = path.join(dir, 'eval-fresh-2026-05-27.jsonl');
    await expect(
      assertJsonlNotClobbered(p, 'eval-fresh-2026-05-27', false),
    ).resolves.toBeUndefined();
  });

  it('throws (suggesting a unique tag) when the file exists and overwrite=false', async () => {
    const p = path.join(dir, 'eval-collide-2026-05-27.jsonl');
    await writeFile(p, '{"prior":"run"}\n');
    await expect(assertJsonlNotClobbered(p, 'eval-collide-2026-05-27', false)).rejects.toThrow(
      /refusing to clobber/i,
    );
    await expect(assertJsonlNotClobbered(p, 'eval-collide-2026-05-27', false)).rejects.toThrow(
      /--overwrite|unique --run-tag/i,
    );
  });

  it('allows truncation (with a stderr warning) when overwrite=true', async () => {
    const p = path.join(dir, 'eval-collide-2026-05-27.jsonl');
    await writeFile(p, '{"prior":"run"}\n');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        assertJsonlNotClobbered(p, 'eval-collide-2026-05-27', true),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toMatch(/overwriting existing/i);
    } finally {
      warn.mockRestore();
    }
  });
});
