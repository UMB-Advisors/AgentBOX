// Strip Qwen3 <think> tokens (MAIL-07) and parse classifier JSON output.
// Hard fallback to {category: 'unknown', confidence: 0} on parse failure (D-06).
//
// D-50 — after parsing, apply deterministic operator-identity preclass
// (see ./preclass.ts). When the sender's address/domain identifies the
// operator, override the LLM verdict to `internal`. The original LLM
// output is preserved in raw_output for forensics.
//
// STAQPRO-260 — additionally apply a noreply preclass that drops obviously
// automated senders (notifications@*, noreply@*, mailer-daemon@*, etc.)
// to `spam_marketing` so `routeFor` short-circuits to `drop` without ever
// generating a draft. Noreply is checked BEFORE operator-domain so a
// noreply address that happens to live on the operator domain still drops.

import { type PreclassContext, precheck, precheckNoReply, precheckSelfLoop } from './preclass';
import { CATEGORIES, type Category, type Route, routeFor } from './prompt';

export interface ClassificationResult {
  category: Category;
  confidence: number;
  // Final routing decision derived from `routeFor(category, confidence)` after
  // preclass (D-50/STAQPRO-260) has run. Single source of truth for the
  // classify→draft dispatch; n8n's MailBOX-Classify IF node reads $json.route
  // rather than re-implementing the routing rules.
  route: Route;
  json_parse_ok: boolean;
  think_stripped: boolean;
  raw_output: string;
  preclass_applied: boolean;
  preclass_source:
    | 'operator-domain'
    | 'operator-allowlist'
    | 'noreply-pattern'
    | 'operator-self-loop'
    | 'operator-owns-thread'
    // MBOX-370: sender is on the never-spam allowlist — a spam_marketing verdict
    // was overridden to surface (unknown→cloud) instead of dropping. Applied in
    // the classification-normalize route + the reclassify re-run (needs a DB
    // lookup, so not in the sync preclass chain).
    | 'sender-never-spam'
    | null;
  // Why the draft was suppressed (distinct from generic spam). Populated when
  // precheckSelfLoop fires ('self_loop') or when the async thread-ownership
  // guard fires ('operator_owns_thread'). null for all other paths.
  suppression_reason: 'self_loop' | 'operator_owns_thread' | null;
}

type ResultWithoutRoute = Omit<ClassificationResult, 'route'>;

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
// Sometimes the model leaves an unclosed <think> open; strip everything up to
// the first '{' if a <think> tag remains after the block-strip pass.
const UNCLOSED_THINK_PREFIX = /^[\s\S]*?<think>[\s\S]*?(?=\{)/i;

const CATEGORY_SET = new Set<string>(CATEGORIES);

export function normalizeClassifierOutput(
  raw: string,
  ctx: PreclassContext = {},
): ClassificationResult {
  const safe = raw ?? '';
  const blockMatched = THINK_BLOCK.test(safe);
  let cleaned = safe.replace(THINK_BLOCK, '');
  const prefixMatched = UNCLOSED_THINK_PREFIX.test(cleaned);
  if (prefixMatched) cleaned = cleaned.replace(UNCLOSED_THINK_PREFIX, '');
  const think_stripped = blockMatched || prefixMatched;

  const fenceStripped = cleaned
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();

  const firstBrace = fenceStripped.indexOf('{');
  const lastBrace = fenceStripped.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    return applyPreclass(fallback(safe, think_stripped), ctx);
  }

  const slice = fenceStripped.slice(firstBrace, lastBrace + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return applyPreclass(fallback(safe, think_stripped), ctx);
  }

  if (!parsed || typeof parsed !== 'object') {
    return applyPreclass(fallback(safe, think_stripped), ctx);
  }

  const obj = parsed as Record<string, unknown>;
  const rawCategory = typeof obj.category === 'string' ? obj.category : '';
  const rawConfidence = obj.confidence;

  const category: Category = CATEGORY_SET.has(rawCategory) ? (rawCategory as Category) : 'unknown';

  let confidence =
    typeof rawConfidence === 'number'
      ? rawConfidence
      : typeof rawConfidence === 'string'
        ? Number.parseFloat(rawConfidence)
        : NaN;
  if (!Number.isFinite(confidence)) confidence = 0;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;

  return applyPreclass(
    {
      category,
      confidence,
      json_parse_ok: true,
      think_stripped,
      raw_output: safe,
      preclass_applied: false,
      preclass_source: null,
      suppression_reason: null,
    },
    ctx,
  );
}

function fallback(raw: string, think_stripped: boolean): ResultWithoutRoute {
  return {
    category: 'unknown',
    confidence: 0,
    json_parse_ok: false,
    think_stripped,
    raw_output: raw,
    preclass_applied: false,
    preclass_source: null,
    suppression_reason: null,
  };
}

function applyPreclass(result: ResultWithoutRoute, ctx: PreclassContext): ClassificationResult {
  // Evaluation order: noreply → self-loop → operator-domain.
  //
  // noreply first: a notifications@operator.com address still belongs in
  // `spam_marketing`, not `internal`.
  //
  // self-loop second (UMB-153): from=operator-domain, to=external → the
  // operator's outbound looped back. Must run before operator-domain so a
  // self-loop isn't silently promoted to `internal → local → draft`.
  //
  // operator-domain last: from=operator, to=operator → legit internal mail.
  //
  // MBOX-370 never-spam: when the sender is on the operator's never-spam
  // allowlist, the heuristic SUPPRESSIONS (noreply + self-loop) are skipped — the
  // operator explicitly said "never drop this sender", so we let the real
  // classification stand. operator-domain still applies (a never-spam colleague
  // on the operator domain → `internal`), and a genuine model `spam_marketing`
  // verdict is surfaced to `unknown` (see passthrough) rather than dropped.
  const neverSpam = ctx.neverSpam === true;

  if (!neverSpam) {
    const noReplyHit = precheckNoReply(ctx);
    if (noReplyHit) {
      return {
        ...result,
        category: noReplyHit.category,
        confidence: noReplyHit.confidence,
        preclass_applied: true,
        preclass_source: noReplyHit.source,
        suppression_reason: null,
        route: routeFor(noReplyHit.category, noReplyHit.confidence),
      };
    }

    const selfLoopHit = precheckSelfLoop(ctx);
    if (selfLoopHit) {
      return {
        ...result,
        category: selfLoopHit.category,
        confidence: selfLoopHit.confidence,
        preclass_applied: true,
        preclass_source: selfLoopHit.source,
        suppression_reason: 'self_loop',
        route: routeFor(selfLoopHit.category, selfLoopHit.confidence),
      };
    }
  }

  const operatorHit = precheck(ctx);
  if (operatorHit) {
    return {
      ...result,
      category: operatorHit.category,
      confidence: operatorHit.confidence,
      preclass_applied: true,
      preclass_source: operatorHit.source,
      suppression_reason: null,
      route: routeFor(operatorHit.category, operatorHit.confidence),
    };
  }

  // No preclass fired — pass through the parsed result. For a never-spam sender
  // whose model verdict is still spam_marketing, surface to `unknown` (→ cloud,
  // gets a draft for review) instead of letting it drop.
  if (neverSpam && result.category === 'spam_marketing') {
    return {
      ...result,
      category: 'unknown',
      preclass_applied: true,
      preclass_source: 'sender-never-spam',
      suppression_reason: null,
      route: routeFor('unknown', result.confidence),
    };
  }

  return {
    ...result,
    suppression_reason: null,
    route: routeFor(result.category, result.confidence),
  };
}
