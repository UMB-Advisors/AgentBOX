// The dashboard can be served either at the root of its host (e.g.
// https://kanban.tilos.com/) or under a URL prefix when reverse-proxied
// (e.g. https://mission-control.tilos.com/hermes/). The Python backend
// injects ``window.__HERMES_BASE_PATH__`` into index.html based on the
// incoming ``X-Forwarded-Prefix`` header so the SPA can address its own
// ``/api/...`` and ``/dashboard-plugins/...`` URLs correctly without a
// rebuild. Empty string means "served at root".
function readBasePath(): string {
  if (typeof window === "undefined") return "";
  const raw = window.__HERMES_BASE_PATH__ ?? "";
  if (!raw) return "";
  // Normalise: ensure leading slash, strip trailing slash.
  const withLead = raw.startsWith("/") ? raw : `/${raw}`;
  return withLead.replace(/\/+$/, "");
}

export const HERMES_BASE_PATH = readBasePath();
const BASE = HERMES_BASE_PATH;

import type { DashboardTheme } from "@/themes/types";

// Ephemeral session token for protected endpoints.
// Injected into index.html by the server — never fetched via API.
declare global {
  interface Window {
    __HERMES_SESSION_TOKEN__?: string;
    __HERMES_BASE_PATH__?: string;
    /** Server-injected flag: ``true`` when the dashboard's OAuth gate is
     * engaged (public bind, no ``--insecure``). Toggles the SPA's
     * WS-upgrade path from legacy ``?token=`` to single-use ``?ticket=``
     * fetched via :func:`getWsTicket`. */
    __HERMES_AUTH_REQUIRED__?: boolean;
  }
}
let _sessionToken: string | null = null;
const SESSION_HEADER = "X-Hermes-Session-Token";

/** Attach the dashboard session token header (idempotent). Shared so non-JSON
 * clients (e.g. the CRM client, which handles its own responses) gate their
 * proxied ``/dashboard/api/*`` requests with the same header. */
export function setSessionHeader(headers: Headers, token: string): void {
  if (!headers.has(SESSION_HEADER)) {
    headers.set(SESSION_HEADER, token);
  }
}

