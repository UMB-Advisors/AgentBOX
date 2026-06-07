// MBOX-168 — unit tests for the swap pre-flight helper.
//
// Mirrors preflight-memory.test.ts: pure-function tests on injected
// /proc/meminfo strings so the same suite runs on macOS dev boxes and the
// Jetson identically.

import { describe, expect, it } from 'vitest';
import { checkSwap, parseSwap } from '@/lib/preflight/swap';

function meminfoWith(opts: {
  swapTotalKb?: number;
  swapFreeKb?: number;
  omit?: ('SwapTotal' | 'SwapFree')[];
}): string {
  const lines = [
    'MemTotal:        8100640 kB',
    'MemFree:         4000000 kB',
    'MemAvailable:    5000000 kB',
    'Buffers:           50000 kB',
    'Cached:          1200000 kB',
  ];
  if (!opts.omit?.includes('SwapTotal')) {
    lines.push(`SwapTotal:       ${opts.swapTotalKb ?? 0} kB`);
  }
  if (!opts.omit?.includes('SwapFree')) {
    lines.push(`SwapFree:        ${opts.swapFreeKb ?? 0} kB`);
  }
  return lines.join('\n');
}

const KB_PER_MIB = 1024;
const mibToKb = (mib: number) => mib * KB_PER_MIB;

describe('parseSwap', () => {
  it('parses well-formed SwapTotal + SwapFree', () => {
    const r = parseSwap(meminfoWith({ swapTotalKb: 4096, swapFreeKb: 2048 }));
    expect(r).not.toBeNull();
    expect(r!.swapTotalBytes).toBe(4096 * 1024);
    expect(r!.swapFreeBytes).toBe(2048 * 1024);
  });

  it('returns null when SwapTotal is missing', () => {
    expect(parseSwap(meminfoWith({ omit: ['SwapTotal'] }))).toBeNull();
  });

  it('returns null when SwapFree is missing', () => {
    expect(parseSwap(meminfoWith({ omit: ['SwapFree'] }))).toBeNull();
  });

  it('clamps SwapFree > SwapTotal (kernel-bug defense)', () => {
    const r = parseSwap(meminfoWith({ swapTotalKb: 100, swapFreeKb: 999 }));
    expect(r!.swapFreeBytes).toBe(r!.swapTotalBytes);
  });
});

describe('checkSwap', () => {
  it('returns green when no swap is in use (SwapTotal=0 or SwapFree==SwapTotal)', () => {
    const r = checkSwap({ meminfo: meminfoWith({ swapTotalKb: 0, swapFreeKb: 0 }) });
    expect(r.status).toBe('green');
    expect(r.swap_in_use_bytes).toBe(0);
    expect(r.swap_total_bytes).toBe(0);
    expect(r.reason).toBeNull();
  });

  it('returns green when swap is configured but fully free', () => {
    const r = checkSwap({
      meminfo: meminfoWith({ swapTotalKb: mibToKb(2048), swapFreeKb: mibToKb(2048) }),
    });
    expect(r.status).toBe('green');
    expect(r.swap_in_use_bytes).toBe(0);
    expect(r.swap_total_bytes).toBe(2048 * 1024 * 1024);
  });

  it('returns yellow when 0 < in_use ≤ threshold (default 100 MiB)', () => {
    // 50 MiB in use: total 2 GiB, free (2048-50) MiB
    const r = checkSwap({
      meminfo: meminfoWith({
        swapTotalKb: mibToKb(2048),
        swapFreeKb: mibToKb(2048 - 50),
      }),
    });
    expect(r.status).toBe('yellow');
    expect(r.swap_in_use_bytes).toBe(50 * 1024 * 1024);
    expect(r.reason).toMatch(/50\.0 MiB.*threshold 100 MiB/);
  });

  it('returns red when in_use > threshold (default 100 MiB)', () => {
    // 200 MiB in use
    const r = checkSwap({
      meminfo: meminfoWith({
        swapTotalKb: mibToKb(2048),
        swapFreeKb: mibToKb(2048 - 200),
      }),
    });
    expect(r.status).toBe('red');
    expect(r.swap_in_use_bytes).toBe(200 * 1024 * 1024);
    expect(r.reason).toMatch(/200\.0 MiB.*threshold 100 MiB/);
    expect(r.reason).toMatch(/RAM over-committed/);
  });

  it('boundary: exactly at threshold is yellow', () => {
    // 100 MiB in use, threshold 100 MiB
    const r = checkSwap({
      meminfo: meminfoWith({
        swapTotalKb: mibToKb(2048),
        swapFreeKb: mibToKb(2048 - 100),
      }),
    });
    expect(r.status).toBe('yellow');
  });

  it('reports red with reason when /proc/meminfo is unparseable', () => {
    const r = checkSwap({ meminfo: meminfoWith({ omit: ['SwapTotal', 'SwapFree'] }) });
    expect(r.status).toBe('red');
    expect(r.swap_in_use_bytes).toBe(0);
    expect(r.swap_total_bytes).toBe(0);
    expect(r.reason).toMatch(/no parseable SwapTotal\/SwapFree/);
  });

  it('honours MAILBOX_SWAP_THRESHOLD_MIB env override', () => {
    const prev = process.env.MAILBOX_SWAP_THRESHOLD_MIB;
    process.env.MAILBOX_SWAP_THRESHOLD_MIB = '50';
    try {
      // 75 MiB in use crosses the lower (50) threshold → red
      const r = checkSwap({
        meminfo: meminfoWith({
          swapTotalKb: mibToKb(2048),
          swapFreeKb: mibToKb(2048 - 75),
        }),
      });
      expect(r.threshold_mib).toBe(50);
      expect(r.status).toBe('red');
    } finally {
      if (prev === undefined) delete process.env.MAILBOX_SWAP_THRESHOLD_MIB;
      else process.env.MAILBOX_SWAP_THRESHOLD_MIB = prev;
    }
  });

  it('falls back to default 100 MiB when env override is garbage', () => {
    const prev = process.env.MAILBOX_SWAP_THRESHOLD_MIB;
    process.env.MAILBOX_SWAP_THRESHOLD_MIB = 'not-a-number';
    try {
      const r = checkSwap({
        meminfo: meminfoWith({ swapTotalKb: 0, swapFreeKb: 0 }),
      });
      expect(r.threshold_mib).toBe(100);
    } finally {
      if (prev === undefined) delete process.env.MAILBOX_SWAP_THRESHOLD_MIB;
      else process.env.MAILBOX_SWAP_THRESHOLD_MIB = prev;
    }
  });
});
