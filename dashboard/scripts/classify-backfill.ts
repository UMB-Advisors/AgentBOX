// dashboard/scripts/classify-backfill.ts
//
// Phase-B one-shot backfill for emails ingested while MailBOX-Classify was
// inactive (post-2026-05-01 n8n upgrade left the sub-workflow active=false;
// re-activated 2026-05-03 via STAQPRO-181 follow-up). The parent MailBOX
// workflow's `Only If Newly Inserted` IF gate skips the Classify Sub call
// for dedup-hit rows, so previously-ingested-but-not-classified messages
// will never auto-classify on a future poll cycle. This script closes the
// gap.
//
// Mirrors the n8n MailBOX-Classify chain end-to-end:
//   Build Prompt  -> POST /api/internal/classification-prompt
//   Call Ollama   -> POST $OLLAMA_BASE_URL/api/generate (mirrors Call Ollama node verbatim)
//   Normalize     -> POST /api/internal/classification-normalize
//   Insert Log    -> INSERT INTO mailbox.classification_log
//
// Intentionally OUT OF SCOPE: Live Gate, Drop Spam IF, Insert Draft Stub,
// Trigger Draft Sub. The goal is to restore visibility on the
// Classifications page; draft regeneration for stale rows is a separate
// decision (operator may not want auto-drafts on day-old emails).
//
// Idempotent: only processes inbox rows with no classification_log entry.
//
// Run from the dashboard container (script and pg are already baked in):
//   docker exec -e BACKFILL_LOOKBACK_HOURS=48 mailbox-dashboard \
//     npx tsx scripts/classify-backfill.ts
//
// Env knobs:
//   BACKFILL_LOOKBACK_HOURS  default 48   - only consider rows received within window
//   BACKFILL_LIMIT           default 100  - hard cap so a runaway can't loop forever
//   DASHBOARD_BASE_URL       default http://localhost:3001/dashboard
//   OLLAMA_BASE_URL          default http://ollama:11434
//   POSTGRES_URL             required (already set on the mailbox-dashboard container)

import process from 'node:process';
import { Pool } from 'pg';
import { checkMemoryPressure } from '../lib/preflight/memory';

const POSTGRES_URL = process.env.POSTGRES_URL;
if (!POSTGRES_URL) {
  console.error('[backfill] POSTGRES_URL not set');
  process.exit(1);
}

const DASHBOARD_BASE = process.env.DASHBOARD_BASE_URL ?? 'http://localhost:3001/dashboard';
const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? 'http://ollama:11434';
const LOOKBACK_HOURS = Number.parseInt(process.env.BACKFILL_LOOKBACK_HOURS ?? '48', 10);
const LIMIT = Number.parseInt(process.env.BACKFILL_LIMIT ?? '100', 10);

interface InboxRow {
  id: number;
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  body: string | null;
  snippet: string | null;
}

interface PromptResponse {
  prompt: string;
  model: string;
}

