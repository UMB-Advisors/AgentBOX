import { type NextRequest, NextResponse } from 'next/server';
import { normalizeClassifierOutput } from '@/lib/classification/normalize';
import { isNeverSpamSender } from '@/lib/classification/sender-allowlist';
import { operatorOwnsThread } from '@/lib/classification/thread-ownership';
import { parseJson } from '@/lib/middleware/validate';
import { classificationNormalizeBodySchema } from '@/lib/schemas/internal';

export const dynamic = 'force-dynamic';

// D-06 / MAIL-07 — strip <think> tokens, parse JSON, fall back to
// {category: 'unknown', confidence: 0} on any parse failure. Exposed for the
// n8n classify sub-workflow so normalization logic stays in code, not in JSON.
//
// D-50 — accept optional `from` / `to` so the deterministic operator-identity
// preclass in lib/classification/preclass.ts can override the LLM verdict.
//
// UMB-153 — precheckSelfLoop fires inside normalizeClassifierOutput (sync).
//
// UMB-154 — after sync normalize, if result is not already dropped and
// thread_id is present, run the async operatorOwnsThread guard. If the
// operator owns the thread (replied within the active window), override to
// spam_marketing/drop with suppression_reason='operator_owns_thread'. The
// n8n Normalize node jsonBody needs a `thread_id` line for this to fire in
// production (see deploy note in SUMMARY).
//
// MBOX-370 — never-spam allowlist. If the verdict would otherwise be suppressed
// (a spam_marketing drop from the model/noreply/self-loop, OR a non-drop that the
// owns-thread guard could still suppress) AND the operator allowlisted this sender
// via /classifications, RE-RUN normalize with `neverSpam` (heuristic suppressions
// disabled → operator-domain `internal` / the model's real category; a genuine
// model spam verdict surfaced to `unknown`) and SKIP the owns-thread guard. The DB
// lookup is gated to the could-be-suppressed path, so a normal non-spam classify
// (no thread_id, non-spam) stays query-free.
export async function POST(req: NextRequest) {
  const b = await parseJson(req, classificationNormalizeBodySchema);
  if (!b.ok) return b.response;
  const { raw, from, to, thread_id } = b.data;

  try {
    const result = normalizeClassifierOutput(raw, { from, to });

    const couldSuppress =
      result.category === 'spam_marketing' || (result.route !== 'drop' && Boolean(thread_id));
    if (couldSuppress && (await isNeverSpamSender(from))) {
      const surfaced = normalizeClassifierOutput(raw, { from, to, neverSpam: true });
      console.log(
        `[classify] never-spam from=${from ?? ''} -> ${surfaced.category}/${surfaced.route} (owns-thread skipped)`,
      );
      return NextResponse.json(surfaced);
    }

    // UMB-154: async thread-ownership check. Short-circuit if already dropped
    // (saves a DB query on every spam/noreply/self-loop path) or if no
    // thread_id was provided (can't prove ownership without it → fail open).
    if (result.route !== 'drop' && thread_id) {
      const ownership = await operatorOwnsThread({ thread_id });
      if (ownership.owned) {
        const suppressed = {
          ...result,
          category: 'spam_marketing' as const,
          route: 'drop' as const,
          preclass_applied: true,
          preclass_source: 'operator-owns-thread' as const,
          suppression_reason: 'operator_owns_thread' as const,
        };
        console.log(
          `[classify] suppressed draft reason=operator_owns_thread from=${from ?? ''} thread=${thread_id} last_op_reply=${ownership.last_operator_reply_at ?? 'unknown'}`,
        );
        return NextResponse.json(suppressed);
      }
    }

    // Log self-loop suppressions too (set by precheckSelfLoop in normalize).
    if (result.suppression_reason === 'self_loop') {
      console.log(
        `[classify] suppressed draft reason=self_loop from=${from ?? ''} to=${to ?? ''} thread=${thread_id ?? ''}`,
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('POST /api/internal/classification-normalize failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