export async function fetchJSON<T>(
  url: string,
  init?: RequestInit,
  options?: FetchJSONOptions,
): Promise<T> {
  // Inject the session token into all /api/ requests.
  const headers = new Headers(init?.headers);
  const token = window.__HERMES_SESSION_TOKEN__;
  if (token) {
    setSessionHeader(headers, token);
  }
  const res = await fetch(`${BASE}${url}`, {
    ...init,
    headers,
    // ``credentials: 'include'`` so the cookie-auth path (gated mode) works
    // for any fetch routed through here. Loopback mode is unaffected — the
    // server doesn't read cookies and the legacy session-token header is
    // already attached above.
    credentials: init?.credentials ?? "include",
  });
  if (res.status === 401) {
    // Phase 6: the gated middleware emits a structured envelope so the
    // SPA can full-page-navigate to /login on session expiry. Parse it,
    // and only redirect on the known error codes — domain-level 401s
    // (e.g. "you don't have permission to read this monitor") bubble
    // up as regular errors so callers can handle them.
    let body: { error?: string; login_url?: string } = {};
    try {
      body = await res.clone().json();
    } catch {
      /* non-JSON 401 — let it fall through */
    }
    if (
      (body.error === "unauthenticated" || body.error === "session_expired") &&
      body.login_url
    ) {
      // Preserve where the user was so /auth/callback can land them back
      // after re-auth. The gate's login_url already carries a ``next=``
      // built from the request path, but the SPA may be deep inside a
      // SPA route the gate never saw — e.g. a hash route or a client-side
      // /sessions/<id> deep link. Save the current location as a
      // fallback the post-login handler can read.
      try {
        sessionStorage.setItem(
          "hermes.lastLocation",
          window.location.pathname + window.location.search,
        );
      } catch {
        /* SSR / privacy mode — ignore */
      }
      window.location.assign(body.login_url);
      // Never resolve — the page is about to unload.
      return new Promise<T>(() => {});
    }
    // Loopback mode: ``_SESSION_TOKEN`` rotates on every server restart
    // (``hermes update``, ``hermes gateway restart``, etc.). A tab kept
    // open across the restart holds the OLD token in
    // ``window.__HERMES_SESSION_TOKEN__`` from the previous HTML render,
    // so every fetch returns 401. The HTML is served ``Cache-Control:
    // no-store`` so a reload picks up the freshly-injected token. Trigger
    // that reload once on the first stale-token 401 — gated mode is
    // handled above, so reaching here in gated mode means a real
    // middleware failure that should not reload-loop.
    if (!window.__HERMES_AUTH_REQUIRED__ && !options?.allowUnauthorized) {
      let alreadyReloaded = false;
      try {
        alreadyReloaded =
          sessionStorage.getItem("hermes.tokenReloadAttempted") === "1";
      } catch {
        /* SSR / privacy mode — fall through to throw */
      }
      if (!alreadyReloaded) {
        try {
          sessionStorage.setItem("hermes.tokenReloadAttempted", "1");
        } catch {
          /* SSR / privacy mode — best effort */
        }
        window.location.reload();
        return new Promise<T>(() => {});
      }
    }
  }
  if (res.ok) {
    // Clear the stale-token reload guard: a successful 2xx proves the
    // current ``window.__HERMES_SESSION_TOKEN__`` is valid, so the next
    // 401 — if any — should be allowed to trigger its own reload cycle.
    try {
      sessionStorage.removeItem("hermes.tokenReloadAttempted");
    } catch {
      /* SSR / privacy mode — ignore */
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

/** Encode a plugin registry key for URL paths (preserves `/` segment separators). */
function pluginPath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

async function getSessionToken(): Promise<string> {
  if (_sessionToken) return _sessionToken;
  const injected = window.__HERMES_SESSION_TOKEN__;
  if (injected) {
    _sessionToken = injected;
    return _sessionToken;
  }
  throw new Error("Session token not available — page must be served by the Hermes dashboard server");
}

/**
 * Fetch a single-use ticket for a WebSocket upgrade in gated mode.
 *
 * The dashboard's gated-mode WS auth (``hermes_cli.web_server._ws_auth_ok``)
 * rejects the legacy ``?token=<_SESSION_TOKEN>`` path and only accepts
 * ``?ticket=<minted>`` consumed against the in-memory ticket store. Browsers
 * can't set ``Authorization`` on a WS upgrade, so this round-trip via the
 * authenticated REST endpoint is the bridge from cookie auth to WS auth.
 *
 * Tickets are single-use and TTL=30s — every WS connect attempt must
 * fetch a fresh ticket.
 */
export async function getWsTicket(): Promise<{ ticket: string; ttl_seconds: number }> {
  const res = await fetch(`${BASE}/api/auth/ws-ticket`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`/api/auth/ws-ticket: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Resolve the auth query-param pair (``[name, value]``) for a WebSocket
 * connect. In gated mode mints a fresh single-use ticket; in loopback
 * mode returns the injected session token.
 */
export async function buildWsAuthParam(): Promise<[string, string]> {
  if (window.__HERMES_AUTH_REQUIRED__) {
    const { ticket } = await getWsTicket();
    return ["ticket", ticket];
  }
  const token = window.__HERMES_SESSION_TOKEN__ ?? "";
  return ["token", token];
}

export const api = {
  getStatus: () => fetchJSON<StatusResponse>("/api/status"),
  /** Aggregated operator status (MBOX-478): hermes-native disk/uptime plus the
   * proxied mailbox-pipeline snapshot. Always 200; per-source availability is
   * carried in the ``native``/``pipeline`` flags. */
  getOperatorStatus: () =>
    fetchJSON<OperatorStatusResponse>("/api/operator-status"),
  /** Most-recent daily digest for the Home landing pane (Phase 3).
   *
   * Always 200, even when no digest exists yet — an empty digest carries
   * ``markdown: null`` so the Home page renders a clean empty state. The
   * endpoint must never 401 (that would trip the loopback stale-token
   * reload in {@link fetchJSON}).
   *
   * Phase 5: optional ``entity`` slug scopes the digest to one gbrain
   * entity source (server-validated; unknown slugs answer 400). */
  getDigest: (entity?: string) =>
    fetchJSON<DigestResponse>(
      "/api/digest/latest" +
        (entity ? `?entity=${encodeURIComponent(entity)}` : ""),
    ),
  /** Daily Digest: which modules + news sources to surface (persisted). */
  getDigestPrefs: () => fetchJSON<DigestPrefs>("/api/digest/prefs"),
  setDigestPrefs: (body: {
    modules?: Record<string, boolean>;
    news_sources?: string[];
    custom_sources?: Array<{ id?: string; label?: string; url: string }>;
  }) =>
    fetchJSON<DigestPrefs>("/api/digest/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  /** Whitelisted news feeds the digest can pull from. */
  getNewsSources: () =>
    fetchJSON<{ sources: NewsSource[] }>("/api/digest/news/sources"),
  /** Paginated, date-sorted merge of the selected feeds (digest infinite scroll). */
  getNews: (sources: string[], offset = 0, limit = 20, refresh = false) => {
    const qs = new URLSearchParams();
    if (sources.length) qs.set("sources", sources.join(","));
    qs.set("offset", String(offset));
    qs.set("limit", String(limit));
    if (refresh) qs.set("refresh", "1");
    return fetchJSON<NewsResponse>(`/api/digest/news?${qs.toString()}`);
  },
  /** Kanban board (digest Tasks module + Org Chart Tasks list view). */
  getKanbanBoard: () => fetchJSON<KanbanBoard>("/api/plugins/kanban/board"),
  /** Create a native kanban task. May carry a dispatcher-presence warning. */
  createKanbanTask: (body: KanbanCreateTaskBody) =>
    fetchJSON<{ task: KanbanTask | null; warning?: string }>(
      "/api/plugins/kanban/tasks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  /** Patch one kanban task (status / assignee / priority / title / body). */
  updateKanbanTask: (id: string, body: KanbanUpdateTaskBody) =>
    fetchJSON<{ task: KanbanTask | null }>(
      `/api/plugins/kanban/tasks/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  /** Apply the same patch to many kanban tasks (per-id outcomes). */
  bulkUpdateKanbanTasks: (body: KanbanBulkUpdateBody) =>
    fetchJSON<KanbanBulkUpdateResponse>("/api/plugins/kanban/tasks/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  /** Known kanban assignees: profiles on disk + names in use on the board. */
  getKanbanAssignees: () =>
    fetchJSON<{ assignees: KanbanAssignee[] }>("/api/plugins/kanban/assignees"),
  /** Append a comment to a kanban task (server defaults author to "dashboard"). */
  addKanbanComment: (id: string, body: string, author?: string) =>
    fetchJSON<{ ok: boolean }>(
      `/api/plugins/kanban/tasks/${encodeURIComponent(id)}/comments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(author ? { body, author } : { body }),
      },
    ),
  /** Org Chart Tasks: which task provider to show (native kanban vs Linear). */
  getTasksPrefs: () => fetchJSON<TasksPrefs>("/api/tasks/prefs"),
  setTasksPrefs: (body: { provider?: TaskProviderId; linear_team_id?: string }) =>
    fetchJSON<TasksPrefs>("/api/tasks/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  /** Kanban Linear-UX sidecar meta: due dates, labels, cycles, saved views
   * (PRD docs/kanban-linear-ux.v0.1.0.md §2.2 — ~/.hermes/kanban-meta.json,
   * NOT the plugin DB; the plugin Board never renders these fields). */
  getKanbanMeta: () => fetchJSON<KanbanMeta>("/api/tasks/meta"),
  /** Full-array replace of any provided key; also carries the lazy
   * sidecar GC (`prune_missing` + `live_task_ids`). Returns the doc. */
  putKanbanMeta: (body: KanbanMetaPut) =>
    fetchJSON<KanbanMeta>("/api/tasks/meta", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  /** Merge one task's sidecar entry; `null` clears a field. Returns the
   * resulting entry (`{}` once everything is cleared). */
  patchKanbanTaskMeta: (id: string, body: KanbanTaskMetaPatch) =>
    fetchJSON<KanbanTaskMeta>(`/api/tasks/meta/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  /** Linear teams for the Org Chart Tasks team picker. */
  getLinearTeams: () => fetchJSON<LinearTeamsResponse>("/api/tasks/linear/teams"),
  /** Read-only Linear board, grouped by workflow-state type. */
  getLinearBoard: (team?: string | null, refresh = false) => {
    const qs = new URLSearchParams();
    if (team) qs.set("team", team);
    if (refresh) qs.set("refresh", "1");
    const s = qs.toString();
    return fetchJSON<LinearBoard>(`/api/tasks/linear/board${s ? `?${s}` : ""}`);
  },
  /** Operations > Conversations: parsed Gemini meeting notes. */
  getConversations: (refresh = false) =>
    fetchJSON<ConversationsResponse>(
      `/api/conversations${refresh ? "?refresh=1" : ""}`,
    ),
  /** Today's calendar events for the digest (placeholder until calendar wired). */
  getDigestCalendar: () => fetchJSON<DigestCalendar>("/api/digest/calendar"),
  getDigestBrief: (account?: string) =>
    fetchJSON<DigestBrief>(
      "/api/digest/brief" +
        (account && account !== "combined"
          ? `?account=${encodeURIComponent(account)}`
          : ""),
    ),
  /** Top-N most-important emails per inbox for the brief's Top of Mind. */
  getInboxRanking: (account = "combined") =>
    fetchJSON<InboxRanking>(
      `/api/digest/inbox-ranking?account=${encodeURIComponent(account)}`,
    ),
  /**
   * Identity probe for the dashboard auth gate (Phase 7).
   *
   * Returns the verified Session as JSON when gated mode is active and a
   * valid cookie is attached. Loopback mode is unaffected — the endpoint
   * still exists but is never useful there (no Session, no cookie). The
   * AuthWidget component swallows 401s from this call: if the gate isn't
   * engaged, /api/auth/me returns 401 and the widget renders nothing.
   *
   * ``allowUnauthorized`` is load-bearing: in loopback mode this endpoint
   * 401s by design, and fetchJSON's default loopback behaviour treats a
   * 401 as a rotated session token and full-page-reloads to pick up a
   * fresh one. Because every *other* dashboard request succeeds (and so
   * clears the one-shot reload guard), that turns this expected 401 into
   * an infinite reload loop. Opting out keeps the 401 a plain throw the
   * widget can catch.
   */
  getAuthMe: () =>
    fetchJSON<AuthMeResponse>("/api/auth/me", undefined, {
      allowUnauthorized: true,
    }),
  logout: () =>
    fetch(`${BASE}/auth/logout`, {
      method: "POST",
      credentials: "include",
    }).then((r) => {
      // /auth/logout returns 302 → /login. Follow that with a full-page
      // navigation rather than letting fetch() opaquely consume the
      // redirect — the SPA needs to leave the protected area.
      window.location.assign("/login");
      return r;
    }),
  getSessions: (limit = 20, offset = 0) =>
    fetchJSON<PaginatedSessions>(`/api/sessions?limit=${limit}&offset=${offset}`),
  getSessionMessages: (id: string) =>
    fetchJSON<SessionMessagesResponse>(`/api/sessions/${encodeURIComponent(id)}/messages`),
  getSessionLatestDescendant: (id: string) =>
    fetchJSON<SessionLatestDescendantResponse>(
      `/api/sessions/${encodeURIComponent(id)}/latest-descendant`,
    ),
  deleteSession: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  getLogs: (params: { file?: string; lines?: number; level?: string; component?: string }) => {
    const qs = new URLSearchParams();
    if (params.file) qs.set("file", params.file);
    if (params.lines) qs.set("lines", String(params.lines));
    if (params.level && params.level !== "ALL") qs.set("level", params.level);
    if (params.component && params.component !== "all") qs.set("component", params.component);
    return fetchJSON<LogsResponse>(`/api/logs?${qs.toString()}`);
  },
  getAnalytics: (days: number) =>
    fetchJSON<AnalyticsResponse>(`/api/analytics/usage?days=${days}`),
  getModelsAnalytics: (days: number) =>
    fetchJSON<ModelsAnalyticsResponse>(`/api/analytics/models?days=${days}`),
  getConfig: () => fetchJSON<Record<string, unknown>>("/api/config"),
  getDefaults: () => fetchJSON<Record<string, unknown>>("/api/config/defaults"),
  getSchema: () => fetchJSON<{ fields: Record<string, unknown>; category_order: string[] }>("/api/config/schema"),
  getModelInfo: () => fetchJSON<ModelInfoResponse>("/api/model/info"),
  getModelOptions: () => fetchJSON<ModelOptionsResponse>("/api/model/options"),
  getAuxiliaryModels: () => fetchJSON<AuxiliaryModelsResponse>("/api/model/auxiliary"),
  setModelAssignment: (body: ModelAssignmentRequest) =>
    fetchJSON<ModelAssignmentResponse>("/api/model/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  saveConfig: (config: Record<string, unknown>) =>
    fetchJSON<{ ok: boolean }>("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    }),
  getConfigRaw: () => fetchJSON<{ yaml: string }>("/api/config/raw"),
  saveConfigRaw: (yaml_text: string) =>
    fetchJSON<{ ok: boolean }>("/api/config/raw", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yaml_text }),
    }),
  getEnvVars: () => fetchJSON<Record<string, EnvVarInfo>>("/api/env"),
  setEnvVar: (key: string, value: string) =>
    fetchJSON<{ ok: boolean }>("/api/env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    }),
  deleteEnvVar: (key: string) =>
    fetchJSON<{ ok: boolean }>("/api/env", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    }),
  revealEnvVar: async (key: string) => {
    const token = await getSessionToken();
    return fetchJSON<{ key: string; value: string }>("/api/env/reveal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SESSION_HEADER]: token,
      },
      body: JSON.stringify({ key }),
    });
  },

  // Cron jobs
  getCronJobs: (profile = "all") =>
    fetchJSON<CronJob[]>(`/api/cron/jobs?profile=${encodeURIComponent(profile)}`),
  createCronJob: (
    job: {
      prompt: string;
      schedule: string;
      name?: string;
      deliver?: string;
      model?: string | null;
      provider?: string | null;
      // Optional skills / toolsets to preload (used by Agent Template instantiation).
      skills?: string[] | null;
      enabled_toolsets?: string[] | null;
      // Operator's end-goal for the job (persisted; drives the Reprompt action).
      objective?: string | null;
      department_id?: number | null;
      department_name?: string | null;
      employee_id?: number | null;
      employee_name?: string | null;
    },
    profile = "default",
  ) =>
    fetchJSON<CronJob>(`/api/cron/jobs?profile=${encodeURIComponent(profile)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(job),
    }),
  updateCronJob: (
    id: string,
    updates: {
      prompt?: string;
      schedule?: string;
      name?: string;
      deliver?: string;
      model?: string | null;
      provider?: string | null;
      objective?: string | null;
      department_id?: number | null;
      department_name?: string | null;
      employee_id?: number | null;
      employee_name?: string | null;
    },
    profile = "default",
  ) =>
    fetchJSON<CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}?profile=${encodeURIComponent(profile)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    }),
  pauseCronJob: (id: string, profile = "default") =>
    fetchJSON<CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}/pause?profile=${encodeURIComponent(profile)}`, { method: "POST" }),
  resumeCronJob: (id: string, profile = "default") =>
    fetchJSON<CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}/resume?profile=${encodeURIComponent(profile)}`, { method: "POST" }),
  triggerCronJob: (id: string, profile = "default") =>
    fetchJSON<CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}/trigger?profile=${encodeURIComponent(profile)}`, { method: "POST" }),
  deleteCronJob: (id: string, profile = "default") =>
    fetchJSON<{ ok: boolean }>(`/api/cron/jobs/${encodeURIComponent(id)}?profile=${encodeURIComponent(profile)}`, { method: "DELETE" }),
  // Interactive, LLM-assisted job-template builder. Sends the running chat
  // transcript and gets back the assistant's next reply plus an optional
  // structured proposal to prefill the create-job form.
  assistCronTemplate: (
    messages: CronTemplateMessage[],
    templateId?: string | null,
    model?: string | null,
    provider?: string | null,
  ) =>
    fetchJSON<CronTemplateAssistResult>(`/api/cron/template/assist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        template_id: templateId || null,
        model: model || null,
        provider: provider || null,
      }),
    }),
  getCronOutputs: (limit = 10, profile = "all") =>
    fetchJSON<{ outputs: CronOutput[] }>(
      `/api/cron/outputs?profile=${encodeURIComponent(profile)}&limit=${limit}`,
    ),

  // Agent Templates — reusable blueprints the Agent Jobs UI builds new jobs from.
  getAgentTemplates: () =>
    fetchJSON<{ templates: AgentTemplateSummary[] }>("/api/cron/templates"),
  getAgentTemplate: (id: string) =>
    fetchJSON<AgentTemplate>(`/api/cron/templates/${encodeURIComponent(id)}`),

  // Live LLM reprompt — improve a draft job prompt toward an outcome objective.
  // model/provider optional (empty → box default). One-shot; UI shows the result.
  repromptCronPrompt: (body: {
    draft_prompt: string;
    outcome_objective?: string;
    model?: string | null;
    provider?: string | null;
  }) =>
    fetchJSON<{ improved_prompt: string; model: string; provider: string }>(
      "/api/cron/reprompt",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),

  // Profiles (minimal)
  getProfiles: () =>
    fetchJSON<{ profiles: ProfileInfo[] }>("/api/profiles"),
  createProfile: (body: { name: string; clone_from_default: boolean }) =>
    fetchJSON<{ ok: boolean; name: string; path: string }>("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  renameProfile: (name: string, newName: string) =>
    fetchJSON<{ ok: boolean; name: string; path: string }>(
      `/api/profiles/${encodeURIComponent(name)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_name: newName }),
      },
    ),
  deleteProfile: (name: string) =>
    fetchJSON<{ ok: boolean }>(
      `/api/profiles/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),
  getProfileSetupCommand: (name: string) =>
    fetchJSON<{ command: string }>(
      `/api/profiles/${encodeURIComponent(name)}/setup-command`,
    ),
  getProfileSoul: (name: string) =>
    fetchJSON<{ content: string; exists: boolean }>(
      `/api/profiles/${encodeURIComponent(name)}/soul`,
    ),
  updateProfileSoul: (name: string, content: string) =>
    fetchJSON<{ ok: boolean }>(
      `/api/profiles/${encodeURIComponent(name)}/soul`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      },
    ),

  // Skills & Toolsets
  getSkills: () => fetchJSON<SkillInfo[]>("/api/skills"),
  toggleSkill: (name: string, enabled: boolean) =>
    fetchJSON<{ ok: boolean }>("/api/skills/toggle", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, enabled }),
    }),
  getToolsets: () => fetchJSON<ToolsetInfo[]>("/api/tools/toolsets"),

  // Session search (FTS5)
  searchSessions: (q: string) =>
    fetchJSON<SessionSearchResponse>(`/api/sessions/search?q=${encodeURIComponent(q)}`),

  // OAuth provider management
  getOAuthProviders: () =>
    fetchJSON<OAuthProvidersResponse>("/api/providers/oauth"),
  disconnectOAuthProvider: async (providerId: string) => {
    const token = await getSessionToken();
    return fetchJSON<{ ok: boolean; provider: string }>(
      `/api/providers/oauth/${encodeURIComponent(providerId)}`,
      {
        method: "DELETE",
        headers: { [SESSION_HEADER]: token },
      },
    );
  },
  startOAuthLogin: async (providerId: string) => {
    const token = await getSessionToken();
    return fetchJSON<OAuthStartResponse>(
      `/api/providers/oauth/${encodeURIComponent(providerId)}/start`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [SESSION_HEADER]: token,
        },
        body: "{}",
      },
    );
  },
  submitOAuthCode: async (providerId: string, sessionId: string, code: string) => {
    const token = await getSessionToken();
    return fetchJSON<OAuthSubmitResponse>(
      `/api/providers/oauth/${encodeURIComponent(providerId)}/submit`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [SESSION_HEADER]: token,
        },
        body: JSON.stringify({ session_id: sessionId, code }),
      },
    );
  },
  pollOAuthSession: (providerId: string, sessionId: string) =>
    fetchJSON<OAuthPollResponse>(
      `/api/providers/oauth/${encodeURIComponent(providerId)}/poll/${encodeURIComponent(sessionId)}`,
    ),
  cancelOAuthSession: async (sessionId: string) => {
    const token = await getSessionToken();
    return fetchJSON<{ ok: boolean }>(
      `/api/providers/oauth/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "DELETE",
        headers: { [SESSION_HEADER]: token },
      },
    );
  },

  // Gateway / update actions
  restartGateway: () =>
    fetchJSON<ActionResponse>("/api/gateway/restart", { method: "POST" }),
  updateHermes: () =>
    fetchJSON<ActionResponse>("/api/hermes/update", { method: "POST" }),
  getActionStatus: (name: string, lines = 200) =>
    fetchJSON<ActionStatusResponse>(
      `/api/actions/${encodeURIComponent(name)}/status?lines=${lines}`,
    ),

  // Dashboard plugins
  getPlugins: () =>
    fetchJSON<PluginManifestResponse[]>("/api/dashboard/plugins"),
  rescanPlugins: () =>
    fetchJSON<{ ok: boolean; count: number }>("/api/dashboard/plugins/rescan"),

  getPluginsHub: () => fetchJSON<PluginsHubResponse>("/api/dashboard/plugins/hub"),

  installAgentPlugin: (body: AgentPluginInstallRequest) =>
    fetchJSON<AgentPluginInstallResponse>("/api/dashboard/agent-plugins/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body }),
    }),

  enableAgentPlugin: (name: string) =>
    fetchJSON<{ ok: boolean; name: string; unchanged?: boolean }>(
      `/api/dashboard/agent-plugins/${pluginPath(name)}/enable`,
      { method: "POST" },
    ),

  disableAgentPlugin: (name: string) =>
    fetchJSON<{ ok: boolean; name: string; unchanged?: boolean }>(
      `/api/dashboard/agent-plugins/${pluginPath(name)}/disable`,
      { method: "POST" },
    ),

  updateAgentPlugin: (name: string) =>
    fetchJSON<AgentPluginUpdateResponse>(
      `/api/dashboard/agent-plugins/${pluginPath(name)}/update`,
      { method: "POST" },
    ),

  removeAgentPlugin: (name: string) =>
    fetchJSON<{ ok: boolean; name: string }>(
      `/api/dashboard/agent-plugins/${pluginPath(name)}`,
      { method: "DELETE" },
    ),

  savePluginProviders: (body: PluginProvidersPutRequest) =>
    fetchJSON<{ ok: boolean }>("/api/dashboard/plugin-providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  setPluginVisibility: (name: string, hidden: boolean) =>
    fetchJSON<{ ok: boolean; name: string; hidden: boolean }>(
      `/api/dashboard/plugins/${pluginPath(name)}/visibility`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden }),
      },
    ),

  // Dashboard themes
  getThemes: () =>
    fetchJSON<DashboardThemesResponse>("/api/dashboard/themes"),
  setTheme: (name: string) =>
    fetchJSON<{ ok: boolean; theme: string }>("/api/dashboard/theme", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),

  // ── Unified Inbox (Phase 1) ────────────────────────────────────────────
  // These call the on-box mailbox-dashboard REST API (Next.js basePath
  // ``/dashboard``) through the SAME reverse-proxy the legacy iframe rode
  // (``web_server.py`` ``/dashboard/{path}``). They are same-origin and
  // unauthenticated loopback: the ``X-Hermes-Session-Token`` ``fetchJSON``
  // attaches is ignored by the mailbox API (the Hermes auth gate only
  // covers ``/api/*``, not ``/dashboard/*``). Do NOT add a parallel fetch
  // helper — reuse ``fetchJSON`` unchanged. See CONTEXT-phase-1 D-1/D-2.

  /** List drafts joined with their inbox message + account (the inbox queue).
   * ``status`` is a CSV of valid {@link InboxDraftStatus} values (server
   * default ``pending``; invalid → 400). ``accountId`` narrows by
   * ``account_id`` when provided. */
  inboxListDrafts: (status = "pending", limit = 50, accountId?: number) => {
    const qs = new URLSearchParams();
    qs.set("status", status);
    qs.set("limit", String(limit));
    if (accountId != null) qs.set("account", String(accountId));
    return fetchJSON<InboxDraftsResponse>(`/dashboard/api/drafts?${qs.toString()}`);
  },
  /** Fresh read of a single draft (no top-level ``account`` object — carry
   * it from the list row). 404 if the row was archived/deleted. */
  inboxGetDraft: (id: number) =>
    fetchJSON<DraftRow>(`/dashboard/api/drafts/${encodeURIComponent(String(id))}`),
  /** Approve + send. ``pending|edited → approved``; 409 if not in that set. */
  inboxApproveDraft: (id: number) =>
    fetchJSON<InboxApproveResult>(
      `/dashboard/api/drafts/${encodeURIComponent(String(id))}/approve`,
      { method: "POST" },
    ),
  /** Reject (writes a ``draft_feedback`` row). ``reason_code`` required;
   * ``free_text`` required iff ``reason_code === "other"``. 409 if stale. */
  inboxRejectDraft: (
    id: number,
    body: { reason_code: InboxRejectReasonCode; free_text?: string },
  ) =>
    fetchJSON<InboxRejectResult>(
      `/dashboard/api/drafts/${encodeURIComponent(String(id))}/reject`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  /** Edit the draft body/subject. Flips status to ``edited``. 409 if stale. */
  inboxEditDraft: (
    id: number,
    body: { draft_body: string; draft_subject?: string | null },
  ) =>
    fetchJSON<InboxEditResult>(
      `/dashboard/api/drafts/${encodeURIComponent(String(id))}/edit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  /** Archive the inbox message (keyed by ``inbox_message_id`` — NOT the
   * draft id). Removes from the active queue; keeps the draft. */
  inboxArchiveMessage: (messageId: number) =>
    fetchJSON<InboxMessageActionResult>(
      `/dashboard/api/inbox-messages/${encodeURIComponent(String(messageId))}/archive`,
      { method: "POST" },
    ),
  /** Clear unread on the inbox message (keyed by ``inbox_message_id``). */
  inboxMarkReadMessage: (messageId: number) =>
    fetchJSON<InboxMessageActionResult>(
      `/dashboard/api/inbox-messages/${encodeURIComponent(String(messageId))}/mark-read`,
      { method: "POST" },
    ),
  /** Snooze until ``isoUntil`` (a FUTURE ISO-8601 instant with offset/Z, or
   * the API 400s). Keyed by ``inbox_message_id``. */
  inboxSnoozeMessage: (messageId: number, isoUntil: string) =>
    fetchJSON<InboxSnoozeResult>(
      `/dashboard/api/inbox-messages/${encodeURIComponent(String(messageId))}/snooze`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ until: isoUntil }),
      },
    ),
  /** Connected inboxes — for the account-filter selector. */
  inboxListAccounts: () =>
    fetchJSON<InboxAccountsResponse>("/dashboard/api/accounts"),

  // ── Persona voice tuning (MBOX-476) ────────────────────────────────────
  // The persona row is the voice fingerprint the mailbox drafting pipeline
  // reads (statistical_markers + category_exemplars, JSONB in mailbox
  // Postgres). hermes_cli has NO Postgres driver by decision, so these — like
  // the inbox bindings above — call the on-box mailbox-dashboard REST API
  // (basePath ``/dashboard``) through the SAME ``/dashboard/{path}`` proxy.
  // Default account only; per-account voice ("Learn voice") is triggered from
  // the accounts registry (MBOX-470/MBOX-373), not here.

  /** Read the default account's persona (voice config). ``persona`` is null
   * until the first save/refresh creates the row. */
  personaGet: () => fetchJSON<PersonaResponse>("/dashboard/api/persona"),
  /** Manual override — replace ``statistical_markers`` + ``category_exemplars``
   * verbatim (the operator-edited JSON). ``source_email_count`` is preserved
   * server-side from the current row. */
  personaSave: (body: {
    statistical_markers: Record<string, unknown>;
    category_exemplars: Record<string, unknown>;
  }) =>
    fetchJSON<PersonaResponse>("/dashboard/api/persona", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  /** Re-extract the voice from ``sent_history`` (on-appliance; no cloud).
   * 409 if the inbox has no sent rows yet. Returns the new persona + the row
   * count it learned from. */
  personaRefresh: () =>
    fetchJSON<PersonaRefreshResponse>("/dashboard/api/persona/refresh", {
      method: "POST",
    }),

  // ── Review-panel data (mailbox-dashboard /dashboard/api/drafts/[id]/*) ──

  /** Replace the full action-items array (the route does a whole-array replace). */
  inboxSaveActionItems: (draftId: number, items: ActionItem[]) =>
    fetchJSON<{ success: boolean; draft: { action_items: ActionItem[] } }>(
      `/dashboard/api/drafts/${encodeURIComponent(String(draftId))}/action-items`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action_items: items }),
      },
    ),
  /** Push one action item (``{index}``) or all (``{all:true}``) to Google Tasks. */
  inboxPushActionItems: (
    draftId: number,
    payload: { index: number } | { all: true },
  ) =>
    fetchJSON<{
      action_items?: ActionItem[];
      results?: Array<{ ok: boolean; error?: string }>;
      error?: string;
    }>(
      `/dashboard/api/drafts/${encodeURIComponent(String(draftId))}/action-items/push`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    ),
  /** RAG attribution — resolves rag/kb context refs to source messages. */
  inboxGetRagRefs: (draftId: number) =>
    fetchJSON<RagRefsResponse>(
      `/dashboard/api/drafts/${encodeURIComponent(String(draftId))}/rag-refs`,
    ),
  /** Per-sender acceptance stats over a 30d window. */
  inboxGetSenderHistory: (draftId: number) =>
    fetchJSON<{ history: SenderHistory | null; reason?: string }>(
      `/dashboard/api/drafts/${encodeURIComponent(String(draftId))}/sender-history`,
    ),
  /** Cross-account intelligence — same counterparty in your other inboxes. */
  inboxGetCrossAccount: (draftId: number) =>
    fetchJSON<{ rows: CrossAccountRow[]; reason?: string }>(
      `/dashboard/api/drafts/${encodeURIComponent(String(draftId))}/cross-account`,
    ),
  /** Operator classification override (relabel only — no re-draft). */
  inboxReclassify: (draftId: number, category: string, reason?: string) =>
    fetchJSON<{ success: boolean; draft: unknown }>(
      `/dashboard/api/drafts/${encodeURIComponent(String(draftId))}/classification`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, reason }),
      },
    ),
  /** Retry a failed (errored) draft. */
  inboxRetryDraft: (draftId: number) =>
    fetchJSON<{ success?: boolean; [k: string]: unknown }>(
      `/dashboard/api/drafts/${encodeURIComponent(String(draftId))}/retry`,
      { method: "POST" },
    ),
  /** Undo a rejection — restore the draft to a decidable state. */
  inboxUndoReject: (draftId: number) =>
    fetchJSON<{ success?: boolean; [k: string]: unknown }>(
      `/dashboard/api/drafts/${encodeURIComponent(String(draftId))}/undo-reject`,
      { method: "POST" },
    ),
  /** Clear a stuck send-attempt marker so the draft can be re-decided. */
  inboxClearSendAttempt: (draftId: number) =>
    fetchJSON<{ success?: boolean; [k: string]: unknown }>(
      `/dashboard/api/drafts/${encodeURIComponent(String(draftId))}/clear-send-attempt`,
      { method: "POST" },
    ),
  /** System-wide Gmail rate-limit cooldown state (MBOX-481). Read-only GET —
   * powers the cooldown banner above the queue. Proxies the on-box
   * mailbox-dashboard ``/api/system/gmail-cooldown`` through the SAME
   * ``/dashboard/*`` reverse-proxy as every other inbox binding. */
  inboxGmailCooldown: () =>
    fetchJSON<InboxCooldownState>("/dashboard/api/system/gmail-cooldown"),

  // ── Auto-send rules (MBOX-477) ─────────────────────────────────────────
  // SAFETY SURFACE: these gate what the mailbox Postgres pipeline sends WITHOUT
  // human approval. They proxy the on-box mailbox-dashboard's CRUD API
  // (``/dashboard/api/auto-send-rules[/:id]``) through the SAME reverse-proxy
  // the Unified Inbox rides — so the rules edited here are byte-for-byte the
  // rows the draft-finalize evaluator (lib/auto-send/rules.ts) enforces. A
  // disconnected copy would silently disable the safety behaviour; do NOT add
  // a parallel data path. The mailbox route owns the zod validation (recipient
  // filters, time window, confidence floor); the UI only shapes the form body.

  /** List all auto-send rules in (priority asc, id asc) order. */
  autoSendListRules: () =>
    fetchJSON<{ rules: AutoSendRule[] }>("/dashboard/api/auto-send-rules"),
  /** Create a rule. Body is the mailbox schema surface (time window as
   * ``active_from``/``active_to`` "HH:MM"; blank conditions => null = any). */
  autoSendCreateRule: (body: AutoSendRuleBody) =>
    fetchJSON<{ rule: AutoSendRule }>("/dashboard/api/auto-send-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  /** Partial update (PATCH). Explicit ``null`` on a condition clears it. */
  autoSendUpdateRule: (id: number, body: AutoSendRuleBody) =>
    fetchJSON<{ rule: AutoSendRule }>(
      `/dashboard/api/auto-send-rules/${encodeURIComponent(String(id))}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  /** Delete a rule by id (404 if missing). */
  autoSendDeleteRule: (id: number) =>
    fetchJSON<{ deleted: boolean }>(
      `/dashboard/api/auto-send-rules/${encodeURIComponent(String(id))}`,
      { method: "DELETE" },
    ),

  // ── VIP senders (MBOX-474 — mailbox-dashboard /dashboard/api/vip-senders) ──
  // Drive the urgency engine's 'vip' signal. These proxy through the same
  // /dashboard/* reverse proxy as the inbox routes to the on-box
  // mailbox-dashboard, which owns the mailbox.vip_senders table the pipeline
  // reads — there is no hermes-side copy of the list.

  /** List VIP senders (newest first). */
  listVipSenders: () =>
    fetchJSON<VipSendersResponse>("/dashboard/api/vip-senders"),
  /** Idempotent upsert of a VIP sender on (email_or_domain, kind). */
  addVipSender: (body: VipSenderCreateBody) =>
    fetchJSON<VipSenderCreated>("/dashboard/api/vip-senders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  /** Remove a VIP sender by id (the source maps an unknown id to 404). */
  removeVipSender: (id: number) =>
    fetchJSON<{ deleted: boolean; id: number }>(
      `/dashboard/api/vip-senders/${encodeURIComponent(String(id))}`,
      { method: "DELETE" },
    ),

  // ── Knowledge base / RAG documents (MBOX-473 — mailbox-dashboard
  //    /dashboard/api/kb-documents) ──────────────────────────────────────────
  // Operator-uploaded SOPs / price sheets / policies that the drafting
  // pipeline retrieves against (RAG over Qdrant). Every read and write rides
  // the SAME /dashboard/* reverse proxy to the on-box mailbox-dashboard
  // (:3001), which owns the mailbox.kb_documents table + Qdrant collection —
  // there is no hermes-side copy. Adds/deletes here change the SAME corpus the
  // pipeline retrieves from. hermes_cli holds no Postgres/Qdrant client (see
  // docs/mailbox-to-hermes-migration-audit), so this is a pure frontend port.
  // The multipart UPLOAD can't go through fetchJSON (JSON-only wrapper) — it
  // uses uploadKbDocument() below, which attaches the session token via
  // setSessionHeader the same way fetchJSON does.

  /** Upload one document (multipart) into the KB, optionally scoped to one
   * inbox. Resolves ``{ status, body }`` for both 2xx and the body-carrying
   * 4xx rejects so the page can surface validation messages. */
  uploadKbDocument,
  /** List KB documents (newest first), optionally scoped to one inbox. */
  listKbDocuments: (accountId?: number) => {
    const qs =
      accountId != null
        ? `?account_id=${encodeURIComponent(String(accountId))}&limit=200`
        : "?limit=200";
    return fetchJSON<KbDocumentsResponse>(`/dashboard/api/kb-documents${qs}`);
  },
  /** Delete a KB document (cascades Qdrant points → DB row → on-disk file). */
  deleteKbDocument: (id: number) =>
    fetchJSON<KbDocumentDeleted>(
      `/dashboard/api/kb-documents/${encodeURIComponent(String(id))}`,
      { method: "DELETE" },
    ),
  /** Retry the embed pipeline for a failed/stuck document. */
  retryKbDocument: (id: number) =>
    fetchJSON<KbDocumentRetried>(
      `/dashboard/api/kb-documents/${encodeURIComponent(String(id))}/retry`,
      { method: "POST" },
    ),

  // ── Google accounts (multi-account connect) ────────────────────────────
  /** List connected Google accounts + whether an OAuth client is installed
   * on the box. ``client_configured === false`` means the operator hasn't
   * dropped in a Google Cloud OAuth client yet, so connecting is impossible. */
  listGoogleAccounts: () =>
    fetchJSON<GoogleAccountsResponse>("/api/google/accounts"),
  /** Disconnect a Google account by email. */
  removeGoogleAccount: (email: string) =>
    fetchJSON<{ removed: boolean }>(
      `/api/google/accounts/${encodeURIComponent(email)}`,
      { method: "DELETE" },
    ),
  /** Upcoming Google Calendar events for the Calendar tab. ``account`` omitted
   * or "combined" aggregates every connected account; ``days`` defaults to 7
   * server-side. */
  getGoogleCalendar: (
    account?: string,
    daysOrRange?: number | { start: string; end: string },
  ) => {
    const qs = new URLSearchParams();
    if (account && account !== "combined") qs.set("account", account);
    if (typeof daysOrRange === "number") {
      qs.set("days", String(daysOrRange));
    } else if (daysOrRange) {
      qs.set("start", daysOrRange.start);
      qs.set("end", daysOrRange.end);
    }
    const suffix = qs.toString();
    return fetchJSON<GoogleCalendarResponse>(
      "/api/google/calendar" + (suffix ? `?${suffix}` : ""),
    );
  },
  /** Create an event on a connected account's primary calendar. */
  createGoogleCalendarEvent: (input: GoogleCalEventInput) =>
    fetchJSON<GoogleCalEventMutation>("/api/google/calendar/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  /** Update an existing event (patch) on a connected account's calendar. */
  updateGoogleCalendarEvent: (id: string, input: GoogleCalEventInput) =>
    fetchJSON<GoogleCalEventMutation>(
      `/api/google/calendar/events/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    ),
  /** Delete an event from a connected account's calendar. */
  deleteGoogleCalendarEvent: (id: string, account?: string) =>
    fetchJSON<{ error: string | null }>(
      `/api/google/calendar/events/${encodeURIComponent(id)}` +
        (account && account !== "combined"
          ? `?account=${encodeURIComponent(account)}`
          : ""),
      { method: "DELETE" },
    ),
  /** Recent Google Drive files for the Drive tab. ``account`` omitted or
   * "combined" aggregates every connected account; ``q`` is an optional name
   * search. */
  getGoogleDrive: (account?: string, q?: string) => {
    const qs = new URLSearchParams();
    if (account && account !== "combined") qs.set("account", account);
    if (q) qs.set("q", q);
    const suffix = qs.toString();
    return fetchJSON<GoogleDriveResponse>(
      "/api/google/drive" + (suffix ? `?${suffix}` : ""),
    );
  },

  /** Import Google Contacts (People API) from one or all connected accounts
   * into the CRM (source='google', deduped by external_id). POST, no body. */
  importGoogleContacts: (account?: string) =>
    fetchJSON<GoogleImportResult>(
      "/api/google/contacts/import" +
        (account && account !== "combined"
          ? `?account=${encodeURIComponent(account)}`
          : ""),
      { method: "POST" },
    ),

  // ── Shopify stores (multi-store connect) ───────────────────────────────
  /** List connected Shopify stores + whether the OAuth app is installed on
   * the box. ``client_configured === false`` means the operator hasn't set
   * SHOPIFY_APP_CLIENT_ID/SECRET yet, so connecting is impossible. Never
   * includes access tokens. */
  listShopifyAccounts: () =>
    fetchJSON<ShopifyAccountsResponse>("/api/shopify/accounts"),
  /** Disconnect a Shopify store by shop domain. */
  removeShopifyAccount: (shop: string) =>
    fetchJSON<{ removed: boolean }>(
      `/api/shopify/accounts/${encodeURIComponent(shop)}`,
      { method: "DELETE" },
    ),

  // ── Mail accounts (Microsoft 365 + IMAP, MBOX-468) ─────────────
  /** Probe (``mode:'test'``) or persist (``mode:'connect'``) a Microsoft 365
   * mailbox via the app-only Graph credentials. Session-gated POST. Returns the
   * raw status + parsed body so the caller can distinguish the two 422 shapes
   * (semantic probe-fail vs pydantic body-validation) — see
   * {@link mailConnectFetch}. The ``client_secret`` is sent ONLY in the request
   * body and is never echoed back in any response. */
  connectMicrosoft: (body: GraphConnectBody) =>
    mailConnectFetch("/api/accounts/microsoft", body),
  /** Probe (``mode:'test'``) or persist (``mode:'connect'``) an IMAP/SMTP
   * mailbox. Session-gated POST. ``app_password`` is sent ONLY in the request
   * body and is never echoed back. See {@link mailConnectFetch} for the
   * 200-or-422 contract. */
  connectImap: (body: ImapConnectBody) =>
    mailConnectFetch("/api/accounts/imap", body),
  /** List connected mail accounts (Microsoft 365 + IMAP) + whether at-rest
   * secret encryption is configured on the box. ``crypto_configured === false``
   * means a ``mode:'connect'`` will 500 — gate the Connect button on it. Never
   * includes any secret. */
  listMailAccounts: () =>
    fetchJSON<MailAccountsResponse>("/api/accounts/mail"),
  /** Disconnect a mail account by its record id (uuid4 hex). */
  removeMailAccount: (id: string) =>
    fetchJSON<{ removed: boolean }>(
      `/api/accounts/mail/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),

  // ── First-run onboarding wizard (MBOX-471 + MBOX-484) ──────────────
  /** Current onboarding stage, active mailbox, and the wizard step descriptors
   * (pure config, no secrets). The wizard drives its progress indicator and
   * stage transitions from this. */
  getOnboardingState: () =>
    fetchJSON<OnboardingState>("/api/onboarding/state"),
  /** Advance the onboarding stage by a strict adjacent pair. Resolves with
   * ``{ status, body }`` WITHOUT throwing on the 409 contract (stale_from /
   * invalid_transition) so the wizard can surface those inline — mirrors the
   * mailbox advance route. */
  advanceOnboarding: (body: OnboardingAdvanceBody) =>
    onboardingAdvanceFetch(body),
  /** Record the active/default mailbox on a successful wizard connect
   * (MBOX-484). The box verifies the email is a connected mail account. */
  recordActiveMailbox: (email: string) =>
    fetchJSON<{ ok: boolean; active_mailbox: string }>(
      "/api/onboarding/active-mailbox",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      },
    ),
  /** Relabel and/or set-default a connected mail account (MBOX-470 registry
   * mutation). PATCH the same file-store record the connect routes write.
   * ``display_label: null`` clears the label (falls back to the email);
   * ``make_default: true`` promotes this inbox and demotes the others. Returns
   * the updated secret-free account summary. Never includes any secret. */
  updateMailAccount: (id: string, body: MailAccountUpdateBody) =>
    fetchJSON<{ account: MailAccount }>(
      `/api/accounts/mail/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),

  // ── Classifications (MBOX-472) ─────────────────────────────────────────
  // These hit the hermes-side ``/api/classifications*`` proxy routes
  // (``web_server.py``), which forward to the on-box mailbox-dashboard. The
  // classification data lives in the mailbox Postgres pipeline; hermes_cli has
  // no DB driver, so it proxies rather than queries (same model as Job Outcomes
  // / Unified Inbox).

  /** Recent classification-log rows joined to inbox + draft outcome, newest
   * first (server caps at 200). ``limit`` narrows the page size. */
  listClassifications: (limit = 100) => {
    const qs = new URLSearchParams();
    qs.set("limit", String(limit));
    return fetchJSON<ClassificationListResponse>(
      `/api/classifications?${qs.toString()}`,
    );
  },
  /** MBOX-370 "reclassify automatically": take ``email`` off the spam list and
   * re-run the classifier on their existing mail. Returns fast; the re-classify
   * runs in the background on the box. */
  reclassifySender: (email: string, reason?: string) =>
    fetchJSON<ReclassifySenderResult>("/api/classifications/reclassify-sender", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reason ? { email, reason } : { email }),
    }),

  // ── Daily brief (MBOX-479) ─────────────────────────────────────────────
  /** Mailbox pipeline rollup for the daily-brief view: pending counts by
   * category, urgent-untouched drafts, oldest-waiting tail. Proxied to the
   * on-box mailbox-dashboard (``/api/daily-brief`` → ``/dashboard/api/daily-brief``);
   * degrades to an empty brief if the upstream JSON route is absent. */
  getDailyBrief: () => fetchJSON<DailyBriefResponse>("/api/daily-brief"),
  // ── Drafting tuning / guidelines (MBOX-475) ──────────────────────────────
  // Proxied to the on-box mailbox dashboard (Next.js ``basePath=/dashboard``)
  // through the SAME ``/dashboard/{path}`` reverse proxy the inbox calls use.
  // Same-origin, unauthenticated loopback; the ``X-Hermes-Session-Token``
  // ``fetchJSON`` attaches is ignored by the mailbox API. These read/write the
  // very persona markers + ``prompt_rules`` the mailbox drafting pipeline
  // consumes — do NOT add a hermes_cli Postgres path. ``account`` narrows by
  // ``account_id`` (absent → the seeded default inbox).

  /** Connected inboxes for the per-account tuning selector (mailbox registry).
   * Reuses ``GET /dashboard/api/accounts`` — same source as ``inboxListAccounts``. */
  tuningListAccounts: () =>
    fetchJSON<InboxAccountsResponse>("/dashboard/api/accounts"),

  /** Seed the Style tab: the persona row's ``statistical_markers`` (default
   * account only — the mailbox persona GET is not account-scoped; per-account
   * style seeding is a documented follow-up gap). */
  tuningGetPersona: () =>
    fetchJSON<TuningPersonaSeedResponse>("/dashboard/api/persona"),

  /** Save the voice-style knobs. The route MERGES the marker subset into the
   * persona (preserving extraction markers + exemplars) and echoes the resolved
   * ``style`` back (post-clamp). ``StyleProfile`` from ``@/lib/tuningStyle``. */
  tuningSaveStyle: (
    style: import("@/lib/tuningStyle").StyleProfile,
    accountId?: number,
  ) => {
    const qs = accountId != null ? `?account=${accountId}` : "";
    return fetchJSON<TuningStyleResponse>(`/dashboard/api/tuning/style${qs}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(style),
    });
  },

  /** List drafting guidelines (enabled rules feed the system prompt). */
  tuningListRules: (accountId?: number) => {
    const qs = accountId != null ? `?account=${accountId}` : "";
    return fetchJSON<PromptRulesResponse>(`/dashboard/api/prompt-rules${qs}`);
  },

  /** Create a guideline (version 1, enabled). */
  tuningCreateRule: (body: PromptRuleCreateBody, accountId?: number) => {
    const qs = accountId != null ? `?account=${accountId}` : "";
    return fetchJSON<PromptRuleResponse>(`/dashboard/api/prompt-rules${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },

  /** Edit / toggle a guideline. Content edits bump version; an enabled-only
   * toggle does not. 404 if the id belongs to another inbox. */
  tuningUpdateRule: (
    id: number,
    body: PromptRuleUpdateBody,
    accountId?: number,
  ) => {
    const qs = accountId != null ? `?account=${accountId}` : "";
    return fetchJSON<PromptRuleResponse>(
      `/dashboard/api/prompt-rules/${id}${qs}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  },

  /** Remove a guideline. 404 if the id belongs to another inbox. */
  tuningDeleteRule: (id: number, accountId?: number) => {
    const qs = accountId != null ? `?account=${accountId}` : "";
    return fetchJSON<{ deleted: boolean; id: number }>(
      `/dashboard/api/prompt-rules/${id}${qs}`,
      { method: "DELETE" },
    );
  },
};

/** POST an onboarding stage transition and return ``{ status, body }`` WITHOUT
 * throwing on the 409 contract. The advance route (ported from the mailbox
 * ``/api/internal/onboarding/advance``) uses 409 as a first-class body-carrying
 * response (``stale_from`` / ``invalid_transition``); {@link fetchJSON}'s
 * throw-on-non-2xx would discard the body the wizard needs to react. 200 and 409
 * both resolve with the parsed body; anything else (404/500/network) throws. */
async function onboardingAdvanceFetch(
  body: OnboardingAdvanceBody,
): Promise<{ status: number; body: OnboardingAdvanceResponse }> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = window.__HERMES_SESSION_TOKEN__;
  if (token) {
    setSessionHeader(headers, token);
  }
  const res = await fetch(`${BASE}/api/onboarding/advance`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (res.status === 200 || res.status === 409) {
    const parsed = (await res.json()) as OnboardingAdvanceResponse;
    return { status: res.status, body: parsed };
  }
  const text = await res.text().catch(() => res.statusText);
  throw new Error(`${res.status}: ${text}`);
}

/** POST a credential-bearing mail-connect body to a session-gated route and
 * return ``{ status, body }`` WITHOUT throwing on a 422. The mail-connect
 * contract (MBOX-468) uses 422 as a first-class, body-carrying response — both
 * the semantic probe-fail (``{ ok:false, ...legs }``) and the pydantic
 * body-validation (``{ detail:[...] }``) shapes — so {@link fetchJSON}'s
 * throw-on-non-2xx behaviour would discard exactly the body the UI needs.
 *
 * 200 (green test / persisted connect) and 422 (probe-fail / validation) both
 * resolve with the parsed body. Anything else (500 persist error, network) is
 * thrown so the page surfaces it as a generic error. The ``X-Hermes-Session-Token``
 * header is attached the same way {@link fetchJSON} attaches it. The secret in
 * ``body`` travels ONLY in the JSON request body — never a query string. */
async function mailConnectFetch(
  url: string,
  body: GraphConnectBody | ImapConnectBody,
): Promise<{ status: number; body: MailConnectResponse }> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = window.__HERMES_SESSION_TOKEN__;
  if (token) {
    setSessionHeader(headers, token);
  }
  const res = await fetch(`${BASE}${url}`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  });
  // 200 and 422 both carry a JSON body the caller must inspect. Everything else
  // (500 persist failure, 5xx, network) is an error the page shows generically.
  if (res.status === 200 || res.status === 422) {
    const parsed = (await res.json()) as MailConnectResponse;
    return { status: res.status, body: parsed };
  }
  const text = await res.text().catch(() => res.statusText);
  throw new Error(`${res.status}: ${text}`);
}

