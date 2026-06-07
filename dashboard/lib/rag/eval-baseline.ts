// dashboard/lib/rag/eval-baseline.ts
//
// STAQPRO-192 Phase 1 — pre-RAG edit-rate baseline.
//
// Goal: lock a single number as the operator's pre-RAG edit-rate so that
// once retrieval ships in STAQPRO-191, a delta over a rolling 7-day window
// is computable. Without a frozen baseline, "did RAG help" decays into
// week-over-week noise after retrieval starts changing the drafts being
// rated.
//
// Capture protocol (one-time, BEFORE STAQPRO-191 deploys to the appliance):
//
//   1. SSH to the appliance:
//        ssh mailbox1 'cd ~/mailbox && docker compose exec postgres \
//          psql -U mailbox -d mailbox -c "
//            SELECT
//              ROUND(
//                COUNT(*) FILTER (WHERE status = '\''edited'\'')::numeric
//                / NULLIF(COUNT(*) FILTER (WHERE status IN
//                    ('\''approved'\'', '\''edited'\'', '\''sent'\'')), 0),
//                4
//              ) AS edit_rate_7d,
//              COUNT(*) FILTER (WHERE status IN
//                ('\''approved'\'', '\''edited'\'', '\''sent'\''))
//                AS sample_size
//            FROM mailbox.drafts
//            WHERE updated_at > NOW() - INTERVAL '\''7 days'\'';
//          "'
//
//   2. Replace the `null` values below with the captured number + date +
//      sample size. Commit. Re-deploy.
//
//   3. From that moment, the /status page shows baseline + live 7d as a
//      side-by-side comparison.
//
// Decision criteria written into STAQPRO-192: "RAG is helping" when the
// post-RAG 7d edit-rate is sustained at a relative reduction of ≥ 15%
// (e.g., baseline 0.40 → live 0.34) over 14 days. Below that, retrieval
// is noise and we should debug before generalizing to a 2nd customer.

export interface RagBaseline {
  edit_rate: number | null;
  captured_at: string | null; // ISO 8601
  sample_size: number | null;
}

// Default = unfrozen. Operator captures before STAQPRO-191 lands.
// The /status page reflects "baseline pending capture" until this is set.
export const RAG_BASELINE: RagBaseline = {
  edit_rate: null,
  captured_at: null,
  sample_size: null,
};

// "RAG is helping" threshold — relative reduction in edit rate.
export const RAG_HELPING_REDUCTION_THRESHOLD = 0.15;

export interface RagEvalSnapshot {
  baseline: RagBaseline;
  live_7d: {
    edit_rate: number | null;
    sample_size: number;
  };
  delta: {
    absolute: number | null; // live - baseline (negative = improvement)
    relative: number | null; // (live - baseline) / baseline
    helping: boolean | null; // null when either input is missing
  };
}

export function buildRagEvalSnapshot(
  liveEditRate: number | null,
  liveSampleSize: number,
): RagEvalSnapshot {
  const baseline = RAG_BASELINE;
  let absolute: number | null = null;
  let relative: number | null = null;
  let helping: boolean | null = null;
  if (liveEditRate !== null && baseline.edit_rate !== null && baseline.edit_rate > 0) {
    absolute = liveEditRate - baseline.edit_rate;
    relative = absolute / baseline.edit_rate;
    helping = relative <= -RAG_HELPING_REDUCTION_THRESHOLD;
  }
  return {
    baseline,
    live_7d: { edit_rate: liveEditRate, sample_size: liveSampleSize },
    delta: { absolute, relative, helping },
  };
}
