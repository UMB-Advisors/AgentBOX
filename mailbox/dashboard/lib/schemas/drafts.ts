import { z } from 'zod';
import { CATEGORIES, type Category } from '@/lib/classification/prompt';
import {
  ACTION_ITEM_SOURCES,
  ACTION_ITEM_TYPES,
  type ActionItemSource,
  type ActionItemType,
  DRAFT_STATUSES,
  type DraftStatus,
  REJECT_REASON_CODES,
  type RejectReasonCode,
  TASK_PROVIDERS,
  type TaskProvider,
} from '@/lib/types';

// Anchor the zod enum to the canonical DRAFT_STATUSES tuple so the schema
// can never drift from the rest of the codebase (STAQPRO-137).
const statusEnum = z.enum(DRAFT_STATUSES as readonly [DraftStatus, ...DraftStatus[]]);

// draft_feedback.reason_code enum anchor (STAQPRO-331 #1). Mirrors the
// Postgres CHECK constraint in migration 023.
const reasonCodeEnum = z.enum(
  REJECT_REASON_CODES as readonly [RejectReasonCode, ...RejectReasonCode[]],
);

// GET /api/drafts — query string `status=csv,of,statuses&limit=N`.
// Match existing behavior: no statuses given → default to `['pending']`.
// Invalid statuses are rejected with 400 (tighter than the previous silent
// filter, but matches the principle that callers should know when their input
// is malformed).
export const listDraftsQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((s) => {
      if (!s) return ['pending'] as DraftStatus[];
      return s
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    })
    .pipe(z.array(statusEnum).min(1, 'at least one status required')),
  limit: z
    .string()
    .optional()
    .transform((s) => (s ? parseInt(s, 10) : 50))
    .pipe(z.number().int().positive().max(250)),
  // MBOX-162 V3 — `urgent=1` restricts to high-priority drafts (≥1 urgency
  // signal) and enriches each row with `urgency` + `account` (the Priority /
  // cross-account view). Absent/0 → the plain status-filtered list.
  urgent: z
    .string()
    .optional()
    .transform((s) => s === '1' || s === 'true'),
  // MBOX-360 (MBOX-162 V3) — optional account filter for the unified queue.
  // `account=<id>` narrows the list to one connected inbox; absent / empty /
  // non-numeric (e.g. "all") → undefined (all accounts). Garbage never 400s —
  // it just falls back to the cross-account view.
  account: z
    .string()
    .optional()
    .transform((s) => {
      const n = s ? Number.parseInt(s, 10) : Number.NaN;
      return Number.isFinite(n) ? n : undefined;
    })
    .pipe(z.number().int().positive().optional()),
});

export type ListDraftsQuery = z.infer<typeof listDraftsQuerySchema>;

// POST /api/drafts/[id]/reject — STAQPRO-331 #1.
// Body shape: { reason_code: <enum>, free_text?: string }.
// reason_code is required and feeds the learning loop downstream
// (persona resolver, RAG eval, classifier eval re-labeling). free_text is
// required when reason_code === 'other'; optional context otherwise.
const FREE_TEXT_MAX = 2000;
export const rejectBodySchema = z
  .object({
    reason_code: reasonCodeEnum,
    free_text: z
      .string()
      .trim()
      .max(FREE_TEXT_MAX, `free_text must be <= ${FREE_TEXT_MAX} chars`)
      .optional()
      .nullable()
      .transform((v) => (v && v.length > 0 ? v : null)),
  })
  .superRefine((val, ctx) => {
    if (val.reason_code === 'other' && (val.free_text === null || val.free_text.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['free_text'],
        message: "free_text is required when reason_code is 'other'",
      });
    }
  });

export type RejectBody = z.infer<typeof rejectBodySchema>;

// POST /api/drafts/[id]/undo-reject — STAQPRO-331 #9.
// Empty body. Strict so callers can't smuggle extra fields (the route flips
// rejected → pending and deletes the latest draft_feedback row; we don't want
// silent acceptance of e.g. an unsupported reason override). `parseJson`
// normalizes missing/invalid JSON to `{}`, which this schema accepts.
export const undoRejectBodySchema = z.object({}).strict();
export type UndoRejectBody = z.infer<typeof undoRejectBodySchema>;

// POST /api/drafts/[id]/clear-send-attempt — STAQPRO-IDEM-2026-05-22 follow-up.
// Operator-driven clear of the MailBOX-Send CAS lock (drafts.send_attempt_at).
// Body REQUIRES `verified_in_gmail_sent: true` so the operator has to
// acknowledge they checked Gmail Sent and confirmed the reply did NOT go out
// — clearing the lock without that check re-introduces the 3-dupes class.
// Strict so future fields (e.g. an audit note) require an explicit schema add.
export const clearSendAttemptBodySchema = z
  .object({
    verified_in_gmail_sent: z.literal(true),
  })
  .strict();
export type ClearSendAttemptBody = z.infer<typeof clearSendAttemptBodySchema>;