/** Upload one KB document (multipart) to the mailbox-dashboard via the
 * ``/dashboard/api/kb-documents`` reverse proxy (MBOX-473). {@link fetchJSON}
 * is JSON-only — it sets ``Content-Type: application/json`` and stringifies the
 * body — so a multipart upload must bypass it. We attach the session token with
 * {@link setSessionHeader} exactly like fetchJSON (proxied ``/dashboard/api/*``
 * is session-gated since PR #47) and DELIBERATELY do not set Content-Type: the
 * browser must emit ``multipart/form-data; boundary=…`` itself so the upstream
 * Next.js ``request.formData()`` parse succeeds.
 *
 * The whole file rides in the request body; the on-box proxy buffers it
 * (``await request.body()``) before forwarding, so uploads are bounded by the
 * upstream KB_MAX_FILE_BYTES cap (10 MB) — well within a single buffered POST.
 *
 * Returns the parsed body for both success (200, ``{ok,duplicate,doc_id,…}``)
 * and the upstream's body-carrying validation rejects (400/413 carry
 * ``{error,message}``) so the caller can show the operator why a file bounced.
 * Network/5xx without a JSON body throws. */
async function uploadKbDocument(
  file: File,
  accountId?: number,
): Promise<{ status: number; body: KbUploadResponse }> {
  const fd = new FormData();
  fd.set("file", file);
  if (accountId != null) fd.set("account_id", String(accountId));

  const headers = new Headers();
  const token = window.__HERMES_SESSION_TOKEN__;
  if (token) {
    setSessionHeader(headers, token);
  }
  const res = await fetch(`${BASE}/dashboard/api/kb-documents`, {
    method: "POST",
    headers,
    credentials: "include",
    body: fd,
  });
  try {
    const parsed = (await res.json()) as KbUploadResponse;
    return { status: res.status, body: parsed };
  } catch {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
}

export interface GoogleImportResult {
  connected: boolean;
  accounts: string[];
  selected: string;
  imported: number;
  updated: number;
  fetched: number;
  by_account: Record<string, number>;
  error: string | null;
}

/** Full-page nav target that kicks off the Google OAuth flow. This is a
 * browser redirect to Google — navigate the whole window to it (do NOT
 * ``fetch()`` it). The server 303-redirects back to ``/settings/google``. */
export function googleAuthStartUrl(): string {
  return `${HERMES_BASE_PATH}/api/google/auth/start`;
}

/** Full-page nav target that kicks off the Shopify OAuth flow for a specific
 * ``*.myshopify.com`` store. This is a browser redirect to Shopify — navigate
 * the whole window to it (do NOT ``fetch()`` it). The server 303-redirects
 * back to ``/settings/shopify``. */
export function shopifyAuthStartUrl(shop: string): string {
  return `${HERMES_BASE_PATH}/api/shopify/auth/start?shop=${encodeURIComponent(shop)}`;
}

/** Identity payload returned by ``GET /api/auth/me`` (Phase 7).
 *
 * Returned by the dashboard's gated middleware when a valid session cookie
 * is attached. ``email`` and ``display_name`` are empty strings under the
 * Nous Portal contract V1 (the access token has no email/name claims —
 * see Contract Anchor C4 in the plan). The AuthWidget surfaces a
 * truncated ``user_id`` instead.
 */
export interface AuthMeResponse {
  user_id: string;
  email: string;
  display_name: string;
  org_id: string;
  provider: string;
  expires_at: number;
}

export interface ActionResponse {
  name: string;
  ok: boolean;
  pid: number;
}

/** A connected Google account as returned by ``GET /api/google/accounts``. */
export interface GoogleAccount {
  email: string;
  scopes: string[];
  connected_at: string | null;
  primary: boolean;
}

/** Response shape for ``GET /api/google/accounts``. ``client_configured`` is
 * ``false`` when no Google Cloud OAuth client is installed on the box. */
export interface GoogleAccountsResponse {
  client_configured: boolean;
  accounts: GoogleAccount[];
}

/** A connected Shopify store as returned by ``GET /api/shopify/accounts``.
 * Never includes the access token. */
export interface ShopifyAccount {
  shop_domain: string;
  scope: string;
  connected_at: string | null;
}

/** Response shape for ``GET /api/shopify/accounts``. ``client_configured`` is
 * ``false`` when no Shopify OAuth app (SHOPIFY_APP_CLIENT_ID/SECRET) is set
 * on the box. */
export interface ShopifyAccountsResponse {
  client_configured: boolean;
  accounts: ShopifyAccount[];
}

/** VIP-sender match kind (MBOX-474). Mirrors the mailbox-dashboard
 * ``VIP_SENDER_KINDS`` — exact email or whole domain, no regex. */
export type VipSenderKind = "email" | "domain";

/** A VIP sender row as returned by the mailbox-dashboard
 * ``GET /api/vip-senders`` (proxied at ``/dashboard/api/vip-senders``). */
export interface VipSender {
  id: number;
  email_or_domain: string;
  kind: VipSenderKind;
  added_at: string;
  added_by: string | null;
  note: string | null;
}

/** Response shape for ``GET /dashboard/api/vip-senders``. */
export interface VipSendersResponse {
  senders: VipSender[];
}

/** Request body for ``POST /dashboard/api/vip-senders``. ``email_or_domain``
 * is lowercased + validated server-side; ``kind`` must match the value shape
 * (email vs bare domain). */
export interface VipSenderCreateBody {
  email_or_domain: string;
  kind: VipSenderKind;
  note?: string;
}

/** Response shape for ``POST /dashboard/api/vip-senders`` (idempotent upsert). */
export interface VipSenderCreated {
  sender: VipSender;
}

// ── Knowledge base / RAG documents (MBOX-473) ───────────────────────────────
// Shapes mirror the mailbox-dashboard's ``/api/kb-documents`` contracts
// (proxied at ``/dashboard/api/kb-documents``). The list/upload/delete/retry
// values stay the SAME corpus the drafting pipeline retrieves against.

/** Processing lifecycle of an uploaded KB document. */
export type KbDocStatus = "processing" | "ready" | "failed";

/** A KB document row as returned by the mailbox-dashboard
 * ``GET /api/kb-documents`` (proxied at ``/dashboard/api/kb-documents``). */
export interface KbDocument {
  id: number;
  account_id: number;
  title: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  chunk_count: number;
  status: KbDocStatus;
  error_message: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
  processing_started_at: string;
  ready_at: string | null;
}

/** Response shape for ``GET /dashboard/api/kb-documents``. */
export interface KbDocumentsResponse {
  documents: KbDocument[];
}

/** Upload result. 200 carries ``ok``/``duplicate``/``doc_id``/``status``;
 * the upstream's body-carrying rejects (400 bad filename/mime/empty, 413 too
 * large, 500) carry ``error``/``message``. Optional fields make one shape
 * cover both the success and the reject body. */
export interface KbUploadResponse {
  ok?: boolean;
  duplicate?: boolean;
  doc_id?: number;
  status?: KbDocStatus;
  sha256?: string;
  error?: string;
  message?: string;
  // The session-gating proxy returns ``{"detail": "Unauthorized"}`` on 401;
  // surface it so the upload feedback can show the proxy's reason.
  detail?: string;
}

/** Response shape for ``DELETE /dashboard/api/kb-documents/:id``. */
export interface KbDocumentDeleted {
  deleted: boolean;
  doc_id: number;
  sha256: string;
}

/** Response shape for ``POST /dashboard/api/kb-documents/:id/retry``. */
export interface KbDocumentRetried {
  retrying: boolean;
  doc_id: number;
}

// ── Mail accounts (Microsoft 365 + IMAP, MBOX-468) ──────────────────────────
// The HTTP contract for Implementer A's session-gated mail-connect routes. No
// type in this block carries a secret in a RESPONSE — ``client_secret`` /
// ``app_password`` appear ONLY on the request bodies below and are never echoed.

/** Request body for ``POST /api/accounts/microsoft``. ``mode`` defaults to
 * ``'test'`` server-side; send ``'connect'`` to persist after a green probe.
 * ``client_secret`` is request-only and never returned. */
export interface GraphConnectBody {
  mode?: "test" | "connect";
  email: string;
  display_label?: string;
  tenant_id: string;
  client_id: string;
  client_secret: string;
  /** Defaults to ``email`` server-side. */
  mailbox?: string;
}

/** Request body for ``POST /api/accounts/imap``. ``mode`` defaults to
 * ``'test'``; send ``'connect'`` to persist. ``app_password`` is request-only
 * and never returned. Ports default to 993 (IMAP) / 587 (SMTP) server-side. */
export interface ImapConnectBody {
  mode?: "test" | "connect";
  email: string;
  display_label?: string;
  imap_host: string;
  imap_port?: number;
  smtp_host: string;
  smtp_port?: number;
  username: string;
  app_password: string;
}

/** One leg of a probe verdict (Graph token/mailbox, or IMAP/SMTP login). */
export interface ProbeLeg {
  ok: boolean;
  detail: string;
}

/** Semantic 422 (probe-fail) for ``POST /api/accounts/microsoft``: the body
 * carries ``ok:false`` and per-leg detail. Discriminated from the
 * body-validation 422 by the presence of ``ok``. */
export interface GraphProbeResult {
  ok: false;
  token: ProbeLeg;
  mailbox: ProbeLeg;
}

/** Semantic 422 (probe-fail) for ``POST /api/accounts/imap``. */
export interface ImapProbeResult {
  ok: false;
  imap: ProbeLeg;
  smtp: ProbeLeg;
}

/** 200 ``mode:'test'`` success — green probe, nothing persisted. The leg
 * shapes vary by provider (token/mailbox vs imap/smtp); kept loose here since
 * the page only needs ``ok``/``tested`` on the happy path. */
export interface MailTestResult {
  ok: true;
  tested: true;
  token?: ProbeLeg;
  mailbox?: ProbeLeg;
  imap?: ProbeLeg;
  smtp?: ProbeLeg;
}

/** 200 ``mode:'connect'`` success — account persisted (secret encrypted at
 * rest). ``account_id`` is a uuid4 hex string. */
export interface MailConnectSuccess {
  ok: true;
  account_id: string;
  provider: "microsoft" | "imap";
}

/** Pydantic body-validation 422 ``{ detail:[...] }`` — discriminated from the
 * probe-fail shape by the absence of ``ok`` and presence of ``detail``. */
export interface ValidationError {
  detail: Array<{ loc: (string | number)[]; msg: string; type: string }>;
}

/** 500 persist failure (incl. ``crypto_configured=false`` on a connect). */
export interface MailConnectError {
  ok: false;
  error: string;
}

/** Every body {@link mailConnectFetch} may resolve with across 200 + 422. The
 * page narrows by: ``ok:false`` present and a leg key (``token``/``imap``) =>
 * probe-fail; ``detail`` array present => validation error; ``ok:true`` +
 * ``tested`` => green test; ``ok:true`` + ``account_id`` => persisted connect. */
export type MailConnectResponse =
  | MailTestResult
  | MailConnectSuccess
  | GraphProbeResult
  | ImapProbeResult
  | ValidationError
  | MailConnectError;

/** A connected mail account as returned by ``GET /api/accounts/mail``. Never
 * includes any secret. */
export interface MailAccount {
  id: string;
  provider: "microsoft" | "imap";
  email: string;
  display_label: string | null;
  mailbox: string | null;
  /** Whether this is the default inbox (MBOX-470). Exactly one account is the
   * default; the registry sorts it first and badges it. Registry metadata only —
   * no send/receive runtime reads it yet (same boundary as MBOX-468). */
  is_default: boolean;
  connected_at: string | null;
}

/** Body for ``PATCH /api/accounts/mail/{id}`` (MBOX-470 registry mutation). All
 * fields optional: relabel, set-default, or both in one call. ``display_label``
 * present-but-``null`` clears the label; omit a field to leave it unchanged. */
export interface MailAccountUpdateBody {
  display_label?: string | null;
  make_default?: boolean;
}

/** Response shape for ``GET /api/accounts/mail``. ``crypto_configured`` is
 * ``false`` when at-rest secret encryption isn't set up — a ``mode:'connect'``
 * will 500 in that case, so the page disables Connect. */
export interface MailAccountsResponse {
  accounts: MailAccount[];
  crypto_configured: boolean;
}

// ── First-run onboarding wizard (MBOX-471 + MBOX-484) ────────────────────────

/** One wizard step descriptor from ``GET /api/onboarding/state``. ``stage`` is
 * the persisted stage the step sits on; consecutive steps may share a stage
 * (welcome+password, profile+network-check) — those navigate client-side with
 * no ``advance`` call. */
export interface OnboardingStep {
  slug: string;
  title: string;
  intent: string;
  stage: string;
  allows_back: boolean;
}

/** Response shape for ``GET /api/onboarding/state``. */
export interface OnboardingState {
  stage: string;
  active_mailbox: string | null;
  lived_at: string | null;
  steps: OnboardingStep[];
  stages: string[];
}

/** Request body for ``POST /api/onboarding/advance``. ``from_stage`` is the
 * wizard's view of the current stage (the concurrency guard); ``to_stage`` is
 * the adjacent stage to move to. */
export interface OnboardingAdvanceBody {
  from_stage: string;
  to_stage: string;
}

/** Body resolved by {@link onboardingAdvanceFetch} across 200 + 409. 200 =>
 * ``{ ok:true, stage }``; 409 => ``{ error:'stale_from'|'invalid_transition', ... }``. */
export type OnboardingAdvanceResponse =
  | { ok: true; stage: string }
  | {
      error: "stale_from" | "invalid_transition";
      actual?: string;
      expected?: string;
      from?: string;
      to?: string;
    };

/** Daily digest payload returned by ``GET /api/digest/latest`` (Phase 3).
 *
 * All content fields are nullable: when no digest has been produced yet the
 * endpoint returns 200 with every field null except ``source``. ``markdown``
 * is the raw digest body; ``generated_at`` is the producer's write time
 * (ISO 8601). */
export interface DigestResponse {
  date: string | null;
  title: string | null;
  markdown: string | null;
  source: string;
  /** Entity-source slug the digest was scoped to (Phase 5); null/absent = combined. */
  entity?: string | null;
  generated_at: string | null;
}

export interface CustomNewsSource {
  id: string;
  label: string;
  url: string;
}

/** Operator-chosen digest modules + news sources (persisted server-side). */
export interface DigestPrefs {
  modules: {
    summary: boolean;
    emails: boolean;
    action_items: boolean;
    tasks: boolean;
    calendar: boolean;
    news: boolean;
  } & Record<string, boolean>;
  news_sources: string[];
  custom_sources: CustomNewsSource[];
}

/** Derived age metrics attached to each board task (seconds, or null when
 *  the underlying timestamp is unset). See ``kanban_db.task_age``. */
export interface KanbanTaskAge {
  created_age_seconds: number | null;
  started_age_seconds: number | null;
  time_to_complete_seconds: number | null;
}

/** Native kanban task (``GET /api/plugins/kanban/board`` + task endpoints).
 *
 *  Priority semantics — VERIFIED against ``hermes_cli/kanban_db.py``: plain
 *  integer where HIGHER = MORE URGENT. The canonical "priority" sort is
 *  ``priority DESC, created_at ASC`` (``VALID_SORT_ORDERS``) and the
 *  dispatcher claims work ``ORDER BY priority DESC``; default is ``0``.
 *  Note this is the OPPOSITE direction of Linear's scale (``LinearIssue``
 *  above, where 1 = urgent).
 *
 *  Typed fields cover what our views read; the plugin attaches more
 *  (diagnostics, progress, workflow fields…) kept reachable through the
 *  index signature for forward-compat. */
export interface KanbanTask {
  id: string;
  title: string;
  status: string;
  priority: number;
  assignee: string | null;
  tenant: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  body?: string | null;
  age?: KanbanTaskAge;
  /** ~200-char preview of the latest run summary (board payload only). */
  latest_summary?: string | null;
  comment_count?: number;
  link_counts?: { parents: number; children: number };
  /** Legacy digest fields (HomePage FYI section). */
  profile?: string;
  owner?: string;
  [k: string]: unknown;
}
export interface KanbanBoard {
  columns: Array<{ name: string; tasks: KanbanTask[] }>;
  tenants: string[];
  assignees: string[];
  latest_event_id: number;
  now: number;
}

/** ``POST /api/plugins/kanban/tasks`` (plugin ``CreateTaskBody``). */
export interface KanbanCreateTaskBody {
  title: string;
  body?: string;
  assignee?: string;
  tenant?: string;
  /** Higher = more urgent (see {@link KanbanTask}); server default 0. */
  priority?: number;
  workspace_kind?: string;
  workspace_path?: string;
  parents?: string[];
  triage?: boolean;
  idempotency_key?: string;
  max_runtime_seconds?: number;
  skills?: string[];
}

/** ``PATCH /api/plugins/kanban/tasks/:id`` (plugin ``UpdateTaskBody``).
 *  ``assignee: ""`` unassigns. The API rejects ``status: "running"``
 *  (dispatcher-owned) and doesn't accept ``"review"`` as a target. */
export interface KanbanUpdateTaskBody {
  status?: string;
  assignee?: string;
  priority?: number;
  title?: string;
  body?: string;
  result?: string;
  block_reason?: string;
  summary?: string;
}

/** ``POST /api/plugins/kanban/tasks/bulk`` (plugin ``BulkTaskBody``).
 *  Per-id outcomes — one bad id doesn't abort siblings. */
export interface KanbanBulkUpdateBody {
  ids: string[];
  status?: string;
  /** ``""`` unassigns. */
  assignee?: string;
  priority?: number;
  archive?: boolean;
  reclaim_first?: boolean;
}
export interface KanbanBulkUpdateResponse {
  results: Array<{ id: string; ok: boolean; error?: string }>;
}

/** One entry from ``GET /api/plugins/kanban/assignees``
 *  (``kanban_db.known_assignees``): every configured profile on disk plus
 *  any name holding a non-archived task. */
export interface KanbanAssignee {
  name: string;
  on_disk: boolean;
  /** Non-archived task counts keyed by status. */
  counts: Record<string, number>;
}

/** Org Chart Tasks provider selection (persisted server-side). */
export type TaskProviderId = "native" | "linear";
export interface TasksPrefs {
  provider: TaskProviderId;
  linear_team_id: string | null;
  /** Whether LINEAR_API_KEY is set on the box (Settings -> Keys). */
  linear_configured: boolean;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}
export interface LinearTeamsResponse {
  connected: boolean;
  teams: LinearTeam[];
  reason?: string;
}

/** Client-side filter model for the native Tasks list (PRD §2.1). Saved
 *  views persist exactly this shape in the sidecar meta store, so the
 *  backend validates against the same key set. */
export interface KanbanFilterState {
  /** Status names; empty = all (same empty-means-all rule per list). */
  statuses: string[];
  assignees: string[];
  tenants: string[];
  /** Label ids (filterable from Phase 3). */
  labels: string[];
  /** Cycle id (filterable from Phase 3). */
  cycleId: string | null;
  /** Case-insensitive substring over title + id. */
  text: string;
  overdueOnly: boolean;
}

/** One task's sidecar entry (``kanban-meta.json`` ``tasks`` values).
 *  Absent field = unset — the store never persists nulls. */
export interface KanbanTaskMeta {
  /** ISO date (YYYY-MM-DD), no time component, local-tz semantics. */
  due_at?: string;
  labels?: string[];
  /** Points, int 0–100. */
  estimate?: number;
  cycle_id?: string;
}

export interface KanbanLabel {
  id: string;
  name: string;
  /** #rrggbb. */
  color: string;
}

export interface KanbanCycle {
  id: string;
  name: string;
  /** ISO dates; start <= end (server-enforced). */
  start: string;
  end: string;
}

export interface KanbanSavedView {
  id: string;
  name: string;
  filters: KanbanFilterState;
}

/** ``GET /api/tasks/meta`` — the whole sidecar doc, defaults merged. */
export interface KanbanMeta {
  version: number;
  tasks: Record<string, KanbanTaskMeta>;
  labels: KanbanLabel[];
  cycles: KanbanCycle[];
  views: KanbanSavedView[];
}

/** ``PATCH /api/tasks/meta/tasks/:id`` — ``null`` clears a field; the
 *  entry disappears once every field is cleared. */
export interface KanbanTaskMetaPatch {
  due_at?: string | null;
  labels?: string[] | null;
  estimate?: number | null;
  cycle_id?: string | null;
}

/** ``PUT /api/tasks/meta``: each provided array fully replaces the stored
 *  one. ``prune_missing`` + ``live_task_ids`` is the lazy GC (PRD §2.2):
 *  the server drops task entries whose id isn't in the live list the
 *  client just fetched from the board. */
export interface KanbanMetaPut {
  labels?: KanbanLabel[];
  cycles?: KanbanCycle[];
  views?: KanbanSavedView[];
  prune_missing?: boolean;
  live_task_ids?: string[];
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  /** Linear priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number;
  updated_at: string;
  state: string;
  assignee: string | null;
  project: string | null;
}
export interface LinearBoard {
  connected: boolean;
  reason?: string;
  team?: string | null;
  columns: Array<{ name: string; issues: LinearIssue[] }>;
}

/** Operations > Conversations: parsed Gemini meeting-notes emails. */
export interface ConversationStep {
  owners: string[];
  title: string;
  text: string;
}
export interface ConversationSection {
  heading: string;
  text: string;
}
export interface Conversation {
  id: number;
  account: string;
  received_at: string | null;
  title: string;
  /** Human date string from the subject line, e.g. "Jun 10, 2026". */
  meeting_date: string;
  summary: string;
  sections: ConversationSection[];
  next_steps: ConversationStep[];
}
export interface ConversationsResponse {
  conversations: Conversation[];
  reason?: string;
}

export interface CalendarEvent {
  id?: string;
  title?: string;
  start?: string;
  end?: string;
  location?: string;
}
export interface DigestCalendar {
  connected: boolean;
  events: CalendarEvent[];
}

/** Daily brief, real-data sources (`GET /api/digest/brief`).
 *
 *  Top of Mind = Gmail unread/primary; On Your Calendar = Google Calendar
 *  today. Both come from the operator's google-workspace credentials. When
 *  Google isn't connected, `connected` is false and both lists are empty (the
 *  UI shows a "Connect Google" prompt). The brief's third section, FYI, is the
 *  local Kanban board — fetched separately via `getKanbanBoard`. */
/** One "most important" email picked for an inbox's Top of Mind. */
export interface InboxRankItem {
  id: number;
  message_id: string;
  subject: string;
  from_addr: string;
  snippet: string;
  received_at: string | null;
  /** Set when the pipeline already drafted a reply → deep-link to the review panel. */
  draft_id: number | null;
  is_read: boolean;
  /** One-line "why this matters" from the ranking model (may be empty). */
  reason: string;
  /** Gmail web link to open the message. */
  link: string;
}
export interface InboxRankGroup {
  account_id: number;
  account: string;
  items: InboxRankItem[];
  error: string | null;
}
export interface InboxRanking {
  inboxes: InboxRankGroup[];
  error?: string | null;
}

export interface BriefEmail {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  date: string;
  unread: boolean;
  link: string;
  /** Source account email this message came from (combined view tagging). */
  account: string;
}
export interface BriefEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string;
  link: string;
  /** Source account email this event came from (combined view tagging). */
  account: string;
}
export interface DigestBrief {
  connected: boolean;
  /** Every connected Google account email. */
  accounts: string[];
  /** "combined" or the email of the active view. */
  selected: string;
  gmail: { messages: BriefEmail[]; error: string | null };
  calendar: { events: BriefEvent[]; error: string | null };
}

/** A Google Calendar event for the Calendar tab (`GET /api/google/calendar`).
 *  ``start``/``end`` are ISO datetimes for timed events or "YYYY-MM-DD" for
 *  all-day ones. ``link`` opens the event in Google Calendar. */
export interface GoogleCalEvent {
  id: string;
  /** Source account email this event came from (combined view tagging). */
  account: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string;
  description: string;
  link: string;
  /** Attendee emails on the event (so the edit form can pre-load them). */
  attendees: string[];
}
/** Payload for creating / updating a calendar event. ``account`` chooses which
 *  connected account's primary calendar to write to (blank = primary). Timed
 *  events send RFC3339 ``start``/``end`` with offset; all-day events send
 *  ``YYYY-MM-DD`` with an exclusive ``end``. */
export interface GoogleCalEventInput {
  account?: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location?: string;
  description?: string;
  timezone?: string;
  /** Attendee emails to invite. */
  attendees?: string[];
  /** When true, Google emails attendees an invite; false adds them silently. */
  send_updates?: boolean;
}
export interface GoogleCalEventMutation {
  event?: GoogleCalEvent;
  error: string | null;
}
export interface GoogleCalendarResponse {
  connected: boolean;
  /** Every connected Google account email. */
  accounts: string[];
  /** "combined" or the email of the active view. */
  selected: string;
  /** Events sorted by ``start`` ascending. */
  events: GoogleCalEvent[];
  error: string | null;
}

/** A Google Drive file for the Drive tab (`GET /api/google/drive`).
 *  ``webViewLink`` opens the file in Drive. */
export interface GoogleDriveFile {
  id: string;
  /** Source account email this file came from (combined view tagging). */
  account: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  iconLink: string;
  webViewLink: string;
  owners: string[];
  folder: boolean;
}
export interface GoogleDriveResponse {
  connected: boolean;
  /** Every connected Google account email. */
  accounts: string[];
  /** "combined" or the email of the active view. */
  selected: string;
  /** Files sorted by ``modifiedTime`` descending. */
  files: GoogleDriveFile[];
  error: string | null;
}

export interface NewsSource {
  id: string;
  label: string;
  /** True for operator-added feeds (vs the built-in whitelist). */
  custom?: boolean;
  /** Present for custom feeds. */
  url?: string;
}

export interface NewsItem {
  title: string;
  link: string;
  summary: string;
  published: string;
  source: string;
  source_id: string;
  /** Best-effort thumbnail URL (Media RSS / enclosure / inline <img>); "" when none. */
  image?: string;
}

export interface NewsResponse {
  items: NewsItem[];
  total: number;
  has_more: boolean;
}

/** Per-call overrides for {@link fetchJSON}. */
interface FetchJSONOptions {
  /** When true, a 401 response is surfaced as a normal thrown error rather
   *  than triggering the loopback stale-token page reload. Use for probes
   *  whose 401 is an expected signal (e.g. /api/auth/me in non-gated mode)
   *  rather than evidence of a rotated session token. */
  allowUnauthorized?: boolean;
}

export interface ActionStatusResponse {
  exit_code: number | null;
  lines: string[];
  name: string;
  pid: number | null;
  running: boolean;
}

export interface PlatformStatus {
  error_code?: string;
  error_message?: string;
  state: string;
  updated_at: string;
}

export interface StatusResponse {
  active_sessions: number;
  /** Phase 7: ``true`` when the dashboard's OAuth gate is engaged
   * (public bind, no ``--insecure``). Read alongside ``auth_providers``
   * to render a "gated / loopback" badge. */
  auth_required?: boolean;
  /** Phase 7: registered ``DashboardAuthProvider`` names (e.g. ``["nous"]``).
   * Empty in loopback mode; empty + ``auth_required=true`` is a
   * fail-closed state (the dashboard will refuse to bind). */
  auth_providers?: string[];
  config_path: string;
  config_version: number;
  env_path: string;
  gateway_exit_reason: string | null;
  gateway_health_url: string | null;
  gateway_pid: number | null;
  gateway_platforms: Record<string, PlatformStatus>;
  gateway_running: boolean;
  gateway_state: string | null;
  gateway_updated_at: string | null;
  hermes_home: string;
  latest_config_version: number;
  release_date: string;
  version: string;
}

// ── Operator status (MBOX-478) ───────────────────────────────────────────────
// The aggregation endpoint returns hermes-native metrics it gathers directly
// plus the mailbox-pipeline snapshot it proxies from the on-box
// mailbox-dashboard. The pipeline ``data`` shape mirrors the upstream
// /dashboard/api/system/status payload; fields are optional/nullable because
// each upstream sub-fetch degrades to null independently.

export interface OperatorDiskFree {
  available: boolean;
  path: string;
  free_bytes?: number;
  total_bytes?: number;
  reason?: string;
}

export interface OperatorStatusNative {
  disk_free: OperatorDiskFree;
  uptime_seconds: number;
}

/** Git state of the appliance repo (proxied from mailbox). */
export interface OperatorGitState {
  available: boolean;
  reason?: string | null;
  git_branch?: string | null;
  git_short_sha?: string | null;
  commits_behind_master?: number | null;
  commits_ahead_master?: number | null;
  fetch_age_seconds?: number | null;
  dirty?: boolean | null;
}

export interface OperatorOllamaModel {
  name: string;
  size_vram?: number;
}

export interface OperatorCloudSpend {
  total_usd: number;
  call_count: number;
  by_source?: Record<string, { total_usd: number; call_count: number }>;
}

export interface OperatorDraftCounts {
  total: number;
  sent: number;
  pending: number;
  failed: number;
  rejected: number;
}

export interface OperatorQdrantHealth {
  exists: boolean;
  points_count?: number | null;
}

export interface OperatorStatusAlert {
  code: string;
  severity: string;
  message: string;
}

/** The proxied mailbox snapshot — mirrors /dashboard/api/system/status. All
 * fields optional/nullable: each upstream sub-fetch degrades independently. */
export interface OperatorPipelineSnapshot {
  uptime_seconds?: number;
  queue_depth?: number | null;
  last_error?: string | null;
  last_error_at?: string | null;
  last_inference_latency_ms?: number | null;
  last_inference_at?: string | null;
  last_email_received_at?: string | null;
  n8n_workflow_active?: number | null;
  disk_free_bytes?: number | null;
  disk_total_bytes?: number | null;
  ollama_models_loaded?: OperatorOllamaModel[] | null;
  drafts_24h?: OperatorDraftCounts | null;
  cloud_spend_24h?: OperatorCloudSpend | null;
  qdrant_collection?: OperatorQdrantHealth | null;
  alerts?: OperatorStatusAlert[];
  git_state?: OperatorGitState;
  generated_at?: string;
}

/** Pipeline-proxy degradation discriminant (MBOX-478). ``available`` is kept
 * for backward compat (true only when ``status === "ok"``). */
export type OperatorPipelineStatus =
  | "ok"
  | "unreachable"
  | "upstream_error"
  | "non_json";

export interface OperatorPipeline {
  status?: OperatorPipelineStatus;
  available: boolean;
  reason?: string;
  data?: OperatorPipelineSnapshot;
}

export interface OperatorStatusGap {
  metric: string;
  reason: string;
}

export interface OperatorStatusResponse {
  native: OperatorStatusNative;
  pipeline: OperatorPipeline;
  gaps: OperatorStatusGap[];
  generated_at: string;
}

export interface SessionInfo {
  id: string;
  source: string | null;
  model: string | null;
  title: string | null;
  started_at: number;
  ended_at: number | null;
  last_active: number;
  is_active: boolean;
  message_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  preview: string | null;
  parent_session_id?: string | null;
}

export interface SessionLatestDescendantResponse {
  requested_session_id: string;
  session_id: string;
  path: string[];
  changed: boolean;
}

export interface PaginatedSessions {
  sessions: SessionInfo[];
  total: number;
  limit: number;
  offset: number;
}

export interface EnvVarInfo {
  is_set: boolean;
  redacted_value: string | null;
  description: string;
  url: string | null;
  category: string;
  is_password: boolean;
  tools: string[];
  advanced: boolean;
}

export interface SessionMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  tool_name?: string;
  tool_call_id?: string;
  timestamp?: number;
}

