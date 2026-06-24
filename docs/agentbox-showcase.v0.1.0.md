---
marp: true
theme: default
paginate: true
title: AgentBOX — Community Friday Call Showcase
---

<!--
AgentBOX — Community Friday Call Showcase
Format: project showcase (ResonantOS "Showcase Your Project" deck)
Target length: 15–20 min (≈12–13 min talk + demo, ≈5 min Q&A)
Deliverable: Marp deck + speaker script + live-demo runbook (this file)

HOW TO USE THIS FILE
- It is a single source: slides (separated by `---`), speaker notes (HTML
  comments under each slide), a run-of-show table, and a demo runbook.
- Render to slides:  `marp docs/agentbox-showcase.v0.1.0.md -o agentbox.html`
  (or `--pdf`). Presenter notes (the HTML comments) show in Marp presenter view.
- Read the RUN-OF-SHOW and DEMO RUNBOOK at the BOTTOM before presenting.
-->

# TL;DR (read me first — not a slide)

**What you're presenting:** AgentBOX — an edge-AI appliance. One 8 GB NVIDIA Jetson
runs a full email pipeline, a conversational agent, and a persistent memory layer,
served as one dashboard, all on-device.

**The spine of the talk:** problem → *show it working live* → how it works → why
local matters → where it's going → how to get involved.

**The demo is the centerpiece.** ~6–7 min live on a real box. Everything else
frames the demo. See the DEMO RUNBOOK at the bottom and run the pre-flight 30 min
before you go on.

**Timing:** ~13 min talk+demo, ~5 min Q&A. Slide count is intentionally low — one
idea per slide, you carry the rest.

---

# AgentBOX

### An entire AI back-office on a box that fits in your hand

<br>

A local agent, its long-term memory, and an email pipeline —
self-provisioning, on one 8 GB Jetson.

<br>

**[Your name] · Community Friday Call**

<!--
[0:00–0:30] HOOK — 30s
Hold up the box if you have it physically. That IS the demo prop.
Say: "This is a complete AI back-office. Email triage, a chat agent, and a memory
that learns your business — and it all runs on this. No cloud account required to
run it. Let me show you."
Do NOT explain the architecture yet. Promise the demo. Move.
-->

---

# Why I built this

Founders and small teams drown in email and lose context.

- Inbox triage eats **hours a day**
- The "AI assistant" answer usually means **shipping your whole inbox to a cloud vendor**
- Context lives in five SaaS tools and **none of them talk to each other**

**The bet:** put the agent, its memory, and the pipeline on *one local box you own.*

<!--
[0:30–2:00] PROBLEM — 90s
This is the emotional anchor. Speak to the audience's pain, not features.
Two sub-points to land:
1. The work is real and repetitive (email ops = hours/day).
2. The standard fix has a tax: privacy (your corpus leaves the building) and
   recurring cloud bills.
The bet line is the thesis of the whole talk. Pause after it.
If audience is technical, you can add: "an appliance, not a subscription."
-->

---

# What AgentBOX is

Three subsystems, one box, one dashboard:

| | | |
|---|---|---|
| **MailBOX** | email pipeline | triage → draft → approve → send |
| **Hermes** | the agent | chat, tools, automations, messaging |
| **gBrain** | the memory | on-device knowledge that learns you |

Served as **one operator dashboard** on the box.

Now — let's look at the real thing.

<!--
[2:00–3:00] WHAT IT IS — 60s
Keep this to 60s. It's the map before the demo, not the deep dive (that comes
AFTER the demo, when they've seen what these words mean).
Name the three things once, slowly. Point at the table.
Last line is your handoff into the demo. Switch to the live screen now.
-->

---

# Live demo

## (switch to the box)

<!--
[3:00–9:30] LIVE DEMO — ~6.5 min — THE CENTERPIECE
Follow the DEMO RUNBOOK at the bottom of this file. Summary of beats:

  A. Dashboard tour (60s): Status page on :9119 — agent healthy, system stats,
     "this is running on the Jetson on the table / over there."
  B. MailBOX money path (3 min): send a test email -> watch it classify (<30s,
     show category + confidence) -> draft generated locally -> you APPROVE ->
     it sends. Narrate "that draft was written on-device, no cloud call."
  C. Hermes agent (90s): open a chat / show Tasks tab pulling a live Linear
     board; show Org Chart. "Same box, conversational surface."
  D. gBrain (60s): terminal — `gbrain salience` or a recall query. "The box
     remembers. This is what makes drafts get better over time."

NARRATE INTENT, NOT CLICKS. Say what's about to happen before it happens, so a
slow response still reads as success.
If anything stalls >10s: cut to the screen-recording fallback (see runbook) and
keep talking. Never debug live.
-->

