# `optimization/style-vectors/` — contrastive activation-steering spike

MBOX-118. A Python research prototype testing whether **contrastive activation
steering** — extracting a single "style vector" from
`(generic-draft, approved-reply)` pairs and adding it back into the residual
stream at inference time — can push the MailBox One drafter toward the
operator's voice, as a **lighter-weight alternative to a per-customer LoRA**.

No weights are trained. The "style vector" is the difference between the mean
hidden state of approved replies and the mean hidden state of generic drafts at
a chosen decoder layer; at inference we add `λ · style_vector` to that layer's
output. `λ=0` disables it entirely (reversible).

## The feasibility / kill question (read this first)

**This is a HuggingFace-transformers research prototype, not a production
path.** It proves the *approach* using `register_forward_hook` against the
residual stream — a surface that **llama.cpp does not expose**. Production
drafting on the appliance runs through llama.cpp (DR-25), which has **no
hidden-state injection hook**. So even if this spike shows a clear quality
lift, shipping it requires a llama.cpp decoder-side hook that does not exist
today. That gap is the open feasibility question this spike exists to surface,
not close.

### Kill criteria (from the issue)

The spike is **killed** if any of these hold:

1. **Throughput** — steered generation runs at **< 15 tokens/sec** on target
   hardware. (Automatically checkable; `eval` emits the aggregate t/s and a
   pass/fail gate.)
2. **Quality** — steered drafts lose a **blind preference** test against the
   unsteered base. (Requires a human or LLM judge — this harness emits a
   blind-pref-READY JSONL but deliberately does **not** fabricate a win-rate.)
3. **Integration** — a **llama.cpp hidden-state injection hook is infeasible**
   to build/maintain. (Engineering judgment, tracked outside this subtree.)

## Background / references

- **StyleVector** — *Yang et al., "StyleVector: Representation Engineering for
  Style Transfer"*, arXiv:2503.05213. The naive recipe: per-text representation
  = unweighted token-mean of a layer's hidden states; style vector = difference
  of the two class means. Implemented as `extract_naive`.
- **SteerX** — arXiv:2510.22256. Restricts the contrast to the tokens that
  actually *diverge* between the two distributions rather than averaging
  indiscriminately. We can't compute a true paired token-alignment across two
  differently-worded replies, so `extract_steerx` **approximates** it by
  weighting each token by its distance from the *opposite* class centroid
  (distinctive tokens dominate; shared boilerplate is down-weighted). The
  approximation is documented inline in `extract.py:_steerx_weights`.

## Layer choice

Steering vectors are most effective injected at a **middle-to-late** decoder
layer — early layers carry mostly lexical/positional signal, the last layer is
too close to the unembedding to redirect cleanly. The right index is
**model-specific** (depends on depth and where "style" concentrates) and should
be swept per target model; there is no universal answer. The CLI takes
`--layer` explicitly and records it in the vector's `.meta.json` sidecar so a
steer/eval run injects at the same layer it was extracted from.

## What's in here

- `pyproject.toml` — uv toolchain (`torch`, `transformers`, `numpy`,
  `pydantic`, `click`, `pyyaml`; dev: `pytest`, `pytest-asyncio`).
- `style_vectors/extract.py` — contrastive extraction (`extract_naive`,
  `extract_steerx`) via forward hooks; pure-math core
  (`style_vector_from_states`) is model-free and synthetic-testable. Model
  loading is isolated behind `load_model` so tests inject a tiny model.
- `style_vectors/steer.py` — `steering_hook` context manager + `generate(...)`
  returning text + token count + elapsed (so t/s is measurable). `λ=0` /
  `vector=None` installs no hook → base output exactly.
- `style_vectors/eval.py` — loads §5.8 traces (the canonical TS trace schema:
  `workflow_category`, `classification`, `inbox_body`, `actual_reply_body`),
  generates base vs base+vector per trace, emits a blind-pref-READY JSONL +
  aggregate t/s. Does **not** compute a win-rate.
- `style_vectors/cli.py` — `extract` / `steer-demo` / `eval` subcommands.
- `tests/` — pytest. Synthetic/math tests run with just `torch`; tiny-model
  tests (`sshleifer/tiny-gpt2`) skip cleanly without transformers or network.

## Operator runbook

This never runs on the appliance. Run it on a CUDA workstation (or CPU-only for
the tiny-model smoke).

```bash
cd optimization/style-vectors
uv sync                                # materializes .venv
```

### Build contrast pairs

A pairs file is a JSON list of `{generic_draft_text, approved_reply_text,
inbox_message_id?}`. The `generic_draft_text` is what the un-tuned drafter
produced; the `approved_reply_text` is what the operator approved/sent on the
same inbound. Source these from the appliance the same way the dspy subtree
fetches traces (see `optimization/dspy/README.md` "Fetch a real trace set") —
they're customer-private, never commit them.

### Extract a style vector

```bash
uv run python -m style_vectors.cli extract \
    --pairs ./pairs.json \
    --model Qwen/Qwen3-4B \
    --layer 18 \
    --variant naive \
    --out outputs/style-naive.npy
```

Writes `outputs/style-naive.npy` + a `style-naive.meta.json` sidecar
(model / layer / variant / hidden_size / norm). A near-zero `norm` means the
layer choice is probably wrong — sweep `--layer`.

### Demo steering on one prompt

```bash
uv run python -m style_vectors.cli steer-demo \
    --prompt "Hi, any update on my reorder?" \
    --vector outputs/style-naive.npy \
    --lam 6.0
```

Prints base vs steered side by side with per-side t/s.

### Eval against a trace set (blind-pref-ready JSONL)

```bash
uv run python -m style_vectors.cli eval \
    --trace-dir ./traces/v1.0 \
    --vector outputs/style-naive.npy \
    --lam 6.0 \
    --out outputs/eval.jsonl
```

Each JSONL row carries the inbound, the operator's actual reply (reference),
and the two candidates in a blind `candidate_a`/`candidate_b` framing with an
`ab_map` for de-blinding. The trailing `{"_summary": ...}` line has the
aggregate t/s and the **≥15 t/s** throughput gate. Hand the JSONL to a human or
an LLM judge to get the blind-preference number — the harness will not invent
it.

## Privacy

- Contrast pairs and trace sets contain PII-scrubbed customer email bodies but
  still embed real names / addresses. Treat as customer-private; `traces/`,
  `*.trace.json`, and `outputs/` are gitignored. The eval JSONL re-emits body
  text (that's the material the judge needs) so it inherits the same status —
  never commit it.
- Unlike the dspy subtree, **nothing here calls a cloud endpoint** — all
  inference is local HuggingFace. The only network access is the one-time model
  download from the HF hub.

## Testing

```bash
cd optimization/style-vectors
uv run pytest
```

The synthetic / pure-math tests (vector = mean(A) − mean(B); λ=0 is identity;
vector shape == hidden size) always run. The tiny-model tests skip cleanly if
`transformers` or the `sshleifer/tiny-gpt2` download is unavailable, so CI
without a GPU or network still exercises the math.

## Scope notes (MBOX-118 v0.1)

- **Prototype only.** No appliance integration, no llama.cpp hook — that's the
  open kill question (#3 above), tracked outside this subtree.
- **Two extraction variants shipped:** `naive` (StyleVector) and `steerx`
  (approximation). A faithful SteerX paired-token-alignment is out of scope.
- **No win-rate produced here.** Blind preference is a human/judge step
  downstream of the JSONL this harness emits.
