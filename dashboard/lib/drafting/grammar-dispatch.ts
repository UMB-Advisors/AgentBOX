// grammar-dispatch.ts — MBOX-120 constrained-decoding (GBNF) dispatch.
//
// SPIKE, DEFAULT OFF. Constrained decoding (GBNF grammar enforcement on the
// llama.cpp local runtime) is a structure-enforcement experiment for the two
// most templated draft categories — `reorder` and `scheduling`. It is gated
// behind CONSTRAINED_DECODING_ENABLED and ships OFF because forcing a grammar
// onto the decoder risks SEMANTIC degradation (arxiv 2603.03305): even a
// structure-only grammar can perturb prose if the model has to back out of a
// token path the grammar forbids. The grammars in ./grammars/*.gbnf are written
// to constrain the bones (greeting / confirmation slot / signoff) and leave the
// body free, but the flag stays off until grammar-eval.ts + a human blind-pref
// pass confirm no quality loss on M1's qwen3:4b-ctx4k.
//
// Only the llama.cpp runtime consumes the `grammar` field; against real Ollama
// it is a harmless ignored option (see ollama.ts / the llm proxy route).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Category } from '@/lib/classification/prompt';

// Resolve the grammars dir relative to THIS module (ESM-safe — the dashboard
// builds as `module: esnext`, so `__dirname` is unavailable; mirror the
// pattern vitest.config.ts uses).
const GRAMMARS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'grammars');

// The categories whose drafts get a grammar when the flag is on. Kept narrow on
// purpose — these two have the most reliably templated reply shape, so the
// structure-only grammar fits without fighting the prose.
export const CONSTRAINED_CATEGORIES: ReadonlyArray<Category> = ['reorder', 'scheduling'];

// Flag read at call-time (not module-load) so a test / runtime can flip it
// without re-importing. Accepts '1' or 'true' (case-insensitive); anything
// else — including unset — is OFF.
export function constrainedDecodingEnabled(): boolean {
  const raw = (process.env.CONSTRAINED_DECODING_ENABLED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

// Lazy + cached GBNF file reads. The two grammars are tiny and immutable on
// disk; read once on first use and memoize. Keyed by category so adding a
// constrained category later is a one-line table edit.
const GRAMMAR_FILES: Partial<Record<Category, string>> = {
  reorder: 'reorder.gbnf',
  scheduling: 'scheduling.gbnf',
};

const grammarCache = new Map<Category, string>();

function loadGrammar(category: Category): string | null {
  const file = GRAMMAR_FILES[category];
  if (file === undefined) return null;
  const cached = grammarCache.get(category);
  if (cached !== undefined) return cached;
  const contents = readFileSync(path.join(GRAMMARS_DIR, file), 'utf-8');
  grammarCache.set(category, contents);
  return contents;
}

// Returns the GBNF grammar string for a draft category, or null when:
//   - the flag is off (the common case — spike default), OR
//   - the category is not a constrained category.
// Callers (prompt.ts) treat null as "no grammar — decode normally".
export function grammarForCategory(category: Category): string | null {
  if (!constrainedDecodingEnabled()) return null;
  if (!CONSTRAINED_CATEGORIES.includes(category)) return null;
  return loadGrammar(category);
}