---

# How it works

```
        ┌──────────── one 8 GB Jetson ────────────┐
        │                                          │
  Gmail │  MailBOX  ──►  Hermes agent              │
   ───► │  (n8n +        (chat, tools, cron)       │  ──► one
        │   local LLM)        │                    │      dashboard
        │       │             ▼                    │      :9119
        │       └────────►  gBrain (memory) ◄──────┤
        │                  Postgres + vectors      │
        └──────────────────────────────────────────┘
   Local Qwen3-4B for routine work · cloud only for the hard 10–20%
```

<!--
[9:30–12:00] HOW IT WORKS — ~2.5 min
Now they've SEEN it, so the architecture lands. Walk the diagram L→R.
- MailBOX: n8n orchestrates ~8 workflows; a local Qwen3-4B classifies and drafts.
- Hermes: the reasoning/chat surface, 30+ tools, scheduled automations.
- gBrain: Postgres + vector embeddings; the agent reads/writes it; that's the
  "learns your business" part.
- One dashboard ties it together on :9119.
Key line: "Routine email is handled by the local model on the box. We only reach
for the cloud on the hard 10–20% — unknown senders, low-confidence cases."
Don't read every box. Tell the story of one email moving through it.
-->

---

# Why a box, not a cloud app

- **Privacy** — your email corpus and knowledge **never leave the appliance**
- **Cost** — no per-seat SaaS; local inference has **no marginal API bill**
- **Ownership** — it's hardware you hold; unplug it and the data's with you
- **It actually fits** — proven at peak load with **1.8 GB headroom** on 8 GB, under ~25W

NVIDIA Jetson Orin Nano Super · local Qwen3-4B · JetPack 7.2

<!--
[12:00–13:30] WHY EDGE — ~90s
This is the differentiator slide — the reason this isn't "just another email AI."
Lead with privacy; it's the strongest and the most felt.
The headroom number is your credibility proof: "we stress-tested the worst case —
local model drafting while the agent runs a heavy turn — and still had 1.8 GB
free. Roughly 3.6x our safety bar. It fits, with room."
Cost: contrast a one-time ~$600–800 board against recurring per-seat AI SaaS.
Keep it tight — don't relitigate the whole privacy debate, just plant the flag.
-->

---

# Where it is today

- **Email pipeline: live.** Classify → draft → approve → send, on-device
- **Customer #1 running** on a real appliance in production
- Conversational agent + dashboard shipped (Status, Config, Org Chart, Tasks/Linear)
- Hardened over the last sprint: CI gate, integration tests on the send path, memory limits
- **One-command provisioning** — bare Jetson → working box

<!--
[13:30–15:00] STATUS — ~90s
Credibility beat. The point: this is not a slide-ware concept — it runs in
production for a real customer.
"Live" and "customer running" are the two words to land. Be honest about scope:
the email money-path is solid; deeper memory integration and a second customer
are in flight (next slide).
If asked for the customer name in Q&A, use your judgment on disclosure.
-->

---

# Where it's going

- **gBrain memory, end-to-end** — agent recall wired into every draft, so it gets sharper with use
- **Unified inbox** — beyond email: social/DMs through the same triage pipeline
- **Branded client URL** + onboarding wizard — turn it into a product anyone can stand up
- **Fleet scaling** — golden-image path: clone the box, personalize per customer

<!--
[15:00–16:00] ROADMAP — ~60s
Three honest buckets: deepen (memory), broaden (unified inbox), productize
(onboarding + fleet). Don't over-promise dates. Frame as direction, not commitments.
The "clone the box" line is a nice forward-looking hook into the ask.
-->

---

# How you can get involved

- **Try it / kick the tires** — happy to give a walkthrough on a box
- **I want your hard email cases** — edge cases that break naive triage
- **Edge-AI / Jetson folks** — let's compare notes on the 8 GB envelope
- **Know a founder drowning in their inbox?** — that's my customer #2

<br>

**[your contact / where to find you]** · Questions?

<!--
[16:00–17:00] THE ASK — ~60s, then Q&A
A showcase call ends with a specific ask, not "thanks." Give the audience exactly
two or three ways to help (above). Pick the ones that fit who's on the call.
Then open Q&A. Anticipated questions + answers are in the run-of-show below.
-->

---

<!--
============================================================================
RUN-OF-SHOW  (presenter reference — not a slide)
============================================================================

| Segment            | Slide | Time      | Cum   |
|--------------------|-------|-----------|-------|
| Hook               | 2     | 0:30      | 0:30  |
| Problem            | 3     | 1:30      | 2:00  |
| What it is         | 4     | 1:00      | 3:00  |
| LIVE DEMO          | 5     | 6:30      | 9:30  |
| How it works       | 6     | 2:30      | 12:00 |
| Why edge           | 7     | 1:30      | 13:30 |
| Status today       | 8     | 1:30      | 15:00 |
| Roadmap            | 9     | 1:00      | 16:00 |
| The ask            | 10    | 1:00      | 17:00 |
| Q&A                | —     | ~3:00     | 20:00 |

