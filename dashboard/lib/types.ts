// SoT for *semantic* types — string-literal enums (DRAFT_STATUSES, DRAFT_SOURCES,
// ClassificationCategory, OnboardingStage) plus the *curated view* interfaces
// the dashboard consumes (Draft, InboxMessage, etc). Each view is an
// intentionally narrower shape than the full DB row in lib/db/schema.ts —
// it's the surface routes/components type against, even though the live
// table has additional columns.
//
// When you need the full DB row shape (e.g., for a kysely insert/update that
// touches columns not in the curated view), import the row alias at the
// bottom of this file (`DraftRow`, `InboxMessageRow`, etc.) — those are
// `Selectable<...>` re-exports of the kysely-codegen output.
//
// String-enum SoT is asserted against the live Postgres CHECK constraints
// by test/schema-invariants.test.ts. Curated views are not asserted against
// the schema; they describe what callers expect, not the full table shape.

import type { Selectable } from 'kysely';
import type {
  AutoSendAudit as AutoSendAuditRow_,
  AutoSendRules as AutoSendRulesRow_,
  ChatConversations as ChatConversationsRow_,
  ChatMessages as ChatMessagesRow_,
  ClassificationLog as ClassificationLogRow_,
  DraftFeedback as DraftFeedbackRow_,
  Drafts as DraftsRow_,
  InboxMessages as InboxMessagesRow_,
  KbDocuments as KbDocumentsRow_,
  Onboarding as OnboardingRow_,
  Persona as PersonaRow_,
  RejectedHistory as RejectedHistoryRow_,
  SentHistory as SentHistoryRow_,
  VipSenders as VipSendersRow_,
} from '@/lib/db/schema';

// ── String-literal enums (SoT — asserted against Postgres CHECK constraints) ─

// drafts.status enum (STAQPRO-137). Mirrored against the CHECK constraint in
// migrations/003-evolve-drafts-to-queue-shape-v1-2026-04-27.sql (last narrowed
// by migration 016, which dropped 'failed' per STAQPRO-202); the
// schema-invariants test asserts they stay in sync.
export const DRAFT_STATUSES = [
  'pending',
  'awaiting_cloud',
  'approved',
  'rejected',
  'edited',
  'sent',
] as const;

export type DraftStatus = (typeof DRAFT_STATUSES)[number];

// drafts.draft_source / sent_history.draft_source enum. The live drafting
// path writes 'local' | 'cloud' (the route taken — see lib/drafting/router.ts);
// the broader set here covers the legacy 'local_qwen3' | 'cloud_haiku' values
// that earlier migrations left in the CHECK constraint and that may still
// appear in older sent_history rows.
export const DRAFT_SOURCES = ['local', 'cloud', 'local_qwen3', 'cloud_haiku'] as const;

export type DraftSource = (typeof DRAFT_SOURCES)[number];

export type ClassificationCategory =
  | 'inquiry'
  | 'reorder'
  | 'scheduling'
  | 'follow_up'
  | 'internal'
  | 'spam_marketing'
  | 'escalate'
  | 'unknown';

// onboarding.stage enum (migration 006). Const tuple is the SoT for the
// zod enum in lib/schemas/internal.ts; the OnboardingStage union is derived
// from it so the two stay in lockstep.
export const ONBOARDING_STAGES = [
  'pending_admin',
  'pending_email',
  'ingesting',
  'pending_tuning',
  'tuning_in_progress',
  'live',
] as const;

export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];

// kb_documents.status enum (STAQPRO-148). Mirrored against the CHECK constraint
// in migrations/014-create-kb-documents-and-refs-v1-2026-05-02.sql; the
// schema-invariants test asserts they stay in sync.
export const KB_DOC_STATUSES = ['processing', 'ready', 'failed'] as const;

export type KbDocStatus = (typeof KB_DOC_STATUSES)[number];

// draft_feedback.reason_code enum (STAQPRO-331 #1). Mirrored against the
// CHECK constraint in migrations/023-create-draft-feedback-v1-2026-05-12.sql;
// the schema-invariants test asserts they stay in sync. Order matches the
// REJECT_REASONS UI list in components/RejectPopover.tsx (top-to-bottom).
export const REJECT_REASON_CODES = [
  'wrong_tone',
  'factually_inaccurate',
  'missing_context',
  'should_reply_myself',
  'dont_reply',
  'other',
] as const;

