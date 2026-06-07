import { z } from 'zod';
import { MAIL_PROVIDERS, ONBOARDING_STAGES } from '@/lib/types';

// Schemas for the n8n-facing internal routes. These accept the exact shapes
// n8n already sends today; tightening here would break the live pipeline.

// POST /api/internal/draft-prompt — { draft_id: number }
export const draftPromptBodySchema = z.object({
  draft_id: z.coerce.number().int().positive(),
});

export type DraftPromptBody = z.infer<typeof draftPromptBodySchema>;

// POST /api/internal/draft-finalize — full payload from n8n's draft sub-workflow.
// `source` mirrors the live drafts.draft_source CHECK constraint values that
// the live code actually writes (the broader CHECK also permits legacy
// `local_qwen3` / `cloud_haiku`, but neither is written by the live path).
export const draftFinalizeBodySchema = z.object({
  draft_id: z.coerce.number().int().positive(),
  body: z.string().min(1, 'body (non-empty string) required'),
  source: z.enum(['local', 'cloud']),
  model: z.string().trim().min(1, 'model (non-empty string) required'),
  input_tokens: z.coerce.number().int().nonnegative().default(0),
  output_tokens: z.coerce.number().int().nonnegative().default(0),
});

export type DraftFinalizeBody = z.infer<typeof draftFinalizeBodySchema>;

// POST /api/internal/classification-prompt — all fields optional (route falls
// back to '' on missing).
export const classificationPromptBodySchema = z.object({
  from: z.string().optional().default(''),
  subject: z.string().optional().default(''),
  body: z.string().optional().default(''),
});

export type ClassificationPromptBody = z.infer<typeof classificationPromptBodySchema>;

// POST /api/internal/classification-normalize — { raw?, from?, to?, thread_id? }.
// `from` / `to` feed the deterministic operator-domain preclass (DR-50).
// `thread_id` feeds the async operator-owns-thread guard (UMB-154). The n8n
// Normalize node must add a `thread_id` line to jsonBody for UMB-154 to fire
// in production — see deploy note in the SUMMARY. Without it the guard is
// dormant (no thread_id → no DB query → drafts normally).
export const classificationNormalizeBodySchema = z.object({
  raw: z.string().optional().default(''),
  from: z.string().optional(),
  to: z.string().optional(),
  thread_id: z.string().optional(),
});

export type ClassificationNormalizeBody = z.infer<typeof classificationNormalizeBodySchema>;

// POST /api/internal/llm/api/generate — Ollama-shape /api/generate body
// forwarded to the local runtime (ollama or llama.cpp, per
// LOCAL_INFERENCE_RUNTIME). STAQPRO-338 / DR-25.
export const llmGenerateBodySchema = z
  .object({
    model: z.string().trim().min(1, 'model required'),
    prompt: z.string().min(1, 'prompt required'),
    stream: z.literal(false).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    stop: z.array(z.string()).optional(),
    format: z.string().optional(),
    system: z.string().optional(),
    template: z.string().optional(),
    // Ollama-side thinking-mode toggle (Qwen3 native param). Propagated to
    // llama.cpp via chat_template_kwargs.enable_thinking by the proxy
    // translator. STAQPRO-360 attempt-4.
    think: z.boolean().optional(),
  })
  .strip();

export type LlmGenerateBody = z.infer<typeof llmGenerateBodySchema>;

// POST /api/internal/llm/api/chat — Ollama-shape /api/chat body. STAQPRO-338.
export const llmChatBodySchema = z
  .object({
    model: z.string().trim().min(1, 'model required'),
    messages: z
      .array(
        z.object({
          role: z.enum(['system', 'user', 'assistant']),
          content: z.string(),
        }),
      )
      .min(1, 'messages (non-empty array) required'),
    stream: z.literal(false).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    format: z.string().optional(),
  })
  .strip();

export type LlmChatBody = z.infer<typeof llmChatBodySchema>;

