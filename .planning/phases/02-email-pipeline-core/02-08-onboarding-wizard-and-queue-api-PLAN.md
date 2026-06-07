---
status: SUPERSEDED
superseded_by: 02-08-onboarding-wizard-and-queue-api-PLAN-v2-2026-04-27-STUB.md (authoritative for architectural intent until promoted to a full v2 plan)
supersession_date: 2026-04-27
supersession_reason: 2026-04-27 Next.js full-stack ADR retired the Express backend layout (`dashboard/backend/src/routes/{onboarding,queue,tuning}.ts`, `dashboard/backend/src/{auth,live-gate}.ts`) this plan targets in favor of `dashboard/app/api/{onboarding,drafts,tuning}/...` route handlers and `dashboard/lib/{auth,onboarding}/...` modules. See ADR in `.planning/STATE.md` and the v2 STUB for the rescoped architecture.
plan_number: 02-08
slug: onboarding-wizard-and-queue-api
wave: 5
depends_on: [02-01, 02-02, 02-03, 02-05, 02-06, 02-07]
autonomous: false
requirements: [ONBR-01, ONBR-02, ONBR-03, ONBR-04, ONBR-05, ONBR-06, APPR-01, APPR-02]
files_modified:
  - dashboard/backend/src/routes/onboarding.ts
  - dashboard/backend/src/routes/queue.ts
  - dashboard/backend/src/routes/tuning.ts
  - dashboard/backend/src/index.ts
  - dashboard/backend/src/auth/password.ts
  - dashboard/backend/src/live-gate.ts
  - n8n/workflows/12-tuning-sample-generate.json
---

<objective>
Deliver the backend API surface for the first-boot onboarding wizard (the front-end UI ships in Phase 4, but the flow is driven by these Express routes now so dogfooding can proceed), the approval queue REST + WebSocket contract that Phase 4 will consume, the persona tuning session API (20 sample drafts + tone ratings), and the `mailbox.onboarding` state machine that gates live email processing. Staged-async per D-12: admin create and email connect are synchronous; sent-history ingest, persona extraction, and tuning-sample generation run as background n8n sub-workflows with progress streamed over WebSocket.
</objective>

<must_haves>
- `mailbox.onboarding` state machine transitions through all 6 D-16 stages: `pending_admin` → `pending_email` → `ingesting` → `pending_tuning` → `tuning_in_progress` → `live`
- Admin account creation at `POST /api/onboarding/admin` validates password >= 12 chars (per UI-SPEC), hashes with scrypt, writes to `onboarding.admin_username` / `admin_password_hash`, advances stage to `pending_email`
- `POST /api/onboarding/email` accepts either `{ oauth_code }` (Gmail OAuth2 callback) or `{ imap_host, imap_port, smtp_host, smtp_port, email, password }` (manual), stores the email address in `onboarding.email_address`, triggers the `06-rag-ingest-sent-history` sub-workflow, advances stage to `ingesting`
- `GET /api/onboarding/status` returns the current stage plus progress counters, streamed over WebSocket on every change
- A new n8n sub-workflow `12-tuning-sample-generate` produces 20 sample drafts over real inbound emails from the ingested corpus and writes them to a new `mailbox.tuning_samples` table (added to the schema via drizzle-kit push in this plan)
- `POST /api/tuning/ratings` accepts 20 ratings from the UI (good / wrong / edit) and advances stage to `live` when all 20 are rated (D-15)
- Approval queue routes: `GET /api/queue` (list pending, paginated), `GET /api/queue/:id` (detail), `POST /api/queue/:id/approve` (optional edit then send), `POST /api/queue/:id/reject`, `POST /api/queue/:id/retry` (re-run drafting)
- WebSocket events broadcast on queue changes (`queue.inserted`, `queue.updated`, `queue.removed`) and onboarding changes (`onboarding.stage`, `onboarding.progress`)
- **Live gate:** inbound emails are NOT drafted until `onboarding.stage = 'live'`. The gate is enforced in the classification sub-workflow by a short-circuit read of `mailbox.onboarding.stage`; if not live, the queue row is still inserted (for persona tuning samples) but no drafting subflow fires
- Document upload (ONBR-04) reuses the `/api/kb` routes from Plan 02-05
- Notification preferences (ONBR-06): a minimal `POST /api/onboarding/notifications` endpoint that writes `{ queue_threshold, digest_email }` to a new `mailbox.settings` table (added via drizzle-kit push)
</must_haves>

<threat_model>
**ASVS L1, block on HIGH.**

