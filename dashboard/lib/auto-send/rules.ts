import type { AutoSendAction, AutoSendRule, ClassificationCategory } from '@/lib/types';
import { LOW_CONF_FLOOR } from '@/lib/urgency';

// MBOX-16 / FR-23 — auto-send rule evaluator. Pure, dependency-free,
// clock-injectable. THIS is the single source of truth for whether a finalized
// draft auto-sends, queues, or drops. The route (app/api/internal/draft-finalize)
// only persists the decision + acts on it; all policy lives here so it is unit
// testable without a DB or n8n.
//
// Safety model (the whole point of FR-23's "auto-send + bad classification =
// embarrassment" warning): config can only ever make auto-send MORE
// conservative, never less. The HARD GUARDRAILS below are applied AFTER a rule
// matches and can only downgrade an 'auto_send' to 'queue'. No rule, however
// authored, can:
//   - auto-send an 'escalate' or 'unknown' draft (those route to a human),
//   - auto-send below the LOW_CONF_FLOOR (0.75) confidence floor,
//   - auto-send a draft the operator (or a prior 'drop' rule) flagged
//     auto_send_blocked.
// Shadow mode is a fourth, time-boxed downgrade: a rule in its shadow window
// logs what it WOULD have sent but queues instead.
//
// Evaluation: walk enabled rules in (priority, id) order; first match wins
// (stop-on-first-match). No match → the default all-manual 'queue' action,
// which is also the entire behavior on a fresh install (zero rules).

// The two categories that must NEVER auto-send regardless of rule config.
// Mirrors the cloud-route safety net (lib/classification/prompt.ts:routeFor
// sends these to the human-reviewed cloud path) — escalate is by definition
// "get a human", unknown means the classifier wasn't sure what this even is.
export const AUTO_SEND_FORBIDDEN_CATEGORIES: ReadonlySet<ClassificationCategory> =
  new Set<ClassificationCategory>(['escalate', 'unknown']);

// The context a single draft presents to the evaluator. Confidence and sender
// are pre-resolved by the caller (the draft-finalize query) so this function
// stays pure / IO-free. `confidence` accepts the pg NUMERIC-as-string shape or
// a number; null/undefined is treated as below-floor (something to look at).
export interface AutoSendEvalContext {
  category: ClassificationCategory | null | undefined;
  confidence: number | string | null | undefined;
  // Draft sender address (the inbound from_addr), used for sender_domain match.
  // Compared case-insensitively. null/undefined never matches a domain rule.
  senderAddr: string | null | undefined;
  // drafts.auto_send_blocked — a hard per-draft veto (operator override, or a
  // prior 'drop' decision). When true, auto_send is always downgraded.
  autoSendBlocked: boolean;
}

export interface AutoSendDecision {
  // The matched rule, or null for the default no-match fall-through.
  rule: AutoSendRule | null;
  // What the matched rule declared (or 'queue' for the default).
  matchedAction: AutoSendAction;
  // What should actually happen after guardrails + shadow downgrade.
  effectiveAction: AutoSendAction;
  // True when an auto_send rule matched but was in its shadow window.
  shadow: boolean;
  // Machine-readable reason — persisted to auto_send_audit.reason.
  reason: string;
}

