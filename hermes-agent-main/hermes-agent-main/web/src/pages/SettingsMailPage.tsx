import { useCallback, useEffect, useMemo, useState } from "react";
import { Mail } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { api } from "@/lib/api";
import type { MailAccount } from "@/lib/api";
import {
  type MailProviderKind,
  type OnboardingStep,
  PROVIDER_ONBOARDING,
} from "@/lib/mailOnboardingSteps";
import { ImapForm, MicrosoftForm } from "@/components/MailConnectForms";
import { usePageHeader } from "@/contexts/usePageHeader";

/**
 * Mail accounts (MBOX-468) — connect a Microsoft 365 (app-only Graph) or IMAP/
 * SMTP mailbox to Hermes. Unlike the Google/Shopify pages this is NOT an OAuth
 * redirect: the operator pastes credentials into an on-page form and the box
 * runs a live probe (``mode:'test'``) against the provider before persisting
 * (``mode:'connect'``). The walkthrough + presets are sourced ENTIRELY from
 * PROVIDER_ONBOARDING (lib/mailOnboardingSteps.ts, the single source of truth)
 * so a provider contributes its own steps with no UI fork.
 *
 * The credential forms (MicrosoftForm / ImapForm) live in
 * @/components/MailConnectForms so the first-run onboarding wizard (MBOX-471)
 * drives the IDENTICAL probe→persist flow — one source of truth, no duplicated
 * form. Secrets (client_secret / app_password) live ONLY in component state and
 * the POST body — never a query string, never localStorage, never the connected
 * list. The LOAD-BEARING invariant from the backend contract: a failed probe
 * returns 422 and NEVER persists; persist happens only on ``mode:'connect'``
 * after a green probe.
 */

type Banner = { kind: "success" | "error"; text: string };

const PROVIDER_ORDER: MailProviderKind[] = ["microsoft", "imap"];

const PROVIDER_LABEL: Record<MailProviderKind, string> = {
  microsoft: "Microsoft 365",
  imap: "IMAP / SMTP",
};

/** Short, human-readable connected date (falls back to the raw string). */
function formatConnectedAt(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ── Walkthrough renderers (ported from ProviderOnboarding.tsx, restyled to the
// hermes nous theme tokens: bg-bg-deep -> border/bg-muted, text-ink-muted ->
// text-text-secondary, text-accent-orange -> text-primary, etc.). ────────────

function StepRow({ index, step }: { index: number; step: OnboardingStep }) {
  return (
    <li className="flex gap-2">
      <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border font-mono text-[10px] text-text-tertiary">
        {index}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-xs font-medium text-foreground">{step.title}</p>
        <p className="text-xs text-text-secondary">{step.body}</p>
        {step.href ? (
          <a
            href={step.href}
            target="_blank"
            rel="noreferrer"
            className="inline-block break-all font-mono text-[11px] text-primary hover:underline"
          >
            {step.href} ↗
          </a>
        ) : null}
        {step.produces && step.produces.length > 0 ? (
          <p className="font-mono text-[10px] text-text-tertiary">
            → fills: {step.produces.join(", ")}
          </p>
        ) : null}
      </div>
    </li>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SettingsMailPage() {
  const { setTitle } = usePageHeader();

  useEffect(() => {
    setTitle("Mail accounts");
  }, [setTitle]);

  const [provider, setProvider] = useState<MailProviderKind>("microsoft");
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [cryptoConfigured, setCryptoConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listMailAccounts();
      setAccounts(res.accounts);
      setCryptoConfigured(res.crypto_configured);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load mail accounts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The shared form passes the connected email (MBOX-484); the settings page
  // just refreshes its list and ignores it.
  const onConnected = useCallback(() => {
    setBanner({ kind: "success", text: "Mailbox connected." });
    void refresh();
  }, [refresh]);

  const remove = useCallback(
    async (acct: MailAccount) => {
      if (
        !window.confirm(
          `Remove ${acct.email}? Hermes will lose access to this mailbox.`,
        )
      )
        return;
      setRemoving(acct.id);
      try {
        await api.removeMailAccount(acct.id);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to remove mailbox");
      } finally {
        setRemoving(null);
      }
    },
    [refresh],
  );

  const onboarding = PROVIDER_ONBOARDING[provider];
  const stepCount = useMemo(() => onboarding.steps.length, [onboarding]);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <CardDescription className="mb-4">
        Connect a Microsoft 365 mailbox (app-only Graph) or any IMAP/SMTP mailbox
        so Hermes can triage it. Credentials are tested live against the provider
        before they're saved, and the secret is encrypted at rest. For Gmail, use
        the Google accounts page instead.
      </CardDescription>

      {banner && (
        <div
          className={`mb-4 rounded border px-3 py-2 text-sm ${
            banner.kind === "success"
              ? "border-border bg-muted/20 text-text-secondary"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          }`}
        >
          {banner.text}
        </div>
      )}

      {error && (
        <div className="mb-4 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Spinner className="text-2xl text-primary" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Connect a mailbox</CardTitle>
              <CardDescription>
                Pick a provider, follow the steps, then test and connect.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {/* Provider picker */}
              <div className="flex flex-wrap gap-2">
                {PROVIDER_ORDER.map((p) => (
                  <Button
                    key={p}
                    size="sm"
                    outlined={provider !== p}
                    onClick={() => {
                      setProvider(p);
                      setBanner(null);
                    }}
                  >
                    {PROVIDER_LABEL[p]}
                  </Button>
                ))}
              </div>

              {/* Data-driven walkthrough */}
              <div className="space-y-3 rounded border border-border bg-muted/20 p-3">
                <p className="text-xs text-text-secondary">
                  {onboarding.summary}
                </p>
                {stepCount > 0 && (
                  <ol className="space-y-2">
                    {onboarding.steps.map((step, i) => (
                      <StepRow key={step.title} index={i + 1} step={step} />
                    ))}
                  </ol>
                )}
              </div>

              {/* Credential form (shared with the onboarding wizard) */}
              {provider === "microsoft" ? (
                <MicrosoftForm
                  cryptoConfigured={cryptoConfigured}
                  onConnected={onConnected}
                />
              ) : (
                <ImapForm
                  cryptoConfigured={cryptoConfigured}
                  onConnected={onConnected}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Connected mailboxes</CardTitle>
              <CardDescription>{accounts.length} connected.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {accounts.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  No mail accounts connected yet.
                </p>
              ) : (
                accounts.map((acct) => {
                  const connectedAt = formatConnectedAt(acct.connected_at);
                  return (
                    <div
                      key={acct.id}
                      className="flex items-center gap-3 rounded border border-border px-3 py-2"
                    >
                      <Mail className="h-4 w-4 shrink-0 text-text-tertiary" />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-bold">
                            {acct.display_label || acct.email}
                          </span>
                          <Badge tone="secondary">
                            {PROVIDER_LABEL[acct.provider]}
                          </Badge>
                        </div>
                        <span className="truncate text-xs text-text-tertiary">
                          {acct.email}
                          {acct.mailbox && acct.mailbox !== acct.email
                            ? ` · ${acct.mailbox}`
                            : ""}
                          {connectedAt ? ` · connected ${connectedAt}` : ""}
                        </span>
                      </div>
                      <Button
                        outlined
                        destructive
                        size="sm"
                        disabled={removing === acct.id}
                        prefix={removing === acct.id ? <Spinner /> : undefined}
                        onClick={() => void remove(acct)}
                      >
                        Remove
                      </Button>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