| Surface | Threat | Mitigation | Severity |
|---------|--------|------------|----------|
| Admin password at rest | Plaintext leak | Node `crypto.scryptSync` with a 16-byte random salt, stored as `salt:hash` in `admin_password_hash`; never log the plaintext | High → mitigated |
| Email account credentials on manual path | IMAP/SMTP passwords end up in Postgres | Store only the email *address* in `mailbox.onboarding`. Credentials are pasted into n8n credentials UI by the operator (stored in n8n's encrypted store); the manual POST body's credential fields are used only to TEST the connection on the server side, then discarded — never persisted | High → mitigated |
| Gmail OAuth2 refresh token | Leak via `/api/onboarding/email` response | Refresh token is exchanged server-side, stored in n8n credentials store, and NEVER returned in any API response | High → mitigated |
| Approval queue authorization | Any LAN user can approve/reject | Phase 2 inherits the Phase 1 LAN-only trust boundary (no auth) per STATE.md. Phase 4 adds admin login (DASH-02). Documented in SECURITY.md and on the `/api/queue` route as a banner response header `X-Mailbox-Security: lan-trust-phase-2` | High, deferred to Phase 4 |
| Unbounded `/api/queue` list | DoS via large pagination | Hard-cap `limit` at 100, default 25. Sort by `received_at DESC` with an indexed column (added in Plan 02-02) | Low → mitigated |
| WebSocket flood | Single client spam broadcasts | Phase 2: no per-client rate limit; documented as acceptable for single-operator appliance | Low, deferred |
| SQL injection via query params | Raw SQL concatenation | All SQL uses drizzle parameterized queries or `sql` template tag; no string concatenation | Medium → mitigated |

Phase-4-deferred items are called out explicitly so the phase 4 reviewer can pick them up.
</threat_model>

<tasks>

<task id="1">
<action>
Add two new tables to `dashboard/backend/src/db/schema.ts` — `tuning_samples` (for the 20 persona-tuning draft rows) and `settings` (for notification preferences). Append to the existing `schema.ts` file from Plan 02-02:

```ts
// ── 8. tuning_samples (D-15 — 20 draft samples for persona tuning) ─────────
export const tuningSamples = mailbox.table(
  'tuning_samples',
  {
    id: serial('id').primaryKey(),
    customerKey: varchar('customer_key', { length: 64 }).notNull().default('default'),
    emailRawId: integer('email_raw_id'),
    inboundFrom: varchar('inbound_from', { length: 320 }).notNull(),
    inboundSubject: text('inbound_subject'),
    inboundBody: text('inbound_body').notNull(),
    classificationCategory: classificationCategoryEnum('classification_category').notNull(),
    draftText: text('draft_text').notNull(),
    rating: varchar('rating', { length: 16 }),   // null until rated; 'good' | 'wrong' | 'edit'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    ratedAt: timestamp('rated_at', { withTimezone: true }),
  },
  (t) => ({
    idxCustomer: index('tuning_samples_customer_idx').on(t.customerKey),
  }),
);

// ── 9. settings (ONBR-06 notification preferences) ────────────────────────
export const settings = mailbox.table('settings', {
  id: serial('id').primaryKey(),
  customerKey: varchar('customer_key', { length: 64 }).notNull().default('default'),
  queueThreshold: integer('queue_threshold').notNull().default(5),
  digestEmail: varchar('digest_email', { length: 320 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqCustomer: uniqueIndex('settings_customer_key_uq').on(t.customerKey),
}));
```

Also add their type re-exports to `dashboard/backend/src/db/types.ts`:
```ts
export type TuningSample = InferSelectModel<typeof tuningSamples>;
export type NewTuningSample = InferInsertModel<typeof tuningSamples>;
export type Settings = InferSelectModel<typeof settings>;
export type NewSettings = InferInsertModel<typeof settings>;
```
</action>
<read_first>
  - dashboard/backend/src/db/schema.ts  (extend the existing file)
  - dashboard/backend/src/db/types.ts
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-15 tuning samples, ONBR-06)
</read_first>
<acceptance_criteria>
- `grep 'export const tuningSamples' dashboard/backend/src/db/schema.ts` matches
- `grep 'export const settings' dashboard/backend/src/db/schema.ts` matches
- `grep "rating: varchar" dashboard/backend/src/db/schema.ts` matches
- `grep 'queueThreshold' dashboard/backend/src/db/schema.ts` matches
- `grep 'TuningSample' dashboard/backend/src/db/types.ts` matches
- `grep 'Settings' dashboard/backend/src/db/types.ts` matches
</acceptance_criteria>
</task>

<task id="2">
<action>
**[BLOCKING]** Re-run `drizzle-kit push` to add the two new tables. Same pattern as Plan 02-02 task 5:

```bash
docker compose build dashboard
docker compose up -d dashboard
docker compose exec -T dashboard npx drizzle-kit push --force
```

Verify both new tables exist:

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema='mailbox' AND table_name IN ('tuning_samples','settings');
"
```
</action>
<read_first>
  - dashboard/backend/src/db/schema.ts
  - dashboard/drizzle.config.ts
</read_first>
<acceptance_criteria>
- `docker compose exec -T dashboard npx drizzle-kit push --force` exits 0
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='mailbox' AND table_name IN ('tuning_samples','settings');"` returns `2`
</acceptance_criteria>
</task>

<task id="3">
<action>
Create `dashboard/backend/src/auth/password.ts` — scrypt password hashing utilities:

