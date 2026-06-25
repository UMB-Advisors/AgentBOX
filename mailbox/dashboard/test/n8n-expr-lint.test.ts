import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildMainInputPredecessors,
  extractJsonFieldReads,
  lintWorkflow,
  type N8nWorkflow,
  postgresReturningFields,
} from '../lib/n8n-expr-lint';

// Regression guard for the MBOX-344 bug class (a node inserted on a main-input
// path silently blanks a downstream node's `$json.*` reads). Runs inside the
// `dashboard (typecheck + test)` CI gate — a bare-`$json` regression on
// MailBOX-Send's Gmail Reply fails CI here.

const WF_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'n8n', 'workflows');

function loadWorkflow(file: string): N8nWorkflow {
  return JSON.parse(readFileSync(join(WF_DIR, file), 'utf8')) as N8nWorkflow;
}

function allWorkflows(): { file: string; wf: N8nWorkflow }[] {
  return readdirSync(WF_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => ({ file: e.name, wf: loadWorkflow(e.name) }));
}

// The FLOOR assertion: in MailBOX-Send (now token-as-data, not the native Gmail
// node), the reply is built in the `Build Reply MIME` Code node and the token is
// minted by `Get Gmail Token`. Both MUST reference `$('Load Draft')` (cross-node)
// and MUST NOT read bare `$json.` for draft fields — the exact MBOX-344 mixup
// guard, carried onto the new send chain.
const BARE_JSON_RE = /\$json\./;
function floorProblems(wf: N8nWorkflow): string[] {
  const problems: string[] = [];

  // The node that turns the draft into the outgoing MIME message.
  const mime = wf.nodes.find((n) => n.name === 'Build Reply MIME');
  if (!mime) {
    problems.push("MailBOX-Send has no 'Build Reply MIME' node");
  } else {
    const code = mime.parameters.jsCode;
    if (typeof code !== 'string') {
      problems.push('Build Reply MIME.jsCode is not a string');
    } else {
      if (!code.includes("$('Load Draft')")) {
        problems.push("Build Reply MIME.jsCode must reference $('Load Draft')");
      }
      if (BARE_JSON_RE.test(code)) {
        problems.push('Build Reply MIME.jsCode reads bare $json (MBOX-344 regression)');
      }
    }
  }

  // The token mint keys off the draft's receiving mailbox — also cross-node.
  const tok = wf.nodes.find((n) => n.name === 'Get Gmail Token');
  if (!tok) {
    problems.push("MailBOX-Send has no 'Get Gmail Token' node");
  } else {
    const url = tok.parameters.url;
    if (typeof url !== 'string' || !url.includes("$('Load Draft')")) {
      problems.push("Get Gmail Token.url must reference $('Load Draft')");
    }
  }

  return problems;
}

describe('n8n expression lint — FLOOR (MBOX-344 send path)', () => {
  it('MailBOX-Send reply build + token mint reference $(Load Draft), never bare $json', () => {
    const wf = loadWorkflow('MailBOX-Send.json');
    expect(floorProblems(wf)).toEqual([]);
  });

  it('catches a bare-$json regression on the reply build (mutated copy)', () => {
    const wf = loadWorkflow('MailBOX-Send.json');
    const mutated: N8nWorkflow = JSON.parse(JSON.stringify(wf));
    const mime = mutated.nodes.find((n) => n.name === 'Build Reply MIME');
    if (!mime) throw new Error('fixture missing Build Reply MIME');
    mime.parameters.jsCode = 'const b = $json.draft_body; return [{ json: {} }];';
    const problems = floorProblems(mutated);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes('MBOX-344 regression'))).toBe(true);
  });
});

describe('buildMainInputPredecessors', () => {
  it('maps each node to the node(s) feeding its main input (MailBOX-Send)', () => {
    const wf = loadWorkflow('MailBOX-Send.json');
    const preds = buildMainInputPredecessors(wf);
    expect(preds.get('Get Gmail Token')).toEqual(new Set(['Lock Acquired?']));
    expect(preds.get('Build Reply MIME')).toEqual(new Set(['Get Gmail Token']));
    expect(preds.get('Gmail Send')).toEqual(new Set(['Build Reply MIME']));
    expect(preds.get('Lock Acquired?')).toEqual(new Set(['Acquire Send Lock']));
    expect(preds.get('Load Draft')).toEqual(new Set(['Webhook (mailbox-send)']));
    // Mark Sent is fed by two branches (Already Sent? true + Gmail Send)
    expect(preds.get('Mark Sent')).toEqual(new Set(['Already Sent?', 'Gmail Send']));
  });
});

