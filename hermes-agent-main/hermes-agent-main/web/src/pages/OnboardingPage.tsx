import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@nous-research/ui/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { api } from "@/lib/api";
import type { OnboardingState, OnboardingStep } from "@/lib/api";
import {
  isSameStageHop,
  nextSlug,
  prevSlug,
  stepForSlug,
} from "@/lib/onboardingWizard";
import { ImapForm, MicrosoftForm } from "@/components/MailConnectForms";
import { usePageHeader } from "@/contexts/usePageHeader";

/**
 * First-run onboarding wizard (MBOX-471 + MBOX-484), ported from the deprecated
 * mailbox dashboard's ``app/onboarding/*`` (welcome / network-check /
 * email-connect / password / profile / complete + StepShell/StepNav/
 * StageIndicator shell).
 *
 * Hermes is a single-page SPA, not Next.js file-based routing, so the six
 * mailbox route-pages collapse into one route (``/onboarding``) with internal
 * step state. The step descriptors + persisted stage + active mailbox come from
 * ``GET /api/onboarding/state`` (the backend is the source of truth); Next
 * advances the persisted stage via ``POST /api/onboarding/advance`` UNLESS the
 * hop is a same-stage UX sub-step (welcome→password, profile→network-check),
 * which navigates client-side with no API call — identical to the mailbox
 * StepNav.
 *
 * MBOX-484: the email-connect step WRAPS the shared MailConnectForms
 * (MBOX-468). On a successful connect it records the active/default mailbox
 * (``POST /api/onboarding/active-mailbox``) and advances the stage, then moves
 * the wizard to the next step.
 *
 * PORT ADAPTATIONS (see PR body):
 *   - password step: mailbox provisioned Caddy basic_auth + an admin password.
 *     Hermes has its own ``dashboard_auth`` gate and the operator already
 *     reached this authenticated dashboard, so the step is informational (no
 *     admin-create route is ported). Same persisted stage as welcome.
 *   - network-check / profile / welcome / complete: informational steps (the
 *     mailbox versions were TODO placeholders too); kept so the staged shape and
 *     progress indicator match, with hermes-appropriate copy.
 */

// ── Stage indicator (ported from StageIndicator.tsx, nous tokens) ────────────

