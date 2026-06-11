import type { KanbanCreateTaskBody } from "@/lib/api";

// Pure quick-add grammar parser (PRD docs/kanban-linear-ux.v0.1.0.md §1.3).
//
// Grammar (whitespace-separated tokens; double-quoted segments are the
// escape hatch — their content always lands in the title, never parsed):
//
//   bare words                          -> title (required)
//   ? (leading)                         -> triage: true ("rough idea")
//   !0–!3 / !urgent !high !medium !low  -> priority
//   @name                               -> assignee (existence is validated
//                                          by the CALLER against
//                                          GET /assignees — parser stays pure)
//   #tenant                             -> tenant (free-form)
//   >taskid                             -> parents[] (repeatable)
//   due:YYYY-MM-DD                      -> dueAt (sidecar field; Phase 1
//                                          callers toast + ignore, Phase 2
//                                          persists — PRD §2.2)
//   *label                              -> labels[] (repeatable; label NAMES —
//                                          the CALLER resolves them against
//                                          the sidecar label list; unknown
//                                          name = inline error with a create
//                                          shortcut, PRD §3.1)
//   est:N                               -> estimate (points, int 0–100 —
//                                          PRD §3.2)
//   cycle:<name>                        -> cycleName (resolved by the CALLER
//                                          against sidecar cycles, PRD §3.3.
//                                          Tokens split on whitespace, so
//                                          cycles whose names contain spaces
//                                          aren't addressable here — use the
//                                          detail panel / palette for those;
//                                          accepted limitation)
//
// Priority direction — VERIFIED against hermes_cli/kanban_db.py: higher int
// = more urgent (canonical sort `priority DESC`; dispatcher claims work
// `ORDER BY priority DESC`). So !urgent=3 !high=2 !medium=1 !low=0, and a
// numeric !N maps straight onto the native int — NOT Linear's inverted
// P-scale where 1 = urgent.

export interface QuickAddParseResult {
  body: KanbanCreateTaskBody;
  /** `due:` value, ISO date. Parsed from Phase 1, persisted from Phase 2. */
  dueAt?: string;
  /** `*label` values — label NAMES, not ids (deduped, original case). The
   *  caller maps them to sidecar label ids (PRD §3.1). */
  labels?: string[];
  /** `est:N` value — points, int 0–100 (PRD §3.2). */
  estimate?: number;
  /** `cycle:<name>` value — a cycle NAME the caller resolves (PRD §3.3). */
  cycleName?: string;
  /** Non-empty = don't create; surface inline. */
  errors: string[];
}

const PRIORITY_ALIASES: Record<string, number> = {
  urgent: 3,
  high: 2,
  medium: 1,
  low: 0,
  "3": 3,
  "2": 2,
  "1": 1,
  "0": 0,
};

interface RawToken {
  text: string;
  quoted: boolean;
}

function tokenize(input: string): RawToken[] {
  const out: RawToken[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      const close = input.indexOf('"', i + 1);
      // Unterminated quote: be lenient and take the rest as the segment.
      const end = close === -1 ? input.length : close;
      out.push({ text: input.slice(i + 1, end), quoted: true });
      i = end + 1;
    } else {
      let j = i;
      while (j < input.length && !/\s/.test(input[j])) j += 1;
      out.push({ text: input.slice(i, j), quoted: false });
      i = j;
    }
  }
  return out;
}

/** Strict YYYY-MM-DD with a real calendar day (rejects 2026-02-31). */
function isRealIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
}

