---
status: SUPERSEDED
superseded_by: 02-06-persona-extract-refresh-PLAN-v2-2026-04-27-STUB.md (authoritative for architectural intent until promoted to a full v2 plan)
supersession_date: 2026-04-27
supersession_reason: 2026-04-27 Next.js full-stack ADR retired the Express backend layout (`dashboard/backend/src/persona/...`, `dashboard/backend/src/routes/persona.ts`) this plan targets in favor of `dashboard/lib/persona/...` modules and `dashboard/app/api/persona/...` route handlers. See ADR in `.planning/STATE.md` and the v2 STUB for the rescoped architecture.
plan_number: 02-06
slug: persona-extract-refresh
wave: 3
depends_on: [02-02]
autonomous: false
requirements: [PERS-01, PERS-02, PERS-03, PERS-04, PERS-05]
files_modified:
  - dashboard/backend/src/persona/stats.ts
  - dashboard/backend/src/persona/exemplars.ts
  - dashboard/backend/src/persona/build.ts
  - dashboard/backend/src/routes/persona.ts
  - dashboard/backend/src/index.ts
  - n8n/workflows/08-persona-monthly-refresh.json
  - n8n/workflows/09-persona-extract-trigger.json
---

<objective>
Extract the operator's voice profile from ingested sent history using the hybrid approach locked in CONTEXT.md D-07 through D-11: deterministic statistical markers (sentence length distribution, formality score, greeting/closing frequencies) plus 3–5 per-category few-shot exemplars drawn from the ingested sent emails. The extraction runs once at onboarding (triggered by Plan 02-08 after the 6-month ingest completes) and re-runs monthly via an n8n scheduled sub-workflow (D-10). Persona is stored in `mailbox.persona` as a single row with JSONB columns. The drafting path (Plan 02-07) reads the row to compose prompts.
</objective>

<must_haves>
- `mailbox.persona` row for `customer_key='default'` contains `statistical_markers` (JSONB with `avg_sentence_length`, `formality_score`, `greeting_frequencies`, `closing_frequencies`, `vocabulary_top_terms`) and `category_exemplars` (JSONB map from category name → array of 3–5 exemplar objects `{ inbound_snippet, reply, subject, sent_at }`)
- `POST /api/persona/extract` endpoint runs the extraction job against the ingested sent corpus and writes/updates the persona row. Idempotent.
- `GET /api/persona` returns the current persona row shape (for dashboard display and Plan 02-08 tuning session)
- Categories with fewer than 3 exemplars in the sent history record the gap explicitly in the persona row (D-09)
- Monthly refresh sub-workflow `08-persona-monthly-refresh` fires on the 1st of each month at 02:00 local time, reads `mailbox.sent_history` for the last 30 days of approved sends plus historical exemplars, and updates the row (PERS-05)
- `09-persona-extract-trigger` is callable from the onboarding flow after the 6-month ingest completes, and from `POST /api/persona/extract`
</must_haves>

<tasks>

<task id="1">
<action>
Create `dashboard/backend/src/persona/stats.ts` — pure functions that compute deterministic statistical markers from a list of sent email bodies. No dependencies beyond the standard library:

