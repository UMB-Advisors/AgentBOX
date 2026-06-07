import { evaluateAutoSend } from '@/lib/auto-send/rules';
import {
  applyDropAction,
  getAutoSendEvalContext,
  getEnabledAutoSendRules,
  recordAutoSendAudit,
} from '@/lib/queries-auto-send';
import { transitionToApprovedAndSend } from '@/lib/transitions';
import type { AutoSendAction } from '@/lib/types';

// MBOX-16 / FR-23 — the orchestration the draft-finalize route runs AFTER a
// draft body is persisted (status='pending'). Loads the eval context + enabled
// rules, runs the pure evaluator, writes the audit row, and ACTS on the
// effective action:
//   - auto_send → transitionToApprovedAndSend(actor='auto'). This reuses the
//     SAME path operator-approve uses, so it inherits ALL the safety gates:
//     the Gmail cooldown circuit breaker (429 → no send, draft stays pending),
//     the send_attempt_at idempotency CAS lock (migration 025), and the
//     migration-009 state_transitions audit trigger. We DO NOT bypass any of
//     them. If the cooldown/lock blocks the send, the draft simply stays
//     queued — the operator handles it like any other pending draft.
//   - drop → applyDropAction (mark auto_send_blocked + reject).
//   - queue / no-match → leave at pending for the operator (the default).
//
// This NEVER throws to the route: auto-send is an enhancement on top of the
// normal queue flow, and a failure here must not fail the (already-persisted)
// finalize. On any error we log, record a best-effort audit, and leave the
// draft pending.

export interface AutoSendOutcome {
  // What actually happened to the draft as a result of rule evaluation.
  effective_action: AutoSendAction;
  // The rule that matched (null = default no-match → queued).
  rule_id: number | null;
  rule_name: string | null;
  shadow: boolean;
  reason: string;
  // True only when an auto_send actually fired the send webhook successfully.
  sent: boolean;
}

export async function runAutoSendForFinalizedDraft(draftId: number): Promise<AutoSendOutcome> {
  // Default outcome if anything below short-circuits — the safe all-manual
  // queue state.
  const queued: AutoSendOutcome = {
    effective_action: 'queue',
    rule_id: null,
    rule_name: null,
    shadow: false,
    reason: 'no_rule_match',
    sent: false,
  };

  try {
    const ctx = await getAutoSendEvalContext(draftId);
    if (!ctx) return { ...queued, reason: 'draft_not_found' };

    const rules = await getEnabledAutoSendRules();
    // Fast path: no rules configured (fresh install) → nothing to evaluate,
    // skip the audit write entirely. Default-safe all-manual.
    if (rules.length === 0) return queued;

    const decision = evaluateAutoSend(rules, ctx, new Date());

    const base: AutoSendOutcome = {
      effective_action: decision.effectiveAction,
      rule_id: decision.rule?.id ?? null,
      rule_name: decision.rule?.name ?? null,
      shadow: decision.shadow,
      reason: decision.reason,
      sent: false,
    };

    if (decision.effectiveAction === 'drop') {
      await applyDropAction(draftId);
      await recordAutoSendAudit(draftId, decision);
      return base;
    }

    if (decision.effectiveAction === 'auto_send') {
      // Reuse the operator approve/send path with actor='auto'. The cooldown
      // check + idempotency lock + audit trigger all live inside this call.
      //
      // fromStates covers EVERY legal pre-send status, not just the one we
      // expect here. A draft reaching this hook is normally 'pending' (the
      // stub was set pending at Insert Draft Stub, draft-finalize doesn't
      // change status). But 'awaiting_cloud' is a live status for in-flight
      // cloud-route drafts, and 'edited' is reachable via the operator edit
      // path — if either ever becomes the status at finalize time, omitting
      // it would 409 the CAS, silently stranding the draft with no
      // operator-visible error. Including all three is safe: the
      // status='approved' WHERE-guard inside transitionToApprovedAndSend is
      // still the atomic CAS, so a draft already past these states no-ops
      // cleanly. Kept in sync with applyDropAction's status guard.
      const res = await transitionToApprovedAndSend(draftId, {
        fromStates: ['pending', 'awaiting_cloud', 'edited'],
        fromStatesLabel: 'pending, awaiting_cloud, or edited',
        clearError: true,
        routeName: 'auto_send',
        actor: 'auto',
        reason: 'auto_send_rule',
      });
      const sent = res.status >= 200 && res.status < 300;
      // Record the attempt outcome. A non-2xx (cooldown 429 / lock 409 / wrong
      // state 409 / webhook 502) means the draft was NOT sent and stays in its
      // queue state for the operator — distinguish that in the audit reason.
      const outcome: AutoSendOutcome = sent
        ? base
        : { ...base, effective_action: 'queue', reason: 'send_blocked', sent: false };
      await recordAutoSendAudit(
        draftId,
        decision,
        sent ? decision.reason : `send_blocked_http_${res.status}`,
      );
      return outcome;
    }

    // queue (explicit rule or shadow downgrade) — nothing to do but audit.
    await recordAutoSendAudit(draftId, decision);
    return base;
  } catch (err) {
    console.error(
      `auto-send evaluation failed draft=${draftId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Best-effort audit of the failure; swallow any secondary error.
    try {
      await recordAutoSendAudit(
        draftId,
        {
          rule: null,
          matchedAction: 'queue',
          effectiveAction: 'queue',
          shadow: false,
          reason: 'eval_error',
        },
        'eval_error',
      );
    } catch (auditErr) {
      // Non-gating — auditing must never mask the queue fallback. Log so a
      // persistent audit-write failure is visible rather than swallowed.
      console.warn('auto-send audit write failed', auditErr);
    }
    return { ...queued, reason: 'eval_error' };
  }
}