export function parseQuickAdd(input: string): QuickAddParseResult {
  const errors: string[] = [];
  let text = input.trim();

  // Leading "?" flags triage; it may be standalone ("? fix x") or glued to
  // the first word ("?fix x").
  let triage = false;
  if (text.startsWith("?")) {
    triage = true;
    text = text.slice(1).trimStart();
  }

  const titleParts: string[] = [];
  const parents: string[] = [];
  const labels: string[] = [];
  let priority: number | undefined;
  let assignee: string | undefined;
  let tenant: string | undefined;
  let dueAt: string | undefined;
  let estimate: number | undefined;
  let cycleName: string | undefined;

  // Single-valued tokens: a repeat with the SAME value is tolerated, a
  // conflicting repeat is an error rather than last-one-wins — explicit
  // beats implicit (smallest-surprise choice; PRD doesn't specify).
  for (const tok of tokenize(text)) {
    if (tok.quoted) {
      if (tok.text) titleParts.push(tok.text);
      continue;
    }
    const t = tok.text;
    if (t.startsWith("!")) {
      const key = t.slice(1).toLowerCase();
      if (!(key in PRIORITY_ALIASES)) {
        errors.push(
          `Unknown priority "${t}" — use !0–!3 or !urgent/!high/!medium/!low`,
        );
      } else if (priority !== undefined && priority !== PRIORITY_ALIASES[key]) {
        errors.push("Conflicting priority tokens");
      } else {
        priority = PRIORITY_ALIASES[key];
      }
    } else if (t.startsWith("@")) {
      const name = t.slice(1);
      if (!name) {
        errors.push("Missing assignee name after @");
      } else if (assignee !== undefined && assignee !== name) {
        errors.push("Conflicting @assignee tokens");
      } else {
        assignee = name;
      }
    } else if (t.startsWith("#")) {
      const name = t.slice(1);
      if (!name) {
        errors.push("Missing tenant name after #");
      } else if (tenant !== undefined && tenant !== name) {
        errors.push("Conflicting #tenant tokens");
      } else {
        tenant = name;
      }
    } else if (t.startsWith(">")) {
      const id = t.slice(1);
      if (!id) {
        errors.push("Missing task id after >");
      } else if (!parents.includes(id)) {
        parents.push(id);
      }
    } else if (t.startsWith("*")) {
      const name = t.slice(1);
      if (!name) {
        errors.push("Missing label name after *");
      } else if (!labels.some((l) => l.toLowerCase() === name.toLowerCase())) {
        labels.push(name);
      }
    } else if (/^est:/i.test(t)) {
      const value = t.slice(4);
      if (!/^\d{1,3}$/.test(value) || Number(value) > 100) {
        errors.push(`Invalid estimate "${t}" — use est:N with N 0–100`);
      } else if (estimate !== undefined && estimate !== Number(value)) {
        errors.push("Conflicting est: tokens");
      } else {
        estimate = Number(value);
      }
    } else if (/^cycle:/i.test(t)) {
      const name = t.slice(6);
      if (!name) {
        errors.push("Missing cycle name after cycle:");
      } else if (cycleName !== undefined && cycleName !== name) {
        errors.push("Conflicting cycle: tokens");
      } else {
        cycleName = name;
      }
    } else if (/^due:/i.test(t)) {
      const value = t.slice(4);
      if (!isRealIsoDate(value)) {
        errors.push(`Invalid due date "${t}" — use due:YYYY-MM-DD`);
      } else if (dueAt !== undefined && dueAt !== value) {
        errors.push("Conflicting due: tokens");
      } else {
        dueAt = value;
      }
    } else {
      titleParts.push(t);
    }
  }

  const title = titleParts.join(" ");
  if (!title) errors.push("Title is required");

  const body: KanbanCreateTaskBody = { title };
  if (priority !== undefined) body.priority = priority;
  if (assignee !== undefined) body.assignee = assignee;
  if (tenant !== undefined) body.tenant = tenant;
  if (parents.length) body.parents = parents;
  if (triage) body.triage = true;

  const result: QuickAddParseResult = { body, errors };
  if (dueAt !== undefined) result.dueAt = dueAt;
  if (labels.length) result.labels = labels;
  if (estimate !== undefined) result.estimate = estimate;
  if (cycleName !== undefined) result.cycleName = cycleName;
  return result;
}
