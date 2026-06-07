import { z } from 'zod';

// MBOX-133: operator filter/sort preference persistence
// (GET/PUT /api/operator/preferences/[key]).
//
// `key` is a dotted namespace the dashboard owns, e.g. 'queue.filters',
// 'queue.sort'. Constrained to a conservative charset so it can't be used to
// smuggle anything odd into the row — lowercase segments, dot-separated,
// bounded length. The DB also CHECKs key is non-blank (migration 026).
export const PREFERENCE_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

export const preferenceKeyParamSchema = z.object({
  key: z
    .string()
    .min(1, 'key is required')
    .max(128, 'key too long')
    .regex(PREFERENCE_KEY_RE, 'key must be dotted lowercase segments, e.g. queue.filters'),
});

// PUT body. `value` is the opaque JSON the dashboard stores for this key — the
// filter-chip Set serialization, the sort key, etc. We don't constrain its
// inner shape here (that's the dashboard's contract per key); we only require
// it to be present and JSON-serializable. Reject top-level scalars/null so the
// stored blob is always an object or array the client can round-trip.
export const preferenceUpdateSchema = z.object({
  value: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]),
});

export type PreferenceKeyParam = z.infer<typeof preferenceKeyParamSchema>;
export type PreferenceUpdate = z.infer<typeof preferenceUpdateSchema>;
