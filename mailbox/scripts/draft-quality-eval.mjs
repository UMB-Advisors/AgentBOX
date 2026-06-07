// Drafting quality eval — compares Qwen3 local vs Ollama Cloud (gpt-oss:120b
// default) vs Anthropic Haiku 4.5 across a small handpicked set of corpus
// emails. Runs from inside the n8n container so Docker DNS resolves.
//
// Usage (run on Bob):
//   docker cp scripts/draft-quality-eval.mjs mailbox-n8n-1:/tmp/eval.mjs
//   docker exec mailbox-n8n-1 node /tmp/eval.mjs > /tmp/eval-output.md
//   docker cp mailbox-n8n-1:/tmp/eval-output.md /home/bob/mailbox/scripts/
//
// What it does:
//   1. Pulls 10 inbox_messages rows hand-picked across categories (or any
//      that classify gave a confidence >= 0.7).
//   2. For each, builds a draft prompt via the dashboard's
//      /api/internal/draft-prompt route (real persona stub + assembly).
//   3. Calls each candidate model with the same prompt:
//        - Local: http://ollama:11434/api/chat with qwen3:4b-ctx4k
//        - Cloud: env-driven OLLAMA_CLOUD_BASE_URL + OLLAMA_CLOUD_MODEL
//          (default gpt-oss:120b at https://ollama.com), with Bearer key
//        - Anthropic: claude-haiku-4-5-20251001 via the messages API
//   4. Writes a side-by-side markdown report for human review.
//
// Skips Anthropic if ANTHROPIC_API_KEY is unset.
// Skips Cloud if OLLAMA_CLOUD_API_KEY is unset.

const DASHBOARD = 'http://mailbox-dashboard:3001/dashboard/api/internal';

// Per-model config. For drafting we want temperature=0.7 (matches what the
// production prompt assembler returns) for fair comparison.
const TARGETS = [
  {
    label: 'Qwen3 local (qwen3:4b-ctx4k)',
    enabled: true,
    invoke: async (prompt) => callOllama('http://ollama:11434', '', 'qwen3:4b-ctx4k', prompt),
  },
  {
    label: `Ollama Cloud (${process.env.OLLAMA_CLOUD_MODEL ?? 'gpt-oss:120b'})`,
    enabled: !!process.env.OLLAMA_CLOUD_API_KEY,
    invoke: async (prompt) => callOllama(
      process.env.OLLAMA_CLOUD_BASE_URL ?? 'https://ollama.com',
      process.env.OLLAMA_CLOUD_API_KEY ?? '',
      process.env.OLLAMA_CLOUD_MODEL ?? 'gpt-oss:120b',
      prompt,
    ),
  },
  {
    label: 'Anthropic Haiku 4.5',
    enabled: !!process.env.ANTHROPIC_API_KEY,
    invoke: async (prompt) => callAnthropic(process.env.ANTHROPIC_API_KEY, prompt),
  },
];

