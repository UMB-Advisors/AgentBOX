import { useCallback, useEffect, useState } from "react";
import { MessagesSquare, RefreshCw } from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { cn } from "@/lib/utils";
import { api, type Conversation } from "@/lib/api";

// Operations > Conversations — Gemini meeting notes (gemini-notes@google.com)
// parsed server-side (/api/conversations) into summary, topic sections, and
// owner-tagged next steps. Read-only; the source of truth stays the email.

export default function ConversationsView() {
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback((refresh: boolean) => {
    if (refresh) setRefreshing(true);
    api
      .getConversations(refresh)
      .then((res) => {
        setConversations(res.conversations);
        setError(res.conversations.length === 0 ? (res.reason ?? null) : null);
        setSelectedId((cur) =>
          cur !== null && res.conversations.some((c) => c.id === cur)
            ? cur
            : (res.conversations[0]?.id ?? null),
        );
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "failed to load conversations");
        setConversations((cur) => cur ?? []);
      })
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => load(false), [load]);

  if (conversations === null) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Meeting notes captured by Gemini across your connected inboxes.
        </p>
        <Button
          type="button"
          outlined
          size="sm"
          onClick={() => load(true)}
          disabled={refreshing}
        >
          <RefreshCw className={cn("mr-1 h-3.5 w-3.5", refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {conversations.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <MessagesSquare className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No meeting notes yet. Turn on &ldquo;Take notes with Gemini&rdquo; in
              Google Meet and notes will appear here after each meeting.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-[280px_1fr]">
          <nav aria-label="Meetings" className="flex flex-col gap-2">
            {conversations.map((c) => {
              const isSelected = c.id === selectedId;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  aria-current={isSelected ? "true" : undefined}
                  className={cn(
                    "rounded-md border px-3 py-2 text-left transition-colors",
                    isSelected
                      ? "border-brand bg-accent/40"
                      : "border-border hover:bg-accent/20",
                  )}
                >
                  <span className="block truncate text-sm font-medium">{c.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {c.meeting_date || c.received_at?.slice(0, 10)} · {c.account}
                  </span>
                </button>
              );
            })}
          </nav>

          {selected ? (
            <Card>
              <CardContent className="flex flex-col gap-5 py-5">
                <div>
                  <h2 className="text-lg font-semibold">{selected.title}</h2>
                  <p className="text-xs text-muted-foreground">
                    {selected.meeting_date || selected.received_at?.slice(0, 10)} ·
                    via {selected.account}
                  </p>
                </div>

                {selected.summary && (
                  <section>
                    <h3 className="mb-1 text-sm font-semibold">Summary</h3>
                    <p className="text-sm text-muted-foreground">{selected.summary}</p>
                  </section>
                )}

                {selected.sections.map((s, i) => (
                  <section key={i}>
                    <h3 className="mb-1 text-sm font-semibold">{s.heading}</h3>
                    <p className="text-sm text-muted-foreground">{s.text}</p>
                  </section>
                ))}

                {selected.next_steps.length > 0 && (
                  <section>
                    <h3 className="mb-2 text-sm font-semibold">
                      Next steps ({selected.next_steps.length})
                    </h3>
                    <ul className="flex flex-col gap-2">
                      {selected.next_steps.map((step, i) => (
                        <li
                          key={i}
                          className="rounded-md border border-border p-2"
                        >
                          <div className="mb-1 flex flex-wrap items-center gap-1">
                            {step.owners.map((o) => (
                              <Badge key={o} tone="secondary">
                                {o}
                              </Badge>
                            ))}
                            {step.title && (
                              <span className="text-sm font-medium">{step.title}</span>
                            )}
                          </div>
                          {step.text && (
                            <p className="text-sm text-muted-foreground">{step.text}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </CardContent>
            </Card>
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground">
              Select a meeting to view its notes.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
