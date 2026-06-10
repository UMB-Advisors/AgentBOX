import { useCallback, useEffect, useMemo, useState } from "react";
import { Mail, Plus } from "lucide-react";
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
import type {
  GraphConnectBody,
  ImapConnectBody,
  MailAccount,
  MailConnectResponse,
} from "@/lib/api";
import {
  DEFAULT_IMAP_PORT,
  DEFAULT_SMTP_PORT,
  type ImapPreset,
  type MailProviderKind,
  type OnboardingStep,
  PROVIDER_ONBOARDING,
} from "@/lib/mailOnboardingSteps";
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
 * Secrets (client_secret / app_password) live ONLY in component state and the
 * POST body — never a query string, never localStorage, never the connected
 * list. The LOAD-BEARING invariant from the backend contract: a failed probe
 * returns 422 and NEVER persists; persist happens only on ``mode:'connect'``
 * after a green probe. The UI mirrors that — Connect is disabled until Test
 * passes (and re-disabled whenever an input changes).
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

// ── Response-shape narrowing (the two 422 shapes the FE must distinguish) ────
// Rule from the contract: ``ok:false`` present => probe shape; ``detail`` array
// present => pydantic validation shape.

function isProbeFail(
  b: MailConnectResponse,
): b is Extract<MailConnectResponse, { ok: false }> & {
  token?: { ok: boolean; detail: string };
  imap?: { ok: boolean; detail: string };
} {
  return "ok" in b && b.ok === false && ("token" in b || "imap" in b);
}

function isValidationError(
  b: MailConnectResponse,
): b is Extract<MailConnectResponse, { detail: unknown[] }> {
  return "detail" in b && Array.isArray((b as { detail: unknown }).detail);
}

function isTestOk(
  b: MailConnectResponse,
): b is Extract<MailConnectResponse, { tested: true }> {
  return "ok" in b && b.ok === true && "tested" in b;
}

function isConnectOk(
  b: MailConnectResponse,
): b is Extract<MailConnectResponse, { account_id: string }> {
  return "ok" in b && b.ok === true && "account_id" in b;
}

/** First pydantic validation message, for the body-validation 422 shape. */
function firstValidationMessage(b: MailConnectResponse): string {
  if (isValidationError(b) && b.detail.length > 0) {
    return b.detail[0]?.msg ?? "Invalid input.";
  }
  return "Invalid input.";
}

// ── Walkthrough renderers (ported from ProviderOnboarding.tsx, restyled to the
// hermes nous theme tokens: bg-bg-deep -> border/bg-muted, text-ink-muted ->
// text-text-secondary, text-accent-orange -> text-primary, etc.) ─────────────

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

