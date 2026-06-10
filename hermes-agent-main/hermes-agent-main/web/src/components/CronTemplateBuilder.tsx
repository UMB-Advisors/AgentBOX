import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useModalBehavior } from "@/hooks/useModalBehavior";
import { api } from "@/lib/api";
import type { CronTemplateMessage, CronTemplateProposal } from "@/lib/api";
import type { Department } from "@/lib/crm";
import { cn, themedBody } from "@/lib/utils";

/** A department-categorized starter that seeds the builder conversation. The
 *  `category` is matched (case-insensitively) against the CRM department list
 *  so picking a template can also pre-assign the job's Department. */
interface JobTemplate {
  category: string;
  label: string;
  description: string;
  /** The opening user message sent to the assistant when this template is picked. */
  seed: string;
}

// Curated starters grouped by department. These are conversation seeds, not
// finished jobs — the assistant refines them with the user before proposing.
const TEMPLATES: JobTemplate[] = [
  {
    category: "Sales",
    label: "Daily pipeline digest",
    description: "Summarize new leads & deals each morning, flag stalled ones.",
    seed: "Build a job that runs every weekday morning and gives me a digest of new leads and deals in the pipeline, flagging any that have stalled.",
  },
  {
    category: "Sales",
    label: "Follow-up reminders",
    description: "Weekly list of contacts that need a follow-up touch.",
    seed: "Build a weekly job that lists the contacts I should follow up with and suggests a short next step for each.",
  },
  {
    category: "Research",
    label: "Morning news scan",
    description: "Scan industry sources and summarize what matters.",
    seed: "Build a job that scans industry news every morning and sends me a short summary of the developments relevant to my business.",
  },
  {
    category: "Research",
    label: "Competitor watch",
    description: "Weekly check for notable competitor changes.",
    seed: "Build a weekly job that checks my main competitors for notable changes (pricing, launches, messaging) and summarizes them.",
  },
  {
    category: "Development",
    label: "Nightly error triage",
    description: "Summarize errors & exceptions from the day's logs.",
    seed: "Build a job that runs nightly, reviews the day's application error logs, and summarizes the most important issues.",
  },
  {
    category: "Development",
    label: "Dependency & security check",
    description: "Weekly flag of outdated or vulnerable dependencies.",
    seed: "Build a weekly job that flags outdated or vulnerable dependencies in my project and summarizes recommended upgrades.",
  },
  {
    category: "CEO",
    label: "Daily executive brief",
    description: "Cross-functional summary across email, calendar & tasks.",
    seed: "Build a job that runs every morning and produces a concise executive brief pulling together my email, calendar, and outstanding tasks.",
  },
  {
    category: "CEO",
    label: "Weekly KPI rollup",
    description: "Compile the week's key metrics into one report.",
    seed: "Build a weekly job that compiles my key business metrics into a single rollup report.",
  },
  {
    category: "Operations",
    label: "Inbox triage",
    description: "Categorize new email and draft replies.",
    seed: "Build a job that runs a few times a day, triages my new email into categories, and drafts replies where useful.",
  },
  {
    category: "Operations",
    label: "Day-ahead prep",
    description: "Brief on tomorrow's meetings each evening.",
    seed: "Build a job that runs every evening and prepares a brief for tomorrow's meetings with context for each.",
  },
  {
    category: "Marketing",
    label: "Content idea generator",
    description: "Weekly batch of on-brand post ideas.",
    seed: "Build a weekly job that proposes a batch of on-brand social and blog post ideas.",
  },
  {
    category: "Marketing",
    label: "Brand mention summary",
    description: "Daily summary of where the brand was mentioned.",
    seed: "Build a daily job that summarizes recent mentions of my brand across the web and social.",
  },
];

const CATEGORY_ORDER = [
  "CEO",
  "Sales",
  "Marketing",
  "Research",
  "Development",
  "Operations",
];

function groupByCategory(templates: JobTemplate[]): [string, JobTemplate[]][] {
  const map = new Map<string, JobTemplate[]>();
  for (const tpl of templates) {
    const list = map.get(tpl.category) ?? [];
    list.push(tpl);
    map.set(tpl.category, list);
  }
  return [...map.entries()].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]),
  );
}

export interface CronTemplateBuilderProps {
  onClose: () => void;
  /** CRM departments, used to map a template's category onto a real Department. */
  departments: Department[];
  /** Called when the user accepts a draft. `departmentId` is "" when no CRM
   *  department matches the template category. */
  onUse: (proposal: CronTemplateProposal, departmentId: string) => void;
}

/** Interactive, LLM-assisted builder for a new agent job. The user picks a
 *  department-categorized starter (or describes their own), the assistant
 *  converses to fill in the gaps, and once a draft is ready it can be dropped
 *  straight into the create-job form.
 *
 *  Mounted only while open (parent gates it), so each session starts with fresh
 *  state — no reset effect needed. */
