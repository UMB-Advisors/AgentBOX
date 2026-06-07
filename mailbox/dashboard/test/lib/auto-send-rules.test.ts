import { describe, expect, it } from 'vitest';
import {
  type AutoSendEvalContext,
  evaluateAutoSend,
  minutesFromMidnight,
} from '@/lib/auto-send/rules';
import type { AutoSendRule } from '@/lib/types';
import { LOW_CONF_FLOOR } from '@/lib/urgency';

// MBOX-16 / FR-23 — auto-send evaluator unit tests. Pure function, no DB / n8n.
// This is the safety-critical SoT: config can only make auto-send MORE
// conservative. These tests pin the hard guardrails (must NOT auto-send on
// cooldown is exercised at the integration layer — the evaluator itself never
// touches cooldown; that gate lives in transitionToApprovedAndSend).

// A permissive "auto_send everything reorder" rule, high min_confidence so the
// guardrail floor isn't the thing under test unless we override.
function rule(overrides: Partial<AutoSendRule> = {}): AutoSendRule {
  return {
    id: 1,
    name: 'auto reorder',
    enabled: true,
    priority: 100,
    action: 'auto_send',
    category: 'reorder',
    sender_domain: null,
    min_confidence: null,
    active_from_min: null,
    active_to_min: null,
    shadow_until: null,
    created_at: '2026-05-24T00:00:00Z',
    updated_at: '2026-05-24T00:00:00Z',
    created_by: null,
    ...overrides,
  };
}

// A draft that WOULD auto-send under the rule above: confident reorder, no
// per-draft block.
function ctx(overrides: Partial<AutoSendEvalContext> = {}): AutoSendEvalContext {
  return {
    category: 'reorder',
    confidence: 0.95,
    senderAddr: 'buyer@acme.com',
    autoSendBlocked: false,
    ...overrides,
  };
}

const NOW = new Date('2026-05-24T12:00:00Z');

describe('evaluateAutoSend — default-safe behavior', () => {
  it('queues (no-match) when there are zero rules — fresh-install all-manual default', () => {
    const d = evaluateAutoSend([], ctx(), NOW);
    expect(d.effectiveAction).toBe('queue');
    expect(d.rule).toBeNull();
    expect(d.reason).toBe('no_rule_match');
  });

  it('queues when no rule matches the draft', () => {
    const d = evaluateAutoSend([rule({ category: 'inquiry' })], ctx({ category: 'reorder' }), NOW);
    expect(d.effectiveAction).toBe('queue');
    expect(d.reason).toBe('no_rule_match');
  });
});

describe('evaluateAutoSend — happy path', () => {
  it('auto-sends a confident draft matching an enabled auto_send rule', () => {
    const d = evaluateAutoSend([rule()], ctx(), NOW);
    expect(d.matchedAction).toBe('auto_send');
    expect(d.effectiveAction).toBe('auto_send');
    expect(d.shadow).toBe(false);
    expect(d.rule?.id).toBe(1);
    expect(d.reason).toBe('matched');
  });

  it('honors an explicit queue rule (leaves at manual)', () => {
    const d = evaluateAutoSend([rule({ action: 'queue' })], ctx(), NOW);
    expect(d.effectiveAction).toBe('queue');
    expect(d.reason).toBe('matched');
  });

  it('honors a drop rule', () => {
    const d = evaluateAutoSend([rule({ action: 'drop' })], ctx(), NOW);
    expect(d.effectiveAction).toBe('drop');
    expect(d.reason).toBe('matched');
  });
});

