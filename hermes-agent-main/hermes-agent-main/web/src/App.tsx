import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Routes,
  Route,
  NavLink,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  Building2,
  CalendarDays,
  Contact,
  HardDrive,
  Home as HomeIcon,
  Inbox,
  Menu,
  MessageSquare,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCw,
  Settings,
  Star,
  X,
} from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { SelectionSwitcher } from "@nous-research/ui/ui/components/selection-switcher";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Typography } from "@nous-research/ui/ui/components/typography/index";
import { cn } from "@/lib/utils";
import { Backdrop } from "@/components/Backdrop";
import ChatDock, { clampChatWidth, CHAT_WIDTH_DEFAULT } from "@/components/ChatDock";
import { SidebarFooter } from "@/components/SidebarFooter";
import { SidebarStatusStrip, gatewayLine } from "@/components/SidebarStatusStrip";
import { useBelowBreakpoint } from "@nous-research/ui/hooks/use-below-breakpoint";
import { useSidebarStatus } from "@/hooks/useSidebarStatus";
import { AuthWidget } from "@/components/AuthWidget";
import { PageHeaderProvider } from "@/contexts/PageHeaderProvider";
import { AccountViewProvider } from "@/contexts/AccountViewProvider";
import { useSystemActions } from "@/contexts/useSystemActions";
import type { SystemAction } from "@/contexts/system-actions-context";
import ConfigPage from "@/pages/ConfigPage";
import DocsPage from "@/pages/DocsPage";
import EnvPage from "@/pages/EnvPage";
import ConnectionsPage from "@/pages/ConnectionsPage";
import SessionsPage from "@/pages/SessionsPage";
import LogsPage from "@/pages/LogsPage";
import AnalyticsPage from "@/pages/AnalyticsPage";
import ModelsPage from "@/pages/ModelsPage";
import CronPage from "@/pages/CronPage";
import ProfilesPage from "@/pages/ProfilesPage";
import SkillsPage from "@/pages/SkillsPage";
import PluginsPage from "@/pages/PluginsPage";
import ChatPage from "@/pages/ChatPage";
import HomePage from "@/pages/HomePage";
import CalendarPage from "@/pages/CalendarPage";
import InboxPage from "@/pages/InboxPage";
import GraphPage from "@/pages/GraphPage";
import DrivePage from "@/pages/DrivePage";
import TeamPage from "@/pages/TeamPage";
import OrgChartPage from "@/pages/OrgChartPage";
import ContactsPage from "@/pages/ContactsPage";
import BusinessesPage from "@/pages/BusinessesPage";
import SettingsHubPage from "@/pages/SettingsHubPage";
import DigestSettingsPage from "@/pages/DigestSettingsPage";
import SettingsGooglePage from "@/pages/SettingsGooglePage";
import SettingsShopifyPage from "@/pages/SettingsShopifyPage";
import SettingsMailPage from "@/pages/SettingsMailPage";
import SettingsVipPage from "@/pages/SettingsVipPage";
import OnboardingPage from "@/pages/OnboardingPage";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { useI18n } from "@/i18n";
import type { Translations } from "@/i18n/types";
import { PluginPage, PluginSlot, usePlugins } from "@/plugins";
import type { PluginManifest } from "@/plugins";
import { useTheme } from "@/themes";
import { isDashboardEmbeddedChatEnabled } from "@/lib/dashboard-flags";
import type { StatusResponse } from "@/lib/api";

function UnknownRouteFallback({ pluginsLoading }: { pluginsLoading: boolean }) {
  if (pluginsLoading) {
    // Render nothing during the plugin-load window — a spinner here would just flash.
    return null;
  }
  return <Navigate to="/" replace />;
}

/**
 * Built-in routes except /chat.  Chat is rendered persistently (outside
 * <Routes>) in the right-hand dock when embedded — see the ChatDock block
 * near the bottom of App() — so the PTY child, WebSocket, and xterm instance
 * survive when the user visits another tab. A `display:none` toggle hides it
 * without unmounting. Routing still owns the URL so /chat deep-links work.
 *
 * `/` is Home (the digest landing). The views demoted out of the primary nav
 * (sessions, analytics, models, logs, skills, plugins, profiles, config, env,
 * docs) keep their routes here — they're reached via the Settings hub.
 */