export interface SessionMessagesResponse {
  session_id: string;
  messages: SessionMessage[];
}

export interface LogsResponse {
  file: string;
  lines: string[];
}

export interface AnalyticsDailyEntry {
  day: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  reasoning_tokens: number;
  estimated_cost: number;
  actual_cost: number;
  sessions: number;
  api_calls: number;
}

export interface AnalyticsModelEntry {
  model: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
  sessions: number;
  api_calls: number;
}

export interface AnalyticsSkillEntry {
  skill: string;
  view_count: number;
  manage_count: number;
  total_count: number;
  percentage: number;
  last_used_at: number | null;
}

export interface AnalyticsSkillsSummary {
  total_skill_loads: number;
  total_skill_edits: number;
  total_skill_actions: number;
  distinct_skills_used: number;
}

export interface AnalyticsResponse {
  daily: AnalyticsDailyEntry[];
  by_model: AnalyticsModelEntry[];
  totals: {
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_reasoning: number;
    total_estimated_cost: number;
    total_actual_cost: number;
    total_sessions: number;
    total_api_calls: number;
  };
  skills: {
    summary: AnalyticsSkillsSummary;
    top_skills: AnalyticsSkillEntry[];
  };
}

export interface ProfileInfo {
  name: string;
  path: string;
  is_default: boolean;
  model: string | null;
  provider: string | null;
  has_env: boolean;
  skill_count: number;
}