function PresetRow({
  preset,
  onApply,
}: {
  preset: ImapPreset;
  onApply: (preset: ImapPreset) => void;
}) {
  const hostBits = [
    preset.imap_host ? `IMAP ${preset.imap_host}:${preset.imap_port ?? ""}` : null,
    preset.smtp_host ? `SMTP ${preset.smtp_host}:${preset.smtp_port ?? ""}` : null,
  ].filter((b): b is string => b !== null);

  return (
    <details className="rounded border border-border bg-muted/20 px-2 py-1.5">
      <summary className="flex cursor-pointer items-center justify-between gap-2 font-mono text-[11px] text-text-secondary">
        <span>{preset.provider}</span>
        <Button
          size="sm"
          outlined
          onClick={(e) => {
            e.preventDefault();
            onApply(preset);
          }}
        >
          Use these settings
        </Button>
      </summary>
      <div className="mt-1.5 space-y-1.5">
        {hostBits.length > 0 ? (
          <p className="font-mono text-[10px] text-text-tertiary">
            {hostBits.join("  ·  ")}
          </p>
        ) : null}
        <ol className="space-y-1">
          {preset.steps.map((s, i) => (
            <li key={s} className="flex gap-2 text-xs text-text-secondary">
              <span className="font-mono text-[10px] text-text-tertiary">
                {i + 1}.
              </span>
              <span className="min-w-0 flex-1">{s}</span>
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}

// Shared input class so every raw <input>/<select> matches the Shopify/Google
// pages (no Input/Select component exists in @nous-research/ui).
const INPUT_CLASS =
  "mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary";

// ── Microsoft 365 form ───────────────────────────────────────────────────────

function MicrosoftForm({
  cryptoConfigured,
  onConnected,
}: {
  cryptoConfigured: boolean;
  onConnected: () => void;
}) {
  const [email, setEmail] = useState("");
  const [displayLabel, setDisplayLabel] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [mailbox, setMailbox] = useState("");

  // Two-step probe→persist state. ``tested`` gates the Connect button; any
  // input edit clears it so a connect can never ride a stale green probe.
  const [tested, setTested] = useState(false);
  const [busy, setBusy] = useState<"test" | "connect" | null>(null);
  const [result, setResult] = useState<MailConnectResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const required =
    email.trim() !== "" &&
    tenantId.trim() !== "" &&
    clientId.trim() !== "" &&
    clientSecret.trim() !== "";

  const buildBody = useCallback(
    (mode: "test" | "connect"): GraphConnectBody => ({
      mode,
      email: email.trim().toLowerCase(),
      display_label: displayLabel.trim() || undefined,
      tenant_id: tenantId.trim(),
      client_id: clientId.trim(),
      client_secret: clientSecret,
      mailbox: mailbox.trim() || undefined,
    }),
    [email, displayLabel, tenantId, clientId, clientSecret, mailbox],
  );

  // Any field change invalidates a prior green probe.
  const invalidate = () => {
    setTested(false);
    setResult(null);
    setError(null);
  };

  const run = useCallback(
    async (mode: "test" | "connect") => {
      if (!required) return;
      setBusy(mode);
      setError(null);
      try {
        const { status, body } = await api.connectMicrosoft(buildBody(mode));
        setResult(body);
        if (status === 200 && isTestOk(body)) {
          setTested(true);
        } else if (status === 200 && isConnectOk(body)) {
          onConnected();
        } else {
          // 422 (probe-fail or validation) — re-gate Connect.
          setTested(false);
        }
      } catch (e) {
        // 500 / network — generic surface; never persisted.
        setError(e instanceof Error ? e.message : "Connection failed.");
        setTested(false);
      } finally {
        setBusy(null);
      }
    },
    [required, buildBody, onConnected],
  );

  return (
    <div className="flex flex-col gap-3">
      <label className="text-xs text-text-secondary">
        Mailbox email
        <input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            invalidate();
          }}
          placeholder="ops@your-tenant.com"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className={INPUT_CLASS}
        />
      </label>

      <label className="text-xs text-text-secondary">
        Display label (optional)
        <input
          type="text"
          value={displayLabel}
          onChange={(e) => {
            setDisplayLabel(e.target.value);
            invalidate();
          }}
          placeholder="Support inbox"
          className={INPUT_CLASS}
        />
      </label>

      <label className="text-xs text-text-secondary">
        Directory (tenant) ID
        <input
          type="text"
          value={tenantId}
          onChange={(e) => {
            setTenantId(e.target.value);
            invalidate();
          }}
          placeholder="00000000-0000-0000-0000-000000000000"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className={INPUT_CLASS}
        />
      </label>

      <label className="text-xs text-text-secondary">
        Application (client) ID
        <input
          type="text"
          value={clientId}
          onChange={(e) => {
            setClientId(e.target.value);
            invalidate();
          }}
          placeholder="00000000-0000-0000-0000-000000000000"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className={INPUT_CLASS}
        />
      </label>

      <label className="text-xs text-text-secondary">
        Client secret (Value)
        <input
          type="password"
          value={clientSecret}
          onChange={(e) => {
            setClientSecret(e.target.value);
            invalidate();
          }}
          placeholder="Secret Value from Certificates & secrets"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className={INPUT_CLASS}
        />
      </label>

      <label className="text-xs text-text-secondary">
        Mailbox / UPN to read (optional — defaults to the email above)
        <input
          type="email"
          value={mailbox}
          onChange={(e) => {
            setMailbox(e.target.value);
            invalidate();
          }}
          placeholder="ops@your-tenant.com"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className={INPUT_CLASS}
        />
      </label>

      <ProbeOutcome result={result} error={error} />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          outlined
          onClick={() => void run("test")}
          disabled={!required || busy !== null}
          prefix={busy === "test" ? <Spinner /> : undefined}
        >
          Test connection
        </Button>
        <Button
          onClick={() => void run("connect")}
          disabled={!required || !tested || !cryptoConfigured || busy !== null}
          prefix={busy === "connect" ? <Spinner /> : <Plus className="h-3.5 w-3.5" />}
          title={
            !cryptoConfigured
              ? "At-rest secret encryption isn't configured on the box"
              : !tested
                ? "Run a passing Test connection first"
                : undefined
          }
        >
          Connect
        </Button>
      </div>
      {!cryptoConfigured && (
        <p className="text-xs text-destructive">
          At-rest secret encryption isn't configured on this box, so connecting
          is disabled. The operator must set the mail secret key before a
          mailbox can be persisted.
        </p>
      )}
    </div>
  );
}

// ── IMAP / SMTP form ─────────────────────────────────────────────────────────

function ImapForm({
  cryptoConfigured,
  onConnected,
}: {
  cryptoConfigured: boolean;
  onConnected: () => void;
}) {
  const [email, setEmail] = useState("");
  const [displayLabel, setDisplayLabel] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState(String(DEFAULT_IMAP_PORT));
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(String(DEFAULT_SMTP_PORT));
  const [username, setUsername] = useState("");
  const [appPassword, setAppPassword] = useState("");

  const [tested, setTested] = useState(false);
  const [busy, setBusy] = useState<"test" | "connect" | null>(null);
  const [result, setResult] = useState<MailConnectResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const imapPortNum = Number.parseInt(imapPort, 10);
  const smtpPortNum = Number.parseInt(smtpPort, 10);
  const portsValid =
    Number.isInteger(imapPortNum) &&
    imapPortNum >= 1 &&
    imapPortNum <= 65535 &&
    Number.isInteger(smtpPortNum) &&
    smtpPortNum >= 1 &&
    smtpPortNum <= 65535;

  const required =
    email.trim() !== "" &&
    imapHost.trim() !== "" &&
    smtpHost.trim() !== "" &&
    username.trim() !== "" &&
    appPassword !== "" &&
    portsValid;

  const buildBody = useCallback(
    (mode: "test" | "connect"): ImapConnectBody => ({
      mode,
      email: email.trim().toLowerCase(),
      display_label: displayLabel.trim() || undefined,
      imap_host: imapHost.trim(),
      imap_port: imapPortNum,
      smtp_host: smtpHost.trim(),
      smtp_port: smtpPortNum,
      username: username.trim(),
      app_password: appPassword,
    }),
    [
      email,
      displayLabel,
      imapHost,
      imapPortNum,
      smtpHost,
      smtpPortNum,
      username,
      appPassword,
    ],
  );

  const invalidate = () => {
    setTested(false);
    setResult(null);
    setError(null);
  };

  const applyPreset = useCallback((preset: ImapPreset) => {
    if (preset.imap_host) setImapHost(preset.imap_host);
    if (preset.imap_port) setImapPort(String(preset.imap_port));
    if (preset.smtp_host) setSmtpHost(preset.smtp_host);
    if (preset.smtp_port) setSmtpPort(String(preset.smtp_port));
    setTested(false);
    setResult(null);
    setError(null);
  }, []);

  const run = useCallback(
    async (mode: "test" | "connect") => {
      if (!required) return;
      setBusy(mode);
      setError(null);
      try {
        const { status, body } = await api.connectImap(buildBody(mode));
        setResult(body);
        if (status === 200 && isTestOk(body)) {
          setTested(true);
        } else if (status === 200 && isConnectOk(body)) {
          onConnected();
        } else {
          setTested(false);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Connection failed.");
        setTested(false);
      } finally {
        setBusy(null);
      }
    },
    [required, buildBody, onConnected],
  );

  const presets = PROVIDER_ONBOARDING.imap.imapPresets ?? [];

  return (
    <div className="flex flex-col gap-3">
      {presets.length > 0 && (
        <div className="space-y-1.5">
          <p className="font-mono text-[11px] uppercase tracking-wider text-text-tertiary">
            Per-provider app-password setup
          </p>
          {presets.map((preset) => (
            <PresetRow
              key={preset.provider}
              preset={preset}
              onApply={applyPreset}
            />
          ))}
        </div>
      )}

      <label className="text-xs text-text-secondary">
        Mailbox email
        <input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            invalidate();
          }}
          placeholder="you@example.com"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className={INPUT_CLASS}
        />
      </label>

      <label className="text-xs text-text-secondary">
        Display label (optional)
        <input
          type="text"
          value={displayLabel}
          onChange={(e) => {
            setDisplayLabel(e.target.value);
            invalidate();
          }}
          placeholder="Personal inbox"
          className={INPUT_CLASS}
        />
      </label>

      <div className="flex gap-2">
        <label className="flex-1 text-xs text-text-secondary">
          IMAP host
          <input
            type="text"
            value={imapHost}
            onChange={(e) => {
              setImapHost(e.target.value);
              invalidate();
            }}
            placeholder="imap.example.com"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className={INPUT_CLASS}
          />
        </label>
        <label className="w-24 text-xs text-text-secondary">
          IMAP port
          <input
            type="number"
            value={imapPort}
            onChange={(e) => {
              setImapPort(e.target.value);
              invalidate();
            }}
            min={1}
            max={65535}
            className={INPUT_CLASS}
          />
        </label>
      </div>

      <div className="flex gap-2">
        <label className="flex-1 text-xs text-text-secondary">
          SMTP host
          <input
            type="text"
            value={smtpHost}
            onChange={(e) => {
              setSmtpHost(e.target.value);
              invalidate();
            }}
            placeholder="smtp.example.com"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className={INPUT_CLASS}
          />
        </label>
        <label className="w-24 text-xs text-text-secondary">
          SMTP port
          <input
            type="number"
            value={smtpPort}
            onChange={(e) => {
              setSmtpPort(e.target.value);
              invalidate();
            }}
            min={1}
            max={65535}
            className={INPUT_CLASS}
          />
        </label>
      </div>
      {!portsValid && (imapPort !== "" || smtpPort !== "") && (
        <p className="text-xs text-destructive">
          Ports must be whole numbers between 1 and 65535.
        </p>
      )}

      <label className="text-xs text-text-secondary">
        Username
        <input
          type="text"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            invalidate();
          }}
          placeholder="usually the full email address"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className={INPUT_CLASS}
        />
      </label>

      <label className="text-xs text-text-secondary">
        App password
        <input
          type="password"
          value={appPassword}
          onChange={(e) => {
            setAppPassword(e.target.value);
            invalidate();
          }}
          placeholder="provider app-specific password"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className={INPUT_CLASS}
        />
      </label>

      <ProbeOutcome result={result} error={error} />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          outlined
          onClick={() => void run("test")}
          disabled={!required || busy !== null}
          prefix={busy === "test" ? <Spinner /> : undefined}
        >
          Test connection
        </Button>
        <Button
          onClick={() => void run("connect")}
          disabled={!required || !tested || !cryptoConfigured || busy !== null}
          prefix={busy === "connect" ? <Spinner /> : <Plus className="h-3.5 w-3.5" />}
          title={
            !cryptoConfigured
              ? "At-rest secret encryption isn't configured on the box"
              : !tested
                ? "Run a passing Test connection first"
                : undefined
          }
        >
          Connect
        </Button>
      </div>
      {!cryptoConfigured && (
        <p className="text-xs text-destructive">
          At-rest secret encryption isn't configured on this box, so connecting
          is disabled. The operator must set the mail secret key before a
          mailbox can be persisted.
        </p>
      )}
    </div>
  );
}