const BUILTIN_ROUTES_CORE: Record<string, ComponentType> = {
  "/": HomePage,
  "/inbox": InboxPage,
  "/calendar": CalendarPage,
  "/drive": DrivePage,
  "/team": TeamPage,
  "/org": OrgChartPage,
  "/contacts": ContactsPage,
  "/businesses": BusinessesPage,
  "/settings": SettingsHubPage,
  "/settings/digest": DigestSettingsPage,
  "/settings/google": SettingsGooglePage,
  "/settings/shopify": SettingsShopifyPage,
  "/settings/mail": SettingsMailPage,
  "/settings/vip": SettingsVipPage,
  "/onboarding": OnboardingPage,
  "/sessions": SessionsPage,
  "/analytics": AnalyticsPage,
  "/models": ModelsPage,
  "/logs": LogsPage,
  "/cron": CronPage,
  "/graph": GraphPage,
  "/skills": SkillsPage,
  "/plugins": PluginsPage,
  "/profiles": ProfilesPage,
  "/config": ConfigPage,
  "/env": EnvPage,
  "/connections": ConnectionsPage,
  "/docs": DocsPage,
};

// Route placeholder for /chat.  The persistent ChatPage host (rendered
// outside <Routes> when embedded chat is on) paints on top; this empty
// element just claims the path so the `*` catch-all redirect doesn't
// fire when the user navigates to /chat.
function ChatRouteSink() {
  return null;
}

/**
 * The simplified primary sidebar: six tabs + Settings. Tasks (/kanban) and
 * Achievements (/achievements) are plugin-provided, so they're shown only when
 * their plugin is present (otherwise the link would dead-end). Every other
 * built-in view and plugin tab is reached through the Settings hub. Labels are
 * inline here (not i18n) for now — localization is a follow-up.
 */
function buildPrimaryNav(manifests: PluginManifest[]): NavItem[] {
  const hasTab = (path: string) =>
    manifests.some(
      (m) => !m.tab.hidden && (m.tab.path === path || m.tab.override === path),
    );

  const items: NavItem[] = [
    { path: "/", label: "Home", icon: HomeIcon },
    { path: "/inbox", label: "Incoming Messages", icon: Inbox },
    { path: "/calendar", label: "Calendar", icon: CalendarDays },
    { path: "/drive", label: "Drive", icon: HardDrive },
    { path: "/contacts", label: "Contacts", icon: Contact },
  ];
  items.push({ path: "/graph", label: "Brain Graph", icon: Network });
  if (hasTab("/achievements"))
    items.push({ path: "/achievements", label: "Achievements", icon: Star });
  // Org Chart consolidates Team, Tasks (/kanban), and Agent Jobs (/cron) as
  // sub-views — grouped at the bottom, just above Settings. The /kanban hasTab
  // gate now lives inside OrgChartPage (it shows the Tasks sub-tab only when
  // the plugin is present).
  items.push({ path: "/org", label: "Org Chart", icon: Building2 });
  items.push({ path: "/settings", label: "Settings", icon: Settings });
  return items;
}

function buildRoutes(
  builtinRoutes: Record<string, ComponentType>,
  manifests: PluginManifest[],
): Array<{
  key: string;
  path: string;
  element: ReactNode;
}> {
  const byOverride = new Map<string, PluginManifest>();
  const addons: PluginManifest[] = [];

  for (const m of manifests) {
    if (m.tab.override) {
      byOverride.set(m.tab.override, m);
    } else {
      addons.push(m);
    }
  }

  const routes: Array<{
    key: string;
    path: string;
    element: ReactNode;
  }> = [];

  for (const [path, Component] of Object.entries(builtinRoutes)) {
    const om = byOverride.get(path);
    if (om) {
      routes.push({
        key: `override:${om.name}`,
        path,
        element: <PluginPage name={om.name} />,
      });
    } else {
      routes.push({ key: `builtin:${path}`, path, element: <Component /> });
    }
  }

  for (const m of addons) {
    if (m.tab.hidden) continue;
    if (m.tab.path === "/plugins") continue;
    if (builtinRoutes[m.tab.path]) continue;
    routes.push({
      key: `plugin:${m.name}`,
      path: m.tab.path,
      element: <PluginPage name={m.name} />,
    });
  }

  for (const m of manifests) {
    if (!m.tab.hidden) continue;
    if (m.tab.path === "/plugins") continue;
    if (builtinRoutes[m.tab.path] || m.tab.override) continue;
    routes.push({
      key: `plugin:hidden:${m.name}`,
      path: m.tab.path,
      element: <PluginPage name={m.name} />,
    });
  }

  return routes;
}