export interface ModelsAnalyticsModelEntry {
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  reasoning_tokens: number;
  estimated_cost: number;
  actual_cost: number;
  sessions: number;
  api_calls: number;
  tool_calls: number;
  last_used_at: number;
  avg_tokens_per_session: number;
  capabilities: {
    supports_tools?: boolean;
    supports_vision?: boolean;
    supports_reasoning?: boolean;
    context_window?: number;
    max_output_tokens?: number;
    model_family?: string;
  };
}

export interface ModelsAnalyticsResponse {
  models: ModelsAnalyticsModelEntry[];
  totals: {
    distinct_models: number;
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_reasoning: number;
    total_estimated_cost: number;
    total_actual_cost: number;
    total_sessions: number;
    total_api_calls: number;
  };
  period_days: number;
}

export interface CronOutput {
  job_id: string;
  job_name: string;
  timestamp: string;
  ran_at: string | null;
  output: string;
  size: number;
  last_status: string | null;
  profile?: string;
}

export interface CronJob {
  id: string;
  profile?: string | null;
  profile_name?: string | null;
  hermes_home?: string | null;
  is_default_profile?: boolean;
  name?: string | null;
  prompt?: string | null;
  // Operator's end-goal for the job (persisted; seeds the Outcome box on edit).
  objective?: string | null;
  script?: string | null;
  schedule?: { kind?: string; expr?: string; display?: string };
  schedule_display?: string | null;
  enabled: boolean;
  state?: string | null;
  deliver?: string | null;
  // Per-job model override (null = box default at run time) + its pinned provider.
  model?: string | null;
  provider?: string | null;
  last_run_at?: string | null;
  next_run_at?: string | null;
  last_error?: string | null;
  // CRM assignment (soft links into the mailbox-dashboard CRM).
  department_id?: number | null;
  department_name?: string | null;
  employee_id?: number | null;
  employee_name?: string | null;
}

