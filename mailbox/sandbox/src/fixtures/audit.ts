// STAQPRO-414 sandbox fixtures — synthetic mailbox.state_transitions rows.
//
// Real schema (per STAQPRO-185 / migration 009):
//   mailbox.state_transitions (
//     id BIGSERIAL,
//     draft_id BIGINT,
//     old_status TEXT, new_status TEXT,
//     actor TEXT, reason TEXT,
//     happened_at TIMESTAMPTZ DEFAULT NOW()
//   )

export type AuditStatus =
  | "pending"
  | "approved"
  | "sent"
  | "rejected"
  | "edited"
  | "awaiting_cloud";

export type AuditActor = "operator" | "system" | "n8n";

export type AuditReason =
  | "approve"
  | "retry"
  | "reject"
  | "edit"
  | "send"
  | "cloud_route"
  | "draft_finalize"
  | "send_failure"
  | "manual_resend"
  | "classify";

export interface AuditTransition {
  id: number;
  draft_id: number;
  old_status: AuditStatus | null;
  new_status: AuditStatus;
  actor: AuditActor;
  reason: AuditReason;
  happened_at: string;
}

export const auditTransitions: AuditTransition[] = [
  { id: 1, draft_id: 1, old_status: null, new_status: "pending", actor: "n8n", reason: "draft_finalize", happened_at: "2026-05-14T15:32:11Z" },
  { id: 2, draft_id: 1, old_status: "pending", new_status: "approved", actor: "operator", reason: "approve", happened_at: "2026-05-14T16:08:44Z" },
  { id: 3, draft_id: 1, old_status: "approved", new_status: "sent", actor: "n8n", reason: "send", happened_at: "2026-05-14T16:08:50Z" },
  { id: 4, draft_id: 2, old_status: null, new_status: "pending", actor: "n8n", reason: "draft_finalize", happened_at: "2026-05-15T09:12:00Z" },
  { id: 5, draft_id: 2, old_status: "pending", new_status: "approved", actor: "operator", reason: "approve", happened_at: "2026-05-15T09:30:11Z" },
  { id: 6, draft_id: 2, old_status: null, new_status: "approved", actor: "system", reason: "send_failure", happened_at: "2026-05-15T09:30:18Z" },
  { id: 7, draft_id: 2, old_status: "approved", new_status: "sent", actor: "operator", reason: "manual_resend", happened_at: "2026-05-15T11:47:02Z" },
  { id: 8, draft_id: 3, old_status: null, new_status: "pending", actor: "n8n", reason: "draft_finalize", happened_at: "2026-05-16T11:01:33Z" },
  { id: 9, draft_id: 3, old_status: "pending", new_status: "edited", actor: "operator", reason: "edit", happened_at: "2026-05-16T11:14:55Z" },
  { id: 10, draft_id: 3, old_status: "edited", new_status: "approved", actor: "operator", reason: "approve", happened_at: "2026-05-16T11:15:02Z" },
  { id: 11, draft_id: 3, old_status: "approved", new_status: "sent", actor: "n8n", reason: "send", happened_at: "2026-05-16T11:15:08Z" },
  { id: 12, draft_id: 4, old_status: null, new_status: "awaiting_cloud", actor: "n8n", reason: "cloud_route", happened_at: "2026-05-17T08:22:15Z" },
  { id: 13, draft_id: 4, old_status: "awaiting_cloud", new_status: "pending", actor: "n8n", reason: "draft_finalize", happened_at: "2026-05-17T08:23:04Z" },
  { id: 14, draft_id: 4, old_status: "pending", new_status: "rejected", actor: "operator", reason: "reject", happened_at: "2026-05-17T08:41:50Z" },
  { id: 15, draft_id: 5, old_status: null, new_status: "pending", actor: "n8n", reason: "draft_finalize", happened_at: "2026-05-18T10:55:21Z" },
  { id: 16, draft_id: 6, old_status: null, new_status: "pending", actor: "n8n", reason: "draft_finalize", happened_at: "2026-05-18T07:14:09Z" },
  { id: 17, draft_id: 6, old_status: "pending", new_status: "approved", actor: "operator", reason: "approve", happened_at: "2026-05-18T07:30:02Z" },
  { id: 18, draft_id: 6, old_status: null, new_status: "approved", actor: "system", reason: "send_failure", happened_at: "2026-05-18T07:30:08Z" },
  { id: 19, draft_id: 7, old_status: null, new_status: "pending", actor: "n8n", reason: "draft_finalize", happened_at: "2026-05-17T14:01:00Z" },
  { id: 20, draft_id: 7, old_status: "pending", new_status: "approved", actor: "operator", reason: "approve", happened_at: "2026-05-17T14:15:30Z" },
  { id: 21, draft_id: 7, old_status: null, new_status: "approved", actor: "system", reason: "send_failure", happened_at: "2026-05-17T14:15:38Z" },
  { id: 22, draft_id: 7, old_status: "approved", new_status: "approved", actor: "operator", reason: "retry", happened_at: "2026-05-17T15:22:14Z" },
  { id: 23, draft_id: 7, old_status: "approved", new_status: "sent", actor: "n8n", reason: "send", happened_at: "2026-05-17T15:22:20Z" },
  { id: 24, draft_id: 8, old_status: null, new_status: "rejected", actor: "n8n", reason: "classify", happened_at: "2026-05-18T11:33:44Z" },
];