const SIDEBAR_COLLAPSED_KEY = "hermes-sidebar-collapsed";
const CHAT_COLLAPSED_KEY = "hermes-chat-collapsed";
const CHAT_WIDTH_KEY = "hermes-chat-width";

export default function App() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const { manifests, loading: pluginsLoading } = usePlugins();
  const { theme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      } catch { /* localStorage may be unavailable in private browsing */ }
      return next;
    });
  }, []);
  const isMobile = useBelowBreakpoint(1024);
  const isDesktopCollapsed = collapsed && !isMobile;
  const tooltipWarmRef = useRef(0);
  const sidebarStatus = useSidebarStatus();
  const isDocsRoute = pathname === "/docs" || pathname === "/docs/";
  const embeddedChat = isDashboardEmbeddedChatEnabled();

  // Right-hand chat dock collapse state (persisted). Defaults expanded — the
  // dashboard "opens to the chat panel".
  const [chatCollapsed, setChatCollapsed] = useState(() => {
    try {
      return localStorage.getItem(CHAT_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const toggleChat = useCallback(() => {
    setChatCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CHAT_COLLAPSED_KEY, String(next));
      } catch {
        /* localStorage may be unavailable in private browsing */
      }
      return next;
    });
  }, []);

  // Right-hand chat dock width (desktop drag-resize, persisted). Lazy-init from
  // localStorage, clamped — never trust the raw parse (stale/hand-edited value).
  const [chatWidth, setChatWidth] = useState(() => {
    try {
      const raw = localStorage.getItem(CHAT_WIDTH_KEY);
      return raw == null ? CHAT_WIDTH_DEFAULT : clampChatWidth(Number(raw));
    } catch {
      return CHAT_WIDTH_DEFAULT;
    }
  });
  const onChatWidthChange = useCallback((next: number) => {
    const clamped = clampChatWidth(next);
    setChatWidth(clamped);
    try {
      localStorage.setItem(CHAT_WIDTH_KEY, String(clamped));
    } catch {
      /* localStorage may be unavailable in private browsing */
    }
  }, []);

  // Mobile chat drawer open/closed. Transient UI — intentionally NOT persisted.
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const closeMobileChat = useCallback(() => setMobileChatOpen(false), []);

  // A plugin can replace the built-in /chat page via `tab.override: "/chat"`
  // in its manifest.  When one does, `buildRoutes` already swaps the route
  // element for <PluginPage /> — but we also have to suppress the
  // persistent ChatPage host below, or the plugin's page and the built-in
  // terminal would paint on top of each other.  The override is niche
  // (nothing ships overriding /chat today) but it's an advertised
  // extension point, so preserve the pre-persistence contract: when a
  // plugin owns /chat, the built-in chat UI is entirely absent.
  //
  // Waiting on `pluginsLoading` is load-bearing: manifests arrive
  // asynchronously from /api/dashboard/plugins, so on initial render
  // `chatOverriddenByPlugin` is always false.  Without the loading
  // gate, the persistent host would mount, spawn a PTY, and THEN get
  // yanked out from under the user when the plugin's manifest resolves
  // — killing the session mid-paint.  Delaying host mount by the
  // plugin-load window (typically <50ms, worst case 2s safety timeout)
  // is the cheaper trade-off.
  const chatOverriddenByPlugin = useMemo(
    () => manifests.some((m) => m.tab.override === "/chat"),
    [manifests],
  );

  const builtinRoutes = useMemo(
    () => ({
      ...BUILTIN_ROUTES_CORE,
      ...(embeddedChat ? { "/chat": ChatRouteSink } : {}),
    }),
    [embeddedChat],
  );

  const primaryNav = useMemo(() => buildPrimaryNav(manifests), [manifests]);
  const routes = useMemo(
    () => buildRoutes(builtinRoutes, manifests),
    [builtinRoutes, manifests],
  );
  const pluginTabMeta = useMemo(
    () =>
      manifests
        .filter((m) => !m.tab.hidden)
        .map((m) => ({
          path: m.tab.override ?? m.tab.path,
          label: m.label,
        })),
    [manifests],
  );

  const layoutVariant = theme.layoutVariant ?? "standard";

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mobileOpen]);

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setMobileOpen(false);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // Mobile chat drawer: Esc-to-close + body-scroll-lock while open. Mirrors the
  // mobile-nav effect above. (Nav and chat drawer aren't openable at once — the
  // FAB is hidden while the nav is open — so the overflow save/restore is safe.)
  useEffect(() => {
    if (!mobileChatOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileChatOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mobileChatOpen]);

  // Crossing up to desktop closes the mobile chat drawer (it reverts to the
  // in-flow dock there).
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setMobileChatOpen(false);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return (
    <AccountViewProvider>
    <div
      data-layout-variant={layoutVariant}
      className="flex h-dvh max-h-dvh min-h-0 flex-col overflow-hidden bg-black text-text-primary antialiased"
    >
      <SelectionSwitcher />
      <Backdrop />
      <PluginSlot name="backdrop" />

      <header
        className={cn(
          "lg:hidden fixed top-0 left-0 right-0 z-40 min-h-14",
          "flex items-center gap-2 px-4 py-2",
          "border-b border-current/20",
          "bg-background-base/90 backdrop-blur-sm",
        )}
        style={{
          background: "var(--component-header-background)",
          borderImage: "var(--component-header-border-image)",
          clipPath: "var(--component-header-clip-path)",
        }}
      >
        <Button
          ghost
          size="icon"
          onClick={() => setMobileOpen(true)}
          aria-label={t.app.openNavigation}
          aria-expanded={mobileOpen}
          aria-controls="app-sidebar"
          className="text-text-secondary hover:text-midground"
        >
          <Menu />
        </Button>

        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className="h-4 w-4 shrink-0 rounded-[5px] bg-brand shadow-[0_0_14px_-2px_var(--color-brand)]"
          />
          <Typography className="font-semibold text-[0.95rem] leading-none tracking-tight text-midground">
            AgentBOX
          </Typography>
        </span>
      </header>

      {mobileOpen && (
        <Button
          ghost
          aria-label={t.app.closeNavigation}
          onClick={closeMobile}
          className={cn(
            "lg:hidden fixed inset-0 z-40 p-0 block",
            "bg-black/60 backdrop-blur-sm",
          )}
        />
      )}

      {/* Mobile chat FAB. Opens the full-screen chat drawer (same ChatPage
          instance the desktop dock uses). Hidden while the drawer or the
          mobile nav is open so it doesn't fight either backdrop. */}
      {embeddedChat &&
        !chatOverriddenByPlugin &&
        !mobileChatOpen &&
        !mobileOpen && (
          <Button
            ghost
            size="icon"
            onClick={() => setMobileChatOpen(true)}
            aria-label="Open chat"
            className={cn(
              "lg:hidden fixed right-4 z-40",
              "border border-current/20 bg-background-base/95 backdrop-blur-sm",
              "text-text-secondary hover:text-midground shadow-lg",
            )}
            style={{
              bottom: "calc(1rem + env(safe-area-inset-bottom, 0px))",
            }}
          >
            <MessageSquare className="h-5 w-5" />
          </Button>
        )}

      <PluginSlot name="header-banner" />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pt-14 lg:pt-0">
        <div className="flex min-h-0 min-w-0 flex-1">
          <aside
            id="app-sidebar"
            aria-label={t.app.navigation}
            className={cn(
              "fixed top-0 left-0 z-50 flex h-dvh max-h-dvh w-64 min-h-0 flex-col",
              "border-r border-current/20",
              "bg-background-base/95 backdrop-blur-sm",
              "transition-[transform] duration-200 ease-out",
              mobileOpen ? "translate-x-0" : "-translate-x-full",
              "lg:sticky lg:top-0 lg:translate-x-0 lg:shrink-0 lg:overflow-hidden",
              "lg:transition-[width] lg:duration-[600ms] lg:ease-[cubic-bezier(0.33,1.35,0.62,1)]",
              collapsed && "lg:w-14",
            )}
            style={{
              background: "var(--component-sidebar-background)",
              clipPath: "var(--component-sidebar-clip-path)",
              borderImage: "var(--component-sidebar-border-image)",
            }}
          >
            <div
              className={cn(
                "flex h-14 shrink-0 items-center gap-2",
                "border-b border-current/20",
                collapsed ? "lg:justify-center lg:px-0" : "px-4 justify-between",
              )}
            >
              <div
                className={cn(
                  "flex items-center gap-2",
                  collapsed && "lg:hidden",
                )}
              >
                <PluginSlot name="header-left" />

                <span
                  aria-hidden
                  className="h-[18px] w-[18px] shrink-0 rounded-[5px] bg-brand shadow-[0_0_14px_-2px_var(--color-brand)]"
                />

                <Typography
                  className="font-semibold text-[1.0625rem] leading-none tracking-tight text-midground"
                >
                  AgentBOX
                </Typography>
              </div>

              <Button
                ghost
                size="icon"
                onClick={closeMobile}
                aria-label={t.app.closeNavigation}
                className="lg:hidden text-text-secondary hover:text-midground"
              >
                <X />
              </Button>

              <Button
                ghost
                size="icon"
                onClick={toggleCollapsed}
                aria-label={
                  collapsed ? t.common.expand : t.common.collapse
                }
                className="hidden lg:flex text-text-secondary hover:text-midground"
              >
                {collapsed ? (
                  <PanelLeftOpen className="h-4 w-4" />
                ) : (
                  <PanelLeftClose className="h-4 w-4" />
                )}
              </Button>
            </div>

            <nav
              className="min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden border-t border-current/10 py-2"
              aria-label={t.app.navigation}
            >
              <ul className="flex flex-col">
                {primaryNav.map((item) => (
                  <SidebarNavLink
                    closeMobile={closeMobile}
                    collapsed={isDesktopCollapsed}
                    item={item}
                    key={item.path}
                    t={t}
                    tooltipWarmRef={tooltipWarmRef}
                  />
                ))}
              </ul>
            </nav>

            <SidebarSystemActions
              collapsed={isDesktopCollapsed}
              onNavigate={closeMobile}
              status={sidebarStatus}
              tooltipWarmRef={tooltipWarmRef}
            />

            <div
              className={cn(
                "flex shrink-0 items-center gap-2",
                "px-3 py-2",
                "border-t border-current/20",
                isDesktopCollapsed
                  ? "lg:flex-col lg:items-start lg:gap-3 lg:py-3"
                  : "justify-between",
              )}
            >
              <div
                className={cn(
                  "flex min-w-0 items-center gap-2",
                  isDesktopCollapsed && "lg:flex-col lg:items-start",
                )}
              >
                <PluginSlot name="header-right" />

                <SidebarIconWithTooltip
                  collapsed={isDesktopCollapsed}
                  label={t.theme?.switchTheme ?? "Switch theme"}
                  tooltipWarmRef={tooltipWarmRef}
                >
                  <ThemeSwitcher collapsed={isDesktopCollapsed} dropUp />
                </SidebarIconWithTooltip>

                <SidebarIconWithTooltip
                  collapsed={isDesktopCollapsed}
                  label={t.language.switchTo}
                  tooltipWarmRef={tooltipWarmRef}
                >
                  <LanguageSwitcher collapsed={isDesktopCollapsed} dropUp />
                </SidebarIconWithTooltip>
              </div>
            </div>

            <div
              className={cn(
                "flex shrink-0 flex-col",
                isDesktopCollapsed && "lg:hidden",
              )}
            >
              <AuthWidget />
              <SidebarFooter status={sidebarStatus} />
            </div>
          </aside>

          <PageHeaderProvider pluginTabs={pluginTabMeta}>
            <div className="flex min-w-0 min-h-0 flex-1">
              <div
                className={cn(
                  "relative z-2 flex min-w-0 min-h-0 flex-1 flex-col",
                  "px-3 sm:px-6 pt-2 sm:pt-4 lg:pt-6",
                  isDocsRoute && "min-h-0 flex-1",
                )}
              >
                <PluginSlot name="pre-main" />
                <div
                  className={cn(
                    "w-full min-w-0",
                    "pb-[calc(2rem+env(safe-area-inset-bottom,0px))] lg:pb-8",
                    isDocsRoute && "min-h-0 flex flex-1 flex-col",
                  )}
                >
                  <Routes>
                    {routes.map(({ key, path, element }) => (
                      <Route key={key} path={path} element={element} />
                    ))}
                    <Route
                      path="*"
                      element={
                        <UnknownRouteFallback pluginsLoading={pluginsLoading} />
                      }
                    />
                  </Routes>
                </div>
                <PluginSlot name="post-main" />
              </div>

              {/* Persistent right-hand chat dock. The single ChatPage instance
                  stays mounted across route changes and collapse toggles so the
                  PTY/WebSocket survive. Only rendered when embedded chat is on
                  (`hermes dashboard --tui`) and no plugin overrides /chat. */}
              {embeddedChat && !chatOverriddenByPlugin && (
                <ChatDock
                  collapsed={chatCollapsed}
                  onToggle={toggleChat}
                  width={chatWidth}
                  onWidthChange={onChatWidthChange}
                  mobileOpen={mobileChatOpen}
                  onMobileClose={closeMobileChat}
                  isMobile={isMobile}
                >
                  {pluginsLoading ? (
                    <div
                      className="flex min-h-0 min-w-0 flex-1 items-center justify-center"
                      aria-busy="true"
                      aria-live="polite"
                    >
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Spinner />
                        <span>Loading chat…</span>
                      </div>
                    </div>
                  ) : (
                    <ChatPage
                      isActive={isMobile ? mobileChatOpen : !chatCollapsed}
                    />
                  )}
                </ChatDock>
              )}
            </div>
          </PageHeaderProvider>
        </div>
      </div>

      <PluginSlot name="overlay" />
    </div>
    </AccountViewProvider>
  );
}