export type RejectReasonCode = (typeof REJECT_REASON_CODES)[number];

// Human-readable labels for REJECT_REASON_CODES — single SoT for any UI
// surface that needs to display the reason (toast confirmations after reject,
// future analytics/report tooling, etc). RejectPopover's REJECT_REASONS hint
// list is a richer UI affordance and stays local to that component; both must
// stay in sync with REJECT_REASON_CODES.
export const REJECT_REASON_LABELS: Record<RejectReasonCode, string> = {
  wrong_tone: 'Wrong tone',
  factually_inaccurate: 'Factually inaccurate',
  missing_context: 'Missing context',
  should_reply_myself: 'Reply myself',
  dont_reply: "Don't reply",
  other: 'Other',
};

// chat_messages.role enum (MBOX-285, parent epic MBOX-282). Mirrored against
// the CHECK constraint in migrations/027-create-chat-history-v1-2026-05-22.sql;
// the schema-invariants test asserts they stay in sync. 'system' is reserved
// for the local-chat system prompt turn when MBOX-287 persists it.
export const CHAT_MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;

export type ChatMessageRole = (typeof CHAT_MESSAGE_ROLES)[number];

// vip_senders.kind enum (MBOX-134, parent epic MBOX-122). Mirrored against the
// CHECK constraint in migrations/028-create-vip-senders-v1-2026-05-22.sql; the
// schema-invariants test asserts they stay in sync. Match semantics are
// exact-email ('email') or domain-suffix ('domain') only — deliberately NO
// 'regex' value (MBOX-134 open question resolved).
export const VIP_SENDER_KINDS = ['email', 'domain'] as const;

export type VipSenderKind = (typeof VIP_SENDER_KINDS)[number];

// MBOX-162 P5b — drafting-guideline scopes. SoT for the
// mailbox.prompt_rules.scope CHECK constraint (migration 044); the
// schema-invariants test asserts they stay in sync.
//   always — hard requirement · prefer — soft preference
//   avoid  — soft prohibition · never  — hard prohibition
export const PROMPT_RULE_SCOPES = ['always', 'prefer', 'avoid', 'never'] as const;

export type PromptRuleScope = (typeof PROMPT_RULE_SCOPES)[number];

// Mail transport providers (MBOX-356 / DR-55, DR-57). SoT for the
// mailbox.accounts.provider CHECK constraint (migration 037) and the
// providerFor() factory in lib/mail/providers. NOTE: distinct from
// mailbox.oauth_tokens.provider, which is the Google OAuth grant key
// (google_calendar | google_tasks | google_drive) — see lib/oauth/google.ts.
export const MAIL_PROVIDERS = ['gmail', 'imap', 'microsoft'] as const;

export type MailProviderKind = (typeof MAIL_PROVIDERS)[number];

// Urgency signal vocabulary (MBOX-134). The evaluator returns the subset of
// these that fired for a draft; `urgent` is true iff at least one fired. Kept
// here as the SoT so the SQL query helper, the evaluator, and any UI badge map
// read the same set. Order is significant for display priority (escalate
// first, then vip, then aged, then low_conf).
export const URGENCY_SIGNALS = ['escalate', 'vip', 'aged', 'low_conf'] as const;

export type UrgencySignal = (typeof URGENCY_SIGNALS)[number];

// Short operator-facing labels for the urgency signal chips (MBOX-134 engine,
// surfaced in the cross-account Priority view, MBOX-162 V3).
export const URGENCY_SIGNAL_LABELS: Record<UrgencySignal, string> = {
  escalate: 'Escalation',
  vip: 'VIP',
  aged: 'Overdue',
  low_conf: 'Low confidence',
};

