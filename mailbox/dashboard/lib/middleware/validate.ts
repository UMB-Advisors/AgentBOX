import { type NextRequest, NextResponse } from 'next/server';
import type { ZodIssue, ZodType, z } from 'zod';

// Generic input-validation helpers (STAQPRO-138). Replaces the inline
// `typeof x !== 'string'` boilerplate that used to live at the top of every
// route handler. On bad input, returns a structured 400 instead of a 500.

export interface ValidationError {
  error: 'validation_failed';
  issues: ReadonlyArray<{
    path: string;
    message: string;
    code: string;
  }>;
}

type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse<ValidationError> };

function buildErrorResponse(issues: ReadonlyArray<ZodIssue>): NextResponse<ValidationError> {
  return NextResponse.json<ValidationError>(
    {
      error: 'validation_failed',
      issues: issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
    },
    { status: 400 },
  );
}

// Missing or invalid JSON body is normalized to `{}` so schemas decide what's
// required. A schema with required fields rejects {} naturally; a schema with
// only optional fields accepts it.
export async function parseJson<S extends ZodType>(
  req: NextRequest,
  schema: S,
): Promise<ParseResult<z.infer<S>>> {
  const raw = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: buildErrorResponse(parsed.error.issues) };
  }
  return { ok: true, data: parsed.data as z.infer<S> };
}

export function parseQuery<S extends ZodType>(
  req: NextRequest,
  schema: S,
): ParseResult<z.infer<S>> {
  const { searchParams } = new URL(req.url);
  const obj: Record<string, string> = {};
  for (const [k, v] of searchParams.entries()) {
    obj[k] = v;
  }
  const parsed = schema.safeParse(obj);
  if (!parsed.success) {
    return { ok: false, response: buildErrorResponse(parsed.error.issues) };
  }
  return { ok: true, data: parsed.data as z.infer<S> };
}

export function parseParams<S extends ZodType>(
  params: unknown,
  schema: S,
): ParseResult<z.infer<S>> {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, response: buildErrorResponse(parsed.error.issues) };
  }
  return { ok: true, data: parsed.data as z.infer<S> };
}