function SidebarNavLink({
  closeMobile,
  collapsed,
  item,
  tooltipWarmRef,
  t,
}: SidebarNavLinkProps) {
  const { path, label, labelKey, icon: Icon } = item;
  const liRef = useRef<HTMLLIElement>(null);
  const [hovered, setHovered] = useState(false);

  const navLabel = labelKey
    ? ((t.app.nav as Record<string, string>)[labelKey] ?? label)
    : label;

  return (
    <li
      ref={liRef}
      onMouseEnter={collapsed ? () => setHovered(true) : undefined}
      onMouseLeave={collapsed ? () => setHovered(false) : undefined}
    >
      <NavLink
        to={path}
        end={path === "/"}
        onClick={closeMobile}
        aria-label={collapsed ? navLabel : undefined}
        onFocus={collapsed ? () => setHovered(true) : undefined}
        onBlur={collapsed ? () => setHovered(false) : undefined}
        className={({ isActive }) =>
          cn(
            "group/nav relative mx-2 flex items-center gap-3 rounded-[var(--radius-md)]",
            "px-3 py-2",
            "text-sm font-medium tracking-tight",
            "whitespace-nowrap transition-colors cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand",
            isActive
              ? "text-brand bg-[color-mix(in_srgb,var(--color-brand)_13%,transparent)]"
              : "text-text-secondary hover:text-midground hover:bg-[color-mix(in_srgb,var(--midground)_6%,transparent)]",
          )
        }
      >
        {({ isActive }) => (
          <>
            <Icon className="h-4 w-4 shrink-0" />

            <span
              className={cn(
                "truncate transition-opacity duration-300",
                collapsed ? "lg:opacity-0" : "lg:opacity-100",
              )}
            >
              {navLabel}
            </span>

            {isActive && (
              <span
                aria-hidden
                className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-brand"
              />
            )}
          </>
        )}
      </NavLink>

      {collapsed && hovered && liRef.current && (
        <SidebarTooltip anchor={liRef.current} label={navLabel} warmRef={tooltipWarmRef} />
      )}
    </li>
  );
}

