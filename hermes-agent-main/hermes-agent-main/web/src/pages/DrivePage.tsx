import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, File, Folder, HardDrive } from "lucide-react";
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
import { api } from "@/lib/api";
import type { GoogleDriveFile, GoogleDriveResponse } from "@/lib/api";
import { isoTimeAgo } from "@/lib/utils";
import { usePageHeader } from "@/contexts/usePageHeader";
import { useAccountView } from "@/contexts/useAccountView";

/**
 * Drive — a recent-files browser backed by the operator's connected Google
 * accounts (`GET /api/google/drive`). Files come back sorted by modified time
 * (most recent first); the search box filters by name (debounced). When no
 * Google account is connected the page shows a "Connect Google" prompt.
 */
const SEARCH_DEBOUNCE_MS = 350;

export default function DrivePage() {
  const { setTitle } = usePageHeader();
  useEffect(() => {
    setTitle("Drive");
  }, [setTitle]);

  const { view } = useAccountView();
  const [query, setQuery] = useState("");
  // Debounced copy of ``query`` — the value actually sent to the API.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [data, setData] = useState<GoogleDriveResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce the search input so typing doesn't spam the API.
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.getGoogleDrive(view, debouncedQuery));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Drive.");
    } finally {
      setLoading(false);
    }
  }, [view, debouncedQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const connected = data?.connected ?? false;
  const files = data?.files ?? [];
  const driveError = data?.error ?? null;
  const firstLoad = loading && data == null;
  const showAccountTag = view === "combined";
  const searching = debouncedQuery.trim().length > 0;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-text-secondary" />
            <CardTitle>Drive</CardTitle>
          </div>
          <CardDescription>Recent files from your Google accounts.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {firstLoad ? (
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <Spinner />
              <span>Loading your files…</span>
            </div>
          ) : error ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Couldn't load Drive. {error}</span>
              </div>
              <div>
                <Button type="button" size="sm" onClick={() => void load()}>
                  Retry
                </Button>
              </div>
            </div>
          ) : !connected ? (
            <ConnectGoogle />
          ) : (
            <>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search Drive by name…"
                className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-text-tertiary focus:border-brand focus:outline-none"
              />

              {driveError ? (
                <p className="text-sm text-destructive">{driveError}</p>
              ) : files.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  {searching ? "No files found." : "No recent files."}
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {files.map((f) => (
                    <FileRow key={f.id} file={f} showAccount={showAccountTag} />
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ── File rows ─────────────────────────────────────────────────────────── */

function FileRow({
  file,
  showAccount,
}: {
  file: GoogleDriveFile;
  showAccount: boolean;
}) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <FileIcon file={file} />
      <div className="min-w-0 flex-1">
        <a
          href={file.webViewLink || undefined}
          target="_blank"
          rel="noreferrer"
          className="block truncate text-sm font-medium leading-snug text-foreground hover:text-brand"
        >
          {file.name || "(untitled)"}
        </a>
      </div>
      {showAccount && <AccountTag account={file.account} />}
      <span className="shrink-0 text-xs text-text-secondary">
        {modifiedLabel(file.modifiedTime)}
      </span>
    </li>
  );
}

/** Drive's own file icon (``iconLink``) when present; falls back to a generic
 *  lucide File/Folder glyph if the icon is missing or 404s. */
function FileIcon({ file }: { file: GoogleDriveFile }) {
  const [failed, setFailed] = useState(false);
  const Fallback = file.folder ? Folder : File;
  if (!file.iconLink || failed) {
    return <Fallback className="h-4 w-4 shrink-0 text-text-secondary" />;
  }
  return (
    <img
      src={file.iconLink}
      alt=""
      width={16}
      height={16}
      referrerPolicy="no-referrer"
      className="h-4 w-4 shrink-0"
      onError={() => setFailed(true)}
    />
  );
}

/** "Connect Google" prompt — shown when no Google account is connected.
 *  Mirrors the Home/Settings connect prompt. */
function ConnectGoogle() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-4">
      <p className="text-sm font-medium text-foreground">
        Connect Google to browse Drive
      </p>
      <p className="text-sm text-text-secondary">
        Drive shows your recent files and lets you search them by name.
      </p>
      <Button size="sm" onClick={() => navigate("/settings/google")}>
        Connect Google accounts
      </Button>
    </div>
  );
}

/* ── Formatting ────────────────────────────────────────────────────────── */

/** ISO modified time → a relative label ("3h ago"), falling back to "" when
 *  unparseable so the row stays clean. */
function modifiedLabel(iso: string): string {
  if (!iso) return "";
  const ago = isoTimeAgo(iso);
  return ago === "unknown" ? "" : ago;
}
