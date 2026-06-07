import { z } from 'zod';

// MBOX-162 P4 — PUT /api/operator-settings body. Full replace of the three
// operator-editable workspace fields (singleton mailbox.operator_settings).
// Each field is optional and defaults to '' so the form can submit a clear
// (empty) value and a partial body never throws — the route writes all three.
//
// Values are trimmed here so the embed builders (lib/embed.ts) and the right
// pane see clean input. booking_link, when non-empty, must be an http(s) URL
// (it's the scheduling link the operator shares); the calendar/drive fields are
// left lenient (they accept either a bare id/email OR a full URL — the builder
// disambiguates and encodes non-URL input safely).

const httpUrl = (v: string) => /^https?:\/\//i.test(v);

export const operatorSettingsUpdateSchema = z.object({
  booking_link: z
    .string()
    .trim()
    .max(2000, 'booking_link too long')
    .optional()
    .default('')
    .refine((v) => v === '' || httpUrl(v), {
      message: 'booking_link must be an http(s) URL',
    }),
  calendar_embed_src: z
    .string()
    .trim()
    .max(2000, 'calendar_embed_src too long')
    .optional()
    .default(''),
  drive_folder_id: z.string().trim().max(1000, 'drive_folder_id too long').optional().default(''),
});

export type OperatorSettingsUpdate = z.infer<typeof operatorSettingsUpdateSchema>;