/** Renders the probe outcome: green test, per-leg probe-fail detail, first
 * validation message, or a generic 500/network error. */
function ProbeOutcome({
  result,
  error,
}: {
  result: MailConnectResponse | null;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {error}
      </div>
    );
  }
  if (!result) return null;

  if (isTestOk(result)) {
    return (
      <div className="rounded border border-border bg-muted/20 px-3 py-2 text-xs text-text-secondary">
        Connection test passed. Click Connect to save this mailbox.
      </div>
    );
  }

  if (isConnectOk(result)) {
    // Parent unmounts/refreshes on connect-ok; this is just a safety net.
    return null;
  }

  if (isProbeFail(result)) {
    const legs: Array<{ label: string; ok: boolean; detail: string }> = [];
    if ("token" in result && result.token) {
      legs.push({ label: "Token", ...result.token });
    }
    if ("mailbox" in result && result.mailbox) {
      legs.push({ label: "Mailbox", ...result.mailbox });
    }
    if ("imap" in result && result.imap) {
      legs.push({ label: "IMAP", ...result.imap });
    }
    if ("smtp" in result && result.smtp) {
      legs.push({ label: "SMTP", ...result.smtp });
    }
    return (
      <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <p className="font-medium">Connection test failed.</p>
        <ul className="mt-1 space-y-0.5">
          {legs.map((leg) => (
            <li key={leg.label} className="flex gap-1.5">
              <span className="font-mono">
                {leg.ok ? "✓" : "✕"} {leg.label}:
              </span>
              <span className="min-w-0 flex-1 break-words">{leg.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (isValidationError(result)) {
    return (
      <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {firstValidationMessage(result)}
      </div>
    );
  }

  return null;
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

              {/* Credential form */}
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