```ts
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SALT_BYTES = 16;
const KEY_LEN = 64;
const N = 16384;   // scrypt cost — balanced for Jetson CPU

export function hashPassword(plain: string): string {
  if (typeof plain !== 'string' || plain.length < 12) throw new Error('password too short');
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plain, salt, KEY_LEN, { N });
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(plain, salt, KEY_LEN, { N });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```
</action>
<read_first>
  - .planning/phases/02-email-pipeline-core/02-UI-SPEC.md  (password ≥ 12 chars rule)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/auth/password.ts` exists
- `grep 'hashPassword' dashboard/backend/src/auth/password.ts` matches
- `grep 'verifyPassword' dashboard/backend/src/auth/password.ts` matches
- `grep 'scryptSync' dashboard/backend/src/auth/password.ts` matches
- `grep 'timingSafeEqual' dashboard/backend/src/auth/password.ts` matches
- `grep "plain.length < 12" dashboard/backend/src/auth/password.ts` matches
</acceptance_criteria>
</task>

<task id="4">
<action>
Create `dashboard/backend/src/live-gate.ts` — single-line helper the classification workflow's short-circuit reads to decide whether to fire drafting. For Plan 02-08 the gate is a SQL check called by the backend; n8n reads it via an HTTP round-trip to keep the logic centralised:

```ts
import { db } from './db/client.js';
import { onboarding } from './db/schema.js';
import { eq } from 'drizzle-orm';

export async function isLive(customerKey = 'default'): Promise<boolean> {
  const rows = await db.select({ stage: onboarding.stage }).from(onboarding).where(eq(onboarding.customerKey, customerKey));
  return rows[0]?.stage === 'live';
}
```

Expose it via a backend route in the onboarding router (task 5) as `GET /api/onboarding/live-gate` → `{ live: boolean }`. The classification workflow in Plan 02-04 will be **updated** in this plan's task 10 to call the gate before firing the drafting sub-workflows.
</action>
<read_first>
  - dashboard/backend/src/db/client.ts
  - dashboard/backend/src/db/schema.ts
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-13 live gate)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/live-gate.ts` exists
- `grep 'export async function isLive' dashboard/backend/src/live-gate.ts` matches
- `grep "stage === 'live'" dashboard/backend/src/live-gate.ts` matches
</acceptance_criteria>
</task>

<task id="5">
<action>
Create `dashboard/backend/src/routes/onboarding.ts` — onboarding API. Implements admin create, email connect (OAuth2 stub + manual), status, live-gate, notifications.