PACING NOTES
- If you're running long, the compressible segments are "How it works" (cut to
  the one-email story) and "Roadmap" (just name the three buckets).
- NEVER compress the demo by debugging live. If it stalls, cut to fallback video.
- The hook and the ask are fixed — don't let them get squeezed.

ANTICIPATED Q&A (have these ready)
- "What's the hardware cost?" → ~$600–800 for the Jetson devkit; one-time, no
  subscription for on-device inference.
- "What model runs locally?" → Qwen3-4B at 4k context, quantized (~2.7 GB).
  Cloud (a larger model) only for the hard 10–20%.
- "Why not just use [cloud email AI]?" → Privacy (corpus stays on-box), cost
  (no per-seat bill), ownership. Different product, not a better mousetrap.
- "Does the agent send email without me?" → No. Human-in-the-loop approval before
  any send. That's a hard design rule.
- "How hard is it to set up?" → One installer; bare Jetson to working box. Three
  manual steps a human must do (recovery jumper, Gmail consent, secret unlock).
- "8 GB — does it actually fit?" → Stress-tested worst case: 1.8 GB free at peak,
  ~3.6x our safety bar. No OOM.
- "What happens if the box loses internet?" → Local classify/draft path keeps
  working; only the cloud-escalation path for hard cases pauses.

============================================================================
DEMO RUNBOOK  (DO THIS — the demo is the talk)
============================================================================

TARGET BOX
- agentbox1 = host `mailbox2` (the reference box, email pipeline live). Prefer this.
- Reach the dashboard over an SSH tunnel from your laptop:
    ssh -L 9119:127.0.0.1:9119 mailbox2
  then open http://localhost:9119 in your browser.
- Keep a second terminal SSH'd in for the gBrain CLI beat.

PRE-FLIGHT (run 30 MIN before you present — do not skip)
1. Tunnel up + dashboard loads:
     curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9119/api/google/auth/start
   Expect 303. If not, the dashboard backend isn't live — fix before you go on.
2. Pipeline healthy on the box:
     ssh mailbox2 'pgrep -af "hermes dashboard" ; docker ps --format "{{.Names}}: {{.Status}}"'
   Confirm the mailbox stack + hermes-dashboard are up.
3. Have a TEST email ready to send into the monitored inbox (use a throwaway
   account you control — NEVER demo on a real customer inbox).
4. Confirm a draft round-trips end-to-end ONCE in rehearsal so you know the
   timing. Note how long classify + draft actually takes today; narrate to it.
5. gBrain has content to show:  ssh mailbox2 'gbrain salience'  (or a recall query)
   — confirm it returns something non-empty.
6. Browser zoom up (125–150%) so the room can read it. Close noisy tabs/notifs.
7. Record the FALLBACK video now (screen-capture a full successful run) and have
   it open in a tab. This is your insurance.

DEMO BEATS (≈6.5 min)
A. Dashboard tour — 60s
   - Open :9119 Status page. "This is the operator surface. It's running on the
     Jetson [on the table / in the rack]. Agent's healthy, here's live system load."
B. MailBOX money path — 3 min  ← the hero moment
   - Send the prepped test email (from your phone/another tab) into the inbox.
   - Narrate: "It's polling Gmail. Watch — it's going to classify this in under
     30 seconds, on-device." Show category + confidence when it lands.
   - "Now it's drafting a reply — local model, no cloud call." Show the draft.
   - Read the draft aloud briefly. Then APPROVE it in the dashboard.
   - Show it sent (flip to the test inbox). "Triage to sent, on a box in my hand."
C. Hermes agent — 90s
   - Open the Tasks tab (live Linear board) and the Org Chart tab. "Same box,
     conversational + ops surface." Optionally one quick chat turn.
D. gBrain memory — 60s
   - Second terminal: `gbrain salience` or a recall query. "The box remembers.
     This is why the drafts get better the longer it runs your inbox."

FAILURE DRILL
- Anything hangs >10s → "while that's working, let me show you the recorded run"
  → play fallback video → keep narrating. Do not open logs. Do not debug.
- If the tunnel dies → fallback video for the whole demo; you lose nothing
  narratively.

DEMO SAFETY
- Throwaway inbox only. No real customer data on screen.
- Close anything with secrets/keys (the Config / API Keys tab shows env — do
  NOT open it on a shared screen).
- Mute desktop notifications before you start.
-->