function SidebarSystemActions({
  collapsed,
  onNavigate,
  status,
  tooltipWarmRef,
}: SidebarSystemActionsProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { activeAction, isBusy, isRunning, pendingAction, runAction } =
    useSystemActions();

  const items: SystemActionItem[] = [
    {
      action: "restart",
      icon: RotateCw,
      label: t.status.restartGateway,
      runningLabel: t.status.restartingGateway,
      spin: true,
    },
  ];

  const handleClick = (action: SystemAction) => {
    if (isBusy) return;
    void runAction(action);
    navigate("/sessions");
    onNavigate();
  };

  return (
    <div
      className={cn(
        "shrink-0 flex flex-col",
        "border-t border-current/10",
        "py-1",
      )}
    >
      <span
        className={cn(
          "px-5 pt-2 pb-1",
          "text-[0.7rem] font-medium uppercase tracking-[0.14em] text-text-tertiary",
          collapsed && "lg:hidden",
        )}
      >
        {t.app.system}
      </span>

      <div className={cn(collapsed && "lg:hidden")}>
        <SidebarStatusStrip status={status} />
      </div>

      <GatewayDot collapsed={collapsed} status={status} tooltipWarmRef={tooltipWarmRef} />

      <ul className="flex flex-col">
        {items.map((item) => (
          <SystemActionButton
            key={item.action}
            collapsed={collapsed}
            disabled={isBusy && !(pendingAction === item.action || (activeAction === item.action && isRunning))}
            tooltipWarmRef={tooltipWarmRef}
            isPending={pendingAction === item.action}
            isRunning={activeAction === item.action && isRunning && pendingAction !== item.action}
            item={item}
            onClick={() => handleClick(item.action)}
          />
        ))}
      </ul>
    </div>
  );
}

