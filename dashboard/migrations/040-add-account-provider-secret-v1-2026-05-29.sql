-- Migration 040 — MBOX-357 (P1 T6): IMAP/SMTP credential at rest.
-- WHAT: adds mailbox.accounts.provider_secret_enc (nullable text) holding the
--   AES-256-GCM-encrypted IMAP/SMTP app-password (packed iv.tag.ciphertext via
--   lib/oauth/google.ts:encryptToken). Non-secret connection params
--   (host/port/tls/username) already live in accounts.provider_config (mig 037).
-- WHY: IMAP/SMTP AUTH needs a plaintext app-password; onboarding (FR-MP-6)
--   captures + test-connection-validates it, then stores it encrypted as the
--   dashboard SoT. n8n holds its own operational credential per DR-56 (Option A);
--   this column is the durable record + the seed for a future dashboard-owned
--   poll loop (STAQPRO-187 / P3). Gmail rows leave it NULL (OAuth, no password).
-- REVERSAL: ALTER TABLE mailbox.accounts DROP COLUMN provider_secret_enc;

ALTER TABLE mailbox.accounts ADD COLUMN provider_secret_enc text;