async function callOllama(baseUrl, apiKey, model, prompt) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const t0 = Date.now();
  const res = await fetch(new URL('/api/chat', baseUrl).toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: prompt.messages,
      stream: false,
      options: { temperature: prompt.temperature, num_predict: prompt.max_tokens },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`${baseUrl} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  return {
    body: stripThink(j.message?.content ?? ''),
    elapsed_ms: Date.now() - t0,
    input_tokens: j.prompt_eval_count ?? 0,
    output_tokens: j.eval_count ?? 0,
  };
}

async function callAnthropic(apiKey, prompt) {
  // Anthropic's messages API expects {model, system, messages: [{role:'user', content}], max_tokens, temperature}
  // We have system as messages[0] and user as messages[1] from assemblePrompt().
  const system = prompt.messages.find((m) => m.role === 'system')?.content ?? '';
  const user = prompt.messages.find((m) => m.role === 'user')?.content ?? '';
  const t0 = Date.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: prompt.max_tokens,
      temperature: prompt.temperature,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const body = (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  return {
    body: stripThink(body),
    elapsed_ms: Date.now() - t0,
    input_tokens: j.usage?.input_tokens ?? 0,
    output_tokens: j.usage?.output_tokens ?? 0,
  };
}

function stripThink(s) {
  let out = s.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
  out = out.replace(/^<think>[\s\S]*$/i, '');
  return out.trim();
}

// PRICING (USD per 1M tokens). Mirrors dashboard/lib/drafting/cost.ts.
const PRICING = {
  'qwen3:4b-ctx4k': { in: 0, out: 0 },
  'gpt-oss:120b': { in: 0.5, out: 1.5 },
  'qwen3-coder:480b': { in: 1.0, out: 3.0 },
  'deepseek-v3.1:671b': { in: 1.0, out: 3.0 },
  'kimi-k2:1t': { in: 2.0, out: 6.0 },
  'claude-haiku-4-5-20251001': { in: 1.0, out: 5.0 },
};
// Map model labels (as printed in the markdown) to PRICING keys. The naive
// includes() check missed Anthropic because the label says "Anthropic Haiku
// 4.5" but the PRICING key is the full model id.
const LABEL_PRICING_ALIAS = [
  { match: /Anthropic Haiku/i, key: 'claude-haiku-4-5-20251001' },
];
function cost(modelLabel, input_tokens, output_tokens) {
  let key = Object.keys(PRICING).find((k) => modelLabel.includes(k));
  if (!key) {
    const alias = LABEL_PRICING_ALIAS.find((a) => a.match.test(modelLabel));
    if (alias) key = alias.key;
  }
  if (!key) return 0;
  const p = PRICING[key];
  return (input_tokens / 1e6) * p.in + (output_tokens / 1e6) * p.out;
}

async function pickCorpus() {
  // Pull a balanced sample: 2 from each non-spam category that has any
  // confident classifications. Falls back to anything classified.
  const url = `${DASHBOARD.replace('/api/internal', '')}/api/drafts?limit=1`;
  // Just use a direct curl-style query via the postgres-side. Easiest:
  // hand-pick rows. The smoke test seeded inbox 5610 (reorder); use real
  // inbox rows from classification_log if available.
  // For tonight's MVP eval, just return a couple of well-formed test
  // emails inline so this script is self-contained and doesn't require
  // a populated corpus.
  return [
    {
      label: 'reorder — high signal',
      from_addr: 'sarah@example-cpg-customer.com',
      to_addr: 'dustin@heronlabsinc.com',
      subject: 'Reorder request — Heron 12oz functional gummies',
      body_text: `Hi Heron Labs team,

We are running low on the 12oz functional gummies SKU (lemon-ginger). We would like to place a reorder for 50 cases on standard PO terms. 3-week lead time works for us.

Standard ship-to is the Otis warehouse.

Thanks,
Sarah Kim
Procurement, Bright Path Wellness`,
      category: 'reorder',
      confidence: 0.92,
    },
    {
      label: 'inquiry — first-touch',
      from_addr: 'mike@new-brand.example.com',
      to_addr: 'dustin@heronlabsinc.com',
      subject: 'Manufacturing partner search — chocolate functional bars',
      body_text: `Hi,

We're a small CPG brand launching a functional chocolate bar (CBD-free, ashwagandha + cordyceps blend) and looking for a co-manufacturer. Targeting 12k units for an initial run, want to scale into the 50k–100k range over 6 months.

Do you take on smaller brands? Pricing range / minimums?

Mike Lin
Founder, Inner Ridge`,
      category: 'inquiry',
      confidence: 0.88,
    },
    {
      label: 'scheduling — sample drop',
      from_addr: 'jenny@retail-buyer.example.com',
      to_addr: 'dustin@heronlabsinc.com',
      subject: 'Sample drop next Tuesday',
      body_text: `Hey,

Confirming Tuesday 11am at our Otis store for the gummy samples. Bring 6 SKUs if possible. Parking out front, ring the bell.

Jenny`,
      category: 'scheduling',
      confidence: 0.91,
    },
    {
      label: 'escalate — complaint',
      from_addr: 'angry@customer.example.com',
      to_addr: 'dustin@heronlabsinc.com',
      subject: 'URGENT: damaged shipment, missing units',
      body_text: `Hi,

The PO #4471 shipment arrived this morning with severe water damage on 8 of 24 cases. Photos attached. Need a replacement shipment expedited or a credit issued — we have a major retail launch Monday and customers waiting.

Please escalate.

Mark Reyes
Operations, Lift House Foods`,
      category: 'escalate',
      confidence: 0.94,
    },
  ];
}

async function getPrompt(testCase) {
  // Build the prompt the same way the production route does. Cheapest path:
  // POST to draft-prompt with a synthetic draft_id. But that requires a real
  // drafts row. Instead, replicate assemblePrompt() inline using the same
  // persona stub via a dedicated debug route, OR construct directly.
  // For simplicity, hardcode the prompt builder here matching prompt.ts —
  // not DRY but keeps the eval self-contained.
  const persona = {
    tone: 'concise, direct, warm — short paragraphs, no corporate hedging',
    signoff: '— Heron Labs',
    operator_first_name: 'Heron Labs team',
    operator_brand: 'Heron Labs (small-batch CPG)',
  };
  // Mirror dashboard/lib/drafting/prompt.ts:buildSystemPrompt — keep in sync.
  // Future: have eval call POST /api/internal/draft-prompt for true SoT.
  const system = [
    `You are an email assistant for a small CPG brand operator (${persona.operator_first_name}, ${persona.operator_brand}).`,
    `You draft replies in their voice: ${persona.tone}.`,
    `You are NOT a chatbot. The operator reviews every draft before it sends, so be specific, useful, and short.`,
    `Sign off with: ${persona.signoff}`,
    `Never mention that you are an AI.`,
    '',
    'CRITICAL — when you do not know a fact, leave a bracketed placeholder.',
    'Do not invent prices, minimums, lead times, capabilities, or commitments.',
    'Use [confirm with operator: <what to confirm>] inline. Examples:',
    '',
    '  ✗ BAD:  "Our minimum order is 5,000 units and pricing starts at $1.20/unit."',
    '  ✓ GOOD: "Our minimum is [confirm with operator: MOQ for this product] and',
    '          pricing depends on volume — happy to share once we know your spec."',
    '',
    '  ✗ BAD:  "We will ship a replacement shipment today."',
    '  ✓ GOOD: "I will get a replacement shipment moving — [confirm with operator:',
    '          ship date once warehouse confirms]."',
    '',
    '  ✗ BAD:  "Our lead time is 3 weeks."  (when not stated by the customer)',
    '  ✓ GOOD: "Lead time is [confirm with operator: current production calendar]."',
    '',
    'If the customer gave you the fact in their email (e.g. "3-week lead time works for us"),',
    'restate it instead of using a placeholder — that is confirmation, not invention.',
  ].join('\n');
  const user = [
    '/no_think',
    `Classification: ${testCase.category} (${(testCase.confidence * 100).toFixed(0)}% confidence)`,
    '',
    "Draft a reply to this email. Match the operator's voice from the system prompt.",
    '',
    '## Inbound email',
    `From: ${testCase.from_addr}`,
    `To: ${testCase.to_addr}`,
    `Subject: ${testCase.subject}`,
    '',
    testCase.body_text,
    '',
    '## Output format',
    'Return ONLY the body of the reply email. No subject line, no headers, no quoted original. Plain text only.',
  ].join('\n');
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: 600,
    temperature: 0.7,
  };
}

async function main() {
  const corpus = await pickCorpus();
  const enabled = TARGETS.filter((t) => t.enabled);
  console.log(`# MailBOX Zero — drafting quality eval`);
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log(`Test cases: ${corpus.length}`);
  console.log(`Models: ${enabled.map((t) => t.label).join(', ')}`);
  console.log();

  for (const tc of corpus) {
    console.log(`---\n## ${tc.label}\n`);
    console.log(`**From:** ${tc.from_addr}`);
    console.log(`**Subject:** ${tc.subject}`);
    console.log(`**Category:** ${tc.category} (conf ${tc.confidence})\n`);
    console.log(`### Inbound\n\n\`\`\`\n${tc.body_text}\n\`\`\`\n`);

    const prompt = await getPrompt(tc);
    for (const target of enabled) {
      console.log(`### ${target.label}\n`);
      try {
        const r = await target.invoke(prompt);
        const c = cost(target.label, r.input_tokens, r.output_tokens);
        console.log(`*${r.elapsed_ms}ms · in=${r.input_tokens} out=${r.output_tokens} · $${c.toFixed(6)}*\n`);
        console.log(`\`\`\`\n${r.body}\n\`\`\`\n`);
      } catch (e) {
        console.log(`**ERROR**: ${e.message}\n`);
      }
    }
  }
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