export function CronTemplateBuilder({
  onClose,
  departments,
  onUse,
}: CronTemplateBuilderProps) {
  const { toast, showToast } = useToast();
  const [messages, setMessages] = useState<CronTemplateMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [proposal, setProposal] = useState<CronTemplateProposal | null>(null);
  // Category of the picked template, so the accepted job can inherit a Department.
  const [pickedCategory, setPickedCategory] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);

  const modalRef = useModalBehavior({ open: true, onClose });

  // Keep the transcript scrolled to the latest turn.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages, sending]);

  const send = useCallback(
    async (text: string, category = "") => {
      const content = text.trim();
      if (!content || sending) return;
      if (category) setPickedCategory(category);
      const next: CronTemplateMessage[] = [
        ...messages,
        { role: "user", content },
      ];
      setMessages(next);
      setInput("");
      setSending(true);
      try {
        const res = await api.assistCronTemplate(next);
        setMessages([...next, { role: "assistant", content: res.reply }]);
        if (res.proposal) setProposal(res.proposal);
      } catch (e) {
        showToast(`Assistant unavailable: ${e}`, "error");
        // Roll back the optimistic user turn so they can retry.
        setMessages(messages);
      } finally {
        setSending(false);
      }
    },
    [messages, sending, showToast],
  );

  const handleUse = useCallback(() => {
    if (!proposal) return;
    const match = departments.find(
      (d) => d.name.trim().toLowerCase() === pickedCategory.trim().toLowerCase(),
    );
    onUse(proposal, match ? String(match.id) : "");
  }, [proposal, departments, pickedCategory, onUse]);

  const started = messages.length > 0;

  return (
    <div
      ref={modalRef}
      className="fixed inset-0 z-[110] flex items-center justify-center bg-background/85 backdrop-blur-sm p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cron-template-title"
    >
      <Toast toast={toast} />
      <div
        className={cn(
          themedBody,
          "relative flex h-[80vh] w-full max-w-4xl flex-col border border-border bg-card shadow-2xl",
        )}
      >
        <Button
          ghost
          size="icon"
          onClick={onClose}
          className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          <X />
        </Button>

        <header className="flex items-center gap-2 border-b border-border p-5 pb-3">
          <Sparkles className="size-4 text-primary" />
          <h2
            id="cron-template-title"
            className="font-mondwest text-display text-base tracking-wider"
          >
            Build a job from a template
          </h2>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[260px_1fr]">
          {/* Template gallery, grouped by department */}
          <aside className="min-h-0 overflow-y-auto border-b border-border p-4 sm:border-b-0 sm:border-r">
            <p className="mb-3 text-xs uppercase tracking-wider text-muted-foreground">
              Templates by department
            </p>
            <div className="flex flex-col gap-4">
              {groupByCategory(TEMPLATES).map(([category, items]) => (
                <div key={category} className="flex flex-col gap-1.5">
                  <p className="font-mondwest text-xs tracking-wider text-foreground/70">
                    {category}
                  </p>
                  {items.map((tpl) => (
                    <button
                      key={tpl.label}
                      type="button"
                      disabled={sending}
                      onClick={() => send(tpl.seed, tpl.category)}
                      className="group flex flex-col items-start gap-0.5 border border-border bg-background/40 px-2.5 py-2 text-left text-sm transition-colors hover:border-foreground/30 hover:bg-background/70 disabled:opacity-50"
                    >
                      <span className="font-courier text-foreground">
                        {tpl.label}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {tpl.description}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </aside>

          {/* Conversation + draft */}
          <section className="flex min-h-0 flex-col">
            <div
              ref={threadRef}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
            >
              {!started && (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                  <Sparkles className="size-6 text-primary/60" />
                  <p>
                    Pick a template on the left, or describe the job you want
                    below.
                  </p>
                  <p className="text-xs">
                    The assistant will ask a question or two, then draft a
                    ready-to-save job.
                  </p>
                </div>
              )}
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={cn(
                    "max-w-[85%] whitespace-pre-wrap px-3 py-2 text-sm font-courier",
                    m.role === "user"
                      ? "ml-auto border border-border bg-background/60"
                      : "mr-auto border border-border bg-background/30",
                  )}
                >
                  {m.content}
                </div>
              ))}
              {sending && (
                <div className="mr-auto flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                  <Spinner /> Thinking…
                </div>
              )}
            </div>

            {/* Draft preview */}
            {proposal && (
              <div className="border-t border-border bg-background/40 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <p className="font-mondwest text-xs uppercase tracking-wider text-foreground/70">
                    Draft job
                  </p>
                  <Button
                    size="sm"
                    className="uppercase"
                    disabled={!proposal.ready}
                    onClick={handleUse}
                  >
                    Use this job
                  </Button>
                </div>
                <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">Name</dt>
                  <dd className="font-courier">{proposal.name || "—"}</dd>
                  <dt className="text-muted-foreground">Schedule</dt>
                  <dd className="font-courier">{proposal.schedule || "—"}</dd>
                  <dt className="text-muted-foreground">Deliver</dt>
                  <dd className="font-courier">{proposal.deliver}</dd>
                  <dt className="text-muted-foreground">Prompt</dt>
                  <dd className="whitespace-pre-wrap font-courier">
                    {proposal.prompt || "—"}
                  </dd>
                </dl>
                {!proposal.ready && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Keep chatting to fill in the schedule and prompt.
                  </p>
                )}
              </div>
            )}

            {/* Composer */}
            <div className="flex items-end gap-2 border-t border-border p-3">
              <textarea
                className="flex max-h-32 min-h-[40px] w-full resize-none border border-border bg-background/40 px-3 py-2 text-sm font-courier shadow-sm placeholder:text-muted-foreground focus-visible:border-foreground/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30"
                placeholder="Describe the job, or refine the draft…"
                value={input}
                disabled={sending}
                rows={1}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
              />
              <Button
                size="sm"
                className="uppercase"
                disabled={sending || !input.trim()}
                onClick={() => void send(input)}
              >
                Send
              </Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