function StageIndicator({
  steps,
  currentSlug,
}: {
  steps: OnboardingStep[];
  currentSlug: string;
}) {
  const currentIndex = steps.findIndex((s) => s.slug === currentSlug);

  return (
    <nav aria-label="Onboarding progress" className="mb-6 w-full">
      <ol className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        {steps.map((step, i) => {
          const status: "completed" | "active" | "future" =
            i < currentIndex ? "completed" : i === currentIndex ? "active" : "future";
          return (
            <li
              key={step.slug}
              className="flex flex-1 items-center gap-2"
              aria-current={status === "active" ? "step" : undefined}
            >
              <span
                className={[
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                  status === "active"
                    ? "border-primary bg-primary/10 text-primary ring-2 ring-primary/40"
                    : status === "completed"
                      ? "border-border bg-muted/40 text-text-secondary"
                      : "border-border bg-transparent text-text-tertiary",
                ].join(" ")}
              >
                {status === "completed" ? "✓" : i + 1}
              </span>
              <span
                className={[
                  "truncate text-xs sm:text-sm",
                  status === "active"
                    ? "font-semibold text-foreground"
                    : status === "completed"
                      ? "text-text-secondary"
                      : "text-text-tertiary",
                ].join(" ")}
              >
                {step.title}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ── Step bodies ───────────────────────────────────────────────────────────────
// The informational steps mirror the mailbox placeholders' intent, restated for
// hermes. The email-connect step wraps the shared MailConnectForms.

function InfoList({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-text-secondary">
      {items.map((it) => (
        <li key={it}>{it}</li>
      ))}
    </ul>
  );
}

function WelcomeBody() {
  return (
    <InfoList
      items={[
        "Walk through connecting a mailbox and getting Hermes triaging email.",
        "Confirm the box is online and this dashboard is reachable.",
        "You stay in the loop on every send while you get comfortable.",
      ]}
    />
  );
}

function PasswordBody() {
  return (
    <div className="space-y-3">
      <InfoList
        items={[
          "This dashboard is already gated by the Hermes session — you authenticated to reach it.",
          "There's no separate admin password to set here on Hermes.",
          "Manage access and keys later under Settings.",
        ]}
      />
      <p className="text-xs text-text-tertiary">
        (The mailbox appliance set a Caddy basic-auth password at this step;
        Hermes uses its own dashboard auth, so this step is informational.)
      </p>
    </div>
  );
}

function ProfileBody() {
  return (
    <div className="space-y-3">
      <InfoList
        items={[
          "Hermes picks up your name, brand, and signoff so drafts sound like you.",
          "Tune these any time under Settings → Profiles.",
        ]}
      />
      <p className="text-xs text-text-tertiary">
        Set up your operator profile under Settings → Profiles after onboarding.
      </p>
    </div>
  );
}

function NetworkCheckBody() {
  return (
    <InfoList
      items={[
        "Hermes reaches the mail providers (Microsoft Graph / IMAP / SMTP) directly when you connect.",
        "The connection test on the next step verifies reachability live before anything is saved.",
        "If a test fails, the per-leg detail tells you exactly which hop to fix.",
      ]}
    />
  );
}

function CompleteBody({ activeMailbox }: { activeMailbox: string | null }) {
  const navigate = useNavigate();
  return (
    <div className="space-y-4">
      <InfoList
        items={[
          activeMailbox
            ? `Hermes is connected to ${activeMailbox} and ready to triage.`
            : "Hermes is set up.",
          "Head to Incoming Messages to review drafts as they arrive.",
        ]}
      />
      <Button onClick={() => navigate("/inbox")}>Go to Incoming Messages</Button>
    </div>
  );
}

/** The email-connect step (MBOX-484): wraps the shared connect forms and, on a
 * successful connect, records the active mailbox then advances the stage and
 * moves the wizard forward. */
function EmailConnectBody({
  cryptoConfigured,
  onConnected,
}: {
  cryptoConfigured: boolean;
  onConnected: (email: string) => void;
}) {
  const [provider, setProvider] = useState<"microsoft" | "imap">("microsoft");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          outlined={provider !== "microsoft"}
          onClick={() => setProvider("microsoft")}
        >
          Microsoft 365
        </Button>
        <Button
          size="sm"
          outlined={provider !== "imap"}
          onClick={() => setProvider("imap")}
        >
          IMAP / SMTP
        </Button>
      </div>
      <p className="text-xs text-text-tertiary">
        For Gmail, finish onboarding and connect it under Settings → Google
        accounts.
      </p>
      {provider === "microsoft" ? (
        <MicrosoftForm
          cryptoConfigured={cryptoConfigured}
          onConnected={onConnected}
        />
      ) : (
        <ImapForm cryptoConfigured={cryptoConfigured} onConnected={onConnected} />
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const { setTitle } = usePageHeader();
  const navigate = useNavigate();

  useEffect(() => {
    setTitle("Setup");
  }, [setTitle]);

  const [state, setState] = useState<OnboardingState | null>(null);
  const [cryptoConfigured, setCryptoConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The slug the operator is currently viewing. Initialised from the persisted
  // stage on first load (the first step whose stage matches), then driven by
  // Back/Next.
  const [slug, setSlug] = useState<string>("welcome");

  const [busy, setBusy] = useState(false);
  const [navError, setNavError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [s, mail] = await Promise.all([
        api.getOnboardingState(),
        api.listMailAccounts(),
      ]);
      setState(s);
      setCryptoConfigured(mail.crypto_configured);
      // Land on the first step matching the persisted stage so a returning
      // operator resumes where they left off.
      const resume =
        s.steps.find((st) => st.stage === s.stage)?.slug ?? s.steps[0]?.slug;
      if (resume) setSlug(resume);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load onboarding");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const steps = useMemo(() => state?.steps ?? [], [state]);
  const step = useMemo(() => stepForSlug(steps, slug), [steps, slug]);
  const next = useMemo(() => nextSlug(steps, slug), [steps, slug]);
  const prev = useMemo(() => prevSlug(steps, slug), [steps, slug]);
  const isLast = next === null;

  /** Advance the persisted stage for a stage-changing hop, then move the wizard
   * to ``targetSlug``. Same-stage hops skip the API call (client-side nav). */
  const advanceTo = useCallback(
    async (targetSlug: string) => {
      if (!state) return;
      setNavError(null);

      const from = stepForSlug(steps, slug)?.stage;
      const to = stepForSlug(steps, targetSlug)?.stage;

      if (from && to && from !== to) {
        setBusy(true);
        try {
          const { status, body } = await api.advanceOnboarding({
            from_stage: from,
            to_stage: to,
          });
          if (status !== 200) {
            const msg =
              "error" in body ? body.error : `unexpected status ${status}`;
            setNavError(msg);
            return;
          }
          // Reflect the new persisted stage locally.
          setState({ ...state, stage: "stage" in body ? body.stage : to });
        } catch (e) {
          setNavError(e instanceof Error ? e.message : "network error");
          return;
        } finally {
          setBusy(false);
        }
      }
      setSlug(targetSlug);
    },
    [state, steps, slug],
  );

  const handleNext = useCallback(async () => {
    if (isLast) {
      navigate("/inbox");
      return;
    }
    if (next) await advanceTo(next);
  }, [isLast, next, advanceTo, navigate]);

  const handleBack = useCallback(() => {
    if (prev) setSlug(prev);
  }, [prev]);

  // MBOX-484: on a successful mail connect, record the active mailbox + advance
  // the stage, then move the wizard to the next step.
  const handleConnected = useCallback(
    async (email: string) => {
      if (!state) return;
      setNavError(null);
      setBusy(true);
      try {
        await api.recordActiveMailbox(email);
        // Refresh so the active mailbox + (possibly already-advanced) stage are
        // reflected; then advance to the next step.
        const refreshed = await api.getOnboardingState();
        setState(refreshed);
        const target = nextSlug(refreshed.steps, slug);
        if (target) {
          const from = stepForSlug(refreshed.steps, slug)?.stage;
          const to = stepForSlug(refreshed.steps, target)?.stage;
          if (from && to && from !== to && from === refreshed.stage) {
            const { status, body } = await api.advanceOnboarding({
              from_stage: from,
              to_stage: to,
            });
            if (status === 200) {
              setState({
                ...refreshed,
                active_mailbox: email,
                stage: "stage" in body ? body.stage : to,
              });
            }
          }
          setSlug(target);
        }
      } catch (e) {
        setNavError(e instanceof Error ? e.message : "Failed to advance setup");
      } finally {
        setBusy(false);
      }
    },
    [state, slug],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner className="text-2xl text-primary" />
      </div>
    );
  }

  if (loadError || !state || !step) {
    return (
      <div className="mx-auto w-full max-w-2xl">
        <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {loadError ?? "Onboarding is unavailable."}
        </div>
        <Button className="mt-3" outlined onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <StageIndicator steps={steps} currentSlug={slug} />

      <Card>
        <CardHeader>
          <CardTitle>{step.title}</CardTitle>
          <p className="mt-1 text-sm text-text-secondary">{step.intent}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {slug === "welcome" && <WelcomeBody />}
          {slug === "password" && <PasswordBody />}
          {slug === "profile" && <ProfileBody />}
          {slug === "network-check" && <NetworkCheckBody />}
          {slug === "email-connect" && (
            <EmailConnectBody
              cryptoConfigured={cryptoConfigured}
              onConnected={handleConnected}
            />
          )}
          {slug === "complete" && (
            <CompleteBody activeMailbox={state.active_mailbox} />
          )}

          {navError && (
            <div
              role="alert"
              className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <span className="font-mono text-xs">{navError}</span>
            </div>
          )}

          {/* StepNav (ported). The email-connect step is advanced by a
              successful connect (handleConnected), so it shows no Next — the
              operator can still go Back. */}
          <div className="mt-2 flex items-center justify-between">
            {step.allows_back && prev ? (
              <Button outlined disabled={busy} onClick={handleBack}>
                Back
              </Button>
            ) : (
              <span />
            )}
            {slug === "email-connect" ? (
              <span className="text-xs text-text-tertiary">
                Connecting a mailbox advances setup automatically.
              </span>
            ) : (
              <Button
                disabled={busy}
                prefix={busy ? <Spinner /> : undefined}
                onClick={() => void handleNext()}
              >
                {isLast ? "Finish" : "Next"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <p className="mt-4 text-center text-xs text-text-tertiary">
        {isSameStageHop(steps, slug)
          ? "This step shares its stage with the next — Next won't change your saved progress."
          : ""}
      </p>
    </div>
  );
}