```ts
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { onboarding, settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../auth/password.js';
import { isLive } from '../live-gate.js';
import { broadcast } from '../ws.js';
import { config } from '../config.js';

export const onboardingRouter = Router();

const adminSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(12).max(256),
});

onboardingRouter.post('/admin', async (req, res) => {
  const parsed = adminSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { username, password } = parsed.data;
  const hash = hashPassword(password);

  const [row] = await db
    .update(onboarding)
    .set({ adminUsername: username, adminPasswordHash: hash, stage: 'pending_email' })
    .where(eq(onboarding.customerKey, 'default'))
    .returning();

  broadcast('onboarding.stage', { stage: row?.stage });
  res.json({ stage: row?.stage });
});

const emailSchema = z.object({
  email: z.string().email(),
  mode: z.enum(['oauth2', 'manual']).default('oauth2'),
  imap_host: z.string().optional(),
  imap_port: z.number().optional(),
  smtp_host: z.string().optional(),
  smtp_port: z.number().optional(),
});

onboardingRouter.post('/email', async (req, res) => {
  const parsed = emailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email } = parsed.data;

  // Credentials themselves are stored in n8n's credentials UI by the operator;
  // this route only records the email address and advances the stage.
  const [row] = await db
    .update(onboarding)
    .set({ emailAddress: email, stage: 'ingesting' })
    .where(eq(onboarding.customerKey, 'default'))
    .returning();

  // Trigger the 06-rag-ingest-sent-history sub-workflow via n8n webhook or CLI
  fetch(`${config.N8N_URL}/rest/workflows/run-by-name?name=06-rag-ingest-sent-history`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customer_key: 'default', months_back: 6 }),
  }).catch(() => { /* logged server-side; do not block response */ });

  broadcast('onboarding.stage', { stage: row?.stage });
  res.json({ stage: row?.stage });
});

onboardingRouter.get('/status', async (_req, res) => {
  const [row] = await db.select().from(onboarding).where(eq(onboarding.customerKey, 'default'));
  if (!row) return res.status(404).json({ error: 'onboarding row missing — run schema seed' });
  res.json(row);
});

onboardingRouter.get('/live-gate', async (_req, res) => {
  res.json({ live: await isLive() });
});

const notificationsSchema = z.object({
  queue_threshold: z.number().int().min(0).max(1000).default(5),
  digest_email: z.string().email().optional(),
});

onboardingRouter.post('/notifications', async (req, res) => {
  const parsed = notificationsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  await db.insert(settings).values({
    customerKey: 'default',
    queueThreshold: parsed.data.queue_threshold,
    digestEmail: parsed.data.digest_email ?? null,
  }).onConflictDoUpdate({
    target: settings.customerKey,
    set: {
      queueThreshold: parsed.data.queue_threshold,
      digestEmail: parsed.data.digest_email ?? null,
      updatedAt: new Date(),
    },
  });
  res.json({ ok: true });
});
```
</action>
<read_first>
  - dashboard/backend/src/auth/password.ts
  - dashboard/backend/src/live-gate.ts
  - dashboard/backend/src/db/schema.ts
  - dashboard/backend/src/ws.ts
  - dashboard/backend/src/config.ts
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-12..D-16, ONBR-01..06)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/routes/onboarding.ts` exists
- `grep "onboardingRouter.post('/admin'" dashboard/backend/src/routes/onboarding.ts` matches
- `grep "onboardingRouter.post('/email'" dashboard/backend/src/routes/onboarding.ts` matches
- `grep "onboardingRouter.get('/status'" dashboard/backend/src/routes/onboarding.ts` matches
- `grep "onboardingRouter.get('/live-gate'" dashboard/backend/src/routes/onboarding.ts` matches
- `grep "onboardingRouter.post('/notifications'" dashboard/backend/src/routes/onboarding.ts` matches
- `grep 'hashPassword' dashboard/backend/src/routes/onboarding.ts` matches
- `grep '06-rag-ingest-sent-history' dashboard/backend/src/routes/onboarding.ts` matches
- `grep 'broadcast' dashboard/backend/src/routes/onboarding.ts` matches (ws events fired)
</acceptance_criteria>
</task>

<task id="6">
<action>
Create `dashboard/backend/src/routes/queue.ts` — approval queue REST API:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { draftQueue } from '../db/schema.js';
import { eq, desc, and, inArray, sql } from 'drizzle-orm';
import { broadcast } from '../ws.js';
import { config } from '../config.js';

export const queueRouter = Router();

const listSchema = z.object({
  status: z.enum(['pending_review', 'awaiting_cloud', 'approved']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

queueRouter.get('/', async (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { status, limit, offset } = parsed.data;

  const rows = await db.select().from(draftQueue)
    .where(status ? eq(draftQueue.status, status) : undefined)
    .orderBy(desc(draftQueue.receivedAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = (await db.execute(sql`SELECT COUNT(*)::int AS count FROM mailbox.draft_queue ${status ? sql`WHERE status = ${status}` : sql``};`)).rows as Array<{ count: number }>;

  res
    .setHeader('X-Mailbox-Security', 'lan-trust-phase-2')
    .json({ items: rows, total: count, limit, offset });
});

queueRouter.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  const [row] = await db.select().from(draftQueue).where(eq(draftQueue.id, id));
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

const approveSchema = z.object({ draft_sent: z.string().optional() });

queueRouter.post('/:id/approve', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  const parsed = approveSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Set draft_sent (edit or copy draft_original) and flip status to 'approved'
  await db.execute(sql`
    UPDATE mailbox.draft_queue
       SET draft_sent = COALESCE(${parsed.data.draft_sent ?? null}, draft_original),
           status = 'approved'::mailbox.draft_queue_status,
           approved_at = NOW()
     WHERE id = ${id};
  `);

  // Fire-and-forget: trigger 11-send-smtp-sub via n8n HTTP API
  fetch(`${config.N8N_URL}/rest/workflows/run-by-name?name=11-send-smtp-sub`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draft_queue_id: id }),
  }).catch(() => {});

  broadcast('queue.updated', { id, status: 'approved' });
  res.json({ ok: true });
});

queueRouter.post('/:id/reject', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  fetch(`${config.N8N_URL}/rest/workflows/run-by-name?name=11-reject-sub`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draft_queue_id: id }),
  }).catch(() => {});
  broadcast('queue.removed', { id });
  res.json({ ok: true });
});

queueRouter.post('/:id/retry', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  await db.execute(sql`
    UPDATE mailbox.draft_queue SET draft_original = NULL, status = 'awaiting_cloud'::mailbox.draft_queue_status WHERE id = ${id};
  `);
  broadcast('queue.updated', { id, status: 'awaiting_cloud' });
  res.json({ ok: true });
});
```
</action>
<read_first>
  - dashboard/backend/src/db/schema.ts
  - dashboard/backend/src/ws.ts
  - dashboard/backend/src/config.ts
  - .planning/phases/02-email-pipeline-core/02-UI-SPEC.md  (API shape expectations)
  - .planning/REQUIREMENTS.md  (APPR-01, APPR-02)
  - n8n/workflows/11-send-smtp-sub.json  (workflow name contract)
  - n8n/workflows/11b-reject-sub.json
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/routes/queue.ts` exists
- `grep "queueRouter.get('/'" dashboard/backend/src/routes/queue.ts` matches
- `grep "queueRouter.post('/:id/approve'" dashboard/backend/src/routes/queue.ts` matches
- `grep "queueRouter.post('/:id/reject'" dashboard/backend/src/routes/queue.ts` matches
- `grep "queueRouter.post('/:id/retry'" dashboard/backend/src/routes/queue.ts` matches
- `grep '11-send-smtp-sub' dashboard/backend/src/routes/queue.ts` matches
- `grep '11-reject-sub' dashboard/backend/src/routes/queue.ts` matches
- `grep 'X-Mailbox-Security' dashboard/backend/src/routes/queue.ts` matches
- `grep 'broadcast' dashboard/backend/src/routes/queue.ts` matches
</acceptance_criteria>
</task>

<task id="7">
<action>
Create `dashboard/backend/src/routes/tuning.ts` — persona tuning session API:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { tuningSamples, onboarding } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { broadcast } from '../ws.js';

export const tuningRouter = Router();

tuningRouter.get('/samples', async (_req, res) => {
  const rows = await db.select().from(tuningSamples).where(eq(tuningSamples.customerKey, 'default')).orderBy(tuningSamples.id);
  res.json({ samples: rows, rated: rows.filter((r) => r.rating).length, total: rows.length });
});

const rateSchema = z.object({
  ratings: z.array(z.object({
    id: z.number().int(),
    rating: z.enum(['good', 'wrong', 'edit']),
  })).min(1).max(20),
});

tuningRouter.post('/ratings', async (req, res) => {
  const parsed = rateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  for (const r of parsed.data.ratings) {
    await db.execute(sql`
      UPDATE mailbox.tuning_samples
         SET rating = ${r.rating}, rated_at = NOW()
       WHERE id = ${r.id} AND customer_key = 'default';
    `);
  }

  // If all samples are rated, advance onboarding.stage to 'live'
  const [{ total, rated }] = (await db.execute(sql`
    SELECT COUNT(*)::int AS total, COUNT(rating)::int AS rated FROM mailbox.tuning_samples WHERE customer_key = 'default';
  `)).rows as Array<{ total: number; rated: number }>;

  let stage: string | undefined;
  if (total > 0 && rated >= total && rated >= 20) {
    const [row] = await db
      .update(onboarding)
      .set({ stage: 'live', livedAt: new Date() })
      .where(eq(onboarding.customerKey, 'default'))
      .returning();
    stage = row?.stage;
    broadcast('onboarding.stage', { stage });
  }
  res.json({ rated, total, stage });
});
```

