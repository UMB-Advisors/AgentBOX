---
phase: quick-260520-ulr
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - dashboard/lib/classification/preclass.ts
  - dashboard/lib/classification/normalize.ts
  - dashboard/lib/classification/thread-ownership.ts
  - dashboard/app/api/internal/classification-normalize/route.ts
  - dashboard/lib/schemas/internal.ts
  - dashboard/test/classification/operator-self-loop.test.ts
  - dashboard/test/classification/thread-ownership.test.ts
autonomous: true
requirements: [UMB-153, UMB-154]
must_haves:
  truths:
    - "An operator outbound that loops back as inbound (from operator-domain, to NON-operator) produces NO draft"
    - "A legitimate internal op1@domain → op2@domain email STILL produces a draft"
    - "An inbound on a thread where an operator-domain address replied within the last 24h produces NO draft"
    - "An inbound on a thread whose last operator reply was >24h ago STILL produces a draft (lapsed thread)"
    - "An inbound on a thread the operator never touched STILL produces a draft"
    - "Both suppressions record WHY (self_loop / operator_owns_thread) and are observable, distinct from spam"
  artifacts:
    - path: "dashboard/lib/classification/preclass.ts"
      provides: "Synchronous self-loop guard (UMB-153) reusing OPERATOR_DOMAINS matcher"
      contains: "precheckSelfLoop"
    - path: "dashboard/lib/classification/thread-ownership.ts"
      provides: "Async operator-owns-thread guard (UMB-154) over sent_history/inbox_messages"
      contains: "operatorOwnsThread"
    - path: "dashboard/test/classification/operator-self-loop.test.ts"
      provides: "Positive + negative unit coverage for UMB-153"
    - path: "dashboard/test/classification/thread-ownership.test.ts"
      provides: "Positive + negative (lapsed >24h, untouched, op-still-active) coverage for UMB-154"
  key_links:
    - from: "dashboard/lib/classification/normalize.ts:applyPreclass"
      to: "precl.precheckSelfLoop"
      via: "synchronous preclass chain"
      pattern: "precheckSelfLoop"
    - from: "dashboard/app/api/internal/classification-normalize/route.ts"
      to: "thread-ownership.operatorOwnsThread"
      via: "async post-normalize override when thread_id present"
      pattern: "operatorOwnsThread"
---

<objective>
Add two pre-draft guards to the operator-domain gate so the live M1 appliance stops generating role-confused / noise drafts on (a) the operator's own outbound looping back as inbound and (b) threads an operator is already actively turn-taking on.

Purpose: Two live M1 false-drafts (draft 154 self-loop, draft 158 operator-already-replied) produced bad replies in the customer queue. Both guards are narrow `drop`-equivalent suppressions layered onto the existing DR-50 operator-domain preclass — NOT a removal of the `internal` category.
Output: One synchronous guard (UMB-153, no DB) extending preclass.ts, one async thread-state guard (UMB-154, DB-backed) in a new module, both wired through the classification-normalize path, with full unit coverage including the negative cases that protect legitimate drafts.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@dashboard/CLAUDE.md

<interfaces>
<!-- Extracted from the codebase. Use these directly — no exploration needed. -->

The single source of truth for "what is an operator domain" (REUSE — do NOT introduce a second):
From dashboard/lib/classification/preclass.ts:
```typescript
export const OPERATOR_DOMAINS: ReadonlyArray<string>;      // default: ['heronlabsinc.com']
export const OPERATOR_ALLOWLIST: ReadonlyArray<string>;    // full addresses
export const OPERATOR_INBOX_EXCEPTIONS: ReadonlyArray<string>; // default: ['sales@heronlabsinc.com']
export interface PreclassContext { from?: string; to?: string }
export interface PreclassResult {
  category: Category;
  confidence: number;
  source: 'operator-domain' | 'operator-allowlist' | 'noreply-pattern';
}
export function precheck(ctx: PreclassContext): PreclassResult | null;       // operator-domain → internal
export function precheckNoReply(ctx: PreclassContext): PreclassResult | null; // noreply → spam_marketing
// INTERNAL HELPERS — extractAddress(raw) strips "Name <addr>" → lowercased addr;
// extractDomain(addr) → lowercased domain. These are file-private today; the new
// self-loop guard needs them, so EXPORT them (do not duplicate the parsing logic).
```

