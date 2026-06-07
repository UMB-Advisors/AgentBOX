import type { MailProviderKind } from '@/lib/types';

export interface WebhookResult {
  success: boolean;
  response?: unknown;
  error?: string;
}

// MBOX-369 — the three Gmail write-through row actions (snooze is local-only,
// never fans out to Gmail). Mirrors the Gmail API mapping in the MBOX-369 PRD:
//   archive   → messages.modify removeLabelIds [INBOX]
//   delete    → messages.trash (recoverable, NOT permanent delete)
//   mark_read → messages.modify removeLabelIds [UNREAD]
export type GmailMsgAction = 'archive' | 'delete' | 'mark_read';

// Fire the MailBOX-MsgAction n8n workflow for a single inbox message. Account-
// scoped (MBOX-162): n8n resolves the owning account's Gmail credential from
// account_id. Same empty-/non-JSON-body tolerance as triggerSendWebhook — an
// n8n node that throws can return an empty 200, which we must not treat as JSON.
// NOTE: Gmail-only today (the n8n MailBOX-MsgAction workflow calls the Gmail
// REST API). IMAP accounts (MBOX-357) have no equivalent label/trash op yet — a
// per-provider msg-action follow-up; callers should gate on the account being
// gmail until then.
export async function triggerMsgActionWebhook(
  action: GmailMsgAction,
  accountId: number,
  messageId: string,
): Promise<WebhookResult> {
  const url = process.env.N8N_MSG_ACTION_URL ?? 'http://n8n:5678/webhook/mailbox-msg-action';
  if (!url) {
    return { success: false, error: 'N8N_MSG_ACTION_URL not configured' };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, account_id: accountId, message_id: messageId }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return { success: false, error: `Webhook returned ${res.status}: ${await res.text()}` };
    }
    const text = await res.text();
    if (!text) {
      return {
        success: false,
        error:
          'n8n msg-action webhook returned empty body — likely an upstream Gmail ' +
          'modify/trash failure. Check the latest errored MailBOX-MsgAction execution_data.',
      };
    }
    try {
      return { success: true, response: JSON.parse(text) };
    } catch {
      return {
        success: false,
        error: `n8n msg-action webhook returned non-JSON body (truncated): ${text.slice(0, 200)}`,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Webhook call failed',
    };
  }
}

// MBOX-357 (P1 T5) — per-provider send webhooks (DR-56 Option A: one n8n
// workflow per transport). Gmail → MailBOX-Send (N8N_WEBHOOK_URL, unchanged);
// IMAP → MailBOX-Imap-Send (N8N_IMAP_WEBHOOK_URL). The provider comes from the
// draft's owning account (getDraftProviderContext). Both webhooks share the
// same { draft_id } request + JSON-or-empty-body response contract, so the
// STAQPRO-231 empty-body handling below applies identically to both.
export async function triggerSendWebhook(
  draftId: number,
  provider: MailProviderKind = 'gmail',
): Promise<WebhookResult> {
  const url =
    provider === 'imap'
      ? (process.env.N8N_IMAP_WEBHOOK_URL ?? '')
      : (process.env.N8N_WEBHOOK_URL ?? '');
  if (!url) {
    const envName = provider === 'imap' ? 'N8N_IMAP_WEBHOOK_URL' : 'N8N_WEBHOOK_URL';
    return { success: false, error: `${envName} not configured` };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft_id: draftId }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return {
        success: false,
        error: `Webhook returned ${res.status}: ${await res.text()}`,
      };
    }

    // STAQPRO-231 — n8n's MailBOX-Send returns an empty body when the
    // Gmail Reply node throws (the workflow exits before reaching the
    // Respond Success / Respond Failure terminal nodes). Tolerate empty +
    // non-JSON bodies rather than throwing 'Unexpected end of JSON input'
    // — that string was the entire operator-visible error during the
    // 2026-05-08 incident (STAQPRO-271). Real cause lives in n8n's
    // execution_data; surface a hint instead.
    const text = await res.text();
    if (!text) {
      return {
        success: false,
        error:
          'n8n webhook returned empty body — likely an upstream send failure. ' +
          'Check the latest errored MailBOX-Send execution_data for the actual cause ' +
          '(commonly Gmail rate-limit on the Reply node).',
      };
    }
    try {
      return { success: true, response: JSON.parse(text) };
    } catch {
      return {
        success: false,
        error: `n8n webhook returned non-JSON body (truncated): ${text.slice(0, 200)}`,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Webhook call failed',
    };
  }
}
