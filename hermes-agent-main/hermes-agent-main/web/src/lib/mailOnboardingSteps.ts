// web/src/lib/mailOnboardingSteps.ts
//
// MBOX-468 — provider-aware mail-account onboarding CONTENT, ported VERBATIM
// from the retired mailbox Next dashboard (dashboard/lib/mail/onboarding-steps.ts,
// MBOX-465) into hermes/web. This module is the SINGLE SOURCE OF TRUTH for the
// inline walkthrough the operator follows on /settings/mail (Azure
// app-registration steps, IMAP/SMTP app-password recipes, host/port defaults)
// so the UI renders steps from DATA, never bespoke per-provider JSX.
//
// Difference from the source: the Gmail ``mode:'oauth'`` entry is DROPPED here —
// Gmail is already covered by the existing /api/google OAuth flow on
// /settings/google. Only the two credential-bearing providers (Microsoft 365,
// IMAP) live in this Hermes port, and ``MailProviderKind`` is narrowed to that
// pair. ``connectPath`` values match Implementer A's session-gated routes.
//
// DATA-ONLY: no DB, no fetch, no React. Field hints (``produces``) surface only
// snake_case names that match the connect-schema bodies (tenant_id,
// client_secret, app_password ...) so the UI can map a step to the input it
// populates.

// The two credential-bearing mail providers Hermes onboards here. Gmail (OAuth)
// is intentionally excluded — it ships through the /settings/google flow.
export type MailProviderKind = "microsoft" | "imap";

// 'credentials' = operator pastes connection params + an app secret/password and
// runs the Test-connection probe (microsoft, imap).
export type OnboardingMode = "credentials";

export interface OnboardingStep {
  title: string;
  body: string;
  // External link the step references (Azure portal, provider app-password page).
  href?: string;
  // connect-schema field names this step yields (snake_case), e.g.
  // ['tenant_id', 'client_id'] | ['client_secret'] | ['app_password']. Lets the
  // UI tie a step to the input it fills. Omitted for purely informational steps.
  produces?: string[];
}

export interface ImapPreset {
  // Human label for the picker: 'Gmail' | 'Fastmail' | 'Zoho' | 'Generic ...'.
  provider: string;
  imap_host?: string;
  imap_port?: number;
  smtp_host?: string;
  smtp_port?: number;
  // Ordered app-password recipe for this provider.
  steps: string[];
}

export interface ProviderOnboarding {
  label: string;
  summary: string;
  mode: OnboardingMode;
  // '/api/accounts/microsoft' | '/api/accounts/imap'.
  connectPath: string;
  // Ordered inline walkthrough.
  steps: OnboardingStep[];
  // IMAP only — per-provider host/port + app-password presets for the picker.
  imapPresets?: ImapPreset[];
}

// IMAP/SMTP defaults kept here (not in JSX) so a host/port change is single-edit.
const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_PORT = 587;

// The single Graph application permission the app-only probe requires. Surfaced
// verbatim so the step copy stays aligned with the probe's 403 failure detail.
// One scope change here, not scattered across step strings.
const GRAPH_PERMISSION = "Mail.ReadWrite";

const IMAP_ONBOARDING: ProviderOnboarding = {
  label: "IMAP / SMTP",
  summary:
    "Connect any mailbox that speaks IMAP (read) and SMTP (send) — Fastmail, Zoho, cPanel/custom hosting, or Gmail/Workspace via an app password. Pick your provider for the host/port and app-password recipe, then run Test connection before saving.",
  mode: "credentials",
  connectPath: "/api/accounts/imap",
  steps: [
    {
      title: "Choose your mail host",
      body: "Pick the closest preset below to prefill the IMAP and SMTP host/port. For anything not listed, choose Generic and copy the IMAP/SMTP server settings from your hosting control panel or your provider help docs.",
    },
    {
      title: "Create an app password",
      body: "Most providers require an app-specific password (not your normal login password) for IMAP/SMTP, especially with two-factor authentication enabled. Follow the per-provider recipe below to generate one, then paste it into the App password field.",
      produces: ["app_password"],
    },
    {
      title: "Confirm the connection settings",
      body: `Enter the mailbox email, the IMAP host/port (default ${DEFAULT_IMAP_PORT}, SSL/TLS) and the SMTP host/port (default ${DEFAULT_SMTP_PORT}, STARTTLS). Username is usually the full email address.`,
      produces: ["imap_host", "imap_port", "smtp_host", "smtp_port", "username"],
    },
    {
      title: "Test, then save",
      body: "Run Test connection — it does a live IMAP login and SMTP auth against the credentials. A green result is required before Connect; a failure shows the exact server error so you can fix host, port, or password.",
    },
  ],
  imapPresets: [
    {
      provider: "Gmail",
      imap_host: "imap.gmail.com",
      imap_port: 993,
      smtp_host: "smtp.gmail.com",
      smtp_port: 465,
      steps: [
        "Turn on 2-Step Verification for the Google account (required before app passwords are available).",
        "Go to myaccount.google.com/apppasswords and sign in.",
        'Create an app password (name it "MailBOX"); Google shows a 16-character code.',
        "Paste that 16-character code (spaces optional) into the App password field. Username is the full Gmail address.",
      ],
    },
    {
      provider: "Fastmail",
      imap_host: "imap.fastmail.com",
      imap_port: 993,
      smtp_host: "smtp.fastmail.com",
      smtp_port: 465,
      steps: [
        "Sign in to Fastmail and open Settings -> Privacy & Security -> App Passwords (Integrations on some plans).",
        'Click New App Password; set Access to "Mail (IMAP/SMTP)".',
        "Copy the generated password.",
        "Paste it into the App password field. Username is the full Fastmail address.",
      ],
    },
    {
      provider: "Zoho",
      imap_host: "imap.zoho.com",
      imap_port: 993,
      smtp_host: "smtp.zoho.com",
      smtp_port: 465,
      steps: [
        "Enable two-factor authentication on the Zoho account (required for app passwords).",
        "Open accounts.zoho.com -> Security -> App Passwords.",
        'Generate a new app-specific password (name it "MailBOX").',
        "Paste it into the App password field. Username is the full Zoho address.",
      ],
    },
    {
      provider: "Generic (cPanel/custom)",
      imap_port: 993,
      smtp_port: 587,
      steps: [
        "Find the IMAP and SMTP server settings in your hosting control panel (cPanel: Email Accounts -> Connect Devices / Mail Client config).",
        "If your host offers app passwords or per-mailbox passwords, generate one for this mailbox; otherwise use the mailbox password.",
        "Enter the IMAP host (port 993, SSL/TLS) and SMTP host (port 587 STARTTLS, or 465 SSL).",
        "Paste the password into the App password field. Username is usually the full email address.",
      ],
    },
  ],
};