// POST /api/internal/llm/api/chat/stream — interactive token streaming for the
// chat UI (MBOX-284). LOCAL-ONLY (DR-53 / SM-73): the route ignores any
// caller-supplied baseUrl/runtime and always targets the local runtime selected
// by LOCAL_INFERENCE_RUNTIME, so no field here can redirect to a cloud model.
// `model` is accepted for telemetry parity with the non-streaming body but the
// route overrides the upstream model with the configured local model name.
export const llmChatStreamBodySchema = z
  .object({
    model: z.string().trim().min(1).optional(),
    messages: z
      .array(
        z.object({
          role: z.enum(['system', 'user', 'assistant']),
          content: z.string(),
        }),
      )
      .min(1, 'messages (non-empty array) required'),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strip();

export type LlmChatStreamBody = z.infer<typeof llmChatStreamBodySchema>;

// POST /api/internal/draft-redraft — P3 (MBOX-162) operator redraft-with-prompt.
// The browser sends the draft id (to load inbound context + persona
// server-side), the operator's current in-progress body, and a refine
// instruction. LOCAL-ONLY (DR-53/SM-73): no model/baseUrl field that could
// redirect to a cloud provider; the route resolves the on-device runtime
// exactly like the chat-stream sibling. `current_body` shares the edit route's
// 10k cap.
export const draftRedraftBodySchema = z
  .object({
    draft_id: z.number().int().positive(),
    current_body: z.string().min(1).max(10_000),
    instruction: z.string().trim().min(1).max(2_000),
  })
  .strip();

export type DraftRedraftBody = z.infer<typeof draftRedraftBodySchema>;

// POST /api/internal/inbox-messages — STAQPRO-135 ingest endpoint that
// replaces n8n's `Insert Inbox (skip dupes)` Postgres node. Field shape
// mirrors what n8n's `Extract Fields` set node already produces; tightening
// here would break the live workflow.
export const inboxMessageInsertBodySchema = z.object({
  message_id: z.string().min(1, 'message_id (Gmail message id) required'),
  // MBOX-357 (P1 T5) — mail-transport discriminator. Omitted by the live Gmail
  // workflow (→ 'gmail', the un-changed path where n8n's Extract Fields node
  // sends already-mapped columns). The MailBOX-Imap workflow sends
  // provider:'imap' + raw header fields; the route then runs
  // providerFor(provider).normalize(...) server-side to synthesize thread_id
  // (IMAP has no native thread id — n8n can't compute the sha256 chain hash).
  provider: z.enum(MAIL_PROVIDERS).optional().default('gmail'),
  // MBOX-348 — multi-account ingestion target. The fan-out passes ONE of these
  // to route the message into the right inbox; the legacy single-account path
  // sends neither and the route falls back to the default account. Both omitted
  // is the un-changed single-account behavior.
  account_id: z.number().int().positive().optional(),
  account_email: z.string().trim().min(1).optional(),
  thread_id: z.string().optional().default(''),
  from_addr: z.string().optional().default(''),
  to_addr: z.string().optional().default(''),
  subject: z.string().optional().default(''),
  // n8n always sends received_at as a string, defaulting to '' when Gmail
  // omits the date. '' would crash the TIMESTAMPTZ insert; coerce to
  // undefined so the route can omit the column from the values clause.
  received_at: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  snippet: z.string().optional().default(''),
  body: z.string().optional().default(''),
  in_reply_to: z.string().optional().default(''),
  references: z.string().optional().default(''),
});

export type InboxMessageInsertBody = z.infer<typeof inboxMessageInsertBodySchema>;

// POST /api/internal/onboarding/advance — STAQPRO-152 wizard step transition.
// Both `from` and `to` are constrained to the live OnboardingStage enum; the
// route then checks them against ALLOWED_TRANSITIONS (lib/onboarding/wizard-stages.ts)
// for the strict adjacent-pair contract. customer_key defaults to 'default'
// since the appliance is single-tenant in v1.
export const onboardingAdvanceBodySchema = z.object({
  from: z.enum(ONBOARDING_STAGES),
  to: z.enum(ONBOARDING_STAGES),
  customer_key: z.string().min(1).default('default'),
});

export type OnboardingAdvanceBody = z.infer<typeof onboardingAdvanceBodySchema>;

// POST /api/internal/gmail-cycle-complete — STAQPRO-226. Reports the size of
// the Gmail Get batch n8n just pulled so the dashboard can advance bootstrap
// state. `messages_returned` is non-negative; 0 is the steady-state empty
// poll case and is what flips bootstrap_complete=true on first install.
export const gmailCycleCompleteBodySchema = z.object({
  messages_returned: z.coerce.number().int().nonnegative(),
});

export type GmailCycleCompleteBody = z.infer<typeof gmailCycleCompleteBodySchema>;

// POST /api/internal/ota/update-now — MBOX-349 customer-initiated OTA execute.
// from_digest/to_digest are optional image-digest strings echoed into the
// audit row (resolved by the MBOX-184 detection panel client-side). Both are
// nullable: a detection miss can still trigger an attempt that records NULLs.
// No free-form fields reach the shell layer — the orchestrator only uses these
// for the audit trail and the rollback target hint.
export const otaUpdateNowBodySchema = z.object({
  from_digest: z.string().min(1).max(200).nullish(),
  to_digest: z.string().min(1).max(200).nullish(),
});

export type OtaUpdateNowBody = z.infer<typeof otaUpdateNowBodySchema>;
