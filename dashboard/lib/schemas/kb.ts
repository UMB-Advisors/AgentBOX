import { z } from 'zod';
import { SUPPORTED_MIME_TYPES } from '@/lib/rag/kb-parsers';

// STAQPRO-148 — schemas for the KB upload + management routes. The upload
// route (POST /api/kb-documents) uses Next.js native request.formData()
// for multipart parsing, then validates the metadata fields with these
// schemas. List/detail/delete routes use these for query/params validation.

// Hard cap on a single uploaded file. Operator-uploaded SOPs / price
// sheets / policies are typically 1-5 MB; 10 MB is a reasonable ceiling
// that keeps the synchronous parse + chunk path under a few seconds even
// for large PDFs.
export const KB_MAX_FILE_BYTES = Number(process.env.KB_MAX_FILE_BYTES ?? 10 * 1024 * 1024);

// Filename safety — operator-uploaded but still untrusted. Keep under 256
// chars to avoid filesystem oddities; reject anything with path separators
// (we derive the on-disk path from the sha256, but the displayed filename
// is what the operator typed).
export const kbFilenameSchema = z
  .string()
  .min(1, 'filename required')
  .max(256, 'filename must be ≤ 256 characters')
  .refine((s) => !s.includes('/') && !s.includes('\\') && !s.includes('\0'), {
    message: 'filename must not contain path separators or null bytes',
  });

export const kbMimeTypeSchema = z.enum(
  SUPPORTED_MIME_TYPES as readonly string[] as readonly [string, ...string[]],
  { message: `mime_type must be one of: ${SUPPORTED_MIME_TYPES.join(', ')}` },
);

export const kbListQuerySchema = z.object({
  status: z.enum(['processing', 'ready', 'failed']).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  // MBOX-400 (MBOX-162 V7) — scope the listing to one inbox's documents.
  account_id: z.coerce.number().int().positive().optional(),
});

export type KbListQuery = z.infer<typeof kbListQuerySchema>;

export const kbIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type KbIdParam = z.infer<typeof kbIdParamSchema>;