// Action-item vocabulary (MBOX-131). `type` classifies the ask; `source`
// records who owes the action — counterparty ('inbound') vs operator
// ('outbound'). Kept as const tuples here as the SoT so the zod schema
// (lib/schemas/drafts.ts:actionItemSchema), the extraction clamp
// (lib/drafting/action-items.ts), and any UI label map read the same set.
// These are NOT backed by a Postgres CHECK constraint — action_items is a
// free-form jsonb array; the enums are enforced at the application boundary
// (zod on write, clamp-or-drop on extraction), so the schema-invariants test
// does not assert them against the DB.
export const ACTION_ITEM_TYPES = ['commitment', 'request', 'deadline', 'meeting'] as const;

export type ActionItemType = (typeof ACTION_ITEM_TYPES)[number];

export const ACTION_ITEM_SOURCES = ['inbound', 'outbound'] as const;

export type ActionItemSource = (typeof ACTION_ITEM_SOURCES)[number];

// auto_send_rules.action / auto_send_audit.{matched,effective}_action enum
// (MBOX-16 / FR-23). Mirrored against the CHECK constraints in
// migrations/032-create-auto-send-rules-v1-2026-05-24.sql; the
// schema-invariants test asserts they stay in sync. 'auto_send' funnels a
// finalized draft through transitionToApprovedAndSend (subject to the hard
// guardrails in lib/auto-send/rules.ts); 'queue' is the explicit all-manual
// action (leave at status='pending' for operator approval); 'drop' rejects the
// draft without sending. Order is display priority for the rules UI.
export const AUTO_SEND_ACTIONS = ['auto_send', 'queue', 'drop'] as const;

export type AutoSendAction = (typeof AUTO_SEND_ACTIONS)[number];

// Task-handoff providers (MBOX-129). v1 ships Google Tasks only; the const
// tuple is the SoT so the push route + zod schema + per-appliance
// TASK_PROVIDER env read the same set. 'linear' is reserved for the v2 toggle
// (see MBOX-129 "Out of scope"). Like ACTION_ITEM_TYPES this is NOT backed by
// a Postgres CHECK constraint — task_external_id/url live on the free-form
// drafts.action_items jsonb; the enum is enforced at the application boundary.
export const TASK_PROVIDERS = ['google_tasks', 'linear'] as const;

export type TaskProvider = (typeof TASK_PROVIDERS)[number];

// MBOX-129 v1 default. Operator can override per-appliance via TASK_PROVIDER
// env once the v2 provider toggle lands; today only 'google_tasks' is wired.
export const DEFAULT_TASK_PROVIDER: TaskProvider = 'google_tasks';

// ── Curated view interfaces (the dashboard's consumer-facing surface) ───────

// MBOX-131 — a single structured action item extracted from the inbound email
// + draft reply. Stored as an array in mailbox.drafts.action_items (jsonb).
export interface ActionItem {
  text: string; // verbatim ask
  type: ActionItemType;
  due_at: string | null; // ISO; null unless a date hint present
  source: ActionItemSource; // who owes: counterparty (inbound) vs operator (outbound)
  confidence: number; // 0..1
  // MBOX-129 — task-handoff fields. All null until the operator pushes the item
  // to their task system (Google Tasks v1). Live on the same drafts.action_items
  // jsonb array — no new table. Re-push is idempotent: it UPDATEs the existing
  // task keyed on task_external_id rather than creating a duplicate.
  task_external_id?: string | null; // provider task id; null until pushed
  task_external_url?: string | null; // deep link to view in the target system
  task_pushed_at?: string | null; // ISO; when the push last succeeded
}

export interface Draft {
  id: number;
  inbox_message_id: number;
  draft_subject: string | null;
  draft_body: string;
  // STAQPRO-121 captures this on first edit (COALESCE in app/api/drafts/[id]/edit);
  // STAQPRO-331 #4 surfaces it to the UI so the operator can review their own
  // changes inline. NULL = draft has never been edited; non-null = the original
  // LLM body before the FIRST edit (subsequent edits do not overwrite — that
  // would discard the highest-quality training signal).
  original_draft_body: string | null;
  model: string;
  draft_source: DraftSource;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string | null; // pg returns NUMERIC as string
  status: DraftStatus;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  error_message: string | null;
  // MBOX-131 — structured action items extracted post-draft-finalize. Empty
  // array when extraction found none, timed out, or errored (non-gating).
  action_items: ActionItem[];
}

