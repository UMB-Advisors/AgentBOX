import { z } from 'zod';

// POST /api/internal/onboarding/imap-connect — MBOX-357 (P1 T6 / FR-MP-6).
//
// Operator-entered IMAP/SMTP connection details from the onboarding wizard's
// email-connect step (IMAP branch). `mode:'test'` runs the test-connection
// probe ONLY (the "Test connection" button — validate without persisting);
// `mode:'save'` runs the probe AND, only if it passes, persists the account +
// the encrypted app-password and advances the wizard. The app-password is never
// returned and is stored AES-256-GCM-encrypted (migration 040).
export const imapConnectBodySchema = z.object({
  mode: z.enum(['test', 'save']).default('test'),
  // Validated as an email; lowercased in the route (mirrors queries-accounts).
  email: z.string().trim().email(),
  display_label: z.string().trim().min(1).max(100).optional(),
  imap_host: z.string().trim().min(1).max(255),
  imap_port: z.coerce.number().int().min(1).max(65535).default(993),
  smtp_host: z.string().trim().min(1).max(255),
  smtp_port: z.coerce.number().int().min(1).max(65535).default(587),
  username: z.string().trim().min(1).max(320),
  app_password: z.string().min(1).max(1024),
});

export type ImapConnectBody = z.infer<typeof imapConnectBodySchema>;
