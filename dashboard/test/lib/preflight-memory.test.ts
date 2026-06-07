// MBOX-166 / MBOX-109 — unit tests for the memory pre-flight helper.
//
// Convention: mirrors test/lib/alerts.test.ts — pure-function tests on
// a deterministic input. Production reads /proc/meminfo; tests pass
// `meminfo: string` directly so they run identically on macOS dev boxes
// and the Jetson.

import { describe, expect, it } from 'vitest';
import { checkMemoryPressure, parseMemAvailableGiB } from '@/lib/preflight/memory';

// Helper — build a meminfo blob with a given MemAvailable in kB.
function meminfoWith(memAvailableKb: number): string {
  return [
    'MemTotal:        8100640 kB',
    'MemFree:         4000000 kB',
    `MemAvailable:    ${memAvailableKb} kB`,
    'Buffers:           50000 kB',
    'Cached:          1200000 kB',
  ].join('\n');
}

const KB_PER_GIB = 1024 * 1024;
const gibToKb = (g: number) => Math.round(g * KB_PER_GIB);

describe('parseMemAvailableGiB', () => {
  it('parses a well-formed MemAvailable line', () => {
    const g = parseMemAvailableGiB(meminfoWith(gibToKb(2.5)));
    expect(g).not.toBeNull();
    expect(g).toBeCloseTo(2.5, 3);
  });

  it('returns null when MemAvailable is missing', () => {
    expect(parseMemAvailableGiB('MemTotal: 8100640 kB\nMemFree: 4000000 kB')).toBeNull();
  });

  it('returns null on malformed numeric', () => {
    expect(parseMemAvailableGiB('MemAvailable:    notanumber kB')).toBeNull();
  });
});

describe('checkMemoryPressure (default 1.5 GiB threshold)', () => {
  it('returns green well above the threshold + amber band', () => {
    const r = checkMemoryPressure({
      minMemGiB: 1.5,
      meminfo: meminfoWith(gibToKb(4.0)),
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('green');
    expect(r.reason).toBeNull();
    expect(r.memAvailableGiB).toBeCloseTo(4.0, 3);
    expect(r.minMemGiB).toBe(1.5);
  });

  it('returns amber inside the 200 MiB band above threshold (still ok)', () => {
    // 1.5 GiB + 100 MiB = 1.5977 GiB — inside amber band (< 1.5 + 200 MiB)
    const amberGiB = 1.5 + 100 / 1024;
    const r = checkMemoryPressure({
      minMemGiB: 1.5,
      meminfo: meminfoWith(gibToKb(amberGiB)),
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('amber');
    expect(r.reason).toMatch(/within 200 MiB of threshold/);
  });

  it('returns red below the threshold and populates an operator-facing reason', () => {
    const r = checkMemoryPressure({
      minMemGiB: 1.5,
      meminfo: meminfoWith(gibToKb(0.9)),
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('red');
    expect(r.reason).toMatch(/MemAvailable 0\.90 GiB < threshold 1\.50 GiB/);
    expect(r.reason).toMatch(/llama-cpp likely holding GPU memory/);
  });

  it('boundary: exactly at the threshold is amber (>= threshold is ok)', () => {
    const r = checkMemoryPressure({
      minMemGiB: 1.5,
      meminfo: meminfoWith(gibToKb(1.5)),
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('amber');
  });

  it('boundary: just under the threshold is red', () => {
    const r = checkMemoryPressure({
      minMemGiB: 1.5,
      meminfo: meminfoWith(gibToKb(1.5 - 0.001)),
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('red');
  });
});

describe('checkMemoryPressure — failure modes do not throw', () => {
  it('missing MemAvailable line maps to red with a clear reason', () => {
    const r = checkMemoryPressure({
      minMemGiB: 1.5,
      meminfo: 'MemTotal: 8100640 kB\nMemFree: 4000000 kB',
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('red');
    expect(r.reason).toMatch(/no parseable MemAvailable line/);
    expect(r.memAvailableGiB).toBe(0);
  });

  it('malformed MemAvailable value maps to red, not a throw', () => {
    const r = checkMemoryPressure({
      minMemGiB: 1.5,
      meminfo: 'MemAvailable: notanumber kB',
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('red');
    expect(r.reason).toMatch(/no parseable MemAvailable line/);
  });
});

describe('checkMemoryPressure — env override', () => {
  it('reads MAILBOX_PREFLIGHT_MIN_MEM_GIB when no opts.minMemGiB given', () => {
    const prev = process.env.MAILBOX_PREFLIGHT_MIN_MEM_GIB;
    process.env.MAILBOX_PREFLIGHT_MIN_MEM_GIB = '2.5';
    try {
      const r = checkMemoryPressure({ meminfo: meminfoWith(gibToKb(2.0)) });
      expect(r.minMemGiB).toBe(2.5);
      expect(r.status).toBe('red');
    } finally {
      if (prev === undefined) delete process.env.MAILBOX_PREFLIGHT_MIN_MEM_GIB;
      else process.env.MAILBOX_PREFLIGHT_MIN_MEM_GIB = prev;
    }
  });

  it('falls back to default 1.5 GiB when env var is garbage', () => {
    const prev = process.env.MAILBOX_PREFLIGHT_MIN_MEM_GIB;
    process.env.MAILBOX_PREFLIGHT_MIN_MEM_GIB = 'not-a-number';
    try {
      const r = checkMemoryPressure({ meminfo: meminfoWith(gibToKb(4.0)) });
      expect(r.minMemGiB).toBe(1.5);
      expect(r.status).toBe('green');
    } finally {
      if (prev === undefined) delete process.env.MAILBOX_PREFLIGHT_MIN_MEM_GIB;
      else process.env.MAILBOX_PREFLIGHT_MIN_MEM_GIB = prev;
    }
  });
});