function SystemActionButton({
  collapsed,
  disabled,
  isPending,
  isRunning: isActionRunning,
  item,
  onClick,
  tooltipWarmRef,
}: SystemActionButtonProps) {
  const { icon: Icon, label, runningLabel, spin } = item;
  const liRef = useRef<HTMLLIElement>(null);
  const [hovered, setHovered] = useState(false);
  const busy = isPending || isActionRunning;
  const displayLabel = isActionRunning ? runningLabel : label;

  return (
    <li
      ref={liRef}
      onMouseEnter={collapsed ? () => setHovered(true) : undefined}
      onMouseLeave={collapsed ? () => setHovered(false) : undefined}
    >
      <button
        onClick={onClick}
        disabled={disabled}
        aria-busy={busy}
        aria-label={collapsed ? displayLabel : undefined}
        onFocus={collapsed ? () => setHovered(true) : undefined}
        onBlur={collapsed ? () => setHovered(false) : undefined}
        type="button"
        className={cn(
          "group/action relative mx-2 flex w-full items-center gap-3 rounded-[var(--radius-md)]",
          "px-3 py-2",
          "text-sm font-medium tracking-tight",
          "whitespace-nowrap transition-colors cursor-pointer",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand",
          busy
            ? "text-midground"
            : "text-text-secondary hover:text-midground hover:bg-[color-mix(in_srgb,var(--midground)_6%,transparent)]",
          "disabled:text-text-disabled disabled:cursor-not-allowed",
        )}
      >
        {isPending ? (
          <Spinner className="shrink-0 text-[0.875rem]" />
        ) : isActionRunning && spin ? (
          <Spinner className="shrink-0 text-[0.875rem]" />
        ) : (
          <Icon
            className={cn(
              "h-4 w-4 shrink-0",
              isActionRunning && !spin && "animate-pulse",
            )}
          />
        )}

        <span className={cn(
          "truncate transition-opacity duration-300",
          collapsed ? "lg:opacity-0" : "lg:opacity-100",
        )}>
          {displayLabel}
        </span>

        {busy && (
          <span
            aria-hidden
            className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-midground"
          />
        )}
      </button>

      {collapsed && hovered && liRef.current && (
        <SidebarTooltip anchor={liRef.current} label={displayLabel} warmRef={tooltipWarmRef} />
      )}
    </li>
  );
}

