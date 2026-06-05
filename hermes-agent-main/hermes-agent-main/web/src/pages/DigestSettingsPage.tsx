import { useCallback, useEffect, useState } from "react";
import { ListChecks, Newspaper, Plus, Sparkles, X } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Checkbox } from "@nous-research/ui/ui/components/checkbox";
import { Input } from "@nous-research/ui/ui/components/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { api } from "@/lib/api";
import type { DigestPrefs, NewsSource } from "@/lib/api";
import { usePageHeader } from "@/contexts/usePageHeader";

/**
 * Daily Digest settings — pick which modules surface on the Home digest and
 * which news feeds the Top News module pulls from. Persists to the server
 * (`/api/digest/prefs`); HomePage reads the same prefs to render the digest.
 */
export default function DigestSettingsPage() {
  const { setTitle } = usePageHeader();
  const { toast, showToast } = useToast();

  useEffect(() => {
    setTitle("Daily Digest");
  }, [setTitle]);

  const [prefs, setPrefs] = useState<DigestPrefs | null>(null);
  const [sources, setSources] = useState<NewsSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Add-custom-feed form
  const [newUrl, setNewUrl] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api.getDigestPrefs(), api.getNewsSources()])
      .then(([p, s]) => {
        setPrefs(p);
        setSources(s.sources);
      })
      .catch((e: unknown) =>
        showToast(e instanceof Error ? e.message : "Failed to load", "error"),
      )
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleModule = useCallback((key: string, on: boolean) => {
    setPrefs((p) =>
      p ? { ...p, modules: { ...p.modules, [key]: on } } : p,
    );
  }, []);

  const toggleSource = useCallback((id: string, on: boolean) => {
    setPrefs((p) => {
      if (!p) return p;
      const set = new Set(p.news_sources);
      if (on) set.add(id);
      else set.delete(id);
      return { ...p, news_sources: Array.from(set) };
    });
  }, []);

  const save = useCallback(async () => {
    if (!prefs) return;
    setSaving(true);
    try {
      const saved = await api.setDigestPrefs({
        modules: prefs.modules,
        news_sources: prefs.news_sources,
      });
      setPrefs(saved);
      showToast("Saved ✓", "success");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to save", "error");
    } finally {
      setSaving(false);
    }
  }, [prefs, showToast]);

  const refreshSources = useCallback(async () => {
    const s = await api.getNewsSources();
    setSources(s.sources);
  }, []);

  const addCustom = useCallback(async () => {
    if (!prefs) return;
    const url = newUrl.trim();
    if (!url) return;
    setBusy(true);
    try {
      const prevIds = new Set(prefs.custom_sources.map((c) => c.id));
      // Persist the new feed (server SSRF-validates + assigns an id)…
      const saved = await api.setDigestPrefs({
        custom_sources: [
          ...prefs.custom_sources.map((c) => ({ id: c.id, label: c.label, url: c.url })),
          { label: newLabel.trim() || undefined, url },
        ],
      });
      // …then auto-select it so it shows up in the feed right away.
      const added = saved.custom_sources.find((c) => !prevIds.has(c.id));
      const finalPrefs = added
        ? await api.setDigestPrefs({
            news_sources: [...saved.news_sources, added.id],
          })
        : saved;
      setPrefs(finalPrefs);
      setNewUrl("");
      setNewLabel("");
      await refreshSources();
      showToast("Source added ✓", "success");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to add source", "error");
    } finally {
      setBusy(false);
    }
  }, [prefs, newUrl, newLabel, refreshSources, showToast]);

  const removeCustom = useCallback(
    async (id: string) => {
      if (!prefs) return;
      setBusy(true);
      try {
        const saved = await api.setDigestPrefs({
          custom_sources: prefs.custom_sources
            .filter((c) => c.id !== id)
            .map((c) => ({ id: c.id, label: c.label, url: c.url })),
          news_sources: prefs.news_sources.filter((s) => s !== id),
        });
        setPrefs(saved);
        await refreshSources();
        showToast("Source removed", "success");
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Failed to remove source", "error");
      } finally {
        setBusy(false);
      }
    },
    [prefs, refreshSources, showToast],
  );

  if (loading || !prefs) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner className="text-2xl text-primary" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Toast toast={toast} />
      <CardDescription className="mb-4">
        Choose what appears on your Home daily digest, and which news sources to
        pull from. The digest page scrolls endlessly through your selected feeds.
      </CardDescription>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Modules</CardTitle>
            <CardDescription>Sections shown on the digest.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ModuleRow
              icon={<Sparkles className="h-4 w-4 text-text-secondary" />}
              label="Daily brief"
              description="Top of Mind (Gmail), On Your Calendar (Google Calendar), and FYI (your Kanban tasks)."
              checked={prefs.modules.summary !== false}
              onChange={(on) => toggleModule("summary", on)}
            />
            <ModuleRow
              icon={<ListChecks className="h-4 w-4 text-text-secondary" />}
              label="Action items"
              description="Open action items extracted from your inbox."
              checked={prefs.modules.action_items !== false}
              onChange={(on) => toggleModule("action_items", on)}
            />
            <ModuleRow
              icon={<Newspaper className="h-4 w-4 text-text-secondary" />}
              label="Top news"
              description="An infinite feed merged from your selected sources."
              checked={prefs.modules.news !== false}
              onChange={(on) => toggleModule("news", on)}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>News sources</CardTitle>
            <CardDescription>
              Feeds for the Top News module ({prefs.news_sources.length} selected).
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {sources.map((s) => {
                const on = prefs.news_sources.includes(s.id);
                return (
                  <label
                    key={s.id}
                    className="flex cursor-pointer items-center gap-2 rounded border border-border px-3 py-2 text-sm hover:bg-muted/20"
                    title={s.url}
                  >
                    <Checkbox
                      checked={on}
                      disabled={prefs.modules.news === false}
                      onCheckedChange={(c) => toggleSource(s.id, c === true)}
                    />
                    <span className="flex-1 truncate">{s.label}</span>
                    {s.custom && (
                      <button
                        type="button"
                        aria-label={`Remove ${s.label}`}
                        disabled={busy}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void removeCustom(s.id);
                        }}
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive disabled:opacity-50"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </label>
                );
              })}
              {sources.length === 0 && (
                <p className="text-sm text-muted-foreground">No sources available.</p>
              )}
            </div>

            {/* Add a custom RSS/Atom feed. The server validates the URL and
                rejects private/internal addresses. */}
            <div className="flex flex-col gap-2 border-t border-border pt-3">
              <span className="text-xs text-muted-foreground">
                Add a custom RSS / Atom feed
              </span>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  placeholder="https://example.com/rss"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void addCustom();
                    }
                  }}
                  className="flex-1"
                />
                <Input
                  placeholder="Label (optional)"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  className="sm:w-48"
                />
                <Button
                  onClick={() => void addCustom()}
                  disabled={busy || !newUrl.trim()}
                  prefix={busy ? <Spinner /> : <Plus className="h-3.5 w-3.5" />}
                >
                  Add
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={save} disabled={saving} prefix={saving ? <Spinner /> : undefined}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ModuleRow({
  icon,
  label,
  description,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded border border-border px-3 py-2 hover:bg-muted/20">
      <Checkbox
        checked={checked}
        className="mt-0.5"
        onCheckedChange={(c) => onChange(c === true)}
      />
      <span className="flex items-start gap-2">
        <span className="mt-0.5">{icon}</span>
        <span className="flex flex-col">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-xs text-muted-foreground">{description}</span>
        </span>
      </span>
    </label>
  );
}
