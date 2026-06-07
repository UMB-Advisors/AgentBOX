// MBOX-168 — System swap-in-use health stat.
//
// Why this exists: the same DR-25 misdiagnosis class that motivated
// MBOX-166 (memory pressure) also has a swap-tail. On the Jetson Orin Nano
// Super 8 GiB, sustained swap use is a *symptom* — not a cause — of memory
// over-commit by the resident GGUF process, an orphan container, or a
// runaway dashboard process. We log it as a stand-alone /status field so
// operators (and other Claude sessions) can correlate "the box is sluggish
// and the last inference latency is up" with "we're paging."
//
// Why /proc/meminfo (and only /proc/meminfo): /proc/swaps would tell us
// *which* swap device is active, but the operator-facing answer is "how
// many bytes are paged out right now" — which is `SwapTotal - SwapFree`.
// One file, one read, no shell-out.
//
// Threshold rationale: 0 = green (swap configured but unused — normal on a
// Jetson with zram), > 0 and ≤ 100 MiB = yellow (some pressure but within
// noise floor of zram swap cycling), > 100 MiB = red (we're actually
// paging RAM out — the GGUF process likely won't survive a second model
// load and inference latency will spike).
//
// Threshold operator-tunable via MAILBOX_SWAP_THRESHOLD_MIB. Bad value →
// silent fall-back to 100 MiB (mirrors the env-handling convention in
// lib/preflight/memory.ts:envMinMemGiB).
//
// Total-failure-safe contract: this helper NEVER throws. /proc/meminfo
// missing, unreadable, or unparseable → returns `status: 'red'` with an
// operator-readable `reason`. Callers in the /api/system/status aggregator
// rely on this — they intentionally don't try/catch around it (same
// contract as checkMemoryPressure).

import { readFileSync } from 'node:fs';

const DEFAULT_THRESHOLD_MIB = 100;
const MIB = 1024 * 1024;

export type SwapStatus = 'green' | 'yellow' | 'red';

export interface SwapResult {
  status: SwapStatus;
  swap_in_use_bytes: number;
  swap_total_bytes: number;
  threshold_mib: number;
  reason: string | null;
}

export interface CheckSwapOptions {
  /** Raw /proc/meminfo content. Tests pass a string; prod reads the file. */
  meminfo?: string;
  /** Override the yellow→red threshold in MiB. */
  thresholdMib?: number;
}

interface ParsedSwap {
  swapTotalBytes: number;
  swapFreeBytes: number;
}

/**
 * Parse `SwapTotal:` and `SwapFree:` (both reported in kB) from a
 * /proc/meminfo payload. Returns null if either line is missing or
 * malformed. Exported for direct unit testing.
 */
export function parseSwap(meminfo: string): ParsedSwap | null {
  const totalMatch = meminfo.match(/^SwapTotal:\s+(\d+)\s+kB$/m);
  const freeMatch = meminfo.match(/^SwapFree:\s+(\d+)\s+kB$/m);
  if (!totalMatch || !freeMatch) return null;
  const totalKb = Number.parseInt(totalMatch[1], 10);
  const freeKb = Number.parseInt(freeMatch[1], 10);
  if (!Number.isFinite(totalKb) || totalKb < 0) return null;
  if (!Number.isFinite(freeKb) || freeKb < 0) return null;
  // SwapFree > SwapTotal would be a kernel bug; clamp defensively rather
  // than report a negative in-use figure.
  const clampedFreeKb = Math.min(freeKb, totalKb);
  return {
    swapTotalBytes: totalKb * 1024,
    swapFreeBytes: clampedFreeKb * 1024,
  };
}

function envThresholdMib(): number {
  const raw = process.env.MAILBOX_SWAP_THRESHOLD_MIB;
  if (!raw) return DEFAULT_THRESHOLD_MIB;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_THRESHOLD_MIB;
}

function red(thresholdMib: number, reason: string): SwapResult {
  return {
    status: 'red',
    swap_in_use_bytes: 0,
    swap_total_bytes: 0,
    threshold_mib: thresholdMib,
    reason,
  };
}

/**
 * Read /proc/meminfo and report current swap usage.
 *
 * - `green`:  no swap in use (the desired steady state on the Jetson)
 * - `yellow`: 0 < swap_in_use ≤ threshold MiB (noise / zram cycling)
 * - `red`:    swap_in_use > threshold MiB OR /proc/meminfo unreadable /
 *             unparseable (operator must be told either way)
 */
export function checkSwap(opts: CheckSwapOptions = {}): SwapResult {
  const thresholdMib = opts.thresholdMib ?? envThresholdMib();
  const thresholdBytes = thresholdMib * MIB;

  let meminfo: string | null = opts.meminfo ?? null;
  if (meminfo === null) {
    try {
      meminfo = readFileSync('/proc/meminfo', 'utf8');
    } catch (e) {
      return red(
        thresholdMib,
        `unable to read /proc/meminfo: ${
          e instanceof Error ? e.message : String(e)
        } — swap status unknown`,
      );
    }
  }

  const parsed = parseSwap(meminfo);
  if (parsed === null) {
    return red(
      thresholdMib,
      '/proc/meminfo had no parseable SwapTotal/SwapFree lines — swap status unknown',
    );
  }

  const inUseBytes = parsed.swapTotalBytes - parsed.swapFreeBytes;
  const inUseMiB = inUseBytes / MIB;

  if (inUseBytes === 0) {
    return {
      status: 'green',
      swap_in_use_bytes: 0,
      swap_total_bytes: parsed.swapTotalBytes,
      threshold_mib: thresholdMib,
      reason: null,
    };
  }

  if (inUseBytes > thresholdBytes) {
    return {
      status: 'red',
      swap_in_use_bytes: inUseBytes,
      swap_total_bytes: parsed.swapTotalBytes,
      threshold_mib: thresholdMib,
      reason: `swap in use ${inUseMiB.toFixed(
        1,
      )} MiB > threshold ${thresholdMib} MiB — RAM over-committed; expect inference latency spikes and OOM risk on next large-GGUF load`,
    };
  }

  return {
    status: 'yellow',
    swap_in_use_bytes: inUseBytes,
    swap_total_bytes: parsed.swapTotalBytes,
    threshold_mib: thresholdMib,
    reason: `swap in use ${inUseMiB.toFixed(
      1,
    )} MiB ≤ threshold ${thresholdMib} MiB — within noise floor but worth watching`,
  };
}
