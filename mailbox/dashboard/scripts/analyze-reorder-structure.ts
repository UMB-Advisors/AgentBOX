#!/usr/bin/env -S npx tsx
// dashboard/scripts/analyze-reorder-structure.ts
//
// MBOX-120 — READ-ONLY structural analysis of past `reorder` replies.
//
// Pulls approved/sent `reorder` replies from mailbox.sent_history and reports
// the common structural patterns — greeting forms, presence of a PO/order ref,
// presence of a ship-by date, signoff forms — so the GBNF grammar
// (lib/drafting/grammars/reorder.gbnf) can be refined against what the operator
// ACTUALLY writes rather than a guess. Prints a summary to stdout; writes
// NOTHING to the DB.
//
// Usage (on the appliance, against the live DB):
//   docker exec mailbox-dashboard npx tsx scripts/analyze-reorder-structure.ts
//   # or with a cap:
//   docker exec mailbox-dashboard npx tsx scripts/analyze-reorder-structure.ts --limit 200
//
// Requires POSTGRES_URL (read by lib/db.ts:getKysely → getPool).

import { getKysely } from '../lib/db';

interface CliArgs {
  /** Cap rows scanned (-1 = all). */
  limit: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let limit = -1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') {
      const v = argv[i + 1];
      if (v === undefined || v === '') throw new Error('--limit requires a value');
      limit = v === 'all' ? -1 : Number(v);
      i++;
    } else if (a !== undefined) {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return { limit };
}

// Heuristic structural probes. Deliberately simple substring/regex checks —
// this is a refinement aid, not a parser. Counts are directional.
const GREETING_RE = /^\s*(hi|hello|hey|dear|good (morning|afternoon|evening)|thanks|thank you)\b/i;
const PO_RE = /\b(po|p\.o\.|purchase order|order(?:\s*(?:#|no\.?|ref|number))?)\b/i;
const SHIP_RE =
  /\b(ship(?:ping|ped|s|-by| by)?|deliver(?:y|ed)?|eta|lead time|ready by|out the door)\b/i;
const SIGNOFF_RE =
  /\b(thanks|thank you|best|regards|cheers|warmly|sincerely|talk soon|appreciate (it|you))\b/i;

function firstNonEmptyLine(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.length > 0) return line;
  }
  return '';
}

function lastNonEmptyLines(body: string, n: number): string[] {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.slice(Math.max(0, lines.length - n));
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function printTop(label: string, map: Map<string, number>, top: number): void {
  const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  console.log(`\n${label}:`);
  if (sorted.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const [key, count] of sorted) {
    console.log(`  ${String(count).padStart(5)}  ${key}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = getKysely();

  let q = db
    .selectFrom('sent_history')
    .select(['id', 'body_text', 'draft_sent'])
    .where('classification_category', '=', 'reorder')
    .orderBy('sent_at', 'desc');
  if (args.limit >= 0) q = q.limit(args.limit);
  const rows = await q.execute();

  console.log(`[analyze-reorder] scanned ${rows.length} reorder sent_history rows.`);

  let withGreeting = 0;
  let withPO = 0;
  let withShip = 0;
  let withSignoff = 0;
  const greetingForms = new Map<string, number>();
  const signoffForms = new Map<string, number>();

  for (const row of rows) {
    // Prefer the actually-sent body; fall back to body_text snapshot.
    const body = (row.draft_sent || row.body_text || '').trim();
    if (body.length === 0) continue;

    const first = firstNonEmptyLine(body);
    if (GREETING_RE.test(first)) {
      withGreeting++;
      // Normalize the greeting to its first word for the form tally.
      const word =
        first
          .split(/\s+/)[0]
          ?.toLowerCase()
          .replace(/[^a-z]/g, '') ?? '';
      if (word) bump(greetingForms, word);
    }
    if (PO_RE.test(body)) withPO++;
    if (SHIP_RE.test(body)) withShip++;

    const tail = lastNonEmptyLines(body, 3).join(' ');
    if (SIGNOFF_RE.test(tail)) {
      withSignoff++;
      const m = tail.match(SIGNOFF_RE);
      if (m?.[0]) bump(signoffForms, m[0].toLowerCase());
    }
  }

  const n = rows.length || 1;
  const pct = (x: number): string => `${((x / n) * 100).toFixed(0)}%`;

  console.log('\n── Structural presence (share of scanned reorder replies) ──');
  console.log(`  greeting line     : ${withGreeting}/${rows.length} (${pct(withGreeting)})`);
  console.log(`  PO / order ref    : ${withPO}/${rows.length} (${pct(withPO)})`);
  console.log(`  ship-by / ETA     : ${withShip}/${rows.length} (${pct(withShip)})`);
  console.log(`  signoff           : ${withSignoff}/${rows.length} (${pct(withSignoff)})`);

  printTop('Greeting forms (first word)', greetingForms, 10);
  printTop('Signoff forms (matched phrase)', signoffForms, 10);

  console.log(
    '\n[analyze-reorder] done (read-only). Use the PO/ship-by share to decide whether ' +
      'reorder.gbnf should keep the confirmation slot required or make it optional.',
  );

  await db.destroy();
}

const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  main().catch((err) => {
    console.error('[analyze-reorder] FATAL:', err);
    process.exit(1);
  });
}
