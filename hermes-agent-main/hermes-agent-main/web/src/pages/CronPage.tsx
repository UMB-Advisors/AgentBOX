import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Clock, LayoutTemplate, Pause, Pencil, Play, Sparkles, Trash2, X, Zap } from "lucide-react";
import cronstrue from "cronstrue";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Select, SelectOption } from "@nous-research/ui/ui/components/select";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { H2 } from "@nous-research/ui/ui/components/typography/h2";
import { api } from "@/lib/api";
import type {
  CronJob,
  ProfileInfo,
  ModelOptionProvider,
  AgentTemplate,
  AgentTemplateSummary,
} from "@/lib/api";
import { crmApi } from "@/lib/crm";
import type { Department, TeamMember } from "@/lib/crm";
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
  const [sortBy, setSortBy] = useState<"default" | "department">("default");
  const [loading, setLoading] = useState(true);
  const { toast, showToast } = useToast();
  const { t } = useI18n();
  const { setEnd, setTitle } = usePageHeader();

  // Renamed in the simplified nav: "Cron" → "Scheduled Actions" → "Agent Jobs".
  useEffect(() => {
    setTitle("Agent Jobs");
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
  // Per-job model override. "" = box default. Options come from /api/model/options
  // (same source as the chat model picker); provider is resolved from the chosen model.
  const [model, setModel] = useState("");
  const [modelProviders, setModelProviders] = useState<ModelOptionProvider[]>([]);
  // CRM assignment. Stored as string select values ("" = none); coerced to
  // number on submit. Department/Employee lists come from the mailbox-dashboard
  // CRM (same-origin via the dashboard proxy).
  const [departmentId, setDepartmentId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [departments, setDepartments] = useState<Department[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [creating, setCreating] = useState(false);
  // Agent Templates: a picker of reusable blueprints that pre-fill the create
  // form. `appliedTemplate` is the full descriptor backing the current draft (so
  // we can show its pattern detail); template* carry the template's skills /
  // toolsets through to createCronJob on submit.
  const [templates, setTemplates] = useState<AgentTemplateSummary[]>([]);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [appliedTemplate, setAppliedTemplate] = useState<AgentTemplate | null>(null);
  const [templateSkills, setTemplateSkills] = useState<string[]>([]);
  const [templateToolsets, setTemplateToolsets] = useState<string[]>([]);
  const [showPattern, setShowPattern] = useState(false);
  // Outcome objective + live reprompt. `objective` is the end-goal the operator
  // describes (persisted on the job); it steers the reprompt rewrite. The
  // reprompt is one-shot: call -> `repromptResult` preview -> Accept/Discard.
  // `repromptModel` defaults to the job's model ("" = box default) and is
  // independently selectable.
  const [objective, setObjective] = useState("");
  const [repromptModel, setRepromptModel] = useState("");
  const [reprompting, setReprompting] = useState(false);
  const [repromptResult, setRepromptResult] = useState<string | null>(null);
  const isEditing = editingKey !== null;

  // Clear any template association from the current draft.
  const clearTemplate = useCallback(() => {
    setAppliedTemplate(null);
    setTemplateSkills([]);
    setTemplateToolsets([]);
    setShowPattern(false);
  }, []);
  const closeCreateModal = useCallback(() => {
    setCreateModalOpen(false);
    setEditingKey(null);
  }, []);
  const createModalRef = useModalBehavior({
    open: createModalOpen,
    onClose: closeCreateModal,
  });
  const createProfile = selectedProfile === "all" ? "default" : selectedProfile;

  // Reset the transient reprompt preview + objective for a fresh draft.
  const resetReprompt = useCallback(() => {
    setObjective("");
    setRepromptModel("");
    setRepromptResult(null);
    setReprompting(false);
  }, []);

  const openCreate = useCallback(() => {
    setEditingKey(null);
    setName("");
    setPrompt("");
    setSchedule("");
    setDeliver("local");
    setModel("");
    setDepartmentId("");
    setEmployeeId("");
    clearTemplate();
    resetReprompt();
    setCreateModalOpen(true);
  }, [clearTemplate, resetReprompt]);

  const openEdit = useCallback((job: CronJob) => {
    setEditingKey(getJobKey(job));
    setEditingProfile(getJobProfile(job));
    setName(getJobName(job));
    setPrompt(getJobPrompt(job));
    setSchedule(getJobScheduleRaw(job));
    setDeliver(asText(job.deliver) || "local");
    setModel(asText(job.model) || "");
    setDepartmentId(job.department_id != null ? String(job.department_id) : "");
    setEmployeeId(job.employee_id != null ? String(job.employee_id) : "");
    clearTemplate();
    resetReprompt();
    setObjective(asText(job.objective));
    setRepromptModel(asText(job.model) || "");
    setCreateModalOpen(true);
  }, [clearTemplate, resetReprompt]);

  // Open the template picker (fetches the list lazily the first time).
  const openTemplatePicker = useCallback(() => {
    if (templates.length === 0) {
      api
        .getAgentTemplates()
        .then((r) => setTemplates(r.templates ?? []))
        .catch(() => showToast("Couldn’t load templates", "error"));
    }
    setTemplatePickerOpen(true);
  }, [templates.length, showToast]);

  // Apply a chosen template: fetch its full descriptor and pre-fill the create
  // form. The operator can edit anything before saving — this only seeds it.
  const applyTemplate = useCallback(
    async (id: string) => {
      try {
        const tpl = await api.getAgentTemplate(id);
        const d = tpl.defaults;
        setEditingKey(null);
        setName(d.name ?? "");
        setObjective(d.objective ?? "");
        setPrompt(d.prompt ?? "");
        setSchedule(d.schedule ?? "");
        setDeliver(d.deliver || "local");
        setModel(d.model || "");
        setRepromptModel(d.model || "");
        setRepromptResult(null);
        setDepartmentId("");
        setEmployeeId("");
        setTemplateSkills(d.skills ?? []);
        setTemplateToolsets(d.enabled_toolsets ?? []);
        setAppliedTemplate(tpl);
        setShowPattern(false);
        setTemplatePickerOpen(false);
        setCreateModalOpen(true);
      } catch {
        showToast("Couldn’t load template", "error");
      }
    },
    [showToast],
  );

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

  // Department + Employee options for assignment. The CRM lives in the
  // mailbox-dashboard; if it's unreachable the selects just stay empty and the
  // rest of the page works unchanged.
  useEffect(() => {
    crmApi.listDepartments().then(setDepartments).catch(() => setDepartments([]));
    crmApi.listTeam().then(setTeam).catch(() => setTeam([]));
  }, []);

  // Model options for the per-job override. If unavailable, the select just shows
  // "Box default" and jobs run with the box default model.
  useEffect(() => {
    api
      .getModelOptions()
      .then((r) => setModelProviders(r.providers ?? []))
      .catch(() => setModelProviders([]));
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  // Optional sort of the jobs list by assigned Department (unassigned last,
  // tie-broken by job name). "default" preserves the backend order.
  const sortedJobs = useMemo(() => {
    if (sortBy !== "department") return jobs;
    const deptName = (job: CronJob) =>
      asText(job.department_name) ||
      departments.find((d) => d.id === job.department_id)?.name ||
      "";
    return [...jobs].sort((a, b) => {
      const da = deptName(a);
      const db = deptName(b);
      if (!da && db) return 1;
      if (da && !db) return -1;
      const cmp = da.localeCompare(db);
      return cmp !== 0 ? cmp : getJobName(a).localeCompare(getJobName(b));
    });
  }, [jobs, sortBy, departments]);

  // Resolve a model name to its provider slug from the picker options.
  const providerForModel = useCallback(
    (m: string) =>
      modelProviders.find((p) => (p.models ?? []).includes(m))?.slug ?? null,
    [modelProviders],
  );

  // Live reprompt: ask the model to improve the draft prompt toward the
  // objective. One-shot — the result lands in `repromptResult` for accept/discard.
  const handleReprompt = async () => {
    if (!prompt.trim()) {
      showToast("Write a draft prompt first", "error");
      return;
    }
    setReprompting(true);
    setRepromptResult(null);
    try {
      const chosen = repromptModel.trim() || null;
      const res = await api.repromptCronPrompt({
        draft_prompt: prompt.trim(),
        outcome_objective: objective.trim(),
        model: chosen,
        provider: chosen ? providerForModel(chosen) : null,
      });
      const improved = (res.improved_prompt || "").trim();
      if (!improved) {
        showToast("Reprompt returned nothing", "error");
      } else {
        setRepromptResult(improved);
      }
    } catch (e) {
      showToast(`Reprompt failed: ${e}`, "error");
    } finally {
      setReprompting(false);
    }
  };

  const handleSubmit = async () => {
    if (!prompt.trim() || !schedule.trim()) {
      showToast(`${t.cron.prompt} & ${t.cron.schedule} required`, "error");
      return;
    }
    // Accept natural language ("10am everyday") by converting to a cron
    // expression the backend understands; fall back to the raw text otherwise.
    const scheduleToSend = parseNaturalSchedule(schedule) ?? schedule.trim();
    // Resolve the chosen department/employee to ids + denormalized names so the
    // job card can label them without a CRM round-trip. null clears assignment.
    const deptIdNum = departmentId ? Number(departmentId) : null;
    const empIdNum = employeeId ? Number(employeeId) : null;
    const crmFields = {
      department_id: deptIdNum,
      department_name: departments.find((d) => d.id === deptIdNum)?.name ?? null,
      employee_id: empIdNum,
      employee_name: team.find((m) => m.id === empIdNum)?.name ?? null,
    };
    // Per-job model override; resolve its provider from the picker (null = box default).
    const chosenModel = model.trim() || null;
    const modelFields = {
      model: chosenModel,
      provider: chosenModel
        ? (modelProviders.find((p) => (p.models ?? []).includes(chosenModel))?.slug ?? null)
        : null,
    };
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
            objective: objective.trim() || null,
            ...modelFields,
            ...crmFields,
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
            objective: objective.trim() || null,
            ...modelFields,
            // From an applied template, if any (omitted when empty).
            skills: templateSkills.length ? templateSkills : undefined,
            enabled_toolsets: templateToolsets.length ? templateToolsets : undefined,
            ...crmFields,
          },
          createProfile,
        );
        showToast(t.common.create + " ✓", "success");
      }
      setPrompt("");
      setSchedule("");
      setName("");
      setDeliver("local");
      setModel("");
      setDepartmentId("");
      setEmployeeId("");
      clearTemplate();
      resetReprompt();
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

      {/* Template picker modal */}
      {templatePickerOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-background/85 backdrop-blur-sm p-4"
          onClick={(e) =>
            e.target === e.currentTarget && setTemplatePickerOpen(false)
          }
          role="dialog"
          aria-modal="true"
          aria-labelledby="template-picker-title"
        >
          <div
            className={cn(
              themedBody,
              "relative w-full max-w-2xl border border-border bg-card shadow-2xl flex flex-col max-h-[85vh]",
            )}
          >
            <Button
              ghost
              size="icon"
              onClick={() => setTemplatePickerOpen(false)}
              className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <X />
            </Button>

            <header className="p-5 pb-3 border-b border-border">
              <h2
                id="template-picker-title"
                className="font-mondwest text-display text-base tracking-wider"
              >
                Build from a template
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Agent Template Pattern blueprints, tuned for this box. Pick one to
                pre-fill a new job — you can edit everything before saving.
              </p>
            </header>

            <div className="p-5 grid gap-3 overflow-y-auto">
              {templates.length === 0 && (
                <p className="text-sm text-muted-foreground py-6 text-center">
                  No templates available.
                </p>
              )}
              {templates.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => applyTemplate(tpl.id)}
                  className="text-left border border-border bg-background/40 p-4 hover:border-foreground/30 hover:bg-background/60 transition-colors"
                >
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-medium text-sm">{tpl.name}</span>
                    <Badge tone={tpl.category === "instance" ? "secondary" : "outline"}>
                      {tpl.category}
                    </Badge>
                    <Badge tone="outline">{tpl.hardware_tier}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {tpl.node_count} nodes
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{tpl.summary}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

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
          <div className={cn(themedBody, "relative w-full max-w-2xl border border-border bg-card shadow-2xl flex flex-col")}>
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

            <div className="p-5 grid gap-4 max-h-[80vh] overflow-y-auto">
              {appliedTemplate && (
                <div className="border border-border bg-background/40 p-3 text-xs">
                  <div className="flex items-center gap-2 flex-wrap">
                    <LayoutTemplate className="h-3.5 w-3.5 text-primary" />
                    <span className="font-medium">{appliedTemplate.name}</span>
                    <Badge tone="outline">{appliedTemplate.hardware_tier}</Badge>
                    <Badge tone="secondary">{appliedTemplate.provenance.status}</Badge>
                    <button
                      type="button"
                      className="ml-auto underline text-muted-foreground hover:text-foreground"
                      onClick={() => setShowPattern((v) => !v)}
                    >
                      {showPattern ? "Hide pattern" : "Show pattern"}
                    </button>
                    <button
                      type="button"
                      className="underline text-muted-foreground hover:text-foreground"
                      onClick={clearTemplate}
                    >
                      Detach
                    </button>
                  </div>
                  {(templateSkills.length > 0 || templateToolsets.length > 0) && (
                    <p className="mt-2 text-muted-foreground">
                      {templateSkills.length > 0 &&
                        `Skills: ${templateSkills.join(", ")}`}
                      {templateSkills.length > 0 && templateToolsets.length > 0 && " · "}
                      {templateToolsets.length > 0 &&
                        `Toolsets: ${templateToolsets.join(", ")}`}
                    </p>
                  )}
                  {showPattern && (
                    <div className="mt-3 grid gap-3 border-t border-border pt-3">
                      <p className="text-muted-foreground">
                        {appliedTemplate.provenance.note}
                      </p>
                      <div className="grid gap-1">
                        {appliedTemplate.primitives.map((p) => (
                          <div key={p.key}>
                            <span className="font-medium">
                              {p.key} · {p.title}
                            </span>{" "}
                            <span className="text-muted-foreground">{p.desc}</span>
                          </div>
                        ))}
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left">
                          <thead className="text-muted-foreground">
                            <tr>
                              <th className="pr-2 font-normal">#</th>
                              <th className="pr-2 font-normal">Node</th>
                              <th className="pr-2 font-normal">Model</th>
                              <th className="font-normal">Routing (T2)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {appliedTemplate.nodes.map((n) => (
                              <tr key={n.n} className="align-top">
                                <td className="pr-2 py-0.5">{n.n}</td>
                                <td className="pr-2 py-0.5">{n.node}</td>
                                <td className="pr-2 py-0.5">
                                  {n.probabilistic ? "model" : "—"}
                                </td>
                                <td className="py-0.5 text-muted-foreground">
                                  {n.routing_t2}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Objective & prompt — the hero of the form */}
              <div className="grid gap-4 border border-border bg-background/30 p-4">
                <div className="grid gap-2">
                  <Label htmlFor="cron-objective">Outcome / objective</Label>
                  <textarea
                    id="cron-objective"
                    className="flex min-h-[64px] w-full resize-y border border-border bg-background/40 px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30 focus-visible:border-foreground/25"
                    placeholder="Describe the end goal — e.g. “a crisp daily digest of overnight email, grouped by sender.” The model uses this to improve your prompt."
                    value={objective}
                    onChange={(e) => setObjective(e.target.value)}
                  />
                </div>

                <div className="grid gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label htmlFor="cron-prompt">{t.cron.prompt}</Label>
                    <div className="flex items-center gap-2">
                      <div className="w-44">
                        <Select
                          id="cron-reprompt-model"
                          value={repromptModel}
                          onValueChange={(v) => setRepromptModel(v)}
                        >
                          <SelectOption value="">Reprompt: box default</SelectOption>
                          {repromptModel &&
                            !modelProviders.some((p) => (p.models ?? []).includes(repromptModel)) && (
                              <SelectOption value={repromptModel}>{repromptModel}</SelectOption>
                            )}
                          {modelProviders.flatMap((p) =>
                            (p.models ?? []).map((m) => (
                              <SelectOption key={`rp:${p.slug}:${m}`} value={m}>
                                {modelProviders.length > 1 ? `${p.name} · ${m}` : m}
                              </SelectOption>
                            )),
                          )}
                        </Select>
                      </div>
                      <Button
                        size="sm"
                        ghost
                        onClick={handleReprompt}
                        disabled={reprompting || !prompt.trim()}
                        prefix={reprompting ? <Spinner /> : <Sparkles />}
                        title="Improve this prompt with the model, steered by your objective"
                      >
                        {reprompting ? "Reprompting…" : "Reprompt"}
                      </Button>
                    </div>
                  </div>
                  <textarea
                    id="cron-prompt"
                    className="flex min-h-[140px] w-full resize-y border border-border bg-background/40 px-3 py-2 text-sm font-courier shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30 focus-visible:border-foreground/25"
                    placeholder={t.cron.promptPlaceholder}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                </div>

                {repromptResult !== null && (
                  <div className="grid gap-2 border border-primary/40 bg-primary/5 p-3">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Sparkles className="h-3.5 w-3.5 text-primary" />
                      <span>Suggested rewrite — review before accepting</span>
                    </div>
                    <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-courier text-sm">
                      {repromptResult}
                    </pre>
                    <div className="flex items-center justify-end gap-2">
                      <Button size="sm" ghost onClick={() => setRepromptResult(null)}>
                        Discard
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          setPrompt(repromptResult);
                          setRepromptResult(null);
                        }}
                      >
                        Accept
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                Job settings
              </p>
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

              <div className="grid gap-2">
                <Label htmlFor="cron-model">Model</Label>
                <Select
                  id="cron-model"
                  value={model}
                  onValueChange={(v) => setModel(v)}
                >
                  <SelectOption value="">Box default</SelectOption>
                  {model &&
                    !modelProviders.some((p) => (p.models ?? []).includes(model)) && (
                      <SelectOption value={model}>{model} (current)</SelectOption>
                    )}
                  {modelProviders.flatMap((p) =>
                    (p.models ?? []).map((m) => (
                      <SelectOption key={`${p.slug}:${m}`} value={m}>
                        {modelProviders.length > 1 ? `${p.name} · ${m}` : m}
                      </SelectOption>
                    )),
                  )}
                </Select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="cron-department">Department</Label>
                  <Select
                    id="cron-department"
                    value={departmentId}
                    onValueChange={(v) => setDepartmentId(v)}
                  >
                    <SelectOption value="">Unassigned</SelectOption>
                    {departments.map((d) => (
                      <SelectOption key={d.id} value={String(d.id)}>
                        {d.name}
                      </SelectOption>
                    ))}
                  </Select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="cron-employee">Employee</Label>
                  <Select
                    id="cron-employee"
                    value={employeeId}
                    onValueChange={(v) => setEmployeeId(v)}
                  >
                    <SelectOption value="">Unassigned</SelectOption>
                    {team.map((m) => (
                      <SelectOption key={m.id} value={String(m.id)}>
                        {m.name}
                        {m.title ? ` — ${m.title}` : ""}
                      </SelectOption>
                    ))}
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
            <Button
              size="sm"
              ghost
              className="uppercase shrink-0"
              onClick={openTemplatePicker}
              prefix={<LayoutTemplate />}
            >
              From Template
            </Button>

            <Button size="sm" className="uppercase shrink-0" onClick={openCreate}>
              Schedule a New Job
            </Button>

            <div className="grid gap-1 min-w-[150px]">
              <Label htmlFor="cron-sort">Sort by</Label>
              <Select
                id="cron-sort"
                value={sortBy}
                onValueChange={(v) => setSortBy(v as "default" | "department")}
              >
                <SelectOption value="default">Default</SelectOption>
                <SelectOption value="department">Department</SelectOption>
              </Select>
            </div>

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
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  ghost
                  className="uppercase"
                  onClick={openTemplatePicker}
                  prefix={<LayoutTemplate />}
                >
                  From Template
                </Button>
                <Button size="sm" className="uppercase" onClick={openCreate}>
                  Schedule a New Job
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {sortedJobs.map((job) => {
          const state = getJobState(job);
          const promptText = getJobPrompt(job);
          const title = getJobTitle(job);
          const hasName = Boolean(getJobName(job));
          const deliver = asText(job.deliver);
          const profile = getJobProfile(job);
          const jobKey = getJobKey(job);
          const deptLabel =
            asText(job.department_name) ||
            departments.find((d) => d.id === job.department_id)?.name ||
            "";
          const empLabel =
            asText(job.employee_name) ||
            team.find((m) => m.id === job.employee_id)?.name ||
            "";

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
                    {deptLabel && <Badge tone="outline">{deptLabel}</Badge>}
                    {empLabel && <Badge tone="secondary">{empLabel}</Badge>}
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