The drop mechanism (REUSE — locked decision #4):
From dashboard/lib/classification/prompt.ts:
```typescript
export type Route = 'local' | 'cloud' | 'drop';
export function routeFor(category: Category, confidence: number): Route {
  if (category === 'spam_marketing') return 'drop'; // ← only category that drops
  if (confidence < LOCAL_CONFIDENCE_FLOOR) return 'cloud';
  if (LOCAL_CATEGORIES.includes(category)) return 'local';
  return 'cloud';
}
```
n8n MailBOX-Classify `Drop Spam?` IF node keys on `category === 'spam_marketing'` (NOT on `.route`).
`.route` is computed by normalize but NOT read by any n8n node (grep-confirmed: 0 references).
=> Forcing `category='spam_marketing'` is the existing drop path. It (a) makes routeFor return 'drop'
   AND (b) trips the existing n8n gate with ZERO workflow-JSON edits and ZERO migrations.

From dashboard/lib/classification/normalize.ts (the wiring point):
```typescript
export interface ClassificationResult {
  category: Category; confidence: number; route: Route;
  json_parse_ok: boolean; think_stripped: boolean; raw_output: string;
  preclass_applied: boolean;
  preclass_source: 'operator-domain' | 'operator-allowlist' | 'noreply-pattern' | null;
}
export function normalizeClassifierOutput(raw: string, ctx: PreclassContext = {}): ClassificationResult;
// applyPreclass() runs: precheckNoReply(ctx) ?? precheck(ctx), then routeFor() last.
```

normalize route already plumbs from + to (n8n Normalize node sends both from Load Inbox Row):
From dashboard/lib/schemas/internal.ts:
```typescript
export const classificationNormalizeBodySchema = z.object({
  raw: z.string().optional().default(''),
  from: z.string().optional(),
  to: z.string().optional(),
});
```

Thread-state source columns (verified present in test/fixtures/schema.sql):
```sql
mailbox.sent_history   (from_addr text NOT NULL, to_addr text NOT NULL, thread_id text, sent_at timestamptz NOT NULL, ...)
mailbox.inbox_messages (message_id text NOT NULL, thread_id text, from_addr text, to_addr text, received_at timestamptz, ...)
```
sent_history = canonical "operator's prior sends in this thread". A DB-backed reference for the
same UNION pattern exists in dashboard/lib/drafting/thread-history.ts:getThreadHistory (read it for
the kysely `sql` template + fail-closed style, but the new guard needs only the most-recent operator
reply timestamp, not full bodies).

Vitest: `npm test` (dashboard cwd) = `vitest run`. include globs cover test/**/*.test.ts.
DB-backed tests skip without TEST_POSTGRES_URL. Pure-logic tests run everywhere.
Existing test to mirror: dashboard/test/classification/preclass.test.ts (env save/restore in afterEach).
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1 (UMB-153): synchronous operator self-loop guard</name>
  <files>dashboard/lib/classification/preclass.ts, dashboard/lib/classification/normalize.ts, dashboard/test/classification/operator-self-loop.test.ts</files>
  <behavior>
    precheckSelfLoop(ctx) — pure, no DB. Reuses extractAddress/extractDomain/OPERATOR_* from preclass.ts.
    - from on operator-domain AND to NOT on operator-domain → returns suppression (the looped-back outbound). Examples that MUST suppress:
        from=jt@heronlabsinc.com,   to=shabegsh@gmail.com        (the live draft-154 case)
    - from on operator-domain AND to ALSO on operator-domain → returns null (legit internal op1→op2 MUST still draft):
        from=op1@heronlabsinc.com,  to=op2@heronlabsinc.com      → null
    - from NOT on operator-domain → returns null (normal inbound):
        from=customer@gmail.com,    to=jt@heronlabsinc.com       → null
    - OPERATOR_INBOX_EXCEPTIONS (sales@) as `from` → returns null (don't suppress role-inbox mail).
    - OPERATOR_ALLOWLIST `from` is treated as operator-domain for the from-side test.
    - "Name <addr>" headers in both from and to are parsed (reuse extractAddress).
    - missing/empty from OR missing/empty to → returns null (cannot prove a self-loop; fail OPEN so we never suppress a legit draft on incomplete data).
    Wiring in normalize.ts applyPreclass: chain order is precheckNoReply → precheck (operator-domain) → THEN, only if the operator-domain hit fired (i.e. from is operator), evaluate precheckSelfLoop to decide drop. Net result for a self-loop: category forced to 'spam_marketing' so routeFor→'drop' AND the existing n8n Drop Spam? gate fires. preclass_source set to a NEW value 'operator-self-loop'; ALSO set a new field suppression_reason='self_loop' (see Task 3 for the field). raw_output (original LLM verdict + true category) is preserved for forensics.
    NEGATIVE wiring test: normalizeClassifierOutput for op1→op2 internal stays category='internal', route='local'.
  </behavior>
  <action>
    In dashboard/lib/classification/preclass.ts:
    1. Export the currently-private `extractAddress` and `extractDomain` (add `export`) — the self-loop guard MUST reuse them; do NOT re-implement address parsing (locked decision #1: one source of truth).
    2. Add `precheckSelfLoop(ctx: PreclassContext): PreclassResult | null`. An address counts as operator-side if it is in OPERATOR_ALLOWLIST OR its domain is in OPERATOR_DOMAINS. Logic: if from is operator-side AND to is present AND to is NOT operator-side → return `{ category: 'spam_marketing', confidence: 1, source: 'operator-self-loop' }`. Apply OPERATOR_INBOX_EXCEPTIONS to the `from` address first (exception `from` → return null, mirroring precheck). Any missing/empty from or to → return null. Add a kill-switch env `OPERATOR_SELF_LOOP_DISABLE === '1'` → return null (mirror NOREPLY_PRECLASS_DISABLE).
    3. Widen the `PreclassResult.source` union to add `'operator-self-loop'`. Add a shared helper `isOperatorAddress(addr: string): boolean` and use it in both precheck and precheckSelfLoop so the domain/allowlist rule has exactly one definition.
    In dashboard/lib/classification/normalize.ts:
    4. In applyPreclass, after the existing `precheckNoReply(ctx) ?? precheck(ctx)`, add: if no noreply/operator hit OR the operator-domain hit fired, evaluate `precheckSelfLoop(ctx)`; if it returns a hit, use it (category→spam_marketing, preclass_applied=true, preclass_source='operator-self-loop'). Self-loop must take precedence over the operator-domain→internal override (a self-loop IS on the operator domain, so precheck would otherwise route it internal→local→draft). Order: noreply → self-loop → operator-domain. Keep routeFor computed last.
    Widen ClassificationResult.preclass_source union to include 'operator-self-loop'.
    Write dashboard/test/classification/operator-self-loop.test.ts mirroring preclass.test.ts structure (afterEach env restore). Cover every bullet in <behavior>, both precheckSelfLoop directly AND the normalizeClassifierOutput wiring (positive drop + negative op1→op2 stays internal/local + negative normal-inbound stays as-classified).
  </action>
  <verify>
    <automated>cd dashboard && npx vitest run test/classification/operator-self-loop.test.ts</automated>
  </verify>
  <done>precheckSelfLoop suppresses from-operator/to-external (draft-154 case) to spam_marketing/drop; op1→op2 internal and customer→operator inbound both still draft; extractAddress/extractDomain reused (not duplicated); kill switch works; all assertions green.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2 (UMB-154): operator-owns-thread guard (DB-backed)</name>
  <files>dashboard/lib/classification/thread-ownership.ts, dashboard/test/classification/thread-ownership.test.ts</files>
  <behavior>
    operatorOwnsThread(opts: { thread_id, current_to, now? }): Promise<{ owned: boolean; reason: string; last_operator_reply_at?: string }>.
    "Owned" = an operator-domain address sent a message in this thread within the active window (default 24h). Source: most-recent operator-domain message in the thread across mailbox.sent_history (outbound, from_addr operator-side) UNION the operator-domain rows of mailbox.inbox_messages (covers the self-loop'd operator messages that landed as inbound). Key on "ANY operator-domain address actively replying", per ticket — not specifically matching current_to.
    Cases (DB-backed, gated on TEST_POSTGRES_URL):
    - last operator-domain message in thread is 1h ago → owned:true, reason:'operator_owns_thread' (the live draft-158 case: jt@ replied, then shabegsh@ sent "Got it - thanks!").
    - last operator-domain message in thread is 26h ago → owned:false, reason:'lapsed' (>24h = lapsed → drafting allowed again).
    - thread has only counterparty messages, operator never replied → owned:false, reason:'no_operator_msg'.
    - thread_id null/empty → owned:false, reason:'no_thread_id' (fail OPEN — can't prove ownership).
    - DB error → owned:false, reason:'db_unavailable' (fail OPEN — never suppress a legit draft on infra failure; mirror getThreadHistory).
    Window is env-tunable: OPERATOR_THREAD_WINDOW_HOURS (default 24). Kill switch OPERATOR_THREAD_GUARD_DISABLE==='1' → owned:false, reason:'disabled'.
    `now` param injectable so tests can pin the clock against fixture timestamps.
  </behavior>
  <action>
    Create dashboard/lib/classification/thread-ownership.ts. Import getKysely + sql from kysely/db (mirror thread-history.ts). Import isOperatorAddress/extractAddress from preclass.ts (Task 1 exports). Query: select the MAX(ts) over the union of (a) sent_history rows where thread_id matches AND from_addr is operator-side, and (b) inbox_messages rows where thread_id matches AND from_addr is operator-side — operator-side filter done in SQL via `lower(from_addr)` domain/allowlist check OR fetch candidate from_addr+ts rows and filter in TS with isOperatorAddress (TS-side is simpler and keeps the operator-domain definition single-sourced — prefer this: SELECT from_addr, GREATEST timestamps with a small LIMIT, filter in TS). Compute owned = (most-recent operator-side message exists) AND (now - that ts <= window). Fail OPEN on every uncertain branch. Parameterize all SQL (no string concat). Add the env knobs + kill switch.
    Write dashboard/test/classification/thread-ownership.test.ts. Use the existing DB-backed test pattern (describe.skipIf(!process.env.TEST_POSTGRES_URL) — check test/routes/*.test.ts for the exact helper). Seed inbox_messages/sent_history fixtures per case, pin `now` to make the 1h vs 26h window deterministic. MUST include all five <behavior> cases — the lapsed(>24h), no-operator-msg, and null-thread negative cases are as load-bearing as the positive (they protect legitimate customer drafts). Also add a pure-logic unit (no DB) for the kill switch + null-thread fail-open branches so coverage exists even when TEST_POSTGRES_URL is unset.
  </action>
  <verify>
    <automated>cd dashboard && npx vitest run test/classification/thread-ownership.test.ts</automated>
  </verify>
  <done>operatorOwnsThread returns owned:true within window (draft-158 case), owned:false for >24h lapsed / never-replied / null-thread / db-error; window + kill switch env-tunable; SQL parameterized; operator-domain definition reused from preclass (no second matcher). DB-backed cases pass with TEST_POSTGRES_URL, pure cases pass without.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: wire thread-ownership into the normalize route + surface suppression_reason</name>
  <files>dashboard/app/api/internal/classification-normalize/route.ts, dashboard/lib/classification/normalize.ts, dashboard/lib/schemas/internal.ts, dashboard/lib/classification/thread-ownership.ts</files>
  <behavior>
    The route is the only async seam (normalizeClassifierOutput is pure). After the sync normalize result is computed:
    - The classify body must carry thread_id (currently it does not). Extend classificationNormalizeBodySchema with `thread_id: z.string().optional()`. The n8n Normalize node already has `$('Load Inbox Row').item.json.thread_id` available — note in the SUMMARY that the n8n JSON `jsonBody` needs a one-line `thread_id` addition on deploy (out-of-band; this plan changes code only, n8n JSON edit is an operator deploy step).
    - If the sync result did NOT already drop (route !== 'drop') AND thread_id present AND the email would otherwise draft: call operatorOwnsThread({ thread_id, current_to: to }). If owned → override to a dropped result: category='spam_marketing', route='drop', preclass_applied=true, preclass_source='operator-owns-thread', suppression_reason='operator_owns_thread'. Preserve original category in raw_output (already there).
    - suppression_reason is a NEW field on ClassificationResult: `'self_loop' | 'operator_owns_thread' | null`. Self-loop (Task 1) sets 'self_loop'; this task sets 'operator_owns_thread'; everything else null. This is the observability requirement (locked decision #4) — captured in the route response and logged via console so the operator can audit suppressed drafts without a migration.
    - Order of precedence: an already-dropped result (spam/noreply/self-loop) short-circuits — do NOT run the DB query (saves a query on the common spam path).
  </behavior>
  <action>
    1. dashboard/lib/schemas/internal.ts: add `thread_id: z.string().optional()` to classificationNormalizeBodySchema.
    2. dashboard/lib/classification/normalize.ts: add `suppression_reason: 'self_loop' | 'operator_owns_thread' | null` to ClassificationResult; default null in fallback() and the success path; set 'self_loop' in applyPreclass when the self-loop hit fired. Widen preclass_source union to add 'operator-owns-thread'.
    3. dashboard/app/api/internal/classification-normalize/route.ts: destructure `thread_id` from the parsed body. After `normalizeClassifierOutput(raw, { from, to })`, if `result.route !== 'drop'` and `thread_id` present, await operatorOwnsThread({ thread_id, current_to: to }); if owned, return a result object spreading the sync result with category='spam_marketing', route='drop', preclass_applied=true, preclass_source='operator-owns-thread', suppression_reason='operator_owns_thread'. Log a single structured console line on any suppression (`[classify] suppressed draft reason=<...> from=<...> thread=<...>`). Keep the existing try/catch 500 handler; operatorOwnsThread already fails open internally so a thrown error there cannot accidentally suppress.
    4. Add/extend route test (reuse test/routes/internal.test.ts pattern or a new test/classification file): a unit asserting that when operatorOwnsThread is stubbed owned:true the route response has route='drop' + suppression_reason='operator_owns_thread', and when owned:false the route returns the original local/cloud route unchanged (negative case). Stub operatorOwnsThread via vi.mock so this stays a pure unit (no DB required in CI).
  </action>
  <verify>
    <automated>cd dashboard && npx vitest run test/classification/ && npx tsc --noEmit</automated>
  </verify>
  <done>thread_id flows through the normalize schema; route drops + tags suppression_reason='operator_owns_thread' when owned, leaves route untouched when not owned; suppression_reason field present on ClassificationResult ('self_loop' | 'operator_owns_thread' | null); already-dropped results skip the DB query; full classification test suite + typecheck green.</done>
</task>

</tasks>

<verification>
- `cd dashboard && npm test` — full Vitest suite green (existing 44+ cases plus the new self-loop + thread-ownership + route cases). DB-backed thread-ownership cases run with TEST_POSTGRES_URL (`ssh -L 5432:localhost:5432 mailbox1 -N` then export the URL per dashboard/CLAUDE.md Tests section); pure cases run unconditionally.
- `cd dashboard && npx tsc --noEmit` — no type errors (new union members + new field threaded through).
- Manual trace of the two live failures: draft-154 (jt@heronlabsinc.com → shabegsh@gmail.com) now drops via self_loop; draft-158 (shabegsh@gmail.com → jt@heronlabsinc.com on a thread jt@ replied to <24h ago) now drops via operator_owns_thread.
</verification>

<success_criteria>
- UMB-153: operator outbound looped back as inbound (operator-domain from, non-operator to) produces no draft; legit op1→op2 internal still drafts. Reuses the single OPERATOR_DOMAINS/allowlist matcher.
- UMB-154: inbound on a thread an operator replied to within 24h produces no draft; >24h lapsed, never-touched, and null-thread cases all still draft. Reuses the same operator-domain matcher.
- Both suppressions hit the existing `category='spam_marketing'` → `routeFor='drop'` → n8n `Drop Spam?` drop path (no migration, no n8n JSON change required from this plan).
- suppression_reason ('self_loop' | 'operator_owns_thread') captures WHY, distinct from real spam, observable in the route response + logs.
- Negative test cases (the false-drop protections) are present and green — this is live customer-routing code.
</success_criteria>

<output>
After completion, create `.planning/quick/260520-ulr-umb-153-umb-154-pre-draft-operator-domai/260520-ulr-SUMMARY.md`.
In the SUMMARY, flag the one out-of-band deploy step: the n8n MailBOX-Classify `Normalize` node `jsonBody` must add a `"thread_id": {{ JSON.stringify($('Load Inbox Row').item.json.thread_id || '') }}` line for UMB-154 to fire in production (code-side already accepts it; without the n8n edit the thread guard is dormant but harmless). Self-loop (UMB-153) needs no n8n change — `from`/`to` are already sent.
</output>
