import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
} from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { api } from "@/lib/api";
import type {
  ClassificationDraftOutcome,
  ClassificationRoute,
  ClassificationRow,
} from "@/lib/api";
import { usePageHeader } from "@/contexts/usePageHeader";

/**
 * Classifications management (MBOX-472) — port of the mailbox-dashboard
 * /classifications surface. Lists recent classification-log rows (category,
 * confidence, route, draft outcome) with category/route/confidence filters, and
 * a per-sender "reclassify automatically" action (MBOX-370): take the sender off
 * the spam list and re-run the classifier on their existing mail.
 *
 * Data is read-only from the operator's side except the reclassify action. Both
 * the list and the action go through hermes ``/api/classifications*`` proxy
 * routes that forward to the on-box mailbox-dashboard (the classification data
 * lives in the mailbox Postgres pipeline; hermes_cli proxies rather than queries
 * — same model as Job Outcomes / Unified Inbox). If the upstream list route is
 * not present yet the table degrades to an empty state.
 */

const ROUTES: ClassificationRoute[] = ["drop", "local", "cloud"];

type ConfidenceBand = "low" | "mid" | "high";
type Banner = { kind: "success" | "error"; text: string };

/** Bare address out of a "Name <addr>" header, lowercased; null if no ``@``. */
function bareEmail(addr: string | null): string | null {
  if (!addr) return null;
  const angle = addr.match(/<([^>]+)>/);
  const out = (angle ? angle[1] : addr).trim().toLowerCase();
  return out.includes("@") ? out : null;
}

/** Display name out of a "Name <addr>" header, else the local-part / raw. */
function senderName(addr: string | null): string {
  if (!addr) return "unknown";
  return addr.match(/^"?([^"<]+)"?\s*</)?.[1]?.trim() || addr.split("@")[0] || addr;
}

function confColor(conf: number): string {
  if (conf >= 0.85) return "text-success";
  if (conf >= 0.6) return "text-warning";
  return "text-destructive";
}

function routeColor(route: ClassificationRoute): string {
  switch (route) {
    case "drop":
      return "text-text-tertiary";
    case "local":
      return "text-success";
    case "cloud":
      return "text-warning";
  }
}

