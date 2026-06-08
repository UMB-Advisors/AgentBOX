import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ListChecks,
  Mail,
  Newspaper,
  RefreshCw,
  SquareKanban,
} from "lucide-react";
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
import { AccountTag } from "@/components/AccountSelector";
import { Markdown } from "@/components/Markdown";
import { useAccountView } from "@/contexts/useAccountView";
import { api } from "@/lib/api";
import type {
  ActionItem,
  BriefEmail,
  BriefEvent,
  CronOutput,
  DigestBrief,
  DigestPrefs,
  DraftRow,
  KanbanBoard,
  NewsItem,
} from "@/lib/api";
import { isoTimeAgo } from "@/lib/utils";
import { usePageHeader } from "@/contexts/usePageHeader";

/**
 * Home — the AgentBOX daily-digest landing.
 *
 *   • Top: the **Daily Brief** — three real-data sections styled like Google's
 *     emailed brief: **Top of Mind** (unread Gmail), **On Your Calendar**
 *     (today's Google Calendar), and **FYI** (active local Kanban cards).
 *     Gmail + Calendar come from `/api/digest/brief`; FYI from the Kanban board.
 *   • Middle: the operator-chosen **Action Items** module (LLM-extracted from
 *     the inbox) — kept because the brief doesn't surface it.
 *   • Bottom: **Google News** — an infinite, thumbnailed top-stories feed.
 */
const NEWS_PAGE = 20;

