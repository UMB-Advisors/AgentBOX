import { z } from 'zod';

// MBOX-460 v2 — operator-composed Google Calendar event for a scheduling draft.
// `start`/`end` are absolute RFC3339 with offset: the browser composes them from
// the operator's wall-clock + local tz before POSTing, same rationale as the
// snooze action (the appliance has no reliable notion of the operator's tz; the
// browser does). attendees are bare emails; the sender is prefilled client-side.
// send_invite=false (default) creates/holds the event WITHOUT emailing attendees
// (sendUpdates=none) — true flips it to sendUpdates=all so Google invites them.
export const calendarEventBodySchema = z
  .object({
    summary: z.string().trim().min(1, 'summary required').max(500),
    description: z.string().max(8000).optional(),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    attendees: z.array(z.string().email()).max(50).optional(),
    status: z.enum(['tentative', 'confirmed']).optional(),
    send_invite: z.boolean().optional(),
  })
  .refine((b) => Date.parse(b.end) > Date.parse(b.start), {
    message: 'end must be after start',
    path: ['end'],
  });

export type CalendarEventBody = z.infer<typeof calendarEventBodySchema>;
