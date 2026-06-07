import { z } from 'zod';

// POST /api/internal/onboarding/graph-connect + /api/accounts/microsoft —
// MBOX-358 (P2). Operator-entered BYO Azure app-registration credentials for a
// Microsoft 365 / Graph mailbox (app-only / client-credentials, NC-34).
//
// `mode:'test'` runs the token + inbox probe ONLY (the "Test connection"
// button — validate without persisting); `mode:'save'` runs the probe AND, only
// if it passes, persists the account + the encrypted client secret and (for the
// onboarding caller) advances the wizard. The client secret is never returned
// and is stored AES-256-GCM-encrypted (migration 040, the same column IMAP's
// app-password uses).
export const graphConnectBodySchema = z.object({
  mode: z.enum(['test', 'save']).default('test'),
  // The connecting identity; lowercased in connectGraph (mirrors queries-accounts).
  email: z.string().trim().email(),
  display_label: z.string().trim().min(1).max(100).optional(),
  // Azure AD directory (tenant) id — GUID or a verified domain.
  tenant_id: z.string().trim().min(1).max(128),
  // App (client) id of the registered Azure application — GUID.
  client_id: z.string().trim().min(1).max(128),
  // Client secret VALUE (not the secret id). Stored encrypted, never echoed.
  client_secret: z.string().min(1).max(2048),
  // The mailbox (UPN / email) the app credential reads on behalf of. Defaults to
  // `email` when omitted (the common single-mailbox case).
  mailbox: z.string().trim().email().optional(),
});

export type GraphConnectBody = z.infer<typeof graphConnectBodySchema>;
