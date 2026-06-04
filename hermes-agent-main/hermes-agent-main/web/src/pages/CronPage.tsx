import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { Clock, Pause, Pencil, Play, Trash2, X, Zap } from "lucide-react";
import cronstrue from "cronstrue";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Select, SelectOption } from "@nous-research/ui/ui/components/select";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { H2 } from "@nous-research/ui/ui/components/typography/h2";
import { api } from "@/lib/api";
import type { CronJob, ProfileInfo } from "@/lib/api";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { useConfirmDelete } from "@nous-research/ui/hooks/use-confirm-delete";
import { useModalBehavior } from "@/hooks/useModalBehavior";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import { useI18n } from "@/i18n";
import { usePageHeader } from "@/contexts/usePageHeader";
import { PluginSlot } from "@/plugins";
import { cn, themedBody } from "@/lib/utils";

function formatTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength
    ? value.slice(0, maxLength) + "..."
    : value;
}

function getJobPrompt(job: CronJob): string {
  return asText(job.prompt);
}

function getJobName(job: CronJob): string {
  return asText(job.name).trim();
}

function getJobTitle(job: CronJob): string {
  const name = getJobName(job);
  if (name) return name;

  const prompt = getJobPrompt(job);
  if (prompt) return truncateText(prompt, 60);

  const script = asText(job.script);
  if (script) return truncateText(script, 60);

  return job.id || "Cron job";
}

function getJobScheduleDisplay(job: CronJob): string {
  return (
    asText(job.schedule_display) ||
    asText(job.schedule?.display) ||
    asText(job.schedule?.expr) ||
    "—"
  );
}

/** The raw schedule expression a user typed (cron expr or "every 30m"),
 *  used to pre-fill the edit form and as a tooltip on the humanized text. */
function getJobScheduleRaw(job: CronJob): string {
  return (
    asText(job.schedule?.expr) ||
    asText(job.schedule?.display) ||
    asText(job.schedule_display)
  );
}

