// Per-model pricing for the drafting path (D-22).
//
// Computed by /api/internal/draft-finalize before persisting the row. n8n
// doesn't need pricing constants — they live in code where they can be
// versioned in PRs.
//
// All prices are USD per 1 million tokens. Update when the operator
// switches Ollama Cloud models or when Anthropic pricing changes.

export interface ModelPrice {
  // USD per 1M tokens.
  input_per_mtok: number;
  output_per_mtok: number;
}

// Local Ollama: zero marginal cost (electricity is overhead). Always 0.
// Ollama Cloud: per-model pricing. Verify against ollama.com/cloud before
// trusting these numbers — they may need refresh.
// Anthropic: kept config-ready as the alt-cloud fallback (not wired tonight).
export const PRICING: Readonly<Record<string, ModelPrice>> = {
  // Local
  'qwen3:4b-ctx4k': { input_per_mtok: 0, output_per_mtok: 0 },
  'qwen3:4b': { input_per_mtok: 0, output_per_mtok: 0 },

  // Ollama Cloud (rough estimates — replace with verified rates before billing
  // customer #2 on cost+20%).
  'gpt-oss:120b': { input_per_mtok: 0.5, output_per_mtok: 1.5 },
  'qwen3-coder:480b': { input_per_mtok: 1.0, output_per_mtok: 3.0 },
  'deepseek-v3.1:671b': { input_per_mtok: 1.0, output_per_mtok: 3.0 },
  'kimi-k2:1t': { input_per_mtok: 2.0, output_per_mtok: 6.0 },

  // Anthropic — config-ready fallback (not used by default per 2026-04-30
  // pivot; values from CLAUDE.md confirmed as of model release).
  'claude-haiku-4-5-20251001': {
    input_per_mtok: 1.0,
    output_per_mtok: 5.0,
  },
};

export function computeCost(model: string, input_tokens: number, output_tokens: number): number {
  const p = PRICING[model];
  if (!p) {
    // Unknown model — return 0 rather than block the write. Cost meter will
    // surface the gap; an alert can be added once the meter UI ships.
    return 0;
  }
  const cost =
    (input_tokens / 1_000_000) * p.input_per_mtok + (output_tokens / 1_000_000) * p.output_per_mtok;
  // 6 decimal places matches the NUMERIC(10,6) column. Cap negative or NaN.
  if (!Number.isFinite(cost) || cost < 0) return 0;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