export interface InboxMessage {
  id: number;
  message_id: string;
  thread_id: string | null;
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  received_at: string | null;
  snippet: string | null;
  body: string | null;
  classification: string | null;
  confidence: string | null; // pg returns NUMERIC as string
  classified_at: string | null;
  model: string | null;
  created_at: string;
  draft_id: number | null;
  // MBOX-369 — per-row Gmail action disposition. archived_at/deleted_at/
  // snooze_until exclude the row from the active queue (snooze resurfaces when
  // it passes); is_read clears the unread dot but keeps the row; gmail_action_state
  // tracks the archive/delete/mark-read write-through to Gmail ('pending'|'ok'|'failed').
  archived_at: string | null;
  deleted_at: string | null;
  snooze_until: string | null;
  is_read: boolean;
  gmail_action_state: string | null;
}

// ── Thread history types (conversation context in DraftDetail) ──────────────

export interface ThreadMessageInbound {
  direction: 'inbound';
  id: number; // inbox_messages.id
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  body: string | null;
  at: string; // received_at (string per pg type-parser override)
}

export interface ThreadMessageOutbound {
  direction: 'outbound';
  id: number; // sent_history.id (Int8 in DB; Number() cast is safe — thread <= ~14 rows)
  from_addr: string;
  to_addr: string;
  subject: string | null;
  body: string | null; // sourced from sent_history.body_text
  at: string; // sent_at
}

export type ThreadMessage = ThreadMessageInbound | ThreadMessageOutbound;

// MBOX-348/MBOX-162 — the connected mailbox a draft belongs to. Populated by
// the query layer from the accounts join; the badge in the Priority/cross-account
// view reads display_label ?? email_address.
export interface AccountRef {
  id: number;
  email_address: string;
  display_label: string | null;
}

export interface DraftWithMessage extends Draft {
  message: InboxMessage;
  thread_history?: ThreadMessage[];
  // Owning mailbox (MBOX-348). Optional so consumers/tests that predate the
  // accounts join still typecheck; the live query layer always populates it.
  account?: AccountRef;
  // Urgency signals (MBOX-134). Populated only on the urgency-aware query path
  // (getQueueWithUrgency / the Priority folder); undefined elsewhere.
  urgency?: { urgent: boolean; signals: UrgencySignal[] };
}

export interface ClassificationLog {
  id: number;
  inbox_message_id: number;
  category: ClassificationCategory;
  confidence: number; // REAL — pg returns as number
  model_version: string;
  latency_ms: number | null;
  raw_output: string | null;
  json_parse_ok: boolean;
  think_stripped: boolean;
  created_at: string;
}

export interface SentHistory {
  id: number;
  draft_id: number;
  inbox_message_id: number;
  from_addr: string;
  to_addr: string;
  subject: string | null;
  body_text: string | null;
  thread_id: string | null;
  draft_original: string | null;
  draft_sent: string;
  draft_source: DraftSource;
  classification_category: ClassificationCategory;
  classification_confidence: number; // REAL — pg returns as number
  rag_context_refs: unknown[];
  kb_context_refs: unknown[]; // STAQPRO-148: parallel to rag_context_refs for KB corpus
  sent_at: string;
  created_at: string;
}

export interface KbDocument {
  id: number;
  // MBOX-400 (MBOX-162 V7) — owning inbox (mailbox.accounts.id). Lets the KB
  // management UI group/scope documents per account on a multi-account box.
  account_id: number;
  title: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  chunk_count: number;
  status: KbDocStatus;
  error_message: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
  processing_started_at: string;
  ready_at: string | null;
}

export interface RejectedHistory {
  id: number;
  draft_id: number;
  inbox_message_id: number;
  from_addr: string;
  subject: string | null;
  classification_category: ClassificationCategory;
  classification_confidence: number; // REAL — pg returns as number
  draft_original: string | null;
  rejected_at: string;
  created_at: string;
}