function humanizeInterval(text: string): string {
  const m = text.trim().match(/^every\s+(\d+)\s*([smhd])$/i);
  if (!m) return text;
  const n = Number(m[1]);
  const unit =
    ({ s: "second", m: "minute", h: "hour", d: "day" } as Record<string, string>)[
      m[2].toLowerCase()
    ] ?? "minute";
  return `Every ${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Render a schedule in plain English ("At 10:00 AM, every day") for at-a-glance
 *  reference. Cron expressions go through cronstrue; intervals/once are handled
 *  inline. Falls back to the raw display if nothing parses. */
function humanizeSchedule(job: CronJob): string {
  const sched = job.schedule ?? {};
  const kind = asText(sched.kind);
  const display = asText(sched.display) || asText(job.schedule_display);
  const expr = (asText(sched.expr) || display).trim();

  if (kind === "interval" || /^every\s/i.test(display)) {
    return humanizeInterval(display || expr);
  }
  if (kind === "once") {
    return job.next_run_at ? `Once — ${formatTime(job.next_run_at)}` : "Once";
  }
  if (expr && /^[\d*/,\-\s]+$/.test(expr) && expr.split(/\s+/).length >= 5) {
    try {
      return cronstrue.toString(expr, {
        verbose: false,
        throwExceptionOnParseError: true,
      });
    } catch {
      /* not a valid cron expr — fall through to the raw display */
    }
  }
  return getJobScheduleDisplay(job);
}

/** Humanize a raw schedule string (cron expr or "every 30m") in isolation —
 *  used for the live preview under the schedule input. */
function humanizeExpr(expr: string): string {
  const e = expr.trim();
  if (/^every\s/i.test(e)) return humanizeInterval(e);
  if (/^[\d*/,\-\s]+$/.test(e) && e.split(/\s+/).length >= 5) {
    try {
      return cronstrue.toString(e, { verbose: false, throwExceptionOnParseError: true });
    } catch {
      /* fall through */
    }
  }
  return e;
}

const DOW: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

/** Parse "10:30 am" / "9am" / "14:00" → {h, m}. */
function parseClock(s: string): { h: number; m: number } | null {
  let m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (m) {
    let h = Number(m[1]) % 12;
    if (/pm/i.test(m[3])) h += 12;
    return { h, m: Number(m[2] ?? 0) };
  }
  m = s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) return { h: Number(m[1]), m: Number(m[2]) };
  return null;
}

/**
 * Turn a natural phrase into something the backend cron parser accepts: a cron
 * expression or an "every Nm/Nh" interval. Returns null if it can't confidently
 * parse (caller then sends the raw text, which the backend may accept or reject).
 *
 * Handles: "every 30m", "every 2 hours", "hourly", "10:00 am everyday",
 * "every day at 6am", "9:30am on weekdays", "every monday at 9am", bare "6am".
 */
function parseNaturalSchedule(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  // Already a cron expression — pass through unchanged.
  if (/^[\d*/,\-\s]+$/.test(s) && s.split(/\s+/).length >= 5) return raw.trim();

  // Intervals.
  const iv = s.match(/^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/);
  if (iv) return `every ${Number(iv[1])}${/^h/.test(iv[2]) ? "h" : "m"}`;
  if (s === "hourly" || /^every\s+hour$/.test(s)) return "0 * * * *";

  const t = parseClock(s);

  // Day-of-week field.
  let dow = "*";
  if (/weekday|mon(day)?\s*(-|–|through|to|thru)\s*fri(day)?|mon-fri/.test(s)) dow = "1-5";
  else if (/weekend/.test(s)) dow = "0,6";
  else {
    for (const [name, n] of Object.entries(DOW)) {
      if (new RegExp(`\\b${name}\\b`).test(s)) { dow = String(n); break; }
    }
  }

  const daily = /every\s*day|everyday|daily/.test(s);

  if (t && (daily || dow !== "*")) return `${t.m} ${t.h} * * ${dow}`;
  // Bare time ("6am", "10:00 am", "at 9pm") → assume every day.
  if (t && /^\s*(at\s+)?\d{1,2}(:\d{2})?\s*(am|pm)?\s*$/.test(s)) {
    return `${t.m} ${t.h} * * *`;
  }
  return null;
}

function getJobState(job: CronJob): string {
  return asText(job.state) || (job.enabled === false ? "disabled" : "scheduled");
}

function getJobProfile(job: CronJob): string {
  return asText(job.profile) || asText(job.profile_name) || "default";
}

function getJobKey(job: CronJob): string {
  return `${getJobProfile(job)}:${job.id}`;
}

function splitJobKey(key: string): { profile: string; id: string } {
  const idx = key.indexOf(":");
  if (idx === -1) return { profile: "default", id: key };
  return { profile: key.slice(0, idx) || "default", id: key.slice(idx + 1) };
}

function profileLabel(profile: string): string {
  return profile === "default" ? "default" : profile;
}

const STATUS_TONE: Record<string, "success" | "warning" | "destructive"> = {
  enabled: "success",
  scheduled: "success",
  paused: "warning",
  error: "destructive",
  completed: "destructive",
};

export default function CronPage() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [selectedProfile, setSelectedProfile] = useState("all");
  const [loading, setLoading] = useState(true);
  const { toast, showToast } = useToast();
  const { t } = useI18n();
  const { setEnd, setTitle } = usePageHeader();

  // Renamed in the simplified nav: "Cron" → "Scheduled Actions".
  useEffect(() => {
    setTitle("Scheduled Actions");
  }, [setTitle]);

  // Create / edit job modal state. `editingKey` is null for a new job, or the
  // job key being edited; `editingProfile` pins the edit to that job's profile.
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState("default");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState("");
  const [name, setName] = useState("");
  const [deliver, setDeliver] = useState("local");
  const [creating, setCreating] = useState(false);
  const isEditing = editingKey !== null;
  const closeCreateModal = useCallback(() => {
    setCreateModalOpen(false);
    setEditingKey(null);
  }, []);
  const createModalRef = useModalBehavior({
    open: createModalOpen,
    onClose: closeCreateModal,
  });
  const createProfile = selectedProfile === "all" ? "default" : selectedProfile;

  const openCreate = useCallback(() => {
    setEditingKey(null);
    setName("");
    setPrompt("");
    setSchedule("");
    setDeliver("local");
    setCreateModalOpen(true);
  }, []);

  const openEdit = useCallback((job: CronJob) => {
    setEditingKey(getJobKey(job));
    setEditingProfile(getJobProfile(job));
    setName(getJobName(job));
    setPrompt(getJobPrompt(job));
    setSchedule(getJobScheduleRaw(job));
    setDeliver(asText(job.deliver) || "local");
    setCreateModalOpen(true);
  }, []);

  const loadJobs = useCallback(() => {
    api
      .getCronJobs(selectedProfile)
      .then(setJobs)
      .catch(() => showToast(t.common.loading, "error"))
      .finally(() => setLoading(false));
  }, [selectedProfile, showToast, t.common.loading]);

  useEffect(() => {
    api
      .getProfiles()
      .then((res) => setProfiles(res.profiles))
      .catch(() => setProfiles([]));
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  const handleSubmit = async () => {
    if (!prompt.trim() || !schedule.trim()) {
      showToast(`${t.cron.prompt} & ${t.cron.schedule} required`, "error");
      return;
    }
    // Accept natural language ("10am everyday") by converting to a cron
    // expression the backend understands; fall back to the raw text otherwise.
    const scheduleToSend = parseNaturalSchedule(schedule) ?? schedule.trim();
    setCreating(true);
    try {
      if (isEditing && editingKey) {
        const { id } = splitJobKey(editingKey);
        await api.updateCronJob(
          id,
          {
            prompt: prompt.trim(),
            schedule: scheduleToSend,
            name: name.trim(),
            deliver,
          },
          editingProfile,
        );
        showToast("Saved ✓", "success");
      } else {
        await api.createCronJob(
          {
            prompt: prompt.trim(),
            schedule: scheduleToSend,
            name: name.trim() || undefined,
            deliver,
          },
          createProfile,
        );
        showToast(t.common.create + " ✓", "success");
      }
      setPrompt("");
      setSchedule("");
      setName("");
      setDeliver("local");
      setEditingKey(null);
      setCreateModalOpen(false);
      loadJobs();
    } catch (e) {
      showToast(`${t.config.failedToSave}: ${e}`, "error");
    } finally {
      setCreating(false);
    }
  };

  const handlePauseResume = async (job: CronJob) => {
    try {
      const isPaused = getJobState(job) === "paused";
      const profile = getJobProfile(job);
      if (isPaused) {
        await api.resumeCronJob(job.id, profile);
        showToast(
          `${t.cron.resume}: "${truncateText(getJobTitle(job), 30)}"`,
          "success",
        );
      } else {
        await api.pauseCronJob(job.id, profile);
        showToast(
          `${t.cron.pause}: "${truncateText(getJobTitle(job), 30)}"`,
          "success",
        );
      }
      loadJobs();
    } catch (e) {
      showToast(`${t.status.error}: ${e}`, "error");
    }
  };

  const handleTrigger = async (job: CronJob) => {
    try {
      await api.triggerCronJob(job.id, getJobProfile(job));
      showToast(
        `${t.cron.triggerNow}: "${truncateText(getJobTitle(job), 30)}"`,
        "success",
      );
      loadJobs();
    } catch (e) {
      showToast(`${t.status.error}: ${e}`, "error");
    }
  };

  const jobDelete = useConfirmDelete({
    onDelete: useCallback(
      async (key: string) => {
        const { profile, id } = splitJobKey(key);
        const job = jobs.find((j) => getJobKey(j) === key);
        try {
          await api.deleteCronJob(id, profile);
          showToast(
            `${t.common.delete}: "${job ? truncateText(getJobTitle(job), 30) : id}"`,
            "success",
          );
          loadJobs();
        } catch (e) {
          showToast(`${t.status.error}: ${e}`, "error");
          throw e;
        }
      },
      [jobs, loadJobs, showToast, t.common.delete, t.status.error],
    ),
  });

  // Put "Create" button in page header
  useLayoutEffect(() => {
    setEnd(
      <Button
        className="uppercase"
        size="sm"
        onClick={openCreate}
      >
        {t.common.create}
      </Button>,
    );
    return () => {
      setEnd(null);
    };
  }, [setEnd, t.common.create, loading, openCreate]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner className="text-2xl text-primary" />
      </div>
    );
  }

  const pendingJob = jobDelete.pendingId
    ? jobs.find((j) => getJobKey(j) === jobDelete.pendingId)
    : null;

  return (
    <div className="flex flex-col gap-6">
      <PluginSlot name="cron:top" />
      <Toast toast={toast} />

      <DeleteConfirmDialog
        open={jobDelete.isOpen}
        onCancel={jobDelete.cancel}
        onConfirm={jobDelete.confirm}
        title={t.cron.confirmDeleteTitle}
        description={
          pendingJob
            ? `"${truncateText(getJobTitle(pendingJob), 40)}" — ${
                t.cron.confirmDeleteMessage
              }`
            : t.cron.confirmDeleteMessage
        }
        loading={jobDelete.isDeleting}
      />

      {/* Create job modal */}
      {createModalOpen && (
        <div
          ref={createModalRef}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-background/85 backdrop-blur-sm p-4"
          onClick={(e) => e.target === e.currentTarget && setCreateModalOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-cron-title"
        >
          <div className={cn(themedBody, "relative w-full max-w-lg border border-border bg-card shadow-2xl flex flex-col")}>
            <Button
              ghost
              size="icon"
              onClick={() => setCreateModalOpen(false)}
              className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <X />
            </Button>

            <header className="p-5 pb-3 border-b border-border">
              <h2
                id="create-cron-title"
                className="font-mondwest text-display text-base tracking-wider"
              >
                {isEditing ? "Edit job" : t.cron.newJob}
              </h2>
            </header>

            <div className="p-5 grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="cron-profile">Profile</Label>
                <Select
                  id="cron-profile"
                  value={isEditing ? editingProfile : createProfile}
                  disabled={isEditing}
                  onValueChange={(v) => {
                    if (!isEditing) setSelectedProfile(v);
                  }}
                >
                  {profiles.map((profile) => (
                    <SelectOption key={profile.name} value={profile.name}>
                      {profileLabel(profile.name)}
                    </SelectOption>
                  ))}
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="cron-name">{t.cron.nameOptional}</Label>
                <Input
                  id="cron-name"
                  autoFocus
                  placeholder={t.cron.namePlaceholder}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="cron-prompt">{t.cron.prompt}</Label>
                <textarea
                  id="cron-prompt"
                  className="flex min-h-[80px] w-full border border-border bg-background/40 px-3 py-2 text-sm font-courier shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30 focus-visible:border-foreground/25"
                  placeholder={t.cron.promptPlaceholder}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="cron-schedule">{t.cron.schedule}</Label>
                  <Input
                    id="cron-schedule"
                    placeholder="e.g. 10:00 am everyday, weekdays at 9am, every 30m"
                    value={schedule}
                    onChange={(e) => setSchedule(e.target.value)}
                  />
                  {schedule.trim() && (
                    <p className="text-xs text-muted-foreground">
                      {(() => {
                        const parsed = parseNaturalSchedule(schedule);
                        return parsed
                          ? `→ ${humanizeExpr(parsed)}`
                          : "Couldn’t parse — will be sent exactly as typed";
                      })()}
                    </p>
                  )}
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="cron-deliver">{t.cron.deliverTo}</Label>
                  <Select
                    id="cron-deliver"
                    value={deliver}
                    onValueChange={(v) => setDeliver(v)}
                  >
                    <SelectOption value="local">
                      {t.cron.delivery.local}
                    </SelectOption>
                    <SelectOption value="telegram">
                      {t.cron.delivery.telegram}
                    </SelectOption>
                    <SelectOption value="discord">
                      {t.cron.delivery.discord}
                    </SelectOption>
                    <SelectOption value="slack">
                      {t.cron.delivery.slack}
                    </SelectOption>
                    <SelectOption value="email">
                      {t.cron.delivery.email}
                    </SelectOption>
                  </Select>
                </div>
              </div>

              <div className="flex justify-end">
                <Button
                  className="uppercase"
                  size="sm"
                  onClick={handleSubmit}
                  disabled={creating}
                  prefix={creating ? <Spinner /> : undefined}
                >
                  {creating
                    ? isEditing
                      ? "Saving…"
                      : t.common.creating
                    : isEditing
                      ? "Save"
                      : t.common.create}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <H2
            variant="sm"
            className="flex items-center gap-2 text-muted-foreground"
          >
            <Clock className="h-4 w-4" />
            {t.cron.scheduledJobs} ({jobs.length})
          </H2>

          <div className="flex items-end gap-3">
            <Button size="sm" className="uppercase shrink-0" onClick={openCreate}>
              Schedule a New Job
            </Button>

            <div className="grid gap-1 min-w-[180px]">
              <Label htmlFor="cron-profile-filter">Profile</Label>
              <Select
                id="cron-profile-filter"
                value={selectedProfile}
                onValueChange={(v) => setSelectedProfile(v)}
              >
                <SelectOption value="all">All profiles</SelectOption>
                {profiles.map((profile) => (
                  <SelectOption key={profile.name} value={profile.name}>
                    {profileLabel(profile.name)}
                  </SelectOption>
                ))}
              </Select>
            </div>
          </div>
        </div>

        {jobs.length === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-sm text-muted-foreground">{t.cron.noJobs}</p>
              <Button size="sm" className="uppercase" onClick={openCreate}>
                Schedule a New Job
              </Button>
            </CardContent>
          </Card>
        )}

        {jobs.map((job) => {
          const state = getJobState(job);
          const promptText = getJobPrompt(job);
          const title = getJobTitle(job);
          const hasName = Boolean(getJobName(job));
          const deliver = asText(job.deliver);
          const profile = getJobProfile(job);
          const jobKey = getJobKey(job);

          return (
            <Card key={jobKey}>
              <CardContent className="flex items-start gap-4 py-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-sm truncate">
                      {title}
                    </span>
                    <Badge tone={STATUS_TONE[state] ?? "secondary"}>
                      {state}
                    </Badge>
                    <Badge tone="outline">{profileLabel(profile)}</Badge>
                    {deliver && deliver !== "local" && (
                      <Badge tone="outline">{deliver}</Badge>
                    )}
                  </div>
                  {hasName && promptText && (
                    <p className="text-xs text-muted-foreground truncate mb-1">
                      {truncateText(promptText, 100)}
                    </p>
                  )}
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span title={getJobScheduleRaw(job)}>
                      {humanizeSchedule(job)}
                    </span>
                    <span>
                      {t.cron.last}: {formatTime(job.last_run_at)}
                    </span>
                    <span>
                      {t.cron.next}: {formatTime(job.next_run_at)}
                    </span>
                  </div>
                  {job.last_error && (
                    <p className="text-xs text-destructive mt-1">
                      {job.last_error}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    ghost
                    size="icon"
                    title="Edit"
                    aria-label="Edit"
                    onClick={() => openEdit(job)}
                  >
                    <Pencil />
                  </Button>

                  <Button
                    ghost
                    size="icon"
                    title={state === "paused" ? t.cron.resume : t.cron.pause}
                    aria-label={
                      state === "paused" ? t.cron.resume : t.cron.pause
                    }
                    onClick={() => handlePauseResume(job)}
                    className={
                      state === "paused" ? "text-success" : "text-warning"
                    }
                  >
                    {state === "paused" ? <Play /> : <Pause />}
                  </Button>

                  <Button
                    ghost
                    size="icon"
                    title={t.cron.triggerNow}
                    aria-label={t.cron.triggerNow}
                    onClick={() => handleTrigger(job)}
                  >
                    <Zap />
                  </Button>

                  <Button
                    ghost
                    destructive
                    size="icon"
                    title={t.common.delete}
                    aria-label={t.common.delete}
                    onClick={() => jobDelete.requestDelete(jobKey)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <PluginSlot name="cron:bottom" />
    </div>
  );
}