/** One turn in the job-template builder conversation. */
export interface CronTemplateMessage {
  role: "user" | "assistant";
  content: string;
}

/** A structured job draft the builder proposes once it has enough detail. */
export interface CronTemplateProposal {
  name: string;
  prompt: string;
  schedule: string;
  deliver: string;
  /** True when prompt + schedule are present and the assistant marked it ready. */
  ready: boolean;
}

/** Response from the LLM-assisted template builder endpoint. */
export interface CronTemplateAssistResult {
  reply: string;
  proposal: CronTemplateProposal | null;
}

// Agent Templates — reusable blueprints the Agent Jobs UI builds new jobs from.
// Served by /api/cron/templates (hermes_cli/agent_templates.py).
export interface AgentTemplateSummary {
  id: string;
  name: string;
  summary: string;
  category: string; // "pattern" | "instance"
  hardware_tier: string;
  tier_label: string;
  tags: string[];
  node_count: number;
}

export interface AgentTemplateNode {
  n: string;
  node: string;
  probabilistic: boolean;
  capability: string;
  routing_t2: string;
  artifact: string;
}

export interface AgentTemplatePrimitive {
  key: string;
  title: string;
  desc: string;
}

export interface AgentTemplateRoutingRow {
  tier: string;
  resident: string;
  default: string;
}

