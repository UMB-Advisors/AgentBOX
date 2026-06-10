'use client';

import {
  type ImapPreset,
  type OnboardingStep,
  PROVIDER_ONBOARDING,
} from '@/lib/mail/onboarding-steps';
import type { MailProviderKind } from '@/lib/types';

// MBOX-465 (child of MBOX-355 multi-provider mail) — provider-aware onboarding
// walkthrough for the Connections/Keys page. Renders the inline steps a
// non-technical operator follows to connect their own Microsoft 365 or IMAP
// account, sourced ENTIRELY from PROVIDER_ONBOARDING (lib/mail/onboarding-steps.ts,
// the single source of truth). The step renderer is GENERIC — no per-provider
// branch — so a new MAIL_PROVIDERS entry contributes its own steps with no UI
// fork (AC4). The actual connection fields + Test connection + Save live in the
// existing ImapConnectForm / GraphConnectForm below this block; this component is
// the walkthrough only.

export function ProviderOnboarding({ provider }: { provider: MailProviderKind }) {
  const onboarding = PROVIDER_ONBOARDING[provider];

  return (
    <div className="space-y-3 rounded-sm border border-border-subtle bg-bg-deep p-3">
      <p className="text-xs text-ink-muted">{onboarding.summary}</p>

      {onboarding.mode === 'oauth' ? null : (
        <ol className="space-y-2">
          {onboarding.steps.map((step, i) => (
            <StepRow key={step.title} index={i + 1} step={step} />
          ))}
        </ol>
      )}

      {onboarding.imapPresets && onboarding.imapPresets.length > 0 ? (
        <div className="space-y-1.5">
          <p className="font-mono text-[11px] uppercase tracking-wider text-ink-dim">
            Per-provider app-password setup
          </p>
          {onboarding.imapPresets.map((preset) => (
            <PresetRow key={preset.provider} preset={preset} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StepRow({ index, step }: { index: number; step: OnboardingStep }) {
  return (
    <li className="flex gap-2">
      <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-border-subtle font-mono text-[10px] text-ink-dim">
        {index}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-sans text-xs font-medium text-ink">{step.title}</p>
        <p className="text-xs text-ink-muted">{step.body}</p>
        {step.href ? (
          <a
            href={step.href}
            target="_blank"
            rel="noreferrer"
            className="inline-block font-mono text-[11px] text-accent-orange hover:underline"
          >
            {step.href} ↗
          </a>
        ) : null}
        {step.produces && step.produces.length > 0 ? (
          <p className="font-mono text-[10px] text-ink-dim">→ fills: {step.produces.join(', ')}</p>
        ) : null}
      </div>
    </li>
  );
}

function PresetRow({ preset }: { preset: ImapPreset }) {
  const hostBits = [
    preset.imap_host ? `IMAP ${preset.imap_host}:${preset.imap_port ?? ''}` : null,
    preset.smtp_host ? `SMTP ${preset.smtp_host}:${preset.smtp_port ?? ''}` : null,
  ].filter((b): b is string => b !== null);

  return (
    <details className="rounded-sm border border-border-subtle bg-bg-panel px-2 py-1.5">
      <summary className="cursor-pointer font-mono text-[11px] text-ink-muted">
        {preset.provider}
      </summary>
      <div className="mt-1.5 space-y-1.5">
        {hostBits.length > 0 ? (
          <p className="font-mono text-[10px] text-ink-dim">{hostBits.join('  ·  ')}</p>
        ) : null}
        <ol className="space-y-1">
          {preset.steps.map((s, i) => (
            <li key={s} className="flex gap-2 text-xs text-ink-muted">
              <span className="font-mono text-[10px] text-ink-dim">{i + 1}.</span>
              <span className="min-w-0 flex-1">{s}</span>
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
