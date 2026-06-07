// dashboard/lib/tasks/google-tasks.ts
//
// MBOX-129 — Google Tasks provider. v1 task-handoff target. Maps an ActionItem
// (text + due_at + a backlink to the draft) onto a Google Tasks task.
//
// Idempotent: when the item already carries a task_external_id, we PATCH the
// existing task instead of creating a duplicate (re-push updates, never dupes).
//
// No googleapis SDK — direct fetch against the Tasks v1 REST API with the
// access token from lib/oauth/google.ts. Rate-limit discipline mirrors the
// Gmail cooldown pattern (CLAUDE.md / STAQPRO-271): a 429 throws a typed
// TaskRateLimitError carrying the Retry-After so the caller can back off.

import { getAccessToken, markFetched, OAuthTokenError } from '@/lib/oauth/google';
import type { ActionItem } from '@/lib/types';

const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';

// Which Google Tasks list new items land in. '@default' is the operator's
// primary list; overridable per-appliance once the settings default-list
// selector lands (MBOX-129 UI scope, deferred — see report).
function defaultTaskList(): string {
  return process.env.GOOGLE_TASKS_LIST_ID?.trim() || '@default';
}

export type TaskPushFailureKind = 'auth' | 'rate_limited' | 'client_error' | 'transient';

export class TaskPushError extends Error {
  constructor(
    message: string,
    readonly kind: TaskPushFailureKind,
    readonly status?: number,
    // Seconds to wait before retrying (parsed from Retry-After on a 429).
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'TaskPushError';
  }
}

export interface PushResult {
  task_external_id: string;
  task_external_url: string;
}

// Build the notes body: a backlink to the draft so the operator can jump from
// the task back to the email it came from. MAILBOX_PUBLIC_BASE_URL + basePath.
function draftBacklink(draftId: number): string {
  const base = process.env.MAILBOX_PUBLIC_BASE_URL?.trim() ?? '';
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  if (!base) return `MailBOX draft #${draftId}`;
  return `From MailBOX draft #${draftId}: ${base.replace(/\/$/, '')}${basePath}/queue?draft=${draftId}`;
}

// Google Tasks `due` is RFC 3339 but the API only honors the DATE portion
// (time-of-day is ignored). Pass the ISO through as-is when present.
function taskBody(item: ActionItem, draftId: number) {
  return {
    title: item.text.slice(0, 1024),
    notes: draftBacklink(draftId),
    ...(item.due_at ? { due: item.due_at } : {}),
  };
}

function mapHttpError(status: number, retryAfter: string | null): TaskPushError {
  if (status === 401 || status === 403) {
    return new TaskPushError(`Google Tasks rejected auth (${status})`, 'auth', status);
  }
  if (status === 429) {
    const sec = retryAfter ? Number.parseInt(retryAfter, 10) : NaN;
    return new TaskPushError(
      `Google Tasks rate-limited (429)`,
      'rate_limited',
      status,
      Number.isFinite(sec) ? sec : undefined,
    );
  }
  if (status >= 500) {
    return new TaskPushError(`Google Tasks server error (${status})`, 'transient', status);
  }
  return new TaskPushError(`Google Tasks request failed (${status})`, 'client_error', status);
}

async function authHeader(): Promise<Record<string, string>> {
  try {
    const token = await getAccessToken('google_tasks');
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  } catch (err) {
    if (err instanceof OAuthTokenError) {
      // Surface as an auth failure so the caller prompts a reconnect.
      throw new TaskPushError(err.message, 'auth', err.status);
    }
    throw new TaskPushError(err instanceof Error ? err.message : 'token error', 'transient');
  }
}

// Create or update (idempotent) a Google Tasks task for an action item. When
// `existingTaskId` is set, PATCHes that task; otherwise creates a new one.
export async function pushToGoogleTasks(
  item: ActionItem,
  draftId: number,
  existingTaskId: string | null,
): Promise<PushResult> {
  const headers = await authHeader();
  const list = encodeURIComponent(defaultTaskList());
  const body = JSON.stringify(taskBody(item, draftId));

  const url = existingTaskId
    ? `${TASKS_API}/lists/${list}/tasks/${encodeURIComponent(existingTaskId)}`
    : `${TASKS_API}/lists/${list}/tasks`;
  const method = existingTaskId ? 'PATCH' : 'POST';

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(8_000) });
  } catch (err) {
    throw new TaskPushError(
      `Google Tasks unreachable: ${err instanceof Error ? err.message : String(err)}`,
      'transient',
    );
  }

  if (!res.ok) {
    throw mapHttpError(res.status, res.headers.get('retry-after'));
  }

  const json = (await res.json().catch(() => null)) as {
    id?: string;
    webViewLink?: string;
    selfLink?: string;
  } | null;
  if (!json?.id) {
    throw new TaskPushError('Google Tasks returned no task id', 'transient', res.status);
  }

  // Best-effort fetch stamp (last successful Tasks API call). Non-fatal.
  void markFetched('google_tasks').catch(() => undefined);

  // Google Tasks' REST API rarely returns a per-task `webViewLink`. When it's
  // absent we leave the URL empty rather than synthesizing the generic
  // https://tasks.google.com/ homepage — a homepage is not a deep link and a
  // "View in Tasks" button pointing at it lies to the operator. The UI hides
  // the button when this is empty.
  const url_ = typeof json.webViewLink === 'string' ? json.webViewLink : '';
  return { task_external_id: json.id, task_external_url: url_ };
}