```ts
export interface StatisticalMarkers {
  avg_sentence_length: number;
  p90_sentence_length: number;
  formality_score: number;      // 0.0 casual → 1.0 formal
  greeting_frequencies: Record<string, number>;  // {"Hi": 0.6, "Hello": 0.2, ...}
  closing_frequencies: Record<string, number>;   // {"Thanks": 0.5, "Best": 0.3, ...}
  vocabulary_top_terms: Array<{ term: string; count: number }>;
  sample_size: number;
}

const GREETING_PATTERNS: Array<[string, RegExp]> = [
  ['Hi',    /\b(hi|hey)\b/i],
  ['Hello', /\bhello\b/i],
  ['Dear',  /\bdear\b/i],
  ['Good morning', /\bgood\s+morning\b/i],
  ['Thanks', /^\s*thanks\b/im],  // opener "Thanks for ..."
];

const CLOSING_PATTERNS: Array<[string, RegExp]> = [
  ['Thanks',       /\bthanks(\s|\.|,|$)/i],
  ['Thank you',    /\bthank you\b/i],
  ['Best',         /\bbest\b/i],
  ['Cheers',       /\bcheers\b/i],
  ['Regards',      /\bregards\b/i],
  ['Sincerely',    /\bsincerely\b/i],
];

const FORMAL_MARKERS = /\b(please|kindly|furthermore|however|therefore|sincerely|regards)\b/gi;
const CASUAL_MARKERS = /\b(thanks|hey|yeah|cool|gonna|wanna|nope|yep)\b/gi;
const STOP_WORDS = new Set(['the','a','an','and','or','but','to','of','in','on','for','with','at','by','from','i','you','we','they','it','is','are','was','were','be','been','have','has','had','do','does','did','this','that','these','those','not','no','as','so','if','my','your','our','their']);

export function computeMarkers(bodies: string[]): StatisticalMarkers {
  const clean = bodies.map((b) => (b || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (clean.length === 0) {
    return {
      avg_sentence_length: 0, p90_sentence_length: 0, formality_score: 0.5,
      greeting_frequencies: {}, closing_frequencies: {}, vocabulary_top_terms: [], sample_size: 0,
    };
  }

  // Sentence length
  const lengths: number[] = [];
  for (const body of clean) {
    for (const sent of body.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean)) {
      lengths.push(sent.split(/\s+/).length);
    }
  }
  const sorted = [...lengths].sort((a, b) => a - b);
  const avg = lengths.reduce((a, b) => a + b, 0) / (lengths.length || 1);
  const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;

  // Greeting / closing frequencies (fraction of bodies that contain each pattern in the first/last 5 lines)
  const greetings: Record<string, number> = {};
  const closings: Record<string, number> = {};
  for (const body of clean) {
    const head = body.slice(0, 200);
    const tail = body.slice(-200);
    for (const [label, re] of GREETING_PATTERNS) if (re.test(head)) greetings[label] = (greetings[label] || 0) + 1;
    for (const [label, re] of CLOSING_PATTERNS) if (re.test(tail)) closings[label] = (closings[label] || 0) + 1;
  }
  for (const k of Object.keys(greetings)) greetings[k] = +(greetings[k] / clean.length).toFixed(3);
  for (const k of Object.keys(closings)) closings[k] = +(closings[k] / clean.length).toFixed(3);

  // Formality (ratio of formal to formal+casual hits)
  let formal = 0, casual = 0;
  for (const body of clean) {
    formal += (body.match(FORMAL_MARKERS) || []).length;
    casual += (body.match(CASUAL_MARKERS) || []).length;
  }
  const formality_score = +(formal / (formal + casual || 1)).toFixed(3);

  // Vocabulary (top 20 non-stop terms)
  const freq: Record<string, number> = {};
  for (const body of clean) {
    for (const w of body.toLowerCase().split(/[^a-z0-9'-]+/).filter(Boolean)) {
      if (w.length < 3 || STOP_WORDS.has(w)) continue;
      freq[w] = (freq[w] || 0) + 1;
    }
  }
  const vocabulary_top_terms = Object.entries(freq)
    .sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([term, count]) => ({ term, count }));

  return {
    avg_sentence_length: +avg.toFixed(2),
    p90_sentence_length: p90,
    formality_score,
    greeting_frequencies: greetings,
    closing_frequencies: closings,
    vocabulary_top_terms,
    sample_size: clean.length,
  };
}
```
</action>
<read_first>
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-07 hybrid approach)
  - .planning/REQUIREMENTS.md  (PERS-01 markers)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/persona/stats.ts` exists
- `grep 'export interface StatisticalMarkers' dashboard/backend/src/persona/stats.ts` matches
- `grep 'export function computeMarkers' dashboard/backend/src/persona/stats.ts` matches
- `grep 'greeting_frequencies' dashboard/backend/src/persona/stats.ts` matches
- `grep 'formality_score' dashboard/backend/src/persona/stats.ts` matches
- `grep 'vocabulary_top_terms' dashboard/backend/src/persona/stats.ts` matches
</acceptance_criteria>
</task>

<task id="2">
<action>
Create `dashboard/backend/src/persona/exemplars.ts` — picks 3–5 representative sent emails per category. A "representative" email is one whose inbound trigger maps to that category (determined via `mailbox.sent_history` joined back to `email_raw` + `classification_log` when historical classification exists; otherwise fall back to keyword heuristics per category).

```ts
import { db } from '../db/client.js';
import { sql } from 'drizzle-orm';