const MICROSOFT_ONBOARDING: ProviderOnboarding = {
  label: "Microsoft 365",
  summary:
    "Connect a Microsoft 365 mailbox using an app-only (client-credentials) registration in your own Azure tenant. You register an app, grant it the Mail.ReadWrite application permission with admin consent, then paste the tenant ID, client ID, and client secret. Requires tenant admin rights to grant consent.",
  mode: "credentials",
  connectPath: "/api/accounts/microsoft",
  steps: [
    {
      title: "Open Azure app registrations",
      body: "Sign in to entra.microsoft.com as a tenant admin and go to Identity -> Applications -> App registrations.",
      href: "https://entra.microsoft.com",
    },
    {
      title: "Create a new registration",
      body: 'Click New registration. Name it (e.g. "MailBOX"), set Supported account types to "Accounts in this organizational directory only (Single tenant)", and leave Redirect URI blank — app-only auth needs none. Click Register.',
    },
    {
      title: "Copy the tenant ID and client ID",
      body: "On the app Overview page, copy the Directory (tenant) ID and the Application (client) ID into the fields below.",
      produces: ["tenant_id", "client_id"],
    },
    {
      title: "Create a client secret (copy the VALUE)",
      body: "Open Certificates & secrets -> New client secret. After it is created, copy the secret Value column immediately — it is shown only once. The Secret ID column is NOT the secret; you want the Value.",
      produces: ["client_secret"],
    },
    {
      title: `Grant the ${GRAPH_PERMISSION} application permission`,
      body: `Open API permissions -> Add a permission -> Microsoft Graph -> Application permissions, then add ${GRAPH_PERMISSION}. This is an APPLICATION permission, not Delegated — app-only auth ignores delegated permissions.`,
    },
    {
      title: "Grant admin consent",
      body: `Still on API permissions, click "Grant admin consent for <your tenant>". The Status column must turn to a green checkmark for ${GRAPH_PERMISSION}. Without admin consent the mailbox read returns 403 and the connection test fails.`,
    },
    {
      title: "Enter the mailbox address",
      body: "Enter the email address / UPN of the mailbox the app will read. This is the mailbox the appliance triages — it must exist in this tenant.",
      produces: ["mailbox"],
    },
    {
      title: "Test the connection",
      body: "Run Test connection. It mints an app-only Graph token from the credentials, then reads the target mailbox inbox. A 403 means the Mail.ReadWrite permission or admin consent is missing; a 404 means the mailbox/UPN is wrong; bad client secret or app id reports invalid_client.",
    },
    {
      title: "Connect",
      body: "Connect is enabled only after a passing test. Connecting persists the account and encrypts the client secret at rest; the secret is never shown again.",
    },
  ],
};

// Record key set is MailProviderKind (microsoft | imap), so the build fails if a
// new MailProviderKind member lands without its onboarding content here. Do NOT
// widen the key type to string — that would silently drop the exhaustiveness check.
export const PROVIDER_ONBOARDING: Record<MailProviderKind, ProviderOnboarding> =
  {
    microsoft: MICROSOFT_ONBOARDING,
    imap: IMAP_ONBOARDING,
  };

export { DEFAULT_IMAP_PORT, DEFAULT_SMTP_PORT };
