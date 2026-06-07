// dashboard/lib/rag/kb-parsers.ts
//
// STAQPRO-148 — mime-aware document parser dispatch for KB uploads.
// Handles the four formats Isa's audit (FR-32) called out: PDF, .docx,
// .md, .txt. Each path returns a single text string + a default title
// derived from the filename or first heading.
//
// Failure mode: throws on parse errors (caller in kb-ingest.ts catches and
// flips kb_documents.status to 'failed' with the error_message). Unlike
// the Qdrant + embed paths which degrade silently, parser failure is a
// caller bug or a corrupt file — surfacing it is correct.

import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';

export interface ParseResult {
  text: string;
  title: string;
}

export const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/markdown',
  'text/plain',
] as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export function isSupportedMimeType(mime: string): mime is SupportedMimeType {
  return (SUPPORTED_MIME_TYPES as readonly string[]).includes(mime);
}

function titleFromFilename(filename: string): string {
  // Strip extension + replace separators with spaces. Operator can edit
  // the title in the UI later; this is just a sane default.
  return (
    filename
      .replace(/\.[^.]+$/, '')
      .replace(/[._-]+/g, ' ')
      .trim() || filename
  );
}

function titleFromMarkdown(text: string, filename: string): string {
  // Use the first H1 if present, else fall back to filename.
  const h1 = text.match(/^#\s+(.+)$/m);
  return h1 ? h1[1].trim() : titleFromFilename(filename);
}

export async function parseDocument(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<ParseResult> {
  if (!isSupportedMimeType(mimeType)) {
    throw new Error(`unsupported mime_type: ${mimeType}`);
  }

  switch (mimeType) {
    case 'application/pdf': {
      const result = await pdfParse(buffer);
      return { text: result.text, title: titleFromFilename(filename) };
    }
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
      const result = await mammoth.extractRawText({ buffer });
      return { text: result.value, title: titleFromFilename(filename) };
    }
    case 'text/markdown': {
      const text = buffer.toString('utf8');
      return { text, title: titleFromMarkdown(text, filename) };
    }
    case 'text/plain': {
      return { text: buffer.toString('utf8'), title: titleFromFilename(filename) };
    }
  }
}