Wire all three new routers plus the drafting router from Plan 02-07 into `dashboard/backend/src/index.ts`:

```ts
import { onboardingRouter } from './routes/onboarding.js';
import { queueRouter } from './routes/queue.js';
import { tuningRouter } from './routes/tuning.js';
// ...
app.use('/api/onboarding', onboardingRouter);
app.use('/api/queue', queueRouter);
app.use('/api/tuning', tuningRouter);
```
</action>
<read_first>
  - dashboard/backend/src/db/schema.ts
  - dashboard/backend/src/ws.ts
  - dashboard/backend/src/index.ts
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-13, D-15)
  - .planning/REQUIREMENTS.md  (PERS-02, ONBR-05)
</read_first>
<acceptance_criteria>
- `dashboard/backend/src/routes/tuning.ts` exists
- `grep "tuningRouter.get('/samples'" dashboard/backend/src/routes/tuning.ts` matches
- `grep "tuningRouter.post('/ratings'" dashboard/backend/src/routes/tuning.ts` matches
- `grep "stage: 'live'" dashboard/backend/src/routes/tuning.ts` matches
- `grep '/api/onboarding' dashboard/backend/src/index.ts` matches
- `grep '/api/queue' dashboard/backend/src/index.ts` matches
- `grep '/api/tuning' dashboard/backend/src/index.ts` matches
</acceptance_criteria>
</task>

