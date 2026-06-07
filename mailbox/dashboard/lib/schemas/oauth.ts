import { z } from 'zod';
import { OAUTH_PROVIDERS, type OAuthProvider } from '@/lib/oauth/google';

// MBOX-130 + MBOX-129 — schemas for the operator-facing Google OAuth
// connect/status/disconnect surface. The provider is a path param constrained
// to the canonical OAUTH_PROVIDERS tuple (lib/oauth/google.ts) so a bad
// provider returns a structured 400 rather than a 500 deeper in.

export const oauthProviderParamSchema = z.object({
  provider: z.enum(OAUTH_PROVIDERS as readonly [OAuthProvider, ...OAuthProvider[]]),
});

export type OAuthProviderParam = z.infer<typeof oauthProviderParamSchema>;

// GET callback query — Google redirects back with ?code=...&state=... on
// success, or ?error=access_denied&state=... when the operator declines.
export const oauthCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().min(1, 'state required'),
  error: z.string().optional(),
});

export type OAuthCallbackQuery = z.infer<typeof oauthCallbackQuerySchema>;
