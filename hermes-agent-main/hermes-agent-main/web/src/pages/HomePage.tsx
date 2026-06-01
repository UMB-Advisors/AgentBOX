import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { api, type DigestResponse } from "@/lib/api";
import { usePageHeader } from "@/contexts/usePageHeader";

/**
 * Home — the AgentBOX landing pane. Surfaces the most-recent daily digest,
 * sourced from gbrain via the Hermes backend's ``GET /api/digest/latest``
 * proxy (see HermesBOX/docs/dashboard-simplification-prd, Phase 3).
 *
 * The digest body is rendered as preformatted markdown text: no markdown
 * renderer is bundled in web/src today, and preformatted text avoids both a
 * new dependency and the XSS surface of dangerouslySetInnerHTML. When no
 * digest has been produced yet the endpoint returns ``markdown: null`` and
 * the page shows a clean empty state.
 */
export default function HomePage() {
  const { setTitle } = usePageHeader();
  useEffect(() => {
    setTitle("Home");
  }, [setTitle]);

  const [digest, setDigest] = useState<DigestResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getDigest();
      setDigest(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load digest.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasContent = !loading && !error && digest?.markdown != null;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-text-secondary" />
              <CardTitle>{hasContent && digest?.title ? digest.title : "Daily Digest"}</CardTitle>
            </div>
            <Button
              type="button"
              ghost
              size="icon"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => void load()}
              disabled={loading}
              aria-label="Refresh digest"
            >
              {loading ? <Spinner /> : <RefreshCw />}
            </Button>
          </div>
          <CardDescription>
            {hasContent && digest?.date
              ? `Your most important info for ${digest.date}.`
              : "Your most important info for today."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <Spinner />
              <span>Loading your digest…</span>
            </div>
          ) : error ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Couldn’t load the digest. {error}</span>
              </div>
              <div>
                <Button type="button" size="sm" onClick={() => void load()}>
                  Retry
                </Button>
              </div>
            </div>
          ) : hasContent ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-foreground">
              {digest?.markdown}
            </pre>
          ) : (
            <p className="text-sm text-text-secondary">
              No digest yet. Once gbrain produces today’s digest it will appear
              here automatically.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