describe('evaluateAutoSend — HARD GUARDRAILS (config cannot override)', () => {
  it('NEVER auto-sends an escalate draft, even if a rule names category=escalate', () => {
    const d = evaluateAutoSend(
      [rule({ category: 'escalate' })],
      ctx({ category: 'escalate' }),
      NOW,
    );
    expect(d.matchedAction).toBe('auto_send');
    expect(d.effectiveAction).toBe('queue');
    expect(d.reason).toBe('guardrail_escalate_category');
  });

  it('NEVER auto-sends an unknown draft', () => {
    const d = evaluateAutoSend([rule({ category: 'unknown' })], ctx({ category: 'unknown' }), NOW);
    expect(d.effectiveAction).toBe('queue');
    expect(d.reason).toBe('guardrail_escalate_category');
  });

  it('NEVER auto-sends below the LOW_CONF_FLOOR confidence floor', () => {
    const d = evaluateAutoSend([rule()], ctx({ confidence: LOW_CONF_FLOOR - 0.01 }), NOW);
    expect(d.effectiveAction).toBe('queue');
    expect(d.reason).toBe('guardrail_low_confidence');
  });

  it('treats null confidence as below-floor (downgrade to queue)', () => {
    const d = evaluateAutoSend([rule()], ctx({ confidence: null }), NOW);
    expect(d.effectiveAction).toBe('queue');
    expect(d.reason).toBe('guardrail_low_confidence');
  });

  it('NEVER auto-sends a draft flagged auto_send_blocked', () => {
    const d = evaluateAutoSend([rule()], ctx({ autoSendBlocked: true }), NOW);
    expect(d.effectiveAction).toBe('queue');
    expect(d.reason).toBe('guardrail_auto_send_blocked');
  });

  it('reports the forbidden-category reason ahead of auto_send_blocked', () => {
    // An escalate draft that is ALSO auto_send_blocked must report the more
    // specific guardrail_escalate_category (forbidden-category check runs
    // first), not guardrail_auto_send_blocked.
    const d = evaluateAutoSend(
      [rule({ category: 'escalate' })],
      ctx({ category: 'escalate', autoSendBlocked: true }),
      NOW,
    );
    expect(d.effectiveAction).toBe('queue');
    expect(d.reason).toBe('guardrail_escalate_category');
  });

  it('a rule confidence floor above 0.75 makes it MORE conservative', () => {
    const r = rule({ min_confidence: '0.9' });
    // 0.8 clears the hard floor but not the rule floor → no match → queue.
    const d = evaluateAutoSend([r], ctx({ confidence: 0.8 }), NOW);
    expect(d.effectiveAction).toBe('queue');
    expect(d.reason).toBe('no_rule_match');
  });

  it('a non-finite rule min_confidence floor never matches (NaN guard)', () => {
    // A malformed stored floor coerces to NaN; without the finite guard
    // `conf < NaN` is always false → the rule would match silently. Guard
    // forces a no-match so a corrupt floor fails closed.
    const r = rule({ min_confidence: 'not-a-number' });
    const d = evaluateAutoSend([r], ctx({ confidence: 0.95 }), NOW);
    expect(d.effectiveAction).toBe('queue');
    expect(d.reason).toBe('no_rule_match');
  });
});

describe('evaluateAutoSend — shadow mode', () => {
  it('downgrades an in-shadow auto_send rule to queue and flags shadow', () => {
    const r = rule({ shadow_until: '2026-05-24T23:59:00Z' }); // after NOW
    const d = evaluateAutoSend([r], ctx(), NOW);
    expect(d.matchedAction).toBe('auto_send');
    expect(d.effectiveAction).toBe('queue');
    expect(d.shadow).toBe(true);
    expect(d.reason).toBe('shadow_mode');
  });

  it('auto-sends once the shadow window has passed', () => {
    const r = rule({ shadow_until: '2026-05-24T06:00:00Z' }); // before NOW
    const d = evaluateAutoSend([r], ctx(), NOW);
    expect(d.effectiveAction).toBe('auto_send');
    expect(d.shadow).toBe(false);
  });

  it('guardrails take precedence over shadow (escalate in shadow is still queue/guardrail)', () => {
    const r = rule({ category: 'escalate', shadow_until: '2026-05-24T23:59:00Z' });
    const d = evaluateAutoSend([r], ctx({ category: 'escalate' }), NOW);
    expect(d.effectiveAction).toBe('queue');
    expect(d.reason).toBe('guardrail_escalate_category');
    expect(d.shadow).toBe(false);
  });
});