function toConfidence(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Minutes-from-midnight for a Date in the appliance's configured timezone.
// We deliberately avoid Intl/timezone math here to keep the evaluator pure and
// clock-injectable; the caller passes a Date already in the desired frame (the
// route uses GENERIC_TIMEZONE-localized "now"). Returns 0..1439.
export function minutesFromMidnight(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

// Is `nowMin` inside the rule's [from, to) window? Supports wrap-around windows
// (from > to means an overnight window, e.g. 22:00→06:00). A rule with a
// null/null window is always active and never reaches here.
function inTimeWindow(nowMin: number, fromMin: number, toMin: number): boolean {
  if (fromMin === toMin) return false; // empty window matches nothing
  if (fromMin < toMin) return nowMin >= fromMin && nowMin < toMin;
  // wrap-around: active if after `from` OR before `to`
  return nowMin >= fromMin || nowMin < toMin;
}

// Does this draft satisfy every (non-null) condition of `rule`? Conditions are
// AND-ed; a null condition column is "don't care".
function ruleMatches(rule: AutoSendRule, ctx: AutoSendEvalContext, now: Date): boolean {
  if (rule.category !== null && rule.category !== ctx.category) return false;

  if (rule.sender_domain !== null) {
    const addr = (ctx.senderAddr ?? '').toLowerCase();
    const domain = addr.split('@')[1] ?? '';
    if (domain !== rule.sender_domain.toLowerCase()) return false;
  }

  if (rule.min_confidence !== null) {
    const conf = toConfidence(ctx.confidence);
    const floor = Number(rule.min_confidence);
    // A non-finite floor (NaN from a malformed stored value) can't be a
    // meaningful threshold; fail the match rather than let NaN comparisons
    // pass silently (NaN < x is always false → would otherwise match).
    if (conf === null || !Number.isFinite(floor) || conf < floor) return false;
  }

  if (rule.active_from_min !== null && rule.active_to_min !== null) {
    if (!inTimeWindow(minutesFromMidnight(now), rule.active_from_min, rule.active_to_min)) {
      return false;
    }
  }

  return true;
}

// Apply the hard, non-overridable guardrails to a matched 'auto_send' rule.
// Returns the reason a guardrail tripped, or null if auto-send is permitted.
// Order matters only for which reason is reported; all are absolute blocks.
function autoSendGuardrailBlock(ctx: AutoSendEvalContext): string | null {
  // Forbidden-category check first so an escalate/unknown draft reports
  // guardrail_escalate_category in the audit even when it's also
  // auto_send_blocked — the category is the more specific, actionable reason.
  if (ctx.category && AUTO_SEND_FORBIDDEN_CATEGORIES.has(ctx.category)) {
    return 'guardrail_escalate_category';
  }
  if (ctx.autoSendBlocked) return 'guardrail_auto_send_blocked';
  // A null/below-floor confidence can never auto-send. Mirrors evaluateUrgency's
  // low_conf bias: missing confidence is treated as low, not silently safe.
  const conf = toConfidence(ctx.confidence);
  if (conf === null || conf < LOW_CONF_FLOOR) return 'guardrail_low_confidence';
  return null;
}

// Evaluate a finalized draft against the (already enabled, already
// priority-ordered) rule set. `rules` MUST be pre-filtered to enabled rules and
// sorted by (priority ASC, id ASC) — the query helper does this. `now` is
// injected for testability + timezone control.
export function evaluateAutoSend(
  rules: readonly AutoSendRule[],
  ctx: AutoSendEvalContext,
  now: Date = new Date(),
): AutoSendDecision {
  for (const rule of rules) {
    if (!rule.enabled) continue; // defensive — caller should pre-filter
    if (!ruleMatches(rule, ctx, now)) continue;

    // First match wins. Branch on the declared action.
    if (rule.action === 'drop') {
      return {
        rule,
        matchedAction: 'drop',
        effectiveAction: 'drop',
        shadow: false,
        reason: 'matched',
      };
    }

    if (rule.action === 'queue') {
      return {
        rule,
        matchedAction: 'queue',
        effectiveAction: 'queue',
        shadow: false,
        reason: 'matched',
      };
    }

    // action === 'auto_send' — apply guardrails, then shadow.
    const block = autoSendGuardrailBlock(ctx);
    if (block !== null) {
      return {
        rule,
        matchedAction: 'auto_send',
        effectiveAction: 'queue',
        shadow: false,
        reason: block,
      };
    }

    const inShadow = rule.shadow_until !== null && now < new Date(rule.shadow_until);
    if (inShadow) {
      return {
        rule,
        matchedAction: 'auto_send',
        effectiveAction: 'queue',
        shadow: true,
        reason: 'shadow_mode',
      };
    }

    return {
      rule,
      matchedAction: 'auto_send',
      effectiveAction: 'auto_send',
      shadow: false,
      reason: 'matched',
    };
  }

  // No enabled rule matched → default all-manual queue (fresh-install behavior).
  return {
    rule: null,
    matchedAction: 'queue',
    effectiveAction: 'queue',
    shadow: false,
    reason: 'no_rule_match',
  };
}