function outcomeTone(
  status: ClassificationDraftOutcome,
): "success" | "warning" | "destructive" | "secondary" {
  switch (status) {
    case "sent":
      return "success";
    case "approved":
    case "edited":
      return "warning";
    case "rejected":
    case "failed":
      return "destructive";
    default:
      return "secondary";
  }
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SettingsClassificationsPage() {
  const { setTitle } = usePageHeader();

  useEffect(() => {
    setTitle("Classifications");
  }, [setTitle]);

  const [rows, setRows] = useState<ClassificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  // Email whose reclassify request is in flight (disables that row's control).
  const [busyEmail, setBusyEmail] = useState<string | null>(null);

  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [routeFilter, setRouteFilter] = useState<ClassificationRoute | null>(null);
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceBand | null>(
    null,
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listClassifications(100);
      // The upstream list route may return a bare array or a ``{ rows }``
      // envelope — normalise both.
      const list = Array.isArray(res) ? res : res.rows;
      setRows(list ?? []);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load classifications",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reclassifySender = useCallback(
    async (email: string, category: string) => {
      const ok = window.confirm(
        `Reclassify mail from ${email} automatically?\n\n` +
          `This removes them from the spam list and re-runs the classifier on ` +
          `their existing emails (currently "${category}") so each gets its real ` +
          `category. Future mail is classified normally and never auto-dropped ` +
          `as spam.`,
      );
      if (!ok) return;
      setBusyEmail(email);
      setBanner(null);
      try {
        const res = await api.reclassifySender(email);
        const n = typeof res.queued === "number" ? res.queued : 0;
        setBanner({
          kind: "success",
          text:
            `Added ${email} to never-spam — re-classifying ${n}${res.capped ? "+" : ""} ` +
            `existing email${n === 1 ? "" : "s"} in the background. Refresh in a ` +
            `moment to see updates.`,
        });
        await refresh();
      } catch (e) {
        setBanner({
          kind: "error",
          text: e instanceof Error ? e.message : "reclassify failed",
        });
      } finally {
        setBusyEmail(null);
      }
    },
    [refresh],
  );

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (categoryFilter && r.category !== categoryFilter) return false;
      if (routeFilter && r.route !== routeFilter) return false;
      if (confidenceFilter === "low" && r.confidence >= 0.6) return false;
      if (confidenceFilter === "mid" && (r.confidence < 0.6 || r.confidence >= 0.85))
        return false;
      if (confidenceFilter === "high" && r.confidence < 0.85) return false;
      return true;
    });
  }, [rows, categoryFilter, routeFilter, confidenceFilter]);

  const categoryCounts = useMemo(() => {
    const acc = new Map<string, number>();
    for (const r of rows) acc.set(r.category, (acc.get(r.category) ?? 0) + 1);
    return acc;
  }, [rows]);

  const routeCounts = useMemo(() => {
    const acc = new Map<ClassificationRoute, number>();
    for (const r of rows) acc.set(r.route, (acc.get(r.route) ?? 0) + 1);
    return acc;
  }, [rows]);

  const categories = useMemo(
    () => Array.from(categoryCounts.keys()).sort(),
    [categoryCounts],
  );
  const hasFilter = Boolean(categoryFilter || routeFilter || confidenceFilter);

  const clearFilters = useCallback(() => {
    setCategoryFilter(null);
    setRouteFilter(null);
    setConfidenceFilter(null);
  }, []);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <CardDescription className="mb-4">
        Recent message classifications from the triage pipeline — category,
        confidence, route, and draft outcome. Reclassify a sender to take them off
        the spam list and re-run the classifier on their existing mail.
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
        <Card>
          <CardContent className="flex flex-col gap-3 pt-6">
            {/* Filter bar */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono uppercase tracking-wide text-text-tertiary">
                category:
              </span>
              {categories.map((cat) => (
                <FilterPill
                  key={cat}
                  label={cat}
                  count={categoryCounts.get(cat) ?? 0}
                  active={categoryFilter === cat}
                  onClick={() =>
                    setCategoryFilter((c) => (c === cat ? null : cat))
                  }
                />
              ))}
              <span className="ml-2 font-mono uppercase tracking-wide text-text-tertiary">
                route:
              </span>
              {ROUTES.map((r) => (
                <FilterPill
                  key={r}
                  label={r}
                  count={routeCounts.get(r) ?? 0}
                  active={routeFilter === r}
                  onClick={() => setRouteFilter((c) => (c === r ? null : r))}
                />
              ))}
              <span className="ml-2 font-mono uppercase tracking-wide text-text-tertiary">
                conf:
              </span>
              <FilterPill
                label="<60%"
                active={confidenceFilter === "low"}
                onClick={() =>
                  setConfidenceFilter((c) => (c === "low" ? null : "low"))
                }
              />
              <FilterPill
                label="60-85%"
                active={confidenceFilter === "mid"}
                onClick={() =>
                  setConfidenceFilter((c) => (c === "mid" ? null : "mid"))
                }
              />
              <FilterPill
                label=">=85%"
                active={confidenceFilter === "high"}
                onClick={() =>
                  setConfidenceFilter((c) => (c === "high" ? null : "high"))
                }
              />
              {hasFilter && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="ml-auto font-mono text-text-tertiary hover:text-foreground"
                >
                  clear
                </button>
              )}
              <Badge tone="secondary" className="ml-auto">
                {filtered.length}
                {filtered.length !== rows.length ? ` / ${rows.length}` : ""}
              </Badge>
            </div>

            {/* Table */}
            {filtered.length === 0 ? (
              <div className="flex h-40 items-center justify-center text-sm text-text-secondary">
                {rows.length === 0
                  ? "No classifications yet"
                  : "No matches for this filter"}
              </div>
            ) : (
              <div className="overflow-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="font-mono uppercase tracking-wide text-text-tertiary">
                    <tr className="border-b border-border">
                      <Th>When</Th>
                      <Th>From</Th>
                      <Th>Subject</Th>
                      <Th>Category</Th>
                      <Th className="text-right">Conf</Th>
                      <Th>Route</Th>
                      <Th>Outcome</Th>
                      <Th>Model</Th>
                      <Th className="text-right">Latency</Th>
                      <Th>Reclassify</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row) => (
                      <tr
                        key={row.log_id}
                        className="border-b border-border/60 hover:bg-muted/10"
                      >
                        <Td className="whitespace-nowrap font-mono text-text-tertiary">
                          {formatWhen(row.classified_at)}
                        </Td>
                        <Td
                          className="max-w-[12rem] truncate"
                          title={row.from_addr ?? undefined}
                        >
                          {senderName(row.from_addr)}
                        </Td>
                        <Td
                          className="max-w-sm truncate text-text-secondary"
                          title={row.subject ?? undefined}
                        >
                          {row.subject || "(no subject)"}
                        </Td>
                        <Td>{row.category}</Td>
                        <Td
                          className={`text-right font-mono ${confColor(row.confidence)}`}
                        >
                          {Math.round(row.confidence * 100)}%
                        </Td>
                        <Td className={`font-mono ${routeColor(row.route)}`}>
                          {row.route}
                        </Td>
                        <Td>
                          {row.draft_status == null ? (
                            <span className="font-mono text-[10px] text-text-tertiary">
                              no draft
                            </span>
                          ) : (
                            <Badge tone={outcomeTone(row.draft_status)}>
                              {row.draft_status}
                            </Badge>
                          )}
                        </Td>
                        <Td className="font-mono text-text-tertiary">
                          {row.model_version}
                        </Td>
                        <Td className="text-right font-mono text-text-tertiary">
                          {row.latency_ms != null ? `${row.latency_ms}ms` : "—"}
                        </Td>
                        <Td>
                          <ReclassifyControl
                            fromAddr={row.from_addr}
                            category={row.category}
                            busyEmail={busyEmail}
                            onReclassify={reclassifySender}
                          />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function FilterPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors ${
        active
          ? "border-primary/60 bg-primary/10 text-primary"
          : "border-border bg-muted/20 text-text-secondary hover:text-foreground"
      }`}
    >
      <span>{label}</span>
      {count != null && <span className="opacity-60">{count}</span>}
    </button>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th className={`px-3 py-1.5 text-[10px] font-medium ${className}`}>
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td className={`px-3 py-1.5 text-xs ${className}`} title={title}>
      {children}
    </td>
  );
}

/** Per-sender "reclassify automatically" control (MBOX-370). A single action,
 * not a category picker — only this sender's button disables while its request
 * is in flight. */
function ReclassifyControl({
  fromAddr,
  category,
  busyEmail,
  onReclassify,
}: {
  fromAddr: string | null;
  category: string;
  busyEmail: string | null;
  onReclassify: (email: string, category: string) => void;
}) {
  const email = bareEmail(fromAddr);
  if (!email) {
    return <span className="font-mono text-[10px] text-text-tertiary">—</span>;
  }
  const busy = busyEmail === email;
  return (
    <Button
      outlined
      size="sm"
      disabled={busy}
      aria-label={`Reclassify mail from ${email} automatically`}
      prefix={busy ? <Spinner /> : <RotateCcw className="h-3 w-3" />}
      onClick={() => onReclassify(email, category)}
    >
      Reclassify
    </Button>
  );
}