export default function HomePage() {
  const { setTitle } = usePageHeader();
  useEffect(() => {
    setTitle("Home");
  }, [setTitle]);

  const [prefs, setPrefs] = useState<DigestPrefs | null>(null);

  // Daily brief — Gmail + Calendar (real Google) and the Kanban board (FYI).
  const [brief, setBrief] = useState<DigestBrief | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);
  // Per-account / combined view comes from the global header selector.
  const { view } = useAccountView();
  const [board, setBoard] = useState<KanbanBoard | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);

  // News module
  const [news, setNews] = useState<NewsItem[]>([]);
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsError, setNewsError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  const loadedRef = useRef(0);
  const hasMoreRef = useRef(false);

  // Action items come from pending/edited inbox drafts.
  const [drafts, setDrafts] = useState<DraftRow[] | null>(null);
  const [draftsError, setDraftsError] = useState<string | null>(null);

  // The "summary" toggle now governs the whole Daily Brief.
  const briefOn = prefs ? prefs.modules.summary !== false : false;
  const actionsOn = prefs ? prefs.modules.action_items !== false : false;
  const newsOn = prefs
    ? prefs.modules.news !== false && prefs.news_sources.length > 0
    : false;

  // Load prefs on mount; fall back to brief-only if the endpoint is missing.
  useEffect(() => {
    api
      .getDigestPrefs()
      .then(setPrefs)
      .catch(() =>
        setPrefs({
          modules: {
            summary: true,
            emails: true,
            action_items: true,
            tasks: true,
            calendar: true,
            news: false,
          },
          news_sources: [],
          custom_sources: [],
        }),
      );
  }, []);

  const loadBrief = useCallback(async () => {
    setBriefLoading(true);
    setBriefError(null);
    try {
      setBrief(await api.getDigestBrief(view));
    } catch (err) {
      setBriefError(err instanceof Error ? err.message : "Failed to load brief.");
    } finally {
      setBriefLoading(false);
    }
  }, [view]);

  const loadBoard = useCallback(() => {
    setBoardError(null);
    api
      .getKanbanBoard()
      .then(setBoard)
      .catch((e: unknown) =>
        setBoardError(e instanceof Error ? e.message : "Failed to load tasks."),
      );
  }, []);

  // The brief needs both Gmail/Calendar and the Kanban board (FYI section).
  useEffect(() => {
    if (!prefs || !briefOn) return;
    void loadBrief();
    loadBoard();
  }, [prefs, briefOn, loadBrief, loadBoard]);

  const refreshBrief = useCallback(() => {
    void loadBrief();
    loadBoard();
  }, [loadBrief, loadBoard]);

  const loadMoreNews = useCallback(async () => {
    const p = prefs;
    if (!p || p.modules.news === false || p.news_sources.length === 0) return;
    if (loadingRef.current) return;
    if (loadedRef.current > 0 && !hasMoreRef.current) return;
    loadingRef.current = true;
    setNewsLoading(true);
    setNewsError(null);
    try {
      const res = await api.getNews(p.news_sources, loadedRef.current, NEWS_PAGE);
      loadedRef.current += res.items.length;
      hasMoreRef.current = res.has_more;
      setNews((prev) => [...prev, ...res.items]);
      setHasMore(res.has_more);
    } catch (err) {
      setNewsError(err instanceof Error ? err.message : "Failed to load news.");
    } finally {
      loadingRef.current = false;
      setNewsLoading(false);
    }
  }, [prefs]);

  // Manual "Refresh feed": drop the loaded pages and re-fetch from the top.
  const refreshNews = useCallback(() => {
    loadingRef.current = false;
    loadedRef.current = 0;
    hasMoreRef.current = false;
    setNews([]);
    setHasMore(false);
    void loadMoreNews();
  }, [loadMoreNews]);

  // Reset + load the first page whenever the news selection changes.
  useEffect(() => {
    loadedRef.current = 0;
    hasMoreRef.current = false;
    setNews([]);
    setHasMore(false);
    if (prefs && prefs.modules.news !== false && prefs.news_sources.length > 0) {
      void loadMoreNews();
    }
  }, [prefs, loadMoreNews]);

  // Infinite scroll: load the next page when the sentinel scrolls into view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMoreNews();
      },
      { rootMargin: "300px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMoreNews]);

  // Action items: pending/edited drafts, flattened.
  useEffect(() => {
    if (!prefs || !actionsOn) return;
    setDraftsError(null);
    api
      .inboxListDrafts("pending,edited", 200)
      .then((r) => setDrafts(r.drafts))
      .catch((e: unknown) =>
        setDraftsError(e instanceof Error ? e.message : "Failed to load inbox."),
      );
  }, [prefs, actionsOn]);

  const actionItems = useMemo(
    () =>
      (drafts ?? [])
        .flatMap((d) =>
          ((d.action_items as ActionItem[] | undefined) ?? []).map((it) => ({
            it,
            from: d.from_addr,
            subject: d.subject ?? d.draft_subject ?? "",
          })),
        )
        .slice(0, 12),
    [drafts],
  );

  // FYI = active Kanban cards (everything not done/archived/completed).
  const fyiTasks = useMemo(() => {
    const skip = new Set(["done", "archived", "completed"]);
    return (board?.columns ?? [])
      .filter((c) => !skip.has(c.name.toLowerCase()))
      .flatMap((c) => c.tasks.map((t) => ({ t, col: c.name })))
      .slice(0, 8);
  }, [board]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
      {/* Daily Brief — Top of Mind (Gmail) · On Your Calendar · FYI (Kanban) */}
      {briefOn && (
        <DailyBrief
          brief={brief}
          fyiTasks={fyiTasks}
          boardLoaded={board != null || boardError != null}
          loading={briefLoading}
          error={briefError}
          onRefresh={refreshBrief}
          view={view}
        />
      )}

      {/* Action Items — kept (the brief doesn't cover LLM-extracted items) */}
      {actionsOn && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-text-secondary" />
              <CardTitle>Action Items</CardTitle>
            </div>
            <CardDescription>Open items extracted from your inbox.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {draftsError ? (
              <p className="text-sm text-destructive">{draftsError}</p>
            ) : drafts == null ? (
              <Loading />
            ) : actionItems.length === 0 ? (
              <Empty>No open action items.</Empty>
            ) : (
              actionItems.map(({ it, from, subject }, i) => (
                <div
                  key={`${i}-${it.text}`}
                  className="flex items-start gap-2 rounded border border-border bg-card px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{it.text}</p>
                    <span className="truncate text-xs text-muted-foreground">
                      {subject || from}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {it.due_at && <Badge tone="outline">{formatDue(it.due_at)}</Badge>}
                    <Badge tone="secondary">{it.type}</Badge>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}

      {/* Job Outcomes — recent completed agent-job runs, expandable */}
      <JobOutcomes />

      {/* Google News — infinite top-stories feed */}
      {newsOn && (
        <GoogleNews
          news={news}
          loading={newsLoading}
          error={newsError}
          hasMore={hasMore}
          onRetry={() => void loadMoreNews()}
          onRefresh={refreshNews}
          sentinelRef={sentinelRef}
        />
      )}

      {prefs && !briefOn && !actionsOn && !newsOn && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-text-secondary">
            No digest modules enabled. Turn some on in Settings → Daily Digest.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ── Daily Brief ───────────────────────────────────────────────────────── */

function todayLong(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

interface FyiTask {
  t: KanbanBoard["columns"][number]["tasks"][number];
  col: string;
}

function DailyBrief({
  brief,
  fyiTasks,
  boardLoaded,
  loading,
  error,
  onRefresh,
  view,
}: {
  brief: DigestBrief | null;
  fyiTasks: FyiTask[];
  boardLoaded: boolean;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  view: string;
}) {
  const weekday = new Date().toLocaleDateString(undefined, { weekday: "long" });
  const connected = brief?.connected ?? false;
  const emails = brief?.gmail.messages ?? [];
  const gmailError = brief?.gmail.error ?? null;
  const events = brief?.calendar.events ?? [];
  const calError = brief?.calendar.error ?? null;
  const firstLoad = loading && brief == null;
  // Combined view tags each item with its source account; single-account
  // views omit the redundant per-item tag.
  const showAccountTag = view === "combined";

  return (
    <Card className="overflow-hidden">
      {/* Brand banner header, echoing the emailed daily brief. */}
      <div className="flex items-start justify-between gap-3 bg-brand px-6 py-5 text-brand-foreground">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Happy {weekday} — here's your daily brief
          </h1>
          <p className="mt-0.5 text-sm opacity-80">{todayLong()}</p>
        </div>
        <Button
          type="button"
          ghost
          size="icon"
          className="text-brand-foreground/80 hover:bg-white/10 hover:text-brand-foreground"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh brief"
        >
          {loading ? <Spinner /> : <RefreshCw />}
        </Button>
      </div>

      <CardContent className="flex flex-col gap-6 px-6 py-5">
        {firstLoad ? (
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <Spinner />
            <span>Loading your brief…</span>
          </div>
        ) : error ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Couldn't load the brief. {error}</span>
            </div>
            <div>
              <Button type="button" size="sm" onClick={onRefresh}>
                Retry
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* Top of Mind + On Your Calendar both need a connected Google.
                The Combined / per-account view comes from the global header
                selector (shared across every account-aware tab). */}
            {!connected && <ConnectGoogle />}

            {connected && (
              <BriefSection icon={<Mail className="h-4 w-4" />} title="Top of Mind">
                {gmailError ? (
                  <SectionNote tone="warn">{gmailError}</SectionNote>
                ) : emails.length === 0 ? (
                  <SectionNote>Inbox zero — nothing unread right now.</SectionNote>
                ) : (
                  <ul className="flex flex-col divide-y divide-border">
                    {emails.map((m) => (
                      <EmailRow key={m.id} email={m} showAccount={showAccountTag} />
                    ))}
                  </ul>
                )}
              </BriefSection>
            )}

            {connected && (
              <BriefSection
                icon={<CalendarDays className="h-4 w-4" />}
                title="On Your Calendar"
              >
                {calError ? (
                  <SectionNote tone="warn">{calError}</SectionNote>
                ) : events.length === 0 ? (
                  <SectionNote>Nothing on your calendar today.</SectionNote>
                ) : (
                  <ul className="flex flex-col divide-y divide-border">
                    {events.map((ev) => (
                      <EventRow
                        key={ev.id || ev.start}
                        event={ev}
                        showAccount={showAccountTag}
                      />
                    ))}
                  </ul>
                )}
              </BriefSection>
            )}

            {/* FYI = local Kanban; always available (no Google needed). */}
            <BriefSection icon={<SquareKanban className="h-4 w-4" />} title="FYI">
              {!boardLoaded ? (
                <Loading />
              ) : fyiTasks.length === 0 ? (
                <SectionNote>No active tasks.</SectionNote>
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {fyiTasks.map(({ t, col }) => (
                    <li key={t.id} className="flex items-center gap-2 py-2.5">
                      <span className="flex-1 truncate text-sm">{t.title || t.id}</span>
                      <Badge tone="outline">{col}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </BriefSection>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BriefSection({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-brand">
        <span className="text-brand">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function EmailRow({
  email,
  showAccount,
}: {
  email: BriefEmail;
  showAccount: boolean;
}) {
  return (
    <li className="flex gap-3 py-2.5">
      <span
        aria-hidden
        className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand/70"
      />
      <a
        href={email.link || undefined}
        target="_blank"
        rel="noreferrer"
        className="group min-w-0 flex-1"
      >
        <div className="flex items-center gap-2">
          <p className="flex-1 truncate text-sm font-medium leading-snug text-foreground group-hover:text-brand">
            {email.subject}
          </p>
          {showAccount && <AccountTag account={email.account} />}
          {email.from && (
            <span className="shrink-0 text-xs text-text-secondary">{email.from}</span>
          )}
        </div>
        {email.snippet && (
          <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">
            {email.snippet}
          </p>
        )}
      </a>
    </li>
  );
}

function EventRow({
  event,
  showAccount,
}: {
  event: BriefEvent;
  showAccount: boolean;
}) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <CalendarClock className="h-4 w-4 shrink-0 text-text-secondary" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-snug text-foreground">
          {event.title}
        </p>
        {event.location && (
          <p className="truncate text-xs text-muted-foreground">{event.location}</p>
        )}
      </div>
      {showAccount && <AccountTag account={event.account} />}
      <span className="shrink-0 text-xs text-text-secondary">
        {formatEventWhen(event)}
      </span>
    </li>
  );
}

/** "Connect Google" prompt — shown when the box has no Google token yet.
 *  Mirrors the calendar-not-connected pattern; the brief lights up the moment
 *  the operator runs the google-workspace login. */
function ConnectGoogle() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-4">
      <p className="text-sm font-medium text-foreground">
        Connect Google to see your mail and calendar
      </p>
      <p className="text-sm text-text-secondary">
        Top of Mind and On Your Calendar read your Gmail and Google Calendar.
      </p>
      <Button size="sm" onClick={() => navigate("/settings/google")}>
        Connect Google accounts
      </Button>
    </div>
  );
}

function SectionNote({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "warn";
}) {
  return (
    <p
      className={`text-sm ${tone === "warn" ? "text-destructive" : "text-text-secondary"}`}
    >
      {children}
    </p>
  );
}

/* ── Google News ───────────────────────────────────────────────────────── */

function GoogleNews({
  news,
  loading,
  error,
  hasMore,
  onRetry,
  onRefresh,
  sentinelRef,
}: {
  news: NewsItem[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  onRetry: () => void;
  onRefresh: () => void;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
}) {
  // Lead = first story with an image (falls back to the first story).
  const leadIdx = useMemo(() => {
    const i = news.findIndex((n) => n.image);
    return i === -1 ? 0 : i;
  }, [news]);
  const lead = news[leadIdx];
  const rest = useMemo(() => news.filter((_, i) => i !== leadIdx), [news, leadIdx]);

  // "Picks for you": one fresh story per source, for source diversity.
  const picks = useMemo(() => {
    const seen = new Set<string>();
    const out: NewsItem[] = [];
    for (const n of news) {
      if (seen.has(n.source_id)) continue;
      seen.add(n.source_id);
      out.push(n);
      if (out.length >= 6) break;
    }
    return out;
  }, [news]);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <Newspaper className="h-5 w-5 text-brand" />
          <h2 className="text-xl font-semibold tracking-tight">Your briefing</h2>
        </div>
        <span className="text-sm text-text-secondary">{todayLong()}</span>
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        {/* Main column — Top stories */}
        <div className="flex flex-col gap-4 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">Top stories</h3>
            <Button
              type="button"
              ghost
              size="sm"
              className="gap-1.5 text-text-secondary hover:text-foreground"
              onClick={onRefresh}
              disabled={loading}
            >
              {loading ? (
                <Spinner />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Refresh feed
            </Button>
          </div>

          {lead && <LeadStory item={lead} />}
          {rest.map((item, i) => (
            <StoryRow key={`${item.source_id}-${i}-${item.link}`} item={item} />
          ))}

          {error && (
            <div className="flex flex-col gap-2">
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
              <div>
                <Button type="button" size="sm" onClick={onRetry}>
                  Retry
                </Button>
              </div>
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center gap-2 py-4 text-sm text-text-secondary">
              <Spinner />
              <span>Loading news…</span>
            </div>
          )}

          {!loading && !error && news.length === 0 && (
            <p className="text-sm text-text-secondary">
              No news yet. Pick sources in Settings → Daily Digest.
            </p>
          )}

          {/* Infinite-scroll sentinel + end marker */}
          <div ref={sentinelRef} aria-hidden className="h-px w-full" />
          {!hasMore && news.length > 0 && (
            <p className="py-2 text-center text-xs text-text-secondary">
              You're all caught up.
            </p>
          )}
        </div>

        {/* Sidebar — Picks for you */}
        {picks.length > 0 && (
          <aside className="hidden flex-col gap-3 lg:flex">
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="mb-3 text-sm font-semibold text-foreground">Picks for you</h3>
              <ul className="flex flex-col divide-y divide-border">
                {picks.map((item, i) => (
                  <li key={`pick-${item.source_id}-${i}`} className="py-2.5 first:pt-0 last:pb-0">
                    <a
                      href={item.link || undefined}
                      target="_blank"
                      rel="noreferrer"
                      className="group flex flex-col gap-1"
                    >
                      <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                        {item.source}
                      </span>
                      <span className="line-clamp-3 text-sm font-medium leading-snug group-hover:text-brand">
                        {item.title || "(untitled)"}
                      </span>
                      <span className="text-xs text-text-secondary">
                        {isoTimeAgo(item.published)}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}

/** Big featured card — large image, headline, source/time. */
function LeadStory({ item }: { item: NewsItem }) {
  return (
    <a
      href={item.link || undefined}
      target="_blank"
      rel="noreferrer"
      className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-brand/40"
    >
      <StoryThumb image={item.image} className="aspect-[16/9] w-full" iconClassName="h-10 w-10" />
      <div className="flex flex-col gap-1.5 p-4">
        <StorySource item={item} />
        <h4 className="text-lg font-semibold leading-snug group-hover:text-brand">
          {item.title || "(untitled)"}
        </h4>
        {item.summary && (
          <p className="line-clamp-2 text-sm text-muted-foreground">{item.summary}</p>
        )}
      </div>
    </a>
  );
}

/** Compact story row — thumbnail left, headline right (Google News list item). */
function StoryRow({ item }: { item: NewsItem }) {
  return (
    <a
      href={item.link || undefined}
      target="_blank"
      rel="noreferrer"
      className="group flex items-start gap-4 rounded-xl border border-border bg-card p-3 transition-colors hover:border-brand/40"
    >
      <div className="min-w-0 flex-1">
        <StorySource item={item} />
        <h4 className="mt-1 line-clamp-2 text-sm font-semibold leading-snug group-hover:text-brand">
          {item.title || "(untitled)"}
        </h4>
        {item.summary && (
          <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{item.summary}</p>
        )}
      </div>
      <StoryThumb
        image={item.image}
        className="h-20 w-28 rounded-lg sm:h-24 sm:w-36"
      />
    </a>
  );
}

function StorySource({ item }: { item: NewsItem }) {
  const when = isoTimeAgo(item.published);
  return (
    <div className="flex items-center gap-1.5 text-xs text-text-secondary">
      <span className="font-medium text-foreground/80">{item.source}</span>
      {when && when !== "unknown" && (
        <>
          <ChevronRight className="h-3 w-3 opacity-50" />
          <span>{when}</span>
        </>
      )}
    </div>
  );
}

/** Article thumbnail: the feed image when present, else a neutral placeholder
 *  tile (so every story shows a thumbnail). Self-heals if the image 404s. */
function StoryThumb({
  image,
  className,
  iconClassName,
}: {
  image?: string;
  className?: string;
  iconClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(image) && !failed;
  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden bg-muted ${className ?? ""}`}
    >
      {showImage ? (
        <img
          src={image}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <Newspaper className={`text-text-secondary opacity-40 ${iconClassName ?? "h-6 w-6"}`} />
      )}
    </div>
  );
}

/* ── Shared helpers ────────────────────────────────────────────────────── */

/** Calendar event → a compact "when" label (all-day, or start time). */
function formatEventWhen(event: BriefEvent): string {
  if (event.all_day) return "All day";
  if (!event.start) return "";
  const d = new Date(event.start);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/* ── Job Outcomes ──────────────────────────────────────────────────────── */

function JobOutcomes() {
  const [outputs, setOutputs] = useState<CronOutput[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    api
      .getCronOutputs(10)
      .then((r) => setOutputs(r.outputs))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load job outcomes."),
      );
  }, []);

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-text-secondary" />
          <CardTitle>Job Outcomes</CardTitle>
        </div>
        <CardDescription>Recent completed agent job runs. Click to expand.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : outputs == null ? (
          <Loading />
        ) : outputs.length === 0 ? (
          <Empty>No completed jobs yet.</Empty>
        ) : (
          outputs.map((o) => {
            const key = `${o.profile ?? ""}:${o.job_id}:${o.timestamp}`;
            const open = expanded.has(key);
            const failed = o.last_status === "error";
            return (
              <div key={key} className="rounded border border-border bg-card">
                <button
                  type="button"
                  onClick={() => toggle(key)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left"
                >
                  <ChevronRight
                    className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                      open ? "rotate-90" : ""
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {o.job_name}
                  </span>
                  {o.ran_at && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {isoTimeAgo(o.ran_at)}
                    </span>
                  )}
                  <Badge tone={failed ? "destructive" : "success"}>
                    {failed ? "error" : "ok"}
                  </Badge>
                </button>
                {open && (
                  <div className="border-t border-border px-3 py-3">
                    {o.output.trim() ? (
                      <Markdown content={o.output} />
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        (No output recorded for this run.)
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function formatDue(due: string): string {
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return "due";
  return `due ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function Loading() {
  return (
    <div className="flex items-center gap-2 py-2 text-sm text-text-secondary">
      <Spinner />
      <span>Loading…</span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-text-secondary">{children}</p>;
}
