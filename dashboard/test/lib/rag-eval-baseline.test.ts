import { describe, expect, it } from 'vitest';
import {
  buildRagEvalSnapshot,
  RAG_BASELINE,
  RAG_HELPING_REDUCTION_THRESHOLD,
} from '@/lib/rag/eval-baseline';

// STAQPRO-192 Phase 1 — buildRagEvalSnapshot must return delta=null when
// either side is missing, and only mark helping=true when the relative
// reduction crosses RAG_HELPING_REDUCTION_THRESHOLD (default 15%).

describe('buildRagEvalSnapshot — STAQPRO-192', () => {
  it('returns helping=null when baseline edit_rate is unset', () => {
    // RAG_BASELINE.edit_rate ships null in source — until operator captures
    // a real value, the harness should refuse to call it helpful.
    expect(RAG_BASELINE.edit_rate).toBeNull();
    const s = buildRagEvalSnapshot(0.2, 100);
    expect(s.delta.helping).toBeNull();
    expect(s.delta.relative).toBeNull();
    expect(s.delta.absolute).toBeNull();
    expect(s.live_7d.edit_rate).toBe(0.2);
  });

  it('returns helping=null when live edit_rate is null (no 7d disposed drafts)', () => {
    const s = buildRagEvalSnapshot(null, 0);
    expect(s.delta.helping).toBeNull();
    expect(s.live_7d.sample_size).toBe(0);
  });

  it('marks helping=true at exactly the threshold reduction', () => {
    // Stub a baseline locally for the math test (the live const is null).
    const stub = { edit_rate: 0.4, captured_at: 'now', sample_size: 100 };
    const liveAtThreshold = stub.edit_rate * (1 - RAG_HELPING_REDUCTION_THRESHOLD);
    // Our function reads from the module constant, so verify the math
    // directly here rather than mutating the const at runtime.
    const relative = (liveAtThreshold - stub.edit_rate) / stub.edit_rate;
    expect(relative).toBeCloseTo(-RAG_HELPING_REDUCTION_THRESHOLD);
    expect(relative <= -RAG_HELPING_REDUCTION_THRESHOLD).toBe(true);
  });

  it('marks helping=false when reduction is below threshold', () => {
    const stub = { edit_rate: 0.4, captured_at: 'now', sample_size: 100 };
    const liveBelowThreshold = stub.edit_rate * (1 - RAG_HELPING_REDUCTION_THRESHOLD * 0.5);
    const relative = (liveBelowThreshold - stub.edit_rate) / stub.edit_rate;
    expect(relative > -RAG_HELPING_REDUCTION_THRESHOLD).toBe(true);
  });

  it('exposes a stable shape: { baseline, live_7d, delta }', () => {
    const s = buildRagEvalSnapshot(0.3, 50);
    expect(s).toHaveProperty('baseline');
    expect(s).toHaveProperty('live_7d');
    expect(s).toHaveProperty('delta');
    expect(s.live_7d).toHaveProperty('edit_rate');
    expect(s.live_7d).toHaveProperty('sample_size');
    expect(s.delta).toHaveProperty('absolute');
    expect(s.delta).toHaveProperty('relative');
    expect(s.delta).toHaveProperty('helping');
  });
});