<task id="8">
<action>
Create `n8n/workflows/12-tuning-sample-generate.json` — generates the 20 persona tuning samples. Triggered by the onboarding flow after persona extraction (plan 02-06 task 5's `09-persona-extract-trigger` ends by calling this). Node graph:

1. **Execute Workflow Trigger** — no inputs; reads `customer_key='default'` state.
2. **Postgres Query: Pick 20 real inbound emails from the ingested corpus** balanced across categories:
   ```sql
   WITH ranked AS (
     SELECT er.id, er.from_addr, er.subject, er.body_text, cl.category,
            ROW_NUMBER() OVER (PARTITION BY cl.category ORDER BY er.received_at DESC) AS rn
     FROM mailbox.email_raw er
     JOIN mailbox.classification_log cl ON cl.email_raw_id = er.id
     WHERE cl.category NOT IN ('spam_marketing')
   )
   SELECT id, from_addr, subject, body_text, category FROM ranked
   WHERE rn <= 4    -- up to 4 per category across 7 allowed = 28 headroom
   ORDER BY category
   LIMIT 20;
   ```
3. **Postgres: Update onboarding.stage = tuning_in_progress** and `tuning_sample_count = <count>`.
4. **Loop Over Items:** for each selected inbound email:
   a. **HTTP Request: Get drafting context** — `GET http://dashboard:3000/api/drafting/context?draft_queue_id=<synthetic>` → but since the rows aren't in `draft_queue`, call a thin helper endpoint instead: `POST http://dashboard:3000/api/tuning/generate-sample` with `{ email_raw_id: $json.id }`. (Add this helper in task 9 below.)
   b. **Postgres Insert into `mailbox.tuning_samples`** — from the helper's response payload.
5. **Postgres: Update onboarding.tuning_sample_count** with the final count.
6. **Postgres: Leave stage at `tuning_in_progress`** — transition to `live` happens in `POST /api/tuning/ratings` once all 20 are rated.

Workflow JSON shape:
```json
{
  "name": "12-tuning-sample-generate",
  "active": false,
  "tags": [{"name":"phase-2"}, {"name":"onboarding"}, {"name":"persona"}]
}
```
</action>
<read_first>
  - dashboard/backend/src/db/schema.ts  (tuning_samples)
  - dashboard/backend/src/routes/tuning.ts
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-15)
</read_first>
<acceptance_criteria>
- `n8n/workflows/12-tuning-sample-generate.json` exists and is valid JSON
- `jq -r '.name' n8n/workflows/12-tuning-sample-generate.json` returns `12-tuning-sample-generate`
- `grep 'tuning_samples' n8n/workflows/12-tuning-sample-generate.json` matches
- `grep 'tuning_in_progress' n8n/workflows/12-tuning-sample-generate.json` matches
- `grep 'classification_log' n8n/workflows/12-tuning-sample-generate.json` matches
</acceptance_criteria>
</task>

<task id="9">
<action>
Add a helper endpoint `POST /api/tuning/generate-sample` to `dashboard/backend/src/routes/tuning.ts` that the `12-tuning-sample-generate` workflow calls to produce one draft against an `email_raw` row without going through the classification pipeline. It reuses the drafting context builder and writes directly into `tuning_samples`:

```ts
// Append to tuning.ts
import { topRagRefs } from '../drafting/rag-snippet.js';
import { renderSystemPrompt, renderUserPrompt } from '../drafting/prompt.js';
import { persona } from '../db/schema.js';

tuningRouter.post('/generate-sample', async (req, res) => {
  const { email_raw_id } = req.body || {};
  const id = Number(email_raw_id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'email_raw_id required' });

  const [email] = (await db.execute(sql`
    SELECT er.id, er.from_addr, er.subject, er.body_text, cl.category
    FROM mailbox.email_raw er
    JOIN mailbox.classification_log cl ON cl.email_raw_id = er.id
    WHERE er.id = ${id};
  `)).rows as any[];
  if (!email) return res.status(404).json({ error: 'email_raw not found' });

  const [p] = await db.select().from(persona).where(eq(persona.customerKey, 'default'));
  if (!p) return res.status(409).json({ error: 'persona not built yet' });
  const exemplars = (p.categoryExemplars as any)?.[email.category] || [];
  const refs = await topRagRefs(`${email.subject} ${email.body_text}`.slice(0, 2000), 3);

  const system = renderSystemPrompt({
    persona_markers: p.statisticalMarkers as any,
    category_exemplars: exemplars,
    rag_refs: refs,
    inbound_email: { from: email.from_addr, subject: email.subject, body: email.body_text || '' },
  });
  const user = renderUserPrompt({
    persona_markers: p.statisticalMarkers as any,
    category_exemplars: exemplars,
    rag_refs: refs,
    inbound_email: { from: email.from_addr, subject: email.subject, body: email.body_text || '' },
  });

  // Use local Qwen3 for tuning samples (faster + zero cloud cost for onboarding)
  const ollamaUrl = process.env.OLLAMA_URL || 'http://ollama:11434';
  const ollamaRes = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3:4b', stream: false, system, prompt: user, options: { temperature: 0.3, num_predict: 1024 } }),
  });
  const ollamaJson = (await ollamaRes.json()) as { response?: string };
  const draft = String(ollamaJson.response || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  const [inserted] = await db.insert(tuningSamples).values({
    customerKey: 'default',
    emailRawId: email.id,
    inboundFrom: email.from_addr,
    inboundSubject: email.subject,
    inboundBody: email.body_text || '',
    classificationCategory: email.category,
    draftText: draft,
  }).returning();

  res.json(inserted);
});
```
</action>
<read_first>
  - dashboard/backend/src/routes/tuning.ts  (extend existing file)
  - dashboard/backend/src/drafting/prompt.ts
  - dashboard/backend/src/drafting/rag-snippet.ts
  - dashboard/backend/src/db/schema.ts
</read_first>
<acceptance_criteria>
- `grep "tuningRouter.post('/generate-sample'" dashboard/backend/src/routes/tuning.ts` matches
- `grep 'renderSystemPrompt' dashboard/backend/src/routes/tuning.ts` matches
- `grep "'qwen3:4b'" dashboard/backend/src/routes/tuning.ts` matches
- `grep 'tuningSamples' dashboard/backend/src/routes/tuning.ts` matches
</acceptance_criteria>
</task>

