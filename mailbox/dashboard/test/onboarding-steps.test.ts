import { describe, expect, it } from 'vitest';
import {
  PROVIDER_ONBOARDING,
  type ProviderOnboarding,
} from '@/lib/mail/onboarding-steps';
import { MAIL_PROVIDERS } from '@/lib/types';

// MBOX-465 — pure-data invariants for the provider-aware onboarding content.
// No DB / no fetch: this guards the SoT shape the Connections-page UI consumes.
//   - exhaustiveness vs MAIL_PROVIDERS is the AC4 "new provider, no UI fork" gate
//   - credentials providers must point at a connect route AND ship steps
//   - oauth providers (gmail) ship zero steps and no connect route
//   - microsoft surfaces the client-secret + admin-consent snags inline
//   - imap ships at least one host preset

describe('PROVIDER_ONBOARDING', () => {
  it('has an entry for every MailProviderKind (AC4 exhaustiveness)', () => {
    for (const kind of MAIL_PROVIDERS) {
      expect(PROVIDER_ONBOARDING[kind], `missing onboarding for ${kind}`).toBeDefined();
    }
    // No stray keys beyond the SoT tuple.
    expect(Object.keys(PROVIDER_ONBOARDING).sort()).toEqual([...MAIL_PROVIDERS].sort());
  });

  const entries = Object.entries(PROVIDER_ONBOARDING) as [string, ProviderOnboarding][];

  it.each(entries)('%s: every step has a non-empty title and body', (_kind, cfg) => {
    for (const step of cfg.steps) {
      expect(step.title.trim().length).toBeGreaterThan(0);
      expect(step.body.trim().length).toBeGreaterThan(0);
    }
  });

  it.each(entries)('%s: credentials entries have a connectPath and steps', (_kind, cfg) => {
    if (cfg.mode !== 'credentials') return;
    expect(cfg.connectPath).toBeTruthy();
    expect(cfg.steps.length).toBeGreaterThan(0);
  });

  it.each(entries)('%s: oauth entries have no steps and no connectPath', (_kind, cfg) => {
    if (cfg.mode !== 'oauth') return;
    expect(cfg.steps.length).toBe(0);
    expect(cfg.connectPath).toBeUndefined();
  });

  it('gmail is oauth with no inline steps', () => {
    expect(PROVIDER_ONBOARDING.gmail.mode).toBe('oauth');
    expect(PROVIDER_ONBOARDING.gmail.steps.length).toBe(0);
    expect(PROVIDER_ONBOARDING.gmail.connectPath).toBeUndefined();
  });

  it('microsoft posts to the graph connect route', () => {
    expect(PROVIDER_ONBOARDING.microsoft.mode).toBe('credentials');
    expect(PROVIDER_ONBOARDING.microsoft.connectPath).toBe('/api/accounts/microsoft');
  });

  it('microsoft has a step that produces client_secret', () => {
    const hasSecretStep = PROVIDER_ONBOARDING.microsoft.steps.some((s) =>
      s.produces?.includes('client_secret'),
    );
    expect(hasSecretStep).toBe(true);
  });

  it('microsoft has a step mentioning admin consent', () => {
    const mentionsConsent = PROVIDER_ONBOARDING.microsoft.steps.some((s) =>
      /admin consent/i.test(`${s.title} ${s.body}`),
    );
    expect(mentionsConsent).toBe(true);
  });

  it('imap posts to the imap connect route and ships at least one preset', () => {
    expect(PROVIDER_ONBOARDING.imap.mode).toBe('credentials');
    expect(PROVIDER_ONBOARDING.imap.connectPath).toBe('/api/accounts/imap');
    expect((PROVIDER_ONBOARDING.imap.imapPresets ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('imap has a step that produces app_password', () => {
    const hasAppPwStep = PROVIDER_ONBOARDING.imap.steps.some((s) =>
      s.produces?.includes('app_password'),
    );
    expect(hasAppPwStep).toBe(true);
  });
});