export interface Persona {
  id: number;
  customer_key: string;
  statistical_markers: Record<string, unknown>;
  category_exemplars: Record<string, unknown>;
  source_email_count: number;
  last_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Onboarding {
  id: number;
  customer_key: string;
  stage: OnboardingStage;
  admin_username: string | null;
  admin_password_hash: string | null;
  email_address: string | null;
  ingest_progress_total: number | null;
  ingest_progress_done: number;
  tuning_sample_count: number;
  tuning_rated_count: number;
  started_at: string;
  lived_at: string | null;
}

// ── Chat history views (MBOX-285, local-model chat surface) ─────────────────

export interface ChatConversation {
  id: number;
  // MBOX-400 (MBOX-162 V7) — the mailbox.accounts row this chat session belongs
  // to (column added by migration 033, DEFAULT = default account). Scopes
  // "Ask the KB" retrieval to one inbox's history on a multi-account appliance.
  account_id: number;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: number;
  conversation_id: number;
  role: ChatMessageRole;
  content: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  // Qdrant point UUIDs that augmented an assistant turn (empty [] otherwise) —
  // same shape/semantics as Draft/SentHistory rag_context_refs.
  rag_context_refs: unknown[];
  rag_retrieval_reason: string;
  created_at: string;
}

// ── Auto-send rules + audit views (MBOX-16 / FR-23) ─────────────────────────

// One operator-defined auto-send rule. Conditions are AND-ed; a NULL condition
// matches anything. The evaluator (lib/auto-send/rules.ts) walks enabled rules
// in (priority, id) order and the first match wins. `action` is what the rule
// declares; the code-side hard guardrails can still downgrade an 'auto_send'
// to 'queue' (see lib/auto-send/rules.ts).
export interface AutoSendRule {
  id: number;
  name: string;
  enabled: boolean;
  priority: number;
  action: AutoSendAction;
  category: ClassificationCategory | null;
  sender_domain: string | null;
  // pg returns NUMERIC as string via the type-parser overrides.
  min_confidence: string | null;
  // Minutes-from-midnight [start, end) operator-local window; null/null = any.
  active_from_min: number | null;
  active_to_min: number | null;
  // While now < shadow_until an auto_send rule is logged-only (downgraded to
  // queue). null = not shadowed.
  shadow_until: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

// One append-only audit row recording an auto-send evaluation for a finalized
// draft (FR-23 §3). rule_id NULL = no enabled rule matched (default manual).
export interface AutoSendAuditEntry {
  id: number;
  draft_id: number;
  rule_id: number | null;
  rule_name: string | null;
  matched_action: AutoSendAction;
  effective_action: AutoSendAction;
  shadow: boolean;
  reason: string;
  evaluated_at: string;
}

// MBOX-162 P4 — operator workspace settings (singleton row in
// mailbox.operator_settings). Curated view: the three operator-editable fields
// the right pane + settings page consume. id/updated_at stay on the DB row.
export interface OperatorSettings {
  booking_link: string;
  calendar_embed_src: string;
  drive_folder_id: string;
}

// ── Full DB row shapes (re-exports of kysely-codegen output) ────────────────
//
// Use these when you need a column the curated view doesn't expose. The
// lib/db/schema.ts file is generated by `npm run db:codegen` from the
// canonical schema snapshot; columns added via migration become available
// here automatically once the codegen is re-run.

export type DraftRow = Selectable<DraftsRow_>;
export type InboxMessageRow = Selectable<InboxMessagesRow_>;
export type ClassificationLogRow = Selectable<ClassificationLogRow_>;
export type SentHistoryRow = Selectable<SentHistoryRow_>;
export type RejectedHistoryRow = Selectable<RejectedHistoryRow_>;
export type PersonaRow = Selectable<PersonaRow_>;
export type OnboardingRow = Selectable<OnboardingRow_>;
export type KbDocumentRow = Selectable<KbDocumentsRow_>;
export type DraftFeedbackRow = Selectable<DraftFeedbackRow_>;
export type ChatConversationRow = Selectable<ChatConversationsRow_>;
export type ChatMessageRow = Selectable<ChatMessagesRow_>;
export type VipSenderRow = Selectable<VipSendersRow_>;
export type AutoSendRuleRow = Selectable<AutoSendRulesRow_>;
export type AutoSendAuditRow = Selectable<AutoSendAuditRow_>;