<task id="10">
<action>
Update `n8n/workflows/03-classify-email-sub.json` from Plan 02-04 to enforce the live gate BEFORE firing `04-draft-local-sub` / `05-draft-cloud-sub`. Insert a new node between "Determine Routing" and the drafting Execute Workflow branches:

- **HTTP Request: Live Gate** — `GET http://dashboard:3000/api/onboarding/live-gate` → `{ live: boolean }`.
- **IF !live** — skip drafting (workflow ends with the queue row already inserted — it will show in the dashboard with `draft_original = NULL` and `status = 'pending_review'`, but no drafting fires; during onboarding this is the expected state).
- **IF live** — proceed to the existing routing decision and drafting branches.

Re-import the updated workflow:
```bash
./scripts/n8n-import-workflows.sh
MAIN=$(docker compose exec -T n8n n8n list:workflow | awk '/01-email-pipeline-main/ {print $1}')
SUB=$(docker compose exec -T n8n n8n list:workflow | awk '/03-classify-email-sub/ {print $1}')
docker compose exec -T n8n n8n update:workflow --active=true --id="$MAIN"
docker compose exec -T n8n n8n update:workflow --active=true --id="$SUB"
```
</action>
<read_first>
  - n8n/workflows/03-classify-email-sub.json  (edit existing file)
  - dashboard/backend/src/routes/onboarding.ts  (live-gate contract)
</read_first>
<acceptance_criteria>
- `grep '/api/onboarding/live-gate' n8n/workflows/03-classify-email-sub.json` matches
- The updated workflow JSON still parses: `jq . n8n/workflows/03-classify-email-sub.json > /dev/null`
- Re-import succeeds: `docker compose exec -T n8n n8n list:workflow | grep -c '03-classify-email-sub'` returns at least `1`
</acceptance_criteria>
</task>

<task id="11">
<action>
End-to-end onboarding smoke test — drive the state machine through every stage programmatically, since Phase 2 has no UI.

```bash
# Rebuild dashboard with new routes
docker compose build dashboard
docker compose up -d dashboard

# Reset onboarding row
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  UPDATE mailbox.onboarding SET stage='pending_admin', admin_username=NULL, admin_password_hash=NULL,
         email_address=NULL, ingest_progress_total=NULL, ingest_progress_done=0, tuning_sample_count=0, tuning_rated_count=0
  WHERE customer_key='default';
  DELETE FROM mailbox.tuning_samples WHERE customer_key='default';
"

# Stage 1: admin
curl -fsS -X POST http://localhost:3000/api/onboarding/admin \
  -H 'content-type: application/json' \
  -d '{"username":"dustin","password":"heronlabs-phase2-ok"}' | jq .

# Stage 2: email connect (stub the OAuth side — creds are pasted into n8n UI separately)
curl -fsS -X POST http://localhost:3000/api/onboarding/email \
  -H 'content-type: application/json' \
  -d '{"email":"dustin@heronlabs.example","mode":"oauth2"}' | jq .

# Wait for ingest to finish (seeded by earlier plans' sent_history or run 06-rag-ingest-sent-history manually)
# For smoke, skip to persona extract manually:
curl -fsS -X POST http://localhost:3000/api/persona/extract | jq .

# Generate 20 tuning samples (normally invoked by 12-tuning-sample-generate after 09-persona-extract-trigger fires)
# For smoke, call the helper endpoint directly for 20 arbitrary email_raw_ids:
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT er.id FROM mailbox.email_raw er
  JOIN mailbox.classification_log cl ON cl.email_raw_id = er.id
  WHERE cl.category != 'spam_marketing' LIMIT 20;
" | while read id; do
  [ -z "$id" ] && continue
  curl -fsS -X POST http://localhost:3000/api/tuning/generate-sample \
    -H 'content-type: application/json' \
    -d "{\"email_raw_id\": $id}" > /dev/null || echo "skip $id"
done

# Check tuning samples
curl -fsS http://localhost:3000/api/tuning/samples | jq '.rated, .total'

# Rate all samples as 'good' (simulate operator)
SAMPLES=$(curl -fsS http://localhost:3000/api/tuning/samples | jq -c '{ratings: [.samples[] | {id: .id, rating: "good"}]}')
curl -fsS -X POST http://localhost:3000/api/tuning/ratings -H 'content-type: application/json' -d "$SAMPLES" | jq .

# Final stage check — must be 'live'
curl -fsS http://localhost:3000/api/onboarding/status | jq .stage
# Expected: "live"

# Live gate open
curl -fsS http://localhost:3000/api/onboarding/live-gate | jq .
# Expected: {"live": true}
```
</action>
<read_first>
  - dashboard/backend/src/routes/onboarding.ts
  - dashboard/backend/src/routes/tuning.ts
  - dashboard/backend/src/routes/queue.ts