export interface Exemplar {
  inbound_snippet: string;
  reply: string;
  subject: string;
  sent_at: string; // ISO
}

export type ExemplarMap = Record<string, Exemplar[]>;
export interface ExemplarGaps { category: string; have: number; need: number; }

const CATEGORIES = ['inquiry','reorder','scheduling','follow_up','internal','spam_marketing','escalate','unknown'];

// Heuristic keyword hints used only when no classification_log join exists (initial onboarding)
const CATEGORY_KEYWORDS: Record<string, RegExp[]> = {
  reorder:    [/reorder/i, /\bship\b.*\bcases?\b/i, /\bPO\b/i, /\bsame as last\b/i],
  scheduling: [/schedul/i, /\bmeet(ing)?\b/i, /\bcalendar\b/i, /\bcall\b.*\bTues|Wed|Mon|Thu|Fri\b/i],
  follow_up:  [/follow(ing)?\s+up/i, /\bchecking in\b/i, /\bstill waiting\b/i],
  internal:   [/\bteam\b/i, /\bfwd:\b/i, /\binternal\b/i],
  inquiry:    [/\bpricing\b/i, /\bwholesale\b/i, /\bMOQ\b/i, /\bminimum order\b/i, /\bquote\b/i],
  escalate:   [/\brefund\b/i, /\burgent\b/i, /\bcomplaint\b/i, /\blegal\b/i, /\bcompliance\b/i],
};

export async function pickExemplars(targetPerCategory = 5): Promise<{ exemplars: ExemplarMap; gaps: ExemplarGaps[] }> {
  // Strategy A: if classification_log rows exist for prior emails, join and select sent replies per category.
  const joined = (await db.execute(sql`
    SELECT sh.draft_sent AS reply,
           sh.subject AS subject,
           sh.sent_at AS sent_at,
           er.body_text AS inbound_body,
           cl.category AS category
    FROM mailbox.sent_history sh
    LEFT JOIN mailbox.email_raw er ON er.id = sh.email_raw_id
    LEFT JOIN mailbox.classification_log cl ON cl.email_raw_id = sh.email_raw_id
    ORDER BY sh.sent_at DESC
    LIMIT 500;
  `)).rows as Array<{ reply: string; subject: string; sent_at: string; inbound_body: string | null; category: string | null }>;

  const exemplars: ExemplarMap = Object.fromEntries(CATEGORIES.map((c) => [c, []]));

  const pushExemplar = (cat: string, row: any) => {
    if (exemplars[cat].length >= targetPerCategory) return;
    exemplars[cat].push({
      inbound_snippet: String(row.inbound_body || '').slice(0, 400),
      reply: String(row.reply || '').slice(0, 1200),
      subject: String(row.subject || '').slice(0, 200),
      sent_at: row.sent_at instanceof Date ? row.sent_at.toISOString() : String(row.sent_at || ''),
    });
  };

  for (const row of joined) {
    if (row.category && CATEGORIES.includes(row.category)) {
      pushExemplar(row.category, row);
    } else {
      // Strategy B: keyword heuristic on reply + inbound
      const hay = `${row.inbound_body || ''} ${row.reply || ''}`;
      let matched: string | null = null;
      for (const [cat, regs] of Object.entries(CATEGORY_KEYWORDS)) {
        if (regs.some((r) => r.test(hay))) { matched = cat; break; }
      }
      if (matched) pushExemplar(matched, row);
    }
  }

  const gaps: ExemplarGaps[] = CATEGORIES
    .filter((c) => c !== 'spam_marketing') // never seed exemplars for spam
    .map((c) => ({ category: c, have: exemplars[c].length, need: Math.max(3 - exemplars[c].length, 0) }))
    .filter((g) => g.need > 0);

  return { exemplars, gaps };
}
```
</action>
<read_first>
  - dashboard/backend/src/db/client.ts
  - dashboard/backend/src/db/schema.ts
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-07..D-09)
  - .planning/REQUIREMENTS.md  (PERS-03 3-5 per category)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/persona/exemplars.ts` exists
