// Regression guard for the MBOX-344 bug class: a node inserted on a main-input
// path silently blanks a downstream node's `$json.*` reads, because in n8n
// `$json` always resolves to the OUTPUT of the immediately-upstream node.
//
// MBOX-344: MailBOX-Send's `Gmail Reply` read `{{ $json.message_id }}` /
// `{{ $json.draft_body }}`, but the `Acquire Send Lock` Postgres node
// (RETURNING `id` only) was spliced between `Load Draft` and `Gmail Reply`
// (via the `Lock Acquired?` IF). `$json` became `{ id }` → both fields went
// empty → Gmail 400 "Invalid id value". Fix: `{{ $('Load Draft').item.json.* }}`.
//
// This module is PURE (no fs / I/O) so it is trivially unit-testable: callers
// pass parsed workflow objects. The companion test
// (`dashboard/test/n8n-expr-lint.test.ts`) loads `n8n/workflows/*.json` and
// runs both the FLOOR assertion (MailBOX-Send Gmail Reply must use a `$('…')`
// cross-node ref) and the general RETURNING-heuristic rule below, inside the
// `dashboard (typecheck + test)` CI gate.
//
// Scope (deliberately narrow — NOT a general n8n data-lineage analyzer): the
// general rule flags only on POSITIVE evidence — a node whose SOLE immediate
// main-input predecessor is a Postgres `executeQuery` whose produced field set
// is determinable and does NOT contain the consumed field. When the predecessor
// is undeterminable, or is a pass-through control node (IF/NoOp), it does NOT
// flag. The MailBOX-Send Gmail Reply path has an intervening `Lock Acquired?`
// IF, so the FLOOR assertion — not this general rule — is its authoritative
// guard. Convention is documented in `n8n/workflows/README.md`.

export interface N8nNode {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
}

export interface N8nConnection {
  node: string;
  type: string;
  index: number;
}

export interface N8nWorkflow {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, { main?: Array<Array<N8nConnection | null> | null> }>;
}

export interface Violation {
  workflow: string;
  node: string;
  field: string;
  predecessor: string;
  suggestion: string;
}

const POSTGRES_TYPE = 'n8n-nodes-base.postgres';

// Bare `$json` reads. Note: `$('Node').item.json.x` contains `.item.json.x`,
// never the literal `$json` token, so this regex naturally ignores cross-node
// refs without needing to strip them first.
const JSON_READ_RE = /\$json(?:\.([A-Za-z_$][\w$]*)|\[(['"])([^'"]+)\2\])/g;

/**
 * Invert `connections` into a map of consumer node name → set of the node
 * names feeding its MAIN input.
 */
export function buildMainInputPredecessors(wf: N8nWorkflow): Map<string, Set<string>> {
  const preds = new Map<string, Set<string>>();
  for (const [source, conn] of Object.entries(wf.connections ?? {})) {
    for (const branch of conn.main ?? []) {
      for (const target of branch ?? []) {
        if (!target || target.type !== 'main') continue;
        const set = preds.get(target.node) ?? new Set<string>();
        set.add(source);
        preds.set(target.node, set);
      }
    }
  }
  return preds;
}

/**
 * Recursively collect the TOP-LEVEL fields read via bare `$json.<field>` /
 * `$json["<field>"]` anywhere inside a parameters value. `$json.body.draft_id`
 * yields `body` (the top-level field). Cross-node `$('X').item.json.y` refs are
 * ignored (they contain no `$json` token).
 */
export function extractJsonFieldReads(value: unknown): Set<string> {
  const fields = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      JSON_READ_RE.lastIndex = 0;
      let m: RegExpExecArray | null = JSON_READ_RE.exec(v);
      while (m !== null) {
        const field = m[1] ?? m[3];
        if (field) fields.add(field);
        m = JSON_READ_RE.exec(v);
      }
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item);
    } else if (v && typeof v === 'object') {
      for (const item of Object.values(v)) walk(item);
    }
  };
  walk(value);
  return fields;
}

function stripSqlComments(query: string): string {
  return query
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

// Split a SQL column list on TOP-LEVEL commas (ignoring commas inside parens,
// e.g. COALESCE(a, b)).
function splitTopLevelCommas(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current);
  return out;
}

function outputNameOf(column: string): string | null {
  const col = column.trim();
  if (!col) return null;
  const aliasMatch = col.match(/\bAS\s+"?([A-Za-z_]\w*)"?\s*$/i);
  if (aliasMatch) return aliasMatch[1];
  const firstToken = col.split(/\s+/)[0];
  const lastSegment = firstToken.split('.').pop() ?? firstToken;
  return lastSegment.replace(/"/g, '') || null;
}

function fieldSetFromColumnList(list: string): Set<string> | null {
  if (list.includes('*')) return null; // ambiguous — don't claim to know the shape
  const fields = new Set<string>();
  for (const col of splitTopLevelCommas(list)) {
    const name = outputNameOf(col);
    if (!name) return null;
    fields.add(name);
  }
  return fields.size > 0 ? fields : null;
}

/**
 * Derive the output field set of a Postgres `executeQuery` from its SQL, or
 * `null` when undeterminable (caller MUST NOT flag on null). Handles the
 * `RETURNING …` clause (the MBOX-344 signal) and a single top-level
 * `SELECT … FROM`. Intentionally a shallow heuristic, not a SQL parser.
 */
export function postgresReturningFields(query: string): Set<string> | null {
  if (typeof query !== 'string') return null;
  const q = stripSqlComments(query);

  const returning = q.match(/\bRETURNING\b([\s\S]+?)(;|$)/i);
  if (returning) return fieldSetFromColumnList(returning[1]);

  const select = q.match(/\bSELECT\b([\s\S]+?)\bFROM\b/i);
  if (select) return fieldSetFromColumnList(select[1]);

  return null;
}

function isPostgresQueryNode(node: N8nNode | undefined): node is N8nNode {
  return !!node && node.type === POSTGRES_TYPE && node.parameters?.operation === 'executeQuery';
}

/**
 * Flag every bare `$json.<field>` read whose SOLE immediate main-input
 * predecessor is a Postgres `executeQuery` node that provably does not produce
 * `<field>`. Returns `[]` when nothing is flaggable (the conservative default).
 */
export function lintWorkflow(wf: N8nWorkflow): Violation[] {
  const byName = new Map(wf.nodes.map((n) => [n.name, n]));
  const preds = buildMainInputPredecessors(wf);
  const violations: Violation[] = [];

  for (const node of wf.nodes) {
    const predNames = preds.get(node.name);
    if (!predNames || predNames.size !== 1) continue;

    const predecessor = byName.get([...predNames][0]);
    if (!isPostgresQueryNode(predecessor)) continue;

    const produced = postgresReturningFields(String(predecessor.parameters.query ?? ''));
    if (produced === null) continue;

    for (const field of extractJsonFieldReads(node.parameters)) {
      if (!produced.has(field)) {
        violations.push({
          workflow: wf.name,
          node: node.name,
          field,
          predecessor: predecessor.name,
          suggestion: `'${node.name}' reads $json.${field}, but its predecessor '${predecessor.name}' only produces { ${[...produced].join(', ')} }. Use $('<earlier-node>').item.json.${field} instead.`,
        });
      }
    }
  }

  return violations;
}
