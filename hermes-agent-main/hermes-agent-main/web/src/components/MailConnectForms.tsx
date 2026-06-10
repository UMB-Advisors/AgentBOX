import { useCallback, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { api } from "@/lib/api";
import type {
  GraphConnectBody,
  ImapConnectBody,
  MailConnectResponse,
} from "@/lib/api";
import {
  DEFAULT_IMAP_PORT,
  DEFAULT_SMTP_PORT,
  type ImapPreset,
  PROVIDER_ONBOARDING,
} from "@/lib/mailOnboardingSteps";

/**
 * Shared Microsoft 365 + IMAP connect forms (MBOX-468 logic, extracted in
 * MBOX-471 so BOTH the standalone Settings → Mail accounts page AND the
 * first-run onboarding wizard's email-connect step drive the SAME probe→persist
 * flow — one source of truth, no duplicated form. The walkthrough/preset data
 * still comes entirely from PROVIDER_ONBOARDING (lib/mailOnboardingSteps.ts).
 *
 * The two-step state machine is unchanged from the original SettingsMailPage:
 * "Test connection" (``mode:'test'``) renders per-leg detail and gates an
 * enabled "Connect" (``mode:'connect'``); any field edit re-disables Connect so
 * a connect can never ride a stale green probe. Secrets (client_secret /
 * app_password) live ONLY in component state + the POST body — never a query
 * string, never localStorage, never the connected list.
 *
 * MBOX-484: ``onConnected`` now receives the connected mailbox email so the
 * wizard can record the active mailbox + advance the onboarding stage. The
 * Settings page ignores the argument (it just refreshes its list), so this is
 * backward-compatible.
 */

/** Shared input class so every raw <input>/<select> matches the Shopify/Google
 * pages (no Input/Select component exists in @nous-research/ui). */
const INPUT_CLASS =
  "mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary";

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

// ── Microsoft 365 form ───────────────────────────────────────────────────────

export function MicrosoftForm({
  cryptoConfigured,
  onConnected,
  disabled = false,
}: {
  cryptoConfigured: boolean;
  /** Receives the connected mailbox email (MBOX-484). Settings ignores it. */
  onConnected: (email: string) => void;
  /** External in-flight guard (MBOX-485). The onboarding wizard passes its
   * post-connect stage-advance busy state so Connect can't be re-fired during
   * the advance window (double-submit). Optional; Settings omits it. */
  disabled?: boolean;
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
          onConnected(email.trim().toLowerCase());
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
    [required, buildBody, onConnected, email],
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
          disabled={
            !required || !tested || !cryptoConfigured || busy !== null || disabled
          }
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

export function ImapForm({
  cryptoConfigured,
  onConnected,
  disabled = false,
}: {
  cryptoConfigured: boolean;
  /** Receives the connected mailbox email (MBOX-484). Settings ignores it. */
  onConnected: (email: string) => void;
  /** External in-flight guard (MBOX-485). The onboarding wizard passes its
   * post-connect stage-advance busy state so Connect can't be re-fired during
   * the advance window (double-submit). Optional; Settings omits it. */
  disabled?: boolean;
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
          onConnected(email.trim().toLowerCase());
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
    [required, buildBody, onConnected, email],
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
          disabled={
            !required || !tested || !cryptoConfigured || busy !== null || disabled
          }
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
