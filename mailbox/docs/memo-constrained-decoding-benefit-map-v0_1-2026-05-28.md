# Constrained Decoding — Benefit Map & Decision Memo v0.1.0

**Tracks:** MBOX-120 (M5 constrained decoding for templated categories). Parent: MBOX-111 / STAQPRO-336 (M5 draft-quality roadmap). Blocked by STAQPRO-338 (llama.cpp grammar support on T2) and STAQPRO-340 (eval harness / §5.8 trace set, to measure benefit per category).

## TL;DR

**Constrain the structure, never the prose.** Grammar enforcement should guarantee the *bones* of a reply — greeting present, required structured slots filled (PO#, ship-by date, proposed times), sign-off present — and leave the body to decode freely. Ship `reorder` first (highest-leverage, lowest-risk), then `scheduling`; skip the long tail. Ship it **default OFF behind a flag** (`CONSTRAINED_DECODING_ENABLED`) because recent research shows over-tight grammars can *degrade* semantic quality, and we want an empirical on-device A/B to confirm it helps before it touches a live draft. This is structural failure-mode prevention, not a general quality lever.

## The mechanism

Production-ready libraries — XGrammar (Dong et al., 2025), Outlines (Willard & Louf), Microsoft Guidance — all work over llama.cpp, whose native grammar format is GBNF. A grammar is a per-category constraint: token by token, the decoder is *prevented* from emitting anything that violates the template. The dispatch is the elegant part and maps onto machinery we already have: **the classifier category selects the grammar.** The pipeline already classifies every inbound (`reorder`, `scheduling`, `inquiry`, ...) before drafting, so routing to the right grammar — or to none — is a lookup, not new infrastructure. Authoring is cheap: ~1-3 hours per category once the pattern is established, against real shapes extracted from a sample of the customer's approved replies in that category.

Skeleton for `reorder` (GBNF):

```
root ::= greeting body confirmation signoff
greeting ::= "Hi " name "," "\n\n"
body ::= sentence+
confirmation ::= "PO #" po-num " confirmed for ship by " date "."
signoff ::= "\n" closing-phrase "\n" sender-name
```

Note that `body` is `sentence+` — deliberately unconstrained free text. The grammar pins the greeting, the structured confirmation slot, and the sign-off; it does not dictate what the body *says*.

## The critical caveat (why default OFF)

"Draft-Conditioned Constrained Decoding for Structured Generation in LLMs" (March 2026, arXiv 2603.03305) documents that **constrained decoding can degrade semantic quality by forcing low-probability syntax decisions.** When the model places little probability mass on the grammar-valid options at a given prefix, renormalization perturbs the generation trajectory — pushing the model toward prefixes that are *easier to keep valid* rather than ones that are *semantically right*. The tighter the grammar, the worse the effect.

The design conclusion follows directly: **right tool for structure, wrong tool for free-form prose.** Enforce only the bones; let the body decode freely. And because the harm/benefit ratio is category- and grammar-specific, the feature ships behind a flag with an A/B eval as the gate — we do not assume it helps, we measure it.

## Per-category benefit map

| Category | Benefit | Why |
|---|---|---|
| `reorder` confirmations | **High** | PO#, ship-by date, qty are genuine structured slots that must appear |
| `scheduling` | **High** | Proposed times, time zones, calendar links are structured |
| `escalation` | **Medium** | Known phrasing template per UPL / professional-rules constraints |
| `inquiry` | **Low-Medium** | Mostly free-form prose around a thin structural shell |
| Open-ended conversation | **Low** | Grammar would harm more than help |

Ship order follows the map: `reorder` first (structured slots, low free-prose surface, lowest risk of the 2603.03305 degradation), then `scheduling`. Defer `escalation` and below unless the live A/B justifies the authoring effort.

## What landed in-repo (this work)

- **Grammars for `reorder` and `scheduling`** — GBNF definitions authored against the structural patterns in the appliance's approved replies for each category. Bones only; body free.
- **Grammar parameter plumbed end-to-end** — a per-request grammar field threaded through `ollama.ts` into the llama.cpp proxy (`--grammar-file` / per-request grammar param on the T2 inference path).
- **Dispatch behind `CONSTRAINED_DECODING_ENABLED`** — classifier category selects the grammar (or none); the whole path is a no-op when the flag is off, so production behavior is unchanged until explicitly enabled.
- **A/B eval wrapper + reorder-structure analyzer** — a harness that runs the §5.8 trace set with vs. without grammar enforcement on `reorder`/`scheduling` traces, plus a script that analyzes structural conformance (greeting/slot/sign-off presence) on the output.

## Open on-device gate and the production wiring still needed

- **Empirical A/B on live llama.cpp (the gate).** The unanswered question is whether grammar enforcement *helps or hurts* on the actual T2 model. The 2603.03305 failure mode is real; the only way to know our grammars are on the right side of it is to run the `reorder`/`scheduling` A/B against the §5.8 trace set on-device and read blind-pref win rate and structural-conformance side by side. Until that lands green, the flag stays OFF in production. Worth running only *after* the bake-off and at least one personalization workstream has shipped, so we know the unconstrained baseline before adding constraints on top.
- **n8n draft-node change for production.** Turning the flag on in production also requires the MailBOX-Draft workflow's draft node to **forward the grammar field** to the inference call (category in -> grammar param out). This is a live-workflow edit on the appliance and must follow the n8n 2.x edit-then-Publish discipline — confirm with a real draft that the grammar param reaches llama.cpp before declaring it wired.

## What this is NOT

- Not a general quality improvement — it is structural failure-mode prevention (missing greeting, wrong sign-off, omitted required slot, runaway repetition).
- Not a replacement for any other workstream — a thin layer over whatever the generator produces.
- Not one-grammar-fits-all — per-category, manually authored, and worth it only where the benefit map says High.

## References

- XGrammar — Dong et al., 2025
- Outlines — Willard & Louf, 2023
- Microsoft Guidance library
- "Draft-Conditioned Constrained Decoding for Structured Generation in LLMs" — March 2026, arXiv 2603.03305 (read the failure-modes section before tightening any grammar)
- Awesome-LLM-Constrained-Decoding (curated list, GitHub)