</read_first>
<acceptance_criteria>
- After admin POST: `curl -fsS http://localhost:3000/api/onboarding/status | jq -r .stage` returns `pending_email`
- After email POST: stage is `ingesting` (or later if ingest completes quickly)
- After persona extract + 20 sample generations: `curl -fsS http://localhost:3000/api/tuning/samples | jq -r '.total'` returns `20`
- After rating all 20: `curl -fsS http://localhost:3000/api/onboarding/status | jq -r .stage` returns `live`
- `curl -fsS http://localhost:3000/api/onboarding/live-gate | jq -r .live` returns `true`
- `curl -fsS http://localhost:3000/api/queue | jq -e '.items, .total, .limit, .offset'` does not fail
- Queue response header includes `X-Mailbox-Security: lan-trust-phase-2`: `curl -fsS -D - http://localhost:3000/api/queue -o /dev/null | grep -i 'X-Mailbox-Security'`
</acceptance_criteria>
</task>

<task id="12">
<action>
Final phase goal check: send a real email to the dogfood inbox, confirm it appears in `/api/queue` within 90s with a filled draft_original, approve it via `/api/queue/:id/approve`, confirm the reply actually arrives at the sender's address and the row lands in `sent_history`.

```bash
# Operator action: send email from another Gmail account to dogfood inbox with:
#   Subject: "Phase 2 end-to-end test — reorder"
#   Body: "Hi Dustin, please ship 24 cases of your Original sauce to our Portland warehouse, same PO template as last month."

# Wait up to 120s for pipeline
for i in $(seq 1 12); do
  ROW=$(curl -fsS 'http://localhost:3000/api/queue?limit=1' | jq -r '.items[0] | {id, status, has_draft: (.draft_original != null), category: .classification_category}')
  echo "[$i] $ROW"
  if [ "$(echo "$ROW" | jq -r '.has_draft')" = 'true' ]; then break; fi
  sleep 10
done

ID=$(curl -fsS 'http://localhost:3000/api/queue?limit=1' | jq -r '.items[0].id')

# Approve
curl -fsS -X POST "http://localhost:3000/api/queue/$ID/approve" -H 'content-type: application/json' -d '{}' | jq .

# Confirm row moved to sent_history
sleep 10
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT COUNT(*) FROM mailbox.sent_history WHERE draft_queue_id = $ID;
  SELECT COUNT(*) FROM mailbox.draft_queue WHERE id = $ID;
"
# Expected: 1 sent_history, 0 draft_queue
```
</action>
<read_first>
  - dashboard/backend/src/routes/queue.ts
  - n8n/workflows/11-send-smtp-sub.json
</read_first>
<acceptance_criteria>
- After real test email send + wait: the top queue row has `status='pending_review'` and non-null `draft_original`
- After approve: `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT COUNT(*) FROM mailbox.sent_history WHERE draft_queue_id = <ID>;"` returns `1`
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT COUNT(*) FROM mailbox.draft_queue WHERE id = <ID>;"` returns `0`
- The original sender receives the reply in their inbox (manual verification)
</acceptance_criteria>
</task>

</tasks>

<verification>
```bash
# 1. All 6 onboarding stages representable and transitioning
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT unnest(enum_range(NULL::mailbox.onboarding_stage))::text;
" | sort | tr '\n' ' ' | grep -q 'ingesting live pending_admin pending_email pending_tuning tuning_in_progress'

# 2. Onboarding API round-trips
curl -fsS http://localhost:3000/api/onboarding/status | jq -e '.stage' > /dev/null
curl -fsS http://localhost:3000/api/onboarding/live-gate | jq -e '.live != null' > /dev/null

# 3. Queue API shape
curl -fsS 'http://localhost:3000/api/queue?limit=5' | jq -e '.items | type == "array"' > /dev/null
curl -fsS -D - 'http://localhost:3000/api/queue?limit=1' -o /dev/null | grep -iq 'X-Mailbox-Security: lan-trust-phase-2'

# 4. Tuning API shape
curl -fsS http://localhost:3000/api/tuning/samples | jq -e '.total != null and .rated != null' > /dev/null

# 5. WebSocket emits queue.updated on approve (manual test via websocat)
# websocat ws://localhost:3000/api/ws  → listen while curling /api/queue/:id/approve

# 6. End-to-end phase-goal check: a real inbound email → drafted → approved → sent from customer address → in sent_history (task 12)

# 7. Schema push result: 9 tables total now in mailbox schema
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema='mailbox'
    AND table_name IN ('email_raw','classification_log','draft_queue','sent_history','rejected_history','persona','onboarding','tuning_samples','settings');
" | grep -q '^9$'

# 8. Live gate enforcement: pre-live state doesn't fire drafting
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE mailbox.onboarding SET stage='pending_tuning' WHERE customer_key='default';"
# Send an email; observe classification_log row created but no draft_original populated on the new draft_queue row
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE mailbox.onboarding SET stage='live' WHERE customer_key='default';"
```
</verification>