describe('extractJsonFieldReads', () => {
  it('extracts top-level fields from $json.x and $json["x"]', () => {
    expect(extractJsonFieldReads('={{ $json.message_id }}')).toEqual(new Set(['message_id']));
    expect(extractJsonFieldReads('={{ $json["draft_body"] }}')).toEqual(new Set(['draft_body']));
  });

  it('treats $json.body.draft_id as a read of top-level field "body"', () => {
    expect(extractJsonFieldReads('={{ $json.body.draft_id }}')).toEqual(new Set(['body']));
  });

  it('ignores cross-node $(Node).item.json.* references', () => {
    expect(extractJsonFieldReads("={{ $('Load Draft').item.json.message_id }}")).toEqual(new Set());
    expect(
      extractJsonFieldReads({
        messageId: "={{ $('Load Draft').item.json.message_id }}",
        message: "={{ $('Load Draft').item.json.draft_body }}",
      }),
    ).toEqual(new Set());
  });

  it('recurses through nested objects/arrays', () => {
    expect(
      extractJsonFieldReads({ a: ['={{ $json.foo }}'], b: { c: '={{ $json.bar }}' } }),
    ).toEqual(new Set(['foo', 'bar']));
  });
});

describe('postgresReturningFields', () => {
  it('parses RETURNING into a field set, stripping leading comments', () => {
    const q =
      '-- a comment\nUPDATE mailbox.drafts SET send_attempt_at = NOW()\nWHERE id = 1 AND send_attempt_at IS NULL\nRETURNING id;';
    expect(postgresReturningFields(q)).toEqual(new Set(['id']));
  });

  it('parses RETURNING with multiple columns + aliases', () => {
    expect(postgresReturningFields('UPDATE t SET x=1 RETURNING id, status AS st')).toEqual(
      new Set(['id', 'st']),
    );
  });

  it('parses a SELECT column list (Load Draft style) including aliases and m.col names', () => {
    const wf = loadWorkflow('MailBOX-Send.json');
    const loadDraft = wf.nodes.find((n) => n.name === 'Load Draft');
    if (!loadDraft) throw new Error('fixture missing Load Draft');
    const produced = postgresReturningFields(String(loadDraft.parameters.query));
    expect(produced).not.toBeNull();
    expect(produced).toContain('draft_id');
    expect(produced).toContain('message_id');
    expect(produced).toContain('draft_body');
  });

  it('returns null when undeterminable (SELECT *, or no parseable clause)', () => {
    expect(postgresReturningFields('SELECT * FROM mailbox.drafts WHERE id = 1')).toBeNull();
    expect(postgresReturningFields('INSERT INTO t (a) VALUES (1)')).toBeNull();
  });
});

describe('lintWorkflow — general rule', () => {
  it('flags exactly the MBOX-344 class: a $json read of a field a Postgres predecessor does not produce', () => {
    const replica: N8nWorkflow = {
      name: 'mbox-344-replica',
      nodes: [
        {
          name: 'Load Draft',
          type: 'n8n-nodes-base.postgres',
          parameters: {
            operation: 'executeQuery',
            query: 'SELECT d.id AS draft_id, m.message_id FROM mailbox.drafts d JOIN x m',
          },
        },
        {
          name: 'Acquire Send Lock',
          type: 'n8n-nodes-base.postgres',
          parameters: {
            operation: 'executeQuery',
            query: 'UPDATE mailbox.drafts SET send_attempt_at = NOW() WHERE id = 1 RETURNING id;',
          },
        },
        {
          name: 'Gmail Reply',
          type: 'n8n-nodes-base.gmail',
          parameters: { messageId: '={{ $json.message_id }}' },
        },
      ],
      connections: {
        'Load Draft': { main: [[{ node: 'Acquire Send Lock', type: 'main', index: 0 }]] },
        'Acquire Send Lock': { main: [[{ node: 'Gmail Reply', type: 'main', index: 0 }]] },
      },
    };
    const violations = lintWorkflow(replica);
    expect(violations).toHaveLength(1);
    expect(violations[0].node).toBe('Gmail Reply');
    expect(violations[0].field).toBe('message_id');
    expect(violations[0].predecessor).toBe('Acquire Send Lock');
  });

  it('does NOT flag when the read field IS produced by the predecessor', () => {
    const ok: N8nWorkflow = {
      name: 'ok',
      nodes: [
        {
          name: 'Lock',
          type: 'n8n-nodes-base.postgres',
          parameters: { operation: 'executeQuery', query: 'UPDATE t SET x=1 RETURNING id;' },
        },
        {
          name: 'Check',
          type: 'n8n-nodes-base.if',
          parameters: { conditions: '={{ $json.id }}' },
        },
      ],
      connections: { Lock: { main: [[{ node: 'Check', type: 'main', index: 0 }]] } },
    };
    expect(lintWorkflow(ok)).toEqual([]);
  });
});

describe('n8n expression lint — WHOLE SUITE GREEN', () => {
  it('every committed workflow in n8n/workflows/*.json is clean today', () => {
    const workflows = allWorkflows();
    expect(workflows.length).toBeGreaterThan(0);
    for (const { file, wf } of workflows) {
      const violations = lintWorkflow(wf);
      expect(
        violations,
        `${file} should be lint-clean:\n${JSON.stringify(violations, null, 2)}`,
      ).toEqual([]);
    }
  });
});
