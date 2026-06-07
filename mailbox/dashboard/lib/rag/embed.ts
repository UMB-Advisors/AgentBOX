// dashboard/lib/rag/embed.ts
//
// STAQPRO-190 — wrap nomic-embed-text:v1.5 via Ollama's /api/embeddings.
// Returns a 768-dimension cosine-normalized vector. The Qdrant
// `email_messages` collection (STAQPRO-188) was created with size=768 /
// distance=Cosine to match this model exactly — do not swap the model
// without re-embedding the corpus.
//
// Failure mode: returns null on any error (Ollama unreachable, model not
// pulled, invalid payload). Callers should treat null as "skip indexing,
// don't fail the pipeline" — RAG is augmentation, not gate (per the issue).
//
// STAQPRO-199 — defensive truncation + explicit num_ctx so long inputs
// (long emails, full-thread excerpts) don't trigger Ollama 500
// "the input length exceeds the context length". nomic-embed-text:v1.5
// supports up to 8192 tokens; Ollama's default for embedding-only models
// can be smaller. We send `options.num_ctx=8192` and char-cap at
// EMBED_MAX_CHARS (~4500 chars ≈ 1125 tokens; comfortable margin under
// 8192). Truncation logs a single-line warning so the surface is visible
// in production without spamming the logs.
//
// STAQPRO-200 — tightened the in-code default from 6000 → 4500 after a
// post-merge canonical eval found 1/30 messages still hit `embed_failed`
// at 6000. The deployed appliance has had `EMBED_MAX_CHARS=4500` via the
// docker-compose env override since commit caa24a7; this aligns the code
// default so anyone running outside the appliance compose (local dev,
// CI, fresh container) gets the corrected behavior automatically.

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://ollama:11434';
const EMBED_MODEL = process.env.EMBED_MODEL ?? 'nomic-embed-text:v1.5';
const EMBED_TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS ?? 10000);

// nomic-embed-text:v1.5 supports up to 8192 tokens. Setting this on the
// request forces Ollama to use the full window rather than its
// embedding-default (often 512).
const EMBED_NUM_CTX = Number(process.env.EMBED_NUM_CTX ?? 8192);

// Defensive char-level cap. ~4 chars/token average → ~1125 tokens for
// 4500 chars, a safe margin under EMBED_NUM_CTX. Tunable via env so we
// can shrink if a future model swap brings the context window down
// without redeploying code. Default tightened 6000 → 4500 in STAQPRO-200
// after empirical eval; see header for context.
const EMBED_MAX_CHARS = Number(process.env.EMBED_MAX_CHARS ?? 4500);

export const EMBED_VECTOR_SIZE = 768;

interface OllamaEmbeddingsResponse {
  embedding?: number[];
}

export async function embedText(input: string): Promise<number[] | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // STAQPRO-199 — char-level truncate before the wire to keep nomic
  // within its context window. Single-line warn so the surface is
  // visible in prod (one warn per oversized input).
  let prompt = trimmed;
  if (prompt.length > EMBED_MAX_CHARS) {
    console.warn(`[rag/embed] input truncated: ${prompt.length} → ${EMBED_MAX_CHARS} chars`);
    prompt = prompt.slice(0, EMBED_MAX_CHARS);
  }

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: EMBED_MODEL,
        prompt,
        // STAQPRO-199 — Ollama embedding-only models often default to
        // num_ctx=512. Force the full nomic window.
        options: { num_ctx: EMBED_NUM_CTX },
      }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[rag/embed] ollama returned ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = (await res.json()) as OllamaEmbeddingsResponse;
    if (!data.embedding || data.embedding.length !== EMBED_VECTOR_SIZE) {
      console.error(
        `[rag/embed] unexpected embedding shape: length=${data.embedding?.length ?? 'null'}`,
      );
      return null;
    }
    return data.embedding;
  } catch (error) {
    console.error('[rag/embed] embedding call threw:', error);
    return null;
  }
}
