import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Checkbox } from "@nous-research/ui/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@nous-research/ui/ui/components/dialog";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import { Select, SelectOption } from "@nous-research/ui/ui/components/select";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { api } from "@/lib/api";
import type { GoogleCalEventInput } from "@/lib/api";

/** Normalized form seed the parent builds for create / edit. Times are local
 *  wall-clock (`HH:MM`); dates are `YYYY-MM-DD`. For all-day events the
 *  end date is INCLUSIVE in the form (the last day the event covers). */
export interface EventFormSeed {
  id?: string;
  account: string;
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  location: string;
  description: string;
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Local date+time → RFC3339 with the browser's UTC offset, so Google stores
 *  the event at the wall-clock time the operator typed. */
function toRFC3339(date: string, time: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const local = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -local.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return (
    `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}` +
    `T${pad(local.getHours())}:${pad(local.getMinutes())}:00${sign}${oh}:${om}`
  );
}

/** Add ``n`` days to a ``YYYY-MM-DD`` string, returning the same format. Used
 *  to convert the form's inclusive all-day end date to Google's exclusive end. */
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, (d || 1) + n);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

/**
 * Create / edit / delete a Google Calendar event. Mirrors Google Calendar's
 * quick-event editor: title, all-day toggle, start/end, location, notes, and
 * (for new events across multiple connected accounts) which calendar to add to.
 */
export function EventDialog({
  open,
  onOpenChange,
  seed,
  accounts,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seed: EventFormSeed | null;
  accounts: string[];
  onSaved: () => void;
}) {
  const isEdit = Boolean(seed?.id);
  const [form, setForm] = useState<EventFormSeed | null>(seed);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reseed whenever the dialog (re)opens with a new event/draft.
  useEffect(() => {
    if (open) {
      setForm(seed);
      setError(null);
    }
  }, [open, seed]);

  if (!form) return null;

  const set = <K extends keyof EventFormSeed>(key: K, value: EventFormSeed[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const buildInput = (): GoogleCalEventInput => {
    if (form.allDay) {
      return {
        account: form.account,
        title: form.title,
        all_day: true,
        start: form.startDate,
        // Google's all-day end is exclusive — bump the inclusive form date by 1.
        end: addDays(form.endDate || form.startDate, 1),
        location: form.location,
        description: form.description,
      };
    }
    return {
      account: form.account,
      title: form.title,
      all_day: false,
      start: toRFC3339(form.startDate, form.startTime),
      end: toRFC3339(form.endDate || form.startDate, form.endTime),
      timezone: TZ,
      location: form.location,
      description: form.description,
    };
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const input = buildInput();
      const res =
        isEdit && form.id
          ? await api.updateGoogleCalendarEvent(form.id, input)
          : await api.createGoogleCalendarEvent(input);
      if (res.error) {
        setError(res.error);
        return;
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save event.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!form.id) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await api.deleteGoogleCalendarEvent(form.id, form.account);
      if (res.error) {
        setError(res.error);
        return;
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete event.");
    } finally {
      setDeleting(false);
    }
  };

  const busy = saving || deleting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-5">
        <DialogHeader className="mb-4">
          <DialogTitle>{isEdit ? "Edit event" : "New event"}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ev-title">Title</Label>
            <Input
              id="ev-title"
              autoFocus
              value={form.title}
              placeholder="Add title"
              onChange={(e) => set("title", e.target.value)}
            />
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <Checkbox
              checked={form.allDay}
              onCheckedChange={(c) => set("allDay", Boolean(c))}
            />
            All day
          </label>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ev-start-date">Starts</Label>
              <Input
                id="ev-start-date"
                type="date"
                value={form.startDate}
                onChange={(e) => set("startDate", e.target.value)}
              />
            </div>
            {!form.allDay && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ev-start-time">&nbsp;</Label>
                <Input
                  id="ev-start-time"
                  type="time"
                  value={form.startTime}
                  onChange={(e) => set("startTime", e.target.value)}
                />
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ev-end-date">Ends</Label>
              <Input
                id="ev-end-date"
                type="date"
                value={form.endDate}
                onChange={(e) => set("endDate", e.target.value)}
              />
            </div>
            {!form.allDay && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ev-end-time">&nbsp;</Label>
                <Input
                  id="ev-end-time"
                  type="time"
                  value={form.endTime}
                  onChange={(e) => set("endTime", e.target.value)}
                />
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ev-location">Location</Label>
            <Input
              id="ev-location"
              value={form.location}
              placeholder="Add location"
              onChange={(e) => set("location", e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ev-desc">Description</Label>
            <textarea
              id="ev-desc"
              rows={3}
              value={form.description}
              placeholder="Add notes"
              onChange={(e) => set("description", e.target.value)}
              className="flex w-full resize-y border border-midground/15 bg-background/40 px-3 py-2 font-courier text-sm transition-colors placeholder:text-midground/50 focus-visible:border-midground/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/30"
            />
          </div>

          {/* Which calendar to add to — only when creating with 2+ accounts. */}
          {!isEdit && accounts.length >= 2 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ev-account">Calendar</Label>
              <Select
                id="ev-account"
                className="w-full"
                value={form.account}
                onValueChange={(v) => set("account", v)}
              >
                {accounts.map((a) => (
                  <SelectOption key={a} value={a}>
                    {a}
                  </SelectOption>
                ))}
              </Select>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="mt-5 flex items-center justify-between gap-2">
          {isEdit ? (
            <Button
              type="button"
              destructive
              ghost
              size="sm"
              disabled={busy}
              onClick={() => void remove()}
              prefix={deleting ? <Spinner /> : <Trash2 />}
            >
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              ghost
              size="sm"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy || !form.title.trim()}
              onClick={() => void save()}
              prefix={saving ? <Spinner /> : undefined}
            >
              {isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