interface NormalizeResponse {
  category: string;
  confidence: number;
  json_parse_ok: boolean;
  think_stripped: boolean;
  raw_output: string;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${url} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function classifyOne(row: InboxRow, pool: Pool): Promise<NormalizeResponse> {
  const prompt = await postJson<PromptResponse>(
    `${DASHBOARD_BASE}/api/internal/classification-prompt`,
    {
      from: row.from_addr ?? '',
      subject: row.subject ?? '',
      body: row.body ?? row.snippet ?? '',
    },
  );

  const t0 = Date.now();
  const ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: prompt.model,
      prompt: prompt.prompt,
      stream: false,
      format: 'json',
      // STAQPRO-240: force non-thinking mode. Mirrors the MailBOX-Classify
      // n8n workflow body. On Ollama < 0.21 (M1 historical) the field is
      // ignored; on 0.23+ (M2 current, M1 post-2026-05-08 unify) it
      // disables Qwen3 thinking-mode which otherwise puts JSON in the
      // `thinking` field and leaves `response` empty.
      think: false,
      options: { temperature: 0 },
    }),
  });
  if (!ollamaRes.ok) {
    throw new Error(`ollama -> HTTP ${ollamaRes.status}`);
  }
  // Defensive: if a future Ollama version revives thinking-mode despite
  // think:false, fall back to the thinking field. Same shape as the n8n
  // Normalize node's `$json.response || $json.thinking || ''`.
  const ollamaJson = (await ollamaRes.json()) as { response?: string; thinking?: string };
  const latency_ms = Date.now() - t0;

  const normalized = await postJson<NormalizeResponse>(
    `${DASHBOARD_BASE}/api/internal/classification-normalize`,
    {
      raw: ollamaJson.response || ollamaJson.thinking || '',
      from: row.from_addr ?? '',
      to: row.to_addr ?? '',
    },
  );

  await pool.query(
    `INSERT INTO mailbox.classification_log
       (inbox_message_id, category, confidence, model_version,
        latency_ms, raw_output, json_parse_ok, think_stripped)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      row.id,
      normalized.category,
      normalized.confidence,
      prompt.model,
      latency_ms,
      normalized.raw_output,
      normalized.json_parse_ok,
      normalized.think_stripped,
    ],
  );

  return normalized;
}

async function main() {
  // MBOX-166 / MBOX-109 — refuse a second large-GGUF load when
  // MemAvailable is below 1.5 GiB. Loading qwen3:4b-ctx4k into Ollama
  // alongside a resident llama-cpp (~3.3 GiB) on the 8 GiB Jetson caused
  // 138 container restarts in the DR-25 soak window via CUDA-side alloc
  // failures (never tripped kernel OOM). Escape hatch:
  // MAILBOX_PREFLIGHT_SKIP=1.
  const preflight = checkMemoryPressure();
  if (!preflight.ok && process.env.MAILBOX_PREFLIGHT_SKIP !== '1') {
    console.error('[backfill] memory preflight FAILED — refusing to load GGUF');
    console.error(`[backfill]   MemAvailable: ${preflight.memAvailableGiB.toFixed(2)} GiB`);
    console.error(`[backfill]   threshold:    ${preflight.minMemGiB.toFixed(2)} GiB`);
    console.error(`[backfill]   reason:       ${preflight.reason ?? 'unknown'}`);
    console.error(
      '[backfill]   recovery:     stop llama-cpp / wait for inference idle, OR set MAILBOX_PREFLIGHT_SKIP=1 to force',
    );
    process.exit(1);
  }
  if (preflight.status === 'amber') {
    console.warn(`[backfill] memory preflight amber — ${preflight.reason}`);
  }
  if (!preflight.ok && process.env.MAILBOX_PREFLIGHT_SKIP === '1') {
    console.warn(
      '[backfill] memory preflight FAILED but MAILBOX_PREFLIGHT_SKIP=1 — proceeding anyway',
    );
    console.warn(`[backfill]   ${preflight.reason}`);
  }

  const pool = new Pool({ connectionString: POSTGRES_URL });
  try {
    const { rows } = await pool.query<InboxRow>(
      `SELECT m.id, m.from_addr, m.to_addr, m.subject, m.body, m.snippet
         FROM mailbox.inbox_messages m
    LEFT JOIN mailbox.classification_log c ON c.inbox_message_id = m.id
        WHERE c.id IS NULL
          AND m.received_at > NOW() - make_interval(hours => $1)
     ORDER BY m.received_at ASC
        LIMIT $2`,
      [LOOKBACK_HOURS, LIMIT],
    );

    if (rows.length === 0) {
      console.log(
        `[backfill] no unclassified inbox_messages in last ${LOOKBACK_HOURS}h — nothing to do`,
      );
      return;
    }

    console.log(`[backfill] ${rows.length} unclassified rows in last ${LOOKBACK_HOURS}h`);
    let ok = 0;
    let fail = 0;
    for (const row of rows) {
      try {
        const r = await classifyOne(row, pool);
        console.log(
          `  [ok]   id=${row.id} -> ${r.category} (${r.confidence.toFixed(2)}) from=${row.from_addr ?? '?'} subject=${(row.subject ?? '').slice(0, 50)}`,
        );
        ok += 1;
      } catch (e) {
        console.error(`  [fail] id=${row.id}: ${e instanceof Error ? e.message : String(e)}`);
        fail += 1;
      }
    }
    console.log(`[backfill] done: ${ok} ok, ${fail} fail`);
    if (fail > 0) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error('[backfill] fatal:', e);
  process.exit(1);
});
