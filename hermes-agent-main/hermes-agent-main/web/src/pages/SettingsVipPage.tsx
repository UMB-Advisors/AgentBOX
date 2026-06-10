import { useCallback, useEffect, useState } from "react";
import { Crown, Plus, Trash2 } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { api } from "@/lib/api";
import type { VipSender, VipSenderKind } from "@/lib/api";
import { usePageHeader } from "@/contexts/usePageHeader";

/**
 * VIP senders (MBOX-474 — port of the mailbox dashboard /settings/vip surface).
 *
 * This page is a pure frontend re-style of the mailbox dashboard's VIP list
 * management. It does NOT keep a hermes-side copy of the list: every read and
 * write goes through the existing /dashboard/* reverse proxy to the on-box
 * mailbox-dashboard (:3001), which owns the ``mailbox.vip_senders`` table that
 * the urgency engine reads (see the mailbox CLAUDE.md "Urgency engine + VIP
 * senders" convention). The list is therefore always the SAME data the
 * pipeline scores against — adds/removes here take effect for triage urgency.
 *
 * Match semantics are exact-email or whole-domain — no wildcards or regex.
 */

type Banner = { kind: "success" | "error"; text: string };

/** Short, human-readable added date (falls back to the raw string). */
function formatAddedAt(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function SettingsVipPage() {
  const { setTitle } = usePageHeader();

  useEffect(() => {
    setTitle("VIP senders");
  }, [setTitle]);

  const [senders, setSenders] = useState<VipSender[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  const [kind, setKind] = useState<VipSenderKind>("email");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false);
  // In-flight remove ids. A Set (not a single id) so two quick clicks on
  // different rows don't clobber each other's finally-cleanup — each row
  // tracks its own DELETE independently.
  const [removingIds, setRemovingIds] = useState<Set<number>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listVipSenders();
      setSenders(res.senders);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load VIP senders");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auto-dismiss the SUCCESS banner after a few seconds; error banners stay
  // until the next action so the operator can read what failed.
  useEffect(() => {
    if (banner?.kind !== "success") return;
    const id = window.setTimeout(() => setBanner(null), 4000);
    return () => window.clearTimeout(id);
  }, [banner]);

  const trimmed = value.trim();
  const addDisabled = adding || trimmed.length === 0;

  const add = useCallback(async () => {
    if (trimmed.length === 0) return;
    setAdding(true);
    setBanner(null);
    try {
      const res = await api.addVipSender({
        email_or_domain: trimmed,
        kind,
        note: note.trim() || undefined,
      });
      const added = res.sender;
      // Idempotent upsert on (email_or_domain, kind): replace any existing row
      // with the same id, else prepend (mirrors the server's upsert).
      setSenders((prev) => [added, ...prev.filter((s) => s.id !== added.id)]);
      setValue("");
      setNote("");
      setBanner({ kind: "success", text: `Added ${added.email_or_domain}` });
    } catch (e) {
      setBanner({
        kind: "error",
        text: e instanceof Error ? e.message : "Failed to add VIP sender",
      });
    } finally {
      setAdding(false);
    }
  }, [trimmed, kind, note]);

  const remove = useCallback(async (s: VipSender) => {
    if (
      !window.confirm(
        `Remove ${s.email_or_domain}? Their email will no longer be flagged VIP.`,
      )
    )
      return;
    setRemovingIds((prev) => new Set(prev).add(s.id));
    setBanner(null);
    try {
      await api.removeVipSender(s.id);
      setSenders((prev) => prev.filter((row) => row.id !== s.id));
      setBanner({ kind: "success", text: `Removed ${s.email_or_domain}` });
    } catch (e) {
      setBanner({
        kind: "error",
        text: e instanceof Error ? e.message : "Failed to remove VIP sender",
      });
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(s.id);
        return next;
      });
    }
  }, []);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <CardDescription className="mb-4">
        Email from a VIP sender is always flagged urgent in the queue — matched
        by exact address or by whole domain. No wildcards or patterns.
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
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Crown className="h-4 w-4 text-text-secondary" />
                <CardTitle>Add a VIP sender</CardTitle>
              </div>
              <CardDescription>
                Choose whether to match a single email address or a whole
                domain, then enter the value.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-start gap-3">
              <div className="flex w-full max-w-lg flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-xs text-text-secondary">
                  Match by
                  <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value as VipSenderKind)}
                    disabled={adding}
                    className="mt-1 rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                  >
                    <option value="email">Email</option>
                    <option value="domain">Domain</option>
                  </select>
                </label>
                <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-text-secondary">
                  {kind === "email" ? "Email address" : "Domain"}
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !addDisabled) void add();
                    }}
                    placeholder={kind === "email" ? "ceo@acme.com" : "acme.com"}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                  />
                </label>
              </div>
              <label className="flex w-full max-w-lg flex-col gap-1 text-xs text-text-secondary">
                Note (optional)
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !addDisabled) void add();
                  }}
                  placeholder="key account, escalations, …"
                  className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
              </label>
              <Button
                onClick={() => void add()}
                disabled={addDisabled}
                prefix={
                  adding ? <Spinner /> : <Plus className="h-3.5 w-3.5" />
                }
              >
                Add VIP sender
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Current list</CardTitle>
              <CardDescription>{senders.length} VIP senders.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {senders.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  No VIP senders yet. Add one above to start flagging their
                  email as urgent.
                </p>
              ) : (
                senders.map((s) => {
                  const addedAt = formatAddedAt(s.added_at);
                  return (
                    <div
                      key={s.id}
                      className="flex items-center gap-3 rounded border border-border px-3 py-2"
                    >
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-bold">
                            {s.email_or_domain}
                          </span>
                          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-text-tertiary">
                            {s.kind}
                          </span>
                        </div>
                        <span className="truncate text-xs text-text-tertiary">
                          {addedAt ? `added ${addedAt}` : ""}
                          {s.note ? ` · ${s.note}` : ""}
                        </span>
                      </div>
                      <Button
                        outlined
                        destructive
                        size="sm"
                        disabled={removingIds.has(s.id)}
                        prefix={
                          removingIds.has(s.id) ? (
                            <Spinner />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )
                        }
                        onClick={() => void remove(s)}
                      >
                        Remove
                      </Button>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