export interface AgentTemplateDefaults {
  name: string;
  objective: string;
  prompt: string;
  schedule: string;
  deliver: string;
  model: string;
  provider: string;
  skills: string[];
  enabled_toolsets: string[];
}

export interface AgentTemplate extends Omit<AgentTemplateSummary, "node_count"> {
  primitives: AgentTemplatePrimitive[];
  routing_table: AgentTemplateRoutingRow[];
  optimizations: string[];
  nodes: AgentTemplateNode[];
  safety: string[];
  open_questions: string[];
  defaults: AgentTemplateDefaults;
  provenance: {
    spec: string;
    status: string;
    tier: string;
    tier_label: string;
    note: string;
  };
}

export interface SkillInfo {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
}

export interface ToolsetInfo {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  tools: string[];
}

export interface SessionSearchResult {
  session_id: string;
  snippet: string;
  role: string | null;
  source: string | null;
  model: string | null;
  session_started: number | null;
}

export interface SessionSearchResponse {
  results: SessionSearchResult[];
}

// ── Model info types ──────────────────────────────────────────────────

export interface ModelInfoResponse {
  model: string;
  provider: string;
  auto_context_length: number;
  config_context_length: number;
  effective_context_length: number;
  capabilities: {
    supports_tools?: boolean;
    supports_vision?: boolean;
    supports_reasoning?: boolean;
    context_window?: number;
    max_output_tokens?: number;
    model_family?: string;
  };
}

// ── Model options / assignment types ──────────────────────────────────

export interface ModelOptionProvider {
  name: string;
  slug: string;
  models?: string[];
  total_models?: number;
  is_current?: boolean;
  is_user_defined?: boolean;
  source?: string;
  warning?: string;
}

export interface ModelOptionsResponse {
  model?: string;
  provider?: string;
  providers?: ModelOptionProvider[];
}

export interface AuxiliaryTaskAssignment {
  task: string;
  provider: string;
  model: string;
  base_url: string;
}

export interface AuxiliaryModelsResponse {
  tasks: AuxiliaryTaskAssignment[];
  main: { provider: string; model: string };
}

export interface ModelAssignmentRequest {
  scope: "main" | "auxiliary";
  provider: string;
  model: string;
  /** For auxiliary: task slot name, "" for all, "__reset__" to reset all. */
  task?: string;
}

export interface ModelAssignmentResponse {
  ok: boolean;
  scope?: string;
  provider?: string;
  model?: string;
  tasks?: string[];
  reset?: boolean;
}

// ── OAuth provider types ────────────────────────────────────────────────

export interface OAuthProviderStatus {
  logged_in: boolean;
  source?: string | null;
  source_label?: string | null;
  token_preview?: string | null;
  expires_at?: string | null;
  has_refresh_token?: boolean;
  last_refresh?: string | null;
  error?: string;
}

export interface OAuthProvider {
  id: string;
  name: string;
  /** "pkce" (browser redirect + paste code), "device_code" (show code + URL),
   *  or "external" (delegated to a separate CLI like Claude Code or Qwen). */
  flow: "pkce" | "device_code" | "external";
  cli_command: string;
  docs_url: string;
  status: OAuthProviderStatus;
}

export interface OAuthProvidersResponse {
  providers: OAuthProvider[];
}

/** Discriminated union — the shape of /start depends on the flow. */
export type OAuthStartResponse =
  | {
      session_id: string;
      flow: "pkce";
      auth_url: string;
      expires_in: number;
    }
  | {
      session_id: string;
      flow: "device_code";
      user_code: string;
      verification_url: string;
      expires_in: number;
      poll_interval: number;
    };

export interface OAuthSubmitResponse {
  ok: boolean;
  status: "approved" | "error";
  message?: string;
}

export interface OAuthPollResponse {
  session_id: string;
  status: "pending" | "approved" | "denied" | "expired" | "error";
  error_message?: string | null;
  expires_at?: number | null;
}

// ── Dashboard theme types ──────────────────────────────────────────────

export interface DashboardThemeSummary {
  description: string;
  label: string;
  name: string;
  /** Full theme definition for user themes; undefined for built-ins
   *  (which the frontend already has locally). */
  definition?: DashboardTheme;
}

export interface DashboardThemesResponse {
  active: string;
  themes: DashboardThemeSummary[];
}

// ── Dashboard plugin types ─────────────────────────────────────────────

export interface PluginManifestResponse {
  name: string;
  label: string;
  description: string;
  icon: string;
  version: string;
  tab: {
    path: string;
    position?: string;
    override?: string;
    hidden?: boolean;
  };
  slots?: string[];
  entry: string;
  css?: string | null;
  has_api: boolean;
  source: string;
}

export interface HubAgentPluginRow {
  name: string;
  version: string;
  description: string;
  source: string;
  runtime_status: "disabled" | "enabled" | "inactive";
  has_dashboard_manifest: boolean;
  dashboard_manifest: PluginManifestResponse | null;
  path: string;
  can_remove: boolean;
  can_update_git: boolean;
  auth_required: boolean;
  auth_command: string;
  user_hidden: boolean;
}

export interface PluginsHubProviders {
  memory_provider: string;
  memory_options: Array<{ name: string; description: string }>;
  context_engine: string;
  context_options: Array<{ name: string; description: string }>;
}

export interface PluginsHubResponse {
  plugins: HubAgentPluginRow[];
  orphan_dashboard_plugins: PluginManifestResponse[];
  providers: PluginsHubProviders;
}

export interface AgentPluginInstallRequest {
  identifier: string;
  force?: boolean;
  enable?: boolean;
}

export interface AgentPluginInstallResponse {
  ok: boolean;
  plugin_name?: string;
  warnings?: string[];
  missing_env?: string[];
  after_install_path?: string | null;
  enabled?: boolean;
  error?: string;
}

export interface AgentPluginUpdateResponse {
  ok: boolean;
  name?: string;
  output?: string;
  unchanged?: boolean;
  error?: string;
}

export interface PluginProvidersPutRequest {
  memory_provider?: string;
  context_engine?: string;
}

// ── Unified Inbox types (Phase 1) ───────────────────────────────────────
// Shapes captured live from the mailbox-dashboard API (migration 045).
// Numeric ids are ``number``; timestamps are ISO strings; ``cost_usd`` is a
// string; jsonb arrays are typed ``unknown[]`` unless rendered. See
// CONTEXT-phase-1 §"API shape".

/** Valid ``drafts.status`` values (live ``DRAFT_STATUSES``). Phase 1 only
 * surfaces the user-facing subset in tabs; ``awaiting_cloud`` is an internal
 * transient state. */
export type InboxDraftStatus =
  | "pending"
  | "awaiting_cloud"
  | "approved"
  | "rejected"
  | "edited"
  | "sent";

/** Live ``REJECT_REASON_CODES`` (mailbox ``lib/types.ts``). ``free_text`` is
 * required iff the code is ``other``. */
export type InboxRejectReasonCode =
  | "wrong_tone"
  | "factually_inaccurate"
  | "missing_context"
  | "should_reply_myself"
  | "dont_reply"
  | "other";

/** The joined inbox-message object carried on every {@link DraftRow}. Keyed
 * by its own ``id`` — message actions (archive/snooze/mark-read) use THIS id,
 * not the draft id. */
export interface InboxMessage {
  id: number;
  message_id: string;
  thread_id: string | null;
  from_addr: string;
  to_addr: string;
  subject: string | null;
  received_at: string;
  snippet: string | null;
  body: string | null;
  classification: string | null;
  confidence: number | null;
  classified_at: string | null;
  model: string | null;
  created_at: string;
  draft_id: number | null;
  archived_at: string | null;
  deleted_at: string | null;
  snooze_until: string | null;
  is_read: boolean;
  gmail_action_state: string | null;
}

/** A connected inbox account (account-filter selector). */
export interface AccountRow {
  id: number;
  email_address: string;
  display_label: string | null;
  is_default: boolean;
}

/** Flattened draft + joined message + account + thread history — the single
 * row type driving both the inbox list and the detail pane. ``account`` is
 * present ONLY on the list endpoint (``/drafts``), not on ``/drafts/[id]``. */
