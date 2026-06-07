// MBOX-166 / MBOX-109 — System memory pre-flight guard.
//
// Why this exists: DR-25 (llama.cpp T2 inference) soak window logged 138
// llama-cpp container restarts when `classify-backfill.ts` loaded
// `qwen3:4b-ctx4k` (~3.6 GiB) into Ollama alongside the resident llama.cpp
// process (~3.3 GiB) on the 8 GiB Jetson Orin Nano Super. CUDA-side
// allocation failures never tripped kernel OOM, so the soak window's
// memory rule was invisible to standard OOM monitoring.
//
// Why MemAvailable (and only MemAvailable): the Jetson uses unified
// memory — the GPU and CPU share one physical pool. There is no separate
// VRAM accounting that we can usefully read at script start: nvidia-smi
// is not installed on Jetson L4T (use tegrastats), tegrastats is a
// streaming tool with a non-trivial parse surface, and any GPU-side reading
// would be redundant on unified memory anyway. /proc/meminfo's
// `MemAvailable` is the kernel's own combined estimate of memory that can
// be allocated without swapping — for a unified-memory device that's the
// authoritative single number we need.
//
// Threshold rationale: 1.5 GiB default. Loading `qwen3:4b-ctx4k` peaks
// around 4 GiB during weight upload + KV-cache warmup; if MemAvailable
// is already below 1.5 GiB, llama-cpp is almost certainly resident and
// a second large-GGUF load will OOM the CUDA allocator. The amber band
// (200 MiB above the threshold) is operator-facing only — we still allow
// the run, but it gives the /status page something to surface before the
// red event.
//
// Scope: this helper is consumed by (a) the two GGUF-loading backfill
// scripts (`classify-backfill.ts`, `rag-backfill.ts`) as a pre-flight
// hard-gate (escape hatch: `MAILBOX_PREFLIGHT_SKIP=1`), and (b) the
// /api/system/status aggregator as a `memory_pressure` health stat. It
// is intentionally NOT wired into the pipeline-time inference path —
// that would add 100s of /proc/meminfo reads per minute and isn't where
// the failure mode lives. Per-script self-guard is enough.

import { readFileSync } from 'node:fs';

const KB_PER_GIB = 1024 * 1024;

const DEFAULT_MIN_MEM_GIB = 1.5;
const AMBER_BAND_MIB = 200;

export type MemoryPressureStatus = 'green' | 'amber' | 'red';

export interface MemoryPressureResult {
  ok: boolean;
  memAvailableGiB: number;
  minMemGiB: number;
  status: MemoryPressureStatus;
  reason: string | null;
}

export interface CheckMemoryPressureOptions {
  /** Minimum acceptable MemAvailable in GiB. Defaults to env / 1.5. */
  minMemGiB?: number;
  /**
   * Raw `/proc/meminfo` content. Primarily for tests. Production callers
   * leave this undefined and the helper reads `/proc/meminfo` itself.
   */
  meminfo?: string;
}

/**
 * Parse the `MemAvailable:` line out of a `/proc/meminfo` payload.
 * Returns null if the line is missing or malformed — callers decide what
 * status to map that to. Exported for direct unit testing.
 */
export function parseMemAvailableGiB(meminfo: string): number | null {
  const m = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  if (!m) return null;
  const kb = Number.parseInt(m[1], 10);
  if (!Number.isFinite(kb) || kb < 0) return null;
  return kb / KB_PER_GIB;
}

function envMinMemGiB(): number {
  const raw = process.env.MAILBOX_PREFLIGHT_MIN_MEM_GIB;
  if (!raw) return DEFAULT_MIN_MEM_GIB;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIN_MEM_GIB;
}

/**
 * Read `/proc/meminfo` and classify current memory pressure.
 *
 * - `green`: MemAvailable above (threshold + 200 MiB) — safe to load a
 *   large GGUF.
 * - `amber`: MemAvailable within the 200 MiB band above the threshold —
 *   still allowed (ok=true) but the operator should know the next big
 *   load is going to be close to the line.
 * - `red`: MemAvailable below the threshold OR `/proc/meminfo` is
 *   unreadable/unparseable. The helper does not throw on read failure —
 *   it returns `ok=false` with `status='red'` and a reason string so
 *   callers can fail loudly without try/catch.
 */
export function checkMemoryPressure(opts: CheckMemoryPressureOptions = {}): MemoryPressureResult {
  const minMemGiB = opts.minMemGiB ?? envMinMemGiB();
  const amberCeilingGiB = minMemGiB + AMBER_BAND_MIB / 1024;

  let meminfo: string | null = opts.meminfo ?? null;
  if (meminfo === null) {
    try {
      meminfo = readFileSync('/proc/meminfo', 'utf8');
    } catch (e) {
      return {
        ok: false,
        memAvailableGiB: 0,
        minMemGiB,
        status: 'red',
        reason: `unable to read /proc/meminfo: ${
          e instanceof Error ? e.message : String(e)
        } — preflight cannot verify memory; aborting to avoid blind GGUF load`,
      };
    }
  }

  const memAvailableGiB = parseMemAvailableGiB(meminfo);
  if (memAvailableGiB === null) {
    return {
      ok: false,
      memAvailableGiB: 0,
      minMemGiB,
      status: 'red',
      reason:
        '/proc/meminfo had no parseable MemAvailable line — preflight cannot verify memory; aborting to avoid blind GGUF load',
    };
  }

  if (memAvailableGiB < minMemGiB) {
    return {
      ok: false,
      memAvailableGiB,
      minMemGiB,
      status: 'red',
      reason: `MemAvailable ${memAvailableGiB.toFixed(2)} GiB < threshold ${minMemGiB.toFixed(
        2,
      )} GiB — llama-cpp likely holding GPU memory; run when idle or stop llama-cpp first`,
    };
  }

  if (memAvailableGiB < amberCeilingGiB) {
    return {
      ok: true,
      memAvailableGiB,
      minMemGiB,
      status: 'amber',
      reason: `MemAvailable ${memAvailableGiB.toFixed(
        2,
      )} GiB within ${AMBER_BAND_MIB} MiB of threshold ${minMemGiB.toFixed(
        2,
      )} GiB — proceeding, but next large-GGUF load will be close to the line`,
    };
  }

  return {
    ok: true,
    memAvailableGiB,
    minMemGiB,
    status: 'green',
    reason: null,
  };
}
