// dashboard/lib/rag/kb-reconciler.ts
//
// STAQPRO-148 — startup reconciler for stuck KB ingestion jobs. Per the
// Plan agent's stress-test: fire-and-forget embed jobs (kb-ingest.ts) can
// be interrupted by a dashboard restart mid-embed, leaving rows
// permanently in 'processing'. This reconciler runs once on cold-start,
// finds rows older than the threshold, and flips them to 'failed' so the
// operator sees a Retry button (which calls embedAndUpsertChunks against
// the already-stored sha256 file — no re-upload needed).
//
// Idempotency: safe to run repeatedly. Only matches rows where
// status='processing' AND processing_started_at < NOW() - INTERVAL '5 min'.
// Healthy in-flight jobs (under 5 min) are not touched.

import { listStuckProcessingDocs, updateKbDocumentStatus } from '@/lib/queries-kb';

const STUCK_THRESHOLD_MIN = Number(process.env.KB_STUCK_THRESHOLD_MIN ?? 5);
const STUCK_ERROR_MESSAGE = 'interrupted, please retry from UI';

let reconcilerRan = false;

export async function reconcileStuckKbDocs(): Promise<{ flipped: number }> {
  const stuck = await listStuckProcessingDocs(STUCK_THRESHOLD_MIN);
  let flipped = 0;
  for (const doc of stuck) {
    await updateKbDocumentStatus(doc.id, {
      status: 'failed',
      error_message: STUCK_ERROR_MESSAGE,
    });
    flipped += 1;
  }
  if (flipped > 0) {
    console.log(`[kb-reconciler] flipped ${flipped} stuck doc(s) to 'failed'`);
  }
  return { flipped };
}

// Runs at most once per process lifetime. Designed to be invoked from a
// cold-start path (e.g., the first request to /api/kb-documents) — Next.js
// doesn't have a clean "boot hook" in the App Router, so first-request
// triggering is the idiomatic alternative.
export async function reconcileOnce(): Promise<void> {
  if (reconcilerRan) return;
  reconcilerRan = true;
  try {
    await reconcileStuckKbDocs();
  } catch (error) {
    console.error('[kb-reconciler] failed:', error);
    // Do not flip the latch back — a transient DB error shouldn't cause
    // the reconciler to spam every subsequent request. Next dashboard
    // restart will retry.
  }
}

// Test-only escape hatch — unit tests need to exercise reconcileOnce more
// than once across describe blocks.
export function _resetReconcilerLatchForTests(): void {
  reconcilerRan = false;
}