function SidebarIconWithTooltip({
  children,
  collapsed,
  label,
  tooltipWarmRef,
}: SidebarIconWithTooltipProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);

  return (
    <div
      ref={ref}
      className={cn(
        "relative w-fit",
        collapsed && "group/icon",
      )}
      onMouseEnter={collapsed ? () => setHovered(true) : undefined}
      onMouseLeave={collapsed ? () => setHovered(false) : undefined}
    >
      {children}

      {collapsed && (
        <span
          aria-hidden
          className="absolute inset-y-0 inset-x-[-0.375rem] bg-midground opacity-0 pointer-events-none transition-opacity duration-200 group-hover/icon:opacity-5 hidden lg:block"
        />
      )}

      {collapsed && hovered && ref.current && (
        <SidebarTooltip anchor={ref.current} label={label} warmRef={tooltipWarmRef} />
      )}
    </div>
  );
}

function GatewayDot({ collapsed, status, tooltipWarmRef }: GatewayDotProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);

  const toneToColor: Record<string, string> = {
    "text-success": "bg-success",
    "text-warning": "bg-warning",
    "text-destructive": "bg-destructive",
    "text-muted-foreground": "bg-muted-foreground",
  };

  let color: string;
  let label: string;

  if (!status) {
    color = "bg-midground/20";
    label = t.status.gateway;
  } else {
    const gw = gatewayLine(status, t);
    color = toneToColor[gw.tone] ?? "bg-muted-foreground";
    label = `${t.status.gateway} ${gw.label}`;
  }

  return (
    <div
      ref={ref}
      className={cn(
        "hidden lg:flex py-3 pl-[1.625rem] transition-opacity duration-300",
        collapsed ? "lg:opacity-100" : "lg:opacity-0 lg:h-0 lg:py-0 lg:overflow-hidden",
      )}
      role="status"
      aria-label={label}
      tabIndex={collapsed ? 0 : -1}
      onMouseEnter={collapsed ? () => setHovered(true) : undefined}
      onMouseLeave={collapsed ? () => setHovered(false) : undefined}
      onFocus={collapsed ? () => setHovered(true) : undefined}
      onBlur={collapsed ? () => setHovered(false) : undefined}
    >
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 rounded-full", color)}
      />

      {hovered && ref.current && (
        <SidebarTooltip anchor={ref.current} label={label} warmRef={tooltipWarmRef} />
      )}
    </div>
  );
}