describe('evaluateAutoSend — condition matching', () => {
  it('matches on sender_domain (case-insensitive, suffix after @)', () => {
    const r = rule({ category: null, sender_domain: 'acme.com' });
    expect(evaluateAutoSend([r], ctx({ senderAddr: 'BUYER@ACME.COM' }), NOW).effectiveAction).toBe(
      'auto_send',
    );
    expect(evaluateAutoSend([r], ctx({ senderAddr: 'buyer@other.com' }), NOW).effectiveAction).toBe(
      'queue',
    );
  });

  it('a null-condition rule is a catch-all (matches any confident, allowed draft)', () => {
    const r = rule({ category: null, sender_domain: null, min_confidence: null });
    expect(evaluateAutoSend([r], ctx({ category: 'inquiry' }), NOW).effectiveAction).toBe(
      'auto_send',
    );
  });

  it('a catch-all rule auto-sends at confidence EXACTLY the hard floor (0.75)', () => {
    // The hard guardrail is `conf < LOW_CONF_FLOOR`, so 0.75 itself PASSES the
    // floor (boundary is inclusive at the floor). Pin the documented behavior:
    // catch-all (all conditions null) + confidence === 0.75 → auto_send.
    const r = rule({ category: null, sender_domain: null, min_confidence: null });
    const d = evaluateAutoSend([r], ctx({ confidence: LOW_CONF_FLOOR }), NOW);
    expect(d.effectiveAction).toBe('auto_send');
    expect(d.reason).toBe('matched');
  });

  it('AND-s conditions: category AND domain must both match', () => {
    const r = rule({ category: 'reorder', sender_domain: 'acme.com' });
    expect(
      evaluateAutoSend([r], ctx({ category: 'reorder', senderAddr: 'x@other.com' }), NOW)
        .effectiveAction,
    ).toBe('queue');
  });
});

describe('evaluateAutoSend — priority + ordering', () => {
  it('first matching rule wins (caller pre-sorts by priority,id)', () => {
    const dropFirst = rule({ id: 1, priority: 10, action: 'drop' });
    const sendSecond = rule({ id: 2, priority: 20, action: 'auto_send' });
    const d = evaluateAutoSend([dropFirst, sendSecond], ctx(), NOW);
    expect(d.rule?.id).toBe(1);
    expect(d.effectiveAction).toBe('drop');
  });

  it('skips a non-matching higher-priority rule and uses the next match', () => {
    const noMatch = rule({ id: 1, priority: 10, category: 'inquiry' });
    const match = rule({ id: 2, priority: 20, category: 'reorder', action: 'auto_send' });
    const d = evaluateAutoSend([noMatch, match], ctx({ category: 'reorder' }), NOW);
    expect(d.rule?.id).toBe(2);
    expect(d.effectiveAction).toBe('auto_send');
  });

  it('defensively skips a disabled rule even if passed in', () => {
    const disabled = rule({ id: 1, enabled: false, action: 'auto_send' });
    const d = evaluateAutoSend([disabled], ctx(), NOW);
    expect(d.effectiveAction).toBe('queue');
    expect(d.reason).toBe('no_rule_match');
  });
});

describe('evaluateAutoSend — time-of-day window', () => {
  it('matches inside a same-day window', () => {
    // window 09:00–17:00; NOW is 12:00 UTC (getHours uses local TZ — assert via
    // minutesFromMidnight on the same Date the evaluator uses).
    const nowMin = minutesFromMidnight(NOW);
    const r = rule({ active_from_min: nowMin - 60, active_to_min: nowMin + 60 });
    expect(evaluateAutoSend([r], ctx(), NOW).effectiveAction).toBe('auto_send');
  });

  it('does not match outside the window', () => {
    const nowMin = minutesFromMidnight(NOW);
    const r = rule({
      active_from_min: (nowMin + 120) % 1440,
      active_to_min: (nowMin + 180) % 1440,
    });
    expect(evaluateAutoSend([r], ctx(), NOW).effectiveAction).toBe('queue');
  });

  it('supports a wrap-around overnight window', () => {
    const nowMin = minutesFromMidnight(NOW);
    // from = now+60 (later today), to = now-60 (earlier today) → wrap window
    // that is active across midnight; now (between to and from) is OUTSIDE it.
    const outside = rule({
      active_from_min: (nowMin + 60) % 1440,
      active_to_min: (nowMin - 60 + 1440) % 1440,
    });
    expect(evaluateAutoSend([outside], ctx(), NOW).effectiveAction).toBe('queue');
    // Invert: from = now-60, to = now+60 is a normal window containing now.
    const inside = rule({
      active_from_min: (nowMin - 60 + 1440) % 1440,
      active_to_min: (nowMin + 60) % 1440,
    });
    expect(evaluateAutoSend([inside], ctx(), NOW).effectiveAction).toBe('auto_send');
  });
});