- `grep 'export interface Exemplar' dashboard/backend/src/persona/exemplars.ts` matches
- `grep 'export async function pickExemplars' dashboard/backend/src/persona/exemplars.ts` matches
- `grep 'CATEGORY_KEYWORDS' dashboard/backend/src/persona/exemplars.ts` matches
- `grep 'targetPerCategory' dashboard/backend/src/persona/exemplars.ts` matches
- `grep 'gaps' dashboard/backend/src/persona/exemplars.ts` matches
</acceptance_criteria>
</task>

<task id="3">
<action>
Create `dashboard/backend/src/persona/build.ts` — orchestration that fetches sent bodies, computes markers, picks exemplars, upserts the `mailbox.persona` row:

```ts
import { db } from '../db/client.js';
import { persona } from '../db/schema.js';
import { sql, eq } from 'drizzle-orm';
import { computeMarkers } from './stats.js';
import { pickExemplars } from './exemplars.js';

export interface PersonaBuildResult {
  source_email_count: number;
  markers: ReturnType<typeof computeMarkers>;
  category_counts: Record<string, number>;
  gaps: { category: string; have: number; need: number }[];
  updated_at: string;
}

export async function buildPersona(customerKey = 'default'): Promise<PersonaBuildResult> {
  // 1. Pull sent bodies (from sent_history preferred; fall back to Qdrant sent_email points if sent_history is still empty)
  const bodies = (await db.execute(sql`
    SELECT COALESCE(draft_sent, '') AS body_text FROM mailbox.sent_history ORDER BY sent_at DESC LIMIT 2000;
  `)).rows.map((r: any) => String(r.body_text || '')).filter(Boolean);

  // 2. Compute markers
  const markers = computeMarkers(bodies);

  // 3. Pick exemplars
  const { exemplars, gaps } = await pickExemplars(5);

  // 4. Upsert mailbox.persona
  const now = new Date();
  await db.insert(persona).values({
    customerKey,
    statisticalMarkers: markers as unknown as object,
    categoryExemplars: exemplars as unknown as object,
    sourceEmailCount: bodies.length,
    lastRefreshedAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: persona.customerKey,
    set: {
      statisticalMarkers: markers as unknown as object,
      categoryExemplars: exemplars as unknown as object,
      sourceEmailCount: bodies.length,
      lastRefreshedAt: now,
      updatedAt: now,
    },
  });

  // 5. Return summary for API consumer + logs
  const category_counts = Object.fromEntries(Object.entries(exemplars).map(([k, v]) => [k, v.length]));
  return { source_email_count: bodies.length, markers, category_counts, gaps, updated_at: now.toISOString() };
}
```
</action>
<read_first>
  - dashboard/backend/src/persona/stats.ts
  - dashboard/backend/src/persona/exemplars.ts
  - dashboard/backend/src/db/schema.ts
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/persona/build.ts` exists
- `grep 'export async function buildPersona' dashboard/backend/src/persona/build.ts` matches
- `grep 'onConflictDoUpdate' dashboard/backend/src/persona/build.ts` matches
- `grep 'sourceEmailCount' dashboard/backend/src/persona/build.ts` matches
</acceptance_criteria>
</task>

<task id="4">
<action>
Create `dashboard/backend/src/routes/persona.ts` — persona REST API used by the onboarding wizard and by any ad-hoc rebuild:

```ts
import { Router } from 'express';
import { db } from '../db/client.js';
import { persona } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { buildPersona } from '../persona/build.js';

export const personaRouter = Router();

personaRouter.get('/', async (_req, res) => {
  const rows = await db.select().from(persona).where(eq(persona.customerKey, 'default'));
  if (rows.length === 0) return res.status(404).json({ error: 'persona not built yet' });
  res.json(rows[0]);
});