function SidebarTooltip({ anchor, label, warmRef }: SidebarTooltipProps) {
  const rect = anchor.getBoundingClientRect();
  const sidebar = document.getElementById("app-sidebar");
  const sidebarRight = sidebar?.getBoundingClientRect().right ?? rect.right;

  const isWarm = warmRef ? Date.now() - warmRef.current < 300 : false;

  useEffect(() => {
    if (warmRef) warmRef.current = Date.now();
    return () => {
      if (warmRef) warmRef.current = Date.now();
    };
  }, [warmRef]);

  return createPortal(
    <span
      className={cn(
        "fixed z-[100] pointer-events-none",
        "px-2.5 py-1 rounded-[var(--radius-md)]",
        "bg-background-base/95 border border-border backdrop-blur-sm shadow-lg",
        "text-xs font-medium tracking-tight text-midground",
      )}
      style={{
        top: rect.top + rect.height / 2,
        left: sidebarRight + 8,
        transform: "translateY(-50%)",
        opacity: isWarm ? 1 : undefined,
        animation: isWarm ? "none" : "sidebar-tooltip-in 120ms ease-out",
      }}
    >
      {label}
    </span>,
    document.body,
  );
}

type TooltipWarmRef = React.RefObject<number>;

interface GatewayDotProps {
  collapsed: boolean;
  status: StatusResponse | null;
  tooltipWarmRef: TooltipWarmRef;
}

interface NavItem {
  icon: ComponentType<{ className?: string }>;
  label: string;
  labelKey?: string;
  path: string;
}

interface SidebarIconWithTooltipProps {
  children: ReactNode;
  collapsed: boolean;
  label: string;
  tooltipWarmRef: TooltipWarmRef;
}

interface SidebarNavLinkProps {
  closeMobile: () => void;
  collapsed: boolean;
  item: NavItem;
  t: Translations;
  tooltipWarmRef: TooltipWarmRef;
}

interface SidebarSystemActionsProps {
  collapsed: boolean;
  onNavigate: () => void;
  status: StatusResponse | null;
  tooltipWarmRef: TooltipWarmRef;
}

interface SidebarTooltipProps {
  anchor: HTMLElement;
  label: string;
  warmRef?: TooltipWarmRef;
}

interface SystemActionButtonProps {
  collapsed: boolean;
  disabled: boolean;
  isPending: boolean;
  isRunning: boolean;
  item: SystemActionItem;
  onClick: () => void;
  tooltipWarmRef: TooltipWarmRef;
}

interface SystemActionItem {
  action: SystemAction;
  icon: ComponentType<{ className?: string }>;
  label: string;
  runningLabel: string;
  spin: boolean;
}