// POST /api/drafts/[id]/edit — body { draft_body: string, draft_subject?: string }.
const MAX_BODY = 10_000;
export const editBodySchema = z.object({
  draft_body: z
    .string()
    .trim()
    .min(1, 'draft_body required')
    .max(MAX_BODY, `draft_body must be <= ${MAX_BODY} chars`),
  draft_subject: z
    .string()
    .trim()
    .min(1)
    .optional()
    .nullable()
    .transform((v) => v ?? null),
});

export type EditBody = z.infer<typeof editBodySchema>;

// PATCH /api/drafts/[id]/classification — MBOX-123 operator classification
// override. Body shape: { category: <enum>, reason?: string }.
//
// `category` is anchored to the canonical CATEGORIES tuple from
// lib/classification/prompt.ts so the zod enum can never drift from the
// classifier's category set OR the live mailbox.classification_log /
// mailbox.drafts CHECK constraints (both list the same 8 categories — asserted
// by test/schema-invariants.test.ts).
//
// `reason` is an optional free-text operator note. It is NOT a structured
// reason_code like reject feedback — an override is a direct relabel, and the
// operator's own words land in mailbox.classification_log.raw_output as the
// audit trail for why the relabel happened. Default cap mirrors the reject
// free_text cap for consistency.
const OVERRIDE_REASON_MAX = 2000;
const categoryEnum = z.enum(CATEGORIES as readonly [Category, ...Category[]]);
export const classificationOverrideBodySchema = z.object({
  category: categoryEnum,
  reason: z
    .string()
    .trim()
    .max(OVERRIDE_REASON_MAX, `reason must be <= ${OVERRIDE_REASON_MAX} chars`)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

export type ClassificationOverrideBody = z.infer<typeof classificationOverrideBodySchema>;

// POST /api/drafts/[id]/action-items — MBOX-131 operator edit of the
// structured action-items list. Body shape: { action_items: ActionItem[] }.
//
// Enums anchored to the canonical ACTION_ITEM_TYPES / ACTION_ITEM_SOURCES
// tuples in lib/types.ts so the schema can never drift from the extraction
// clamp (lib/drafting/action-items.ts) or the ActionItem view interface.
// `text` is capped to keep an operator (or a misbehaving model upstream) from
// persisting an unbounded blob into the jsonb array. due_at is an ISO 8601
// datetime or null. confidence is the model's 0..1 score; operator edits
// default it to 1.0 client-side but the schema accepts any in-range value.
const ACTION_ITEM_TEXT_MAX = 500;
const typeEnum = z.enum(ACTION_ITEM_TYPES as readonly [ActionItemType, ...ActionItemType[]]);
const sourceEnum = z.enum(
  ACTION_ITEM_SOURCES as readonly [ActionItemSource, ...ActionItemSource[]],
);
export const actionItemSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'text required')
    .max(ACTION_ITEM_TEXT_MAX, `text must be <= ${ACTION_ITEM_TEXT_MAX} chars`),
  type: typeEnum,
  due_at: z.string().datetime().nullable(),
  source: sourceEnum,
  confidence: z.number().min(0).max(1),
  // MBOX-129 — task-handoff fields. Optional + nullable so the operator-edit
  // route (full-array replace) round-trips a pushed item WITHOUT stripping its
  // task linkage: the client posts the items it received (which carry these
  // when set), and the push route is the only writer that populates them.
  // .optional() keeps pre-MBOX-129 payloads (no task fields) valid.
  task_external_id: z.string().max(256).nullable().optional(),
  task_external_url: z.string().url().max(2048).nullable().optional(),
  task_pushed_at: z.string().datetime().nullable().optional(),
});

export type ActionItemInput = z.infer<typeof actionItemSchema>;

const ACTION_ITEMS_MAX = 50;
export const actionItemsBodySchema = z.object({
  action_items: z
    .array(actionItemSchema)
    .max(ACTION_ITEMS_MAX, `at most ${ACTION_ITEMS_MAX} action items`),
});

export type ActionItemsBody = z.infer<typeof actionItemsBodySchema>;

// POST /api/internal/action-items/[id]/push — MBOX-129 task handoff. [id] is the
// DRAFT id (action items have no DB id of their own — they live positionally in
// drafts.action_items). The body addresses items by their array index:
//   - { index: N }       → push (or re-push) the single item at index N
//   - { all: true }      → push every not-yet-pushed item on the draft (bulk)
// `provider` defaults to the per-appliance DEFAULT_TASK_PROVIDER; only
// 'google_tasks' is wired in v1 (the enum carries 'linear' for the v2 toggle).
const taskProviderEnum = z.enum(TASK_PROVIDERS as readonly [TaskProvider, ...TaskProvider[]]);
export const pushActionItemBodySchema = z
  .object({
    index: z.number().int().nonnegative().optional(),
    all: z.literal(true).optional(),
    provider: taskProviderEnum.optional(),
  })
  .refine((v) => v.all === true || typeof v.index === 'number', {
    message: 'provide either { index } or { all: true }',
  });

export type PushActionItemBody = z.infer<typeof pushActionItemBodySchema>;