personaRouter.post('/extract', async (_req, res) => {
  try {
    const result = await buildPersona('default');
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
```

Wire into `dashboard/backend/src/index.ts`:

```ts
import { personaRouter } from './routes/persona.js';
// ...after healthRouter and kbRouter...
app.use('/api/persona', personaRouter);
```
</action>
<read_first>
  - dashboard/backend/src/persona/build.ts
  - dashboard/backend/src/index.ts
  - dashboard/backend/src/db/schema.ts
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/routes/persona.ts` exists
- `grep "personaRouter.get('/')" dashboard/backend/src/routes/persona.ts` matches
- `grep "personaRouter.post('/extract'" dashboard/backend/src/routes/persona.ts` matches
- `grep '/api/persona' dashboard/backend/src/index.ts` matches
</acceptance_criteria>
</task>

<task id="5">
<action>
Create `n8n/workflows/09-persona-extract-trigger.json` — thin sub-workflow that invokes the dashboard backend's `POST /api/persona/extract`. Triggered by the onboarding flow (Plan 02-08) after the 6-month sent ingest completes. Node graph:

1. **Execute Workflow Trigger** — accepts no parameters.
2. **HTTP Request** — `POST http://dashboard:3000/api/persona/extract`, expect 200 with JSON body `{ source_email_count, markers, category_counts, gaps, updated_at }`.
3. **IF gaps is non-empty** — write a warning to stderr (n8n Function node `console.warn`) and continue.
4. **Postgres: Update onboarding.tuning_sample_count** — sets the stage's ready-for-tuning counter. Actual tuning sample generation is Plan 02-08.

Workflow shape:
```json
{
  "name": "09-persona-extract-trigger",
  "active": false,
  "tags": [{"name":"phase-2"}, {"name":"persona"}]
}
```
</action>
<read_first>
  - dashboard/backend/src/routes/persona.ts
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-12 staged async, D-15 tuning sample set)
</read_first>
<acceptance_criteria>
- `n8n/workflows/09-persona-extract-trigger.json` exists and is valid JSON
- `jq -r '.name' n8n/workflows/09-persona-extract-trigger.json` returns `09-persona-extract-trigger`
- `grep '/api/persona/extract' n8n/workflows/09-persona-extract-trigger.json` matches
- `grep 'http://dashboard:3000' n8n/workflows/09-persona-extract-trigger.json` matches
</acceptance_criteria>
</task>

<task id="6">
<action>
Create `n8n/workflows/08-persona-monthly-refresh.json` — cron-triggered monthly refresh (D-10, PERS-05). Fires on the 1st of each month at 02:00, calls the same `POST /api/persona/extract` endpoint, and logs the result to n8n execution history:

1. **Cron trigger** — `0 2 1 * *` (UTC).
2. **HTTP Request** — `POST http://dashboard:3000/api/persona/extract`.
3. **Function: Log summary** — writes `source_email_count`, `gaps`, and `updated_at` to `console.log` for audit via n8n execution log.

Workflow JSON top-level:
```json
{
  "name": "08-persona-monthly-refresh",
  "active": true,
  "tags": [{"name":"phase-2"}, {"name":"persona"}, {"name":"schedule"}]
}
```
</action>
<read_first>
  - n8n/workflows/09-persona-extract-trigger.json
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-10 monthly refresh)
</read_first>
<acceptance_criteria>
- `n8n/workflows/08-persona-monthly-refresh.json` exists and is valid JSON
- `jq -r '.name' n8n/workflows/08-persona-monthly-refresh.json` returns `08-persona-monthly-refresh`
- `grep '"0 2 1 \* \*"\|0 2 1 \* \*' n8n/workflows/08-persona-monthly-refresh.json` matches (monthly cron)
- `grep '/api/persona/extract' n8n/workflows/08-persona-monthly-refresh.json` matches
- `jq -r '.active' n8n/workflows/08-persona-monthly-refresh.json` returns `true`
</acceptance_criteria>
</task>

<task id="7">
<action>
Rebuild the dashboard image, import the two new workflows, and smoke-test the persona extraction path:

```bash
docker compose build dashboard
docker compose up -d dashboard

# Import new workflows
./scripts/n8n-import-workflows.sh

# Seed some sent_history rows so the persona extraction has data to chew on.
# In real dogfood this is populated by Plan 02-05's 06-rag-ingest-sent-history workflow during onboarding.
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
INSERT INTO mailbox.email_raw (message_id, from_addr, to_addr, subject, body_text, received_at) VALUES
  ('seed-001','buyer@ex.com','me@heron.com','Re: Reorder','We would like to reorder the same SKU.','2026-04-01'),
  ('seed-002','prospect@ex.com','me@heron.com','Wholesale inquiry','Hi! Interested in your hot sauces at wholesale.','2026-04-02')
ON CONFLICT (message_id) DO NOTHING;

INSERT INTO mailbox.sent_history (draft_queue_id, email_raw_id, from_addr, to_addr, subject, body_text, draft_sent, draft_source, classification_category, classification_confidence, sent_at)
SELECT 0, er.id, 'me@heron.com', er.from_addr, 'Re: '||er.subject, er.body_text,
       'Thanks for reaching out! Happy to reorder 48 cases same terms as last month. Best, Dustin',
       'local_qwen3','reorder',0.92, NOW()
FROM mailbox.email_raw er WHERE message_id = 'seed-001' ON CONFLICT DO NOTHING;

INSERT INTO mailbox.sent_history (draft_queue_id, email_raw_id, from_addr, to_addr, subject, body_text, draft_sent, draft_source, classification_category, classification_confidence, sent_at)
SELECT 0, er.id, 'me@heron.com', er.from_addr, 'Re: '||er.subject, er.body_text,
       'Hi! Thanks for the interest. Our wholesale MOQ is 12 cases; full pricing sheet attached. Thanks, Dustin',
       'cloud_haiku','inquiry',0.88, NOW()
FROM mailbox.email_raw er WHERE message_id = 'seed-002' ON CONFLICT DO NOTHING;
"

# Run extraction
curl -fsS -X POST http://localhost:3000/api/persona/extract | tee /tmp/persona.json
cat /tmp/persona.json | jq .

# Inspect the persona row
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT customer_key, source_email_count, last_refreshed_at,
         statistical_markers::jsonb -> 'formality_score' AS formality,
         jsonb_object_keys(category_exemplars::jsonb) AS categories_with_exemplars
  FROM mailbox.persona WHERE customer_key = 'default';
"
```
</action>
<read_first>
  - dashboard/backend/src/routes/persona.ts
  - dashboard/backend/src/persona/build.ts
  - n8n/workflows/08-persona-monthly-refresh.json
  - n8n/workflows/09-persona-extract-trigger.json
</read_first>
<acceptance_criteria>
- `curl -fsS -X POST http://localhost:3000/api/persona/extract` exits 0 and returns JSON with `source_email_count` > 0
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT source_email_count FROM mailbox.persona WHERE customer_key='default';"` returns a positive integer
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT statistical_markers ? 'formality_score' FROM mailbox.persona WHERE customer_key='default';"` returns `t`
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT category_exemplars ? 'reorder' FROM mailbox.persona WHERE customer_key='default';"` returns `t`
- `docker compose exec -T n8n n8n list:workflow | grep -q '08-persona-monthly-refresh'`
- `docker compose exec -T n8n n8n list:workflow | grep -q '09-persona-extract-trigger'`
</acceptance_criteria>
</task>

</tasks>

<verification>
```bash
# 1. Persona row exists and is structurally valid
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT (statistical_markers ? 'avg_sentence_length') AND
         (statistical_markers ? 'formality_score') AND
         (statistical_markers ? 'greeting_frequencies') AND
         (statistical_markers ? 'closing_frequencies') AND
         (statistical_markers ? 'vocabulary_top_terms')
  FROM mailbox.persona WHERE customer_key='default';
" | grep -q '^t$'

# 2. Category exemplars object has required shape (at least one non-spam category)
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT jsonb_array_length(category_exemplars -> 'reorder') > 0
  FROM mailbox.persona WHERE customer_key='default';
" | grep -q '^t$'

# 3. Gaps tracking exists in API response
curl -fsS -X POST http://localhost:3000/api/persona/extract | jq -e '.gaps' > /dev/null

# 4. Monthly workflow scheduled (cron: 0 2 1 * *)
grep -q '0 2 1' n8n/workflows/08-persona-monthly-refresh.json

# 5. Monthly refresh can be invoked manually via CLI
docker compose exec -T n8n n8n list:workflow | grep -q '08-persona-monthly-refresh'
```
</verification>