export interface DraftRow {
  id: number;
  inbox_message_id: number;
  draft_subject: string | null;
  draft_body: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string | null;
  status: InboxDraftStatus;
  created_at: string;
  updated_at: string;
  error_message: string | null;
  approved_at: string | null;
  sent_at: string | null;
  draft_source: string | null;
  classification_category: string | null;
  classification_confidence: number | null;
  rag_context_refs: unknown[];
  auto_send_blocked: boolean;
  from_addr: string;
  to_addr: string;
  subject: string | null;
  body_text: string | null;
  received_at: string;
  message_id: string;
  thread_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  original_draft_body: string | null;
  rag_retrieval_reason: string | null;
  kb_context_refs: unknown[];
  last_retry_at: string | null;
  exemplar_refs: unknown[];
  sent_gmail_message_id: string | null;
  send_attempt_at: string | null;
  action_items: unknown[];
  scheduling_calendar_unavailable: boolean | null;
  account_id: number | null;
  provider_message_id: string | null;
  /** Post-045 channel discriminator (default ``email``). May be absent on
   * legacy pre-backfill rows — default to ``email`` defensively. */
  channel?: string | null;
  message: InboxMessage;
  /** Present only on the list endpoint. */
  account?: AccountRow;
  /** Prior messages in the thread (inbound + outbound), oldest-first. Built
   * server-side by ``getThreadHistory`` (mailbox-dashboard). */
  thread_history: ThreadHistoryMessage[];
}

/** One prior message in a draft's conversation thread. Shape mirrors the
 * mailbox-dashboard ``ThreadMessage`` union (inbound from ``inbox_messages``,
 * outbound from ``sent_history``), flattened for transport. */
export interface ThreadHistoryMessage {
  /** Source-table row id; string for inbound, number for outbound — display only. */
  id: number | string;
  direction: "inbound" | "outbound";
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  body: string | null;
  /** ISO-ish timestamp (``received_at`` / ``sent_at``). */
  at: string;
}

// ── Review-panel types (mirror mailbox-dashboard lib/types.ts) ────────────

export const INBOX_ACTION_ITEM_TYPES = [
  "commitment",
  "request",
  "deadline",
  "meeting",
] as const;
export type InboxActionItemType = (typeof INBOX_ACTION_ITEM_TYPES)[number];

export const INBOX_ACTION_ITEM_SOURCES = ["inbound", "outbound"] as const;
export type InboxActionItemSource = (typeof INBOX_ACTION_ITEM_SOURCES)[number];

/** Structured action item on a draft (jsonb array; whole-array replace). */
export interface ActionItem {
  text: string;
  type: InboxActionItemType;
  due_at: string | null;
  source: InboxActionItemSource;
  confidence: number;
  task_external_id?: string | null;
  task_external_url?: string | null;
  task_pushed_at?: string | null;
}

/** Canonical classification categories (mirror lib/classification/prompt.ts). */
export const INBOX_CATEGORIES = [
  "inquiry",
  "reorder",
  "scheduling",
  "follow_up",
  "internal",
  "spam_marketing",
  "escalate",
  "unknown",
] as const;
export type InboxCategory = (typeof INBOX_CATEGORIES)[number];

// ── Auto-send rules (MBOX-477) ───────────────────────────────────────────────
// Mirrors the mailbox-dashboard contract (lib/types.ts AutoSendRule + the zod
// surface in lib/schemas/auto-send.ts). The mailbox API is the source of truth;
// these types only describe the wire shapes the proxy passes through.

/** The action a matched rule declares. ``auto_send`` sends without operator
 * approval (still subject to the hard confidence + cooldown guardrails);
 * ``queue`` leaves the draft for manual review; ``drop`` rejects it. */
export const AUTO_SEND_ACTIONS = ["auto_send", "queue", "drop"] as const;
export type AutoSendAction = (typeof AUTO_SEND_ACTIONS)[number];

/** One auto-send rule row as the mailbox CRUD API returns it. ``min_confidence``
 * is a string because pg returns NUMERIC as a string; the time window is stored
 * as minutes-from-midnight (the UI round-trips to "HH:MM"). */
export interface AutoSendRule {
  id: number;
  name: string;
  enabled: boolean;
  priority: number;
  action: AutoSendAction;
  category: string | null;
  sender_domain: string | null;
  min_confidence: string | null;
  active_from_min: number | null;
  active_to_min: number | null;
  shadow_until: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

/** Create/update body. Conditions accept ``null`` (= match any / clear). The
 * time window is "HH:MM" strings, all-or-nothing (the mailbox schema enforces
 * both-or-neither and rejects equal endpoints). */
export interface AutoSendRuleBody {
  name?: string;
  enabled?: boolean;
  priority?: number;
  action?: AutoSendAction;
  category?: string | null;
  sender_domain?: string | null;
  min_confidence?: number | null;
  active_from?: string | null;
  active_to?: string | null;
}

export interface EmailSourceRef {
  source: "email";
  point_id: string;
  message_id: string;
  sender: string;
  recipient: string;
  subject: string | null;
  body_excerpt: string;
  sent_at: string;
  direction: "inbound" | "outbound";
  classification_category: string | null;
}

export interface KbSourceRef {
  source: "kb";
  point_id: string;
  doc_id: number;
  doc_title: string;
  chunk_index: number;
  mime_type: string;
  excerpt: string;
  uploaded_at: string;
}

export type SourceRef = EmailSourceRef | KbSourceRef;

export interface RagRefsResponse {
  reason: string;
  refs: SourceRef[];
  qdrant_error?: string;
  unresolved_point_ids?: string[];
  kb_qdrant_error?: string;
  kb_unresolved_point_ids?: string[];
}

export interface SenderHistory {
  sender: string;
  lookback_days: number;
  total_emails: number;
  drafts_approved: number;
  drafts_rejected: number;
  drafts_edited: number;
  drafts_sent: number;
  drafts_pending: number;
  mean_confidence: number | null;
  top_reject_reason: InboxRejectReasonCode | null;
}

export interface CrossAccountRow {
  account_id: number;
  account_email: string;
  account_label: string | null;
  total_emails: number;
  drafts_sent: number;
  last_seen_at: string | null;
}

/** One frame from the redraft SSE stream. */
export type RedraftStreamEvent =
  | { type: "token"; delta: string }
  | { type: "done"; [k: string]: unknown }
  | { type: "error"; code?: string; detail?: string };

/** POST a redraft turn and yield {@link RedraftStreamEvent}s as they stream.
 * Mirrors mailbox ``streamRedraft`` (SSE ``event:/data:`` framing) against the
 * mailbox-dashboard ``/dashboard/api/internal/draft-redraft`` endpoint. */
export async function* streamInboxRedraft(
  body: { draft_id: number; current_body: string; instruction: string },
  signal?: AbortSignal,
): AsyncGenerator<RedraftStreamEvent, void, unknown> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = window.__HERMES_SESSION_TOKEN__;
  if (token) setSessionHeader(headers, token);
  const res = await fetch(`${BASE}/dashboard/api/internal/draft-redraft`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    credentials: "include",
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) detail = j.error;
    } catch {
      /* non-JSON body — keep status detail */
    }
    yield { type: "error", code: "upstream_malformed", detail };
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = function* (frame: string): Generator<RedraftStreamEvent> {
    const ev = parseRedraftFrame(frame);
    if (ev) yield ev;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        yield* flush(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        sep = buffer.indexOf("\n\n");
      }
    }
    const tail = buffer.trim();
    if (tail) yield* flush(tail);
  } finally {
    reader.releaseLock();
  }
}

function parseRedraftFrame(frame: string): RedraftStreamEvent | null {
  let eventType = "";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!eventType || dataLines.length === 0) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
  return { type: eventType, ...payload } as RedraftStreamEvent;
}

export interface InboxDraftsResponse {
  drafts: DraftRow[];
  total: number;
}

export interface InboxAccountsResponse {
  accounts: AccountRow[];
}

// ── Drafting tuning / guidelines (MBOX-475) ────────────────────────────────
// Shapes for the Tuning page. These ride the same ``/dashboard/*`` reverse
// proxy as the inbox calls above; the bodies mirror the mailbox dashboard's
// ``/api/tuning/style`` + ``/api/prompt-rules`` contracts so the values stay
// the SAME data the mailbox drafting pipeline reads.

/** PUT /dashboard/api/tuning/style body + echo. ``StyleProfile`` lives in
 * ``@/lib/tuningStyle`` (the marker-subset shape). */
export interface TuningStyleResponse {
  style: import("@/lib/tuningStyle").StyleProfile;
}

/** A row from ``GET /dashboard/api/persona`` — used only to seed the Style tab
 * (``statistical_markers`` → ``markersToStyle``). The persona surface itself is
 * owned by MBOX-476; this read is the Style-seed dependency only. */
export interface TuningPersonaSeedResponse {
  persona: {
    statistical_markers?: Record<string, unknown> | null;
    [key: string]: unknown;
  } | null;
}

/** A single drafting guideline (mailbox ``prompt_rules`` row). */
export interface PromptRule {
  id: number;
  scope: import("@/lib/tuningStyle").PromptRuleScope;
  rule: string;
  rationale: string;
  enabled: boolean;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PromptRulesResponse {
  rules: PromptRule[];
}

export interface PromptRuleResponse {
  rule: PromptRule;
}

export interface PromptRuleCreateBody {
  scope: import("@/lib/tuningStyle").PromptRuleScope;
  rule: string;
  rationale?: string;
}

export interface PromptRuleUpdateBody {
  scope?: import("@/lib/tuningStyle").PromptRuleScope;
  rule?: string;
  rationale?: string;
  enabled?: boolean;
}

/** Result of POST .../approve — the ``transitionToApprovedAndSend`` JSON.
 * Shape is intentionally loose; the UI only needs success + optional error. */
export interface InboxApproveResult {
  success?: boolean;
  draft?: { id: number; status: InboxDraftStatus; error_message?: string | null };
  error?: string;
  [key: string]: unknown;
}

export interface InboxRejectResult {
  success: boolean;
  draft: { id: number; status: InboxDraftStatus };
}

export interface InboxEditResult {
  success: boolean;
  draft: {
    id: number;
    status: InboxDraftStatus;
    draft_body: string;
    draft_subject: string | null;
    updated_at: string;
  };
}

/** Gmail write-through result for archive/mark-read. Loose by design. */
export interface InboxMessageActionResult {
  success?: boolean;
  [key: string]: unknown;
}

export interface InboxSnoozeResult {
  success: boolean;
  id: number;
  snooze_until: string;
}

/** System-wide Gmail rate-limit cooldown (MBOX-481, ported from mailbox
 * GmailCooldownBanner / STAQPRO-331). Read from the on-box mailbox-dashboard
 * ``/api/system/gmail-cooldown`` GET — ``is_active`` is the operator gate; the
 * timestamps drive the banner's "next safe send" copy. All ISO-8601 or null. */
export interface InboxCooldownState {
  is_active: boolean;
  until: string | null;
  set_at: string | null;
  recommended_safe_at: string | null;
}

// ── Classifications (MBOX-472) ───────────────────────────────────────────────
// Mirrors the mailbox-dashboard ClassificationRow shape
// (lib/queries-classifications.ts). ``route`` is derived server-side from the
// category + confidence; ``draft_status`` is the joined draft outcome (null when
// the message produced no draft).

export type ClassificationRoute = "drop" | "local" | "cloud";

export type ClassificationDraftOutcome =
  | "pending"
  | "approved"
  | "sent"
  | "rejected"
  | "edited"
  | "failed"
  | null;

export interface ClassificationRow {
  log_id: string;
  classified_at: string;
  inbox_message_id: number;
  from_addr: string | null;
  subject: string | null;
  category: string;
  confidence: number;
  model_version: string;
  latency_ms: number | null;
  route: ClassificationRoute;
  draft_id: number | null;
  draft_status: ClassificationDraftOutcome;
  draft_sent_at: string | null;
}

/** Shape of GET /api/classifications. The mailbox list route may return either a
 * bare array or a ``{ rows }`` envelope; the page normalises both. */
export type ClassificationListResponse =
  | ClassificationRow[]
  | { rows: ClassificationRow[] };

/** Result of POST /api/classifications/reclassify-sender (MBOX-370). */
export interface ReclassifySenderResult {
  success: boolean;
  email: string;
  allowlisted: boolean;
  queued: number;
  capped: boolean;
  error?: string;
}

// ── Daily brief (MBOX-479) ───────────────────────────────────────────────────
// Mirrors the mailbox-dashboard DigestPayload widgets (lib/queries-digest.ts):
// pending counts by category, urgent-untouched drafts, and the oldest-waiting
// tail. Read through the hermes ``/api/daily-brief`` proxy → on-box
// mailbox-dashboard (same data-access model as Classifications / Job Outcomes;
// hermes_cli has no Postgres driver). The narrative digest the page also shows
// comes from the NATIVE ``/api/digest/latest`` (gbrain), not this proxy.

/** One pending-by-category bucket. ``category`` is null for unclassified. */
export interface BriefCategoryCount {
  category: string | null;
  count: number;
}

/** A lean draft row as the brief lists it (urgent + oldest-waiting sections). */
export interface BriefDraftItem {
  draft_id: number;
  from_addr: string | null;
  subject: string | null;
  category: string | null;
  age_hours: number;
  signals: string[];
}

/** GET /api/daily-brief — the mailbox pipeline rollup the brief renders. All
 * lists default to empty so an upstream that is absent (404) or unreachable
 * degrades to a clean empty brief rather than an error surface. */
export interface DailyBriefResponse {
  counts_by_category: BriefCategoryCount[];
  urgent_untouched: BriefDraftItem[];
  oldest_pending: BriefDraftItem[];
  health?: { sent_24h?: number; stuck_approved?: number };
}

// ── Persona voice tuning (MBOX-476) ──────────────────────────────────────
// Shapes for the mailbox ``persona`` row surfaced through the proxy. The two
// JSONB columns are the application contract for the drafting pipeline's voice;
// they carry arbitrary operator-edited keys, so they stay ``Record`` here and
// the page edits them as raw JSON (same as the mailbox surface).

/** The mailbox ``persona`` row — the voice fingerprint the drafting pipeline
 * reads. ``statistical_markers`` holds the voice profile (sentence length,
 * sign-offs, tone, reject-feedback signals); ``category_exemplars`` holds the
 * per-route few-shot pairs. Both are JSONB — untyped here by design. */
export interface PersonaRow {
  id: number;
  customer_key: string;
  statistical_markers: Record<string, unknown>;
  category_exemplars: Record<string, unknown>;
  source_email_count: number;
  last_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** GET/PUT ``/dashboard/api/persona`` — ``persona`` is null when no row exists
 * yet (first save/refresh creates it). */
export interface PersonaResponse {
  persona: PersonaRow | null;
}

/** POST ``/dashboard/api/persona/refresh`` — the re-extracted persona plus how
 * many ``sent_history`` rows it learned from. */
export interface PersonaRefreshResponse {
  persona: PersonaRow;
  source_email_count: number;
}
