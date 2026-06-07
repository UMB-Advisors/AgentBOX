---
phase: 260518-wfv-staqpro-225-sdk-manager-jetson-linux-onl
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - docs/runbook/factory-flash.v0.1.0.md
autonomous: true
requirements:
  - STAQPRO-225
must_haves:
  truths:
    - "Operator can flash a blank NVMe with JetPack 6.2 Jetson Linux only (no GUI desktop) using SDK Manager by following the runbook end-to-end"
    - "Runbook documents the exact SDK Manager Step 2 unchecks that drop ubuntu-desktop from the install set (Approach A locked in STAQPRO-225)"
    - "First-boot verification proves `dpkg -l | grep ubuntu-desktop` is empty — the value-prop vs STAQPRO-201 post-purge path"
    - "Runbook hands off cleanly to STAQPRO-410 (factory-bootstrap.sh) and STAQPRO-409 (golden-image capture)"
    - "Screenshot placeholders are present with explicit TODO markers — Dustin fills them in during first real flash session"
  artifacts:
    - path: "docs/runbook/factory-flash.v0.1.0.md"
      provides: "SDK Manager Jetson-Linux-only factory flash runbook (v0.1.0)"
      min_lines: 150
      contains: "factory-image-pipeline.v0.1.0.md"
  key_links:
    - from: "docs/runbook/factory-flash.v0.1.0.md"
      to: "docs/runbook/factory-image-pipeline.v0.1.0.md"
      via: "cross-reference in §5 (Hand-off) and §8 (References)"
      pattern: "factory-image-pipeline\\.v0\\.1\\.0\\.md"
    - from: "docs/runbook/factory-flash.v0.1.0.md"
      to: "STAQPRO-410 factory-bootstrap.sh"
      via: "cross-reference in §5 (Hand-off)"
      pattern: "STAQPRO-410|factory-bootstrap\\.sh"
---

<objective>
Produce `docs/runbook/factory-flash.v0.1.0.md` — operator runbook for flashing a seed NVMe via NVIDIA SDK Manager with the "Jetson Linux only" option. This is Approach A (locked in STAQPRO-225 2026-05-18): drop the GUI/desktop stack at flash-time rather than purging it post-flash per STAQPRO-201. Applies to customer #3+ appliances; M1 (`mailbox.heronlabsinc.com`) and M2 (`mailbox.staqs.io`) are grandfathered.

Purpose: Eliminate the STAQPRO-201 GNOME post-purge step from the customer #3+ install path. Faster, cleaner first boot; one fewer manual step for the operator; smaller seed NVMe footprint for the STAQPRO-409 golden-image pipeline to consume.

Output: One new doc, committed in one logical commit. Pure documentation — no code changes, no schema changes, no n8n workflow changes.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@docs/runbook/provisioning.v0.1.0.md
@.planning/STATE.md

<interfaces>
<!-- Style reference: docs/runbook/provisioning.v0.1.0.md
     Key structural elements to mirror in factory-flash.v0.1.0.md:

     1. Top-of-doc frontmatter block (plain markdown, not YAML):
        # MailBox <Name> Runbook v0.1.0
        **Status:** <SKELETON | DRAFT | STABLE> — <note about completion state>
        **Audience:** <who runs this>
        **Tracks:** STAQPRO-225. <related issues>

     2. "How to use this doc" section that explains TODO / OPEN Q / STALE markers.

     3. Numbered top-level sections using `## N. <Title>` (NOT `### N.` — the
        original constraints block says "### N." but provisioning.v0.1.0.md
        uses `## N.` — mirror provisioning.v0.1.0.md for visual consistency
        across the runbook family).

     4. Each section has a **Goal:** one-liner at the top.

     5. Checklist items use `- [ ] <action>` with copy-paste commands in
        fenced ```bash blocks below the checkbox line when the command is
        non-trivial.

     6. TODO / OPEN Q markers as standalone backtick-quoted lines at the
        end of the relevant section.

     7. Appendices at the end (A, B, C...) — keep optional, only if useful.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Write docs/runbook/factory-flash.v0.1.0.md per STAQPRO-225 Approach A</name>
  <files>docs/runbook/factory-flash.v0.1.0.md</files>
  <action>
Create a new file at `docs/runbook/factory-flash.v0.1.0.md` matching the style of `docs/runbook/provisioning.v0.1.0.md` (read it first; mirror its frontmatter pattern, section numbering with `## N. <Title>`, **Goal:** one-liner per section, `- [ ]` checklist items, copy-paste commands in fenced ```bash blocks, and TODO / OPEN Q / STALE markers as standalone backtick-quoted lines).

**File header (mirror provisioning.v0.1.0.md's pattern exactly):**

```
# MailBox Factory Flash Runbook v0.1.0

**Status:** DRAFT — screenshots TODO; will land in a follow-up commit when Dustin runs the first real flash session and captures SDK Manager UI state. Procedure itself is canonical for customer #3+ appliances.

**Audience:** Operator preparing a seed NVMe for the STAQPRO-409 golden-image batch pipeline. Assumes Dustin or successor with workstation access.

**Tracks:** STAQPRO-225 (this work). Related: STAQPRO-409 (golden-image pipeline that consumes this seed NVMe), STAQPRO-410 (factory-bootstrap.sh — runs on the appliance after this runbook completes), STAQPRO-201 (post-flash GNOME purge — what this supersedes for customer #3+), STAQPRO-202 (factory-bootstrap.sh predecessor; status drift flagged — see §8).

---

## How to use this doc

- Each numbered section maps to one phase of the SDK Manager flash flow.
- `TODO:` markers are walkthrough capture points — Dustin will fill these in (especially screenshots) during the first real flash session.
- `OPEN Q:` markers are decisions/lookups that need a real answer before v1.0.0.
- Bump file version on revision: patch for typos, minor for added sections, major for structural rewrite.
- Screenshots referenced as `./screenshots/sdk-manager-*.png` are **not yet committed**; the doc lands first so the procedure is reviewable, screenshots land in a follow-up commit (STAQPRO-225 follow-up).
```

**Then write all 8 sections** using the content laid out in the planning_context block exactly (sections 1-8). Specifically:

- **## 1. Pre-flight** — workstation prerequisites. Use `- [ ]` checklist. Items per planning_context §1: Ubuntu 22.04 x86_64 workstation, SDK Manager installed via `.deb`, NVIDIA Developer account (free; flag this in an OPEN Q as the once-per-JetPack-version cost we accept per Approach A), USB-A→USB-C cable, blank NVMe seated in Jetson Orin Nano Super dev kit, 30 GB free on workstation for SDK Manager cache.

- **## 2. Recovery mode** — putting the Jetson into recovery mode. Items per §2: power off, jumper FC REC pin to GND pin (note: dev kit has FC REC and GND adjacent on the 40-pin header; jumper or pre-bent paperclip works), connect USB-C cable to workstation, power on, verify with `lsusb | grep -i nvidia` showing "NVidia Corp. APX" device. Include the lsusb command in a fenced bash block.

- **## 3. SDK Manager flow (Approach A)** — this is THE meat. Per §3, walk through each SDK Manager step. Sub-headings using `### Step N — <name>`:
  - `### Step 1 — Product selection` — Hardware = "Jetson Orin Nano Developer Kit (8GB)"; Target OS = Linux / JetPack 6.2 (the current latest); Host components = KEEP DEFAULT.
  - `### Step 2 — Component selection (critical)` — UNCHECK "Jetson SDK Components" (CUDA, cuDNN, TensorRT, multimedia, samples — anything that pulls in `ubuntu-desktop`). KEEP CHECKED only "Jetson Linux" (kernel, bootloader, BSP, minimal `nv-tegra` rootfs). Include a paragraph explaining **why**: we pull CUDA/cuDNN at runtime via `nvidia-container-toolkit` + the `ollama/ollama` upstream container (cross-ref CLAUDE.md "Stack Patterns by Variant"), so the host CUDA stack costs us nothing and the GUI desktop is pure overhead. Screenshot placeholder: `![SDK Manager Step 2 — uncheck Jetson SDK Components](./screenshots/sdk-manager-step-2.png)` with a note immediately below: `> TODO: screenshot pending first real flash session — Dustin to capture and commit in STAQPRO-225 follow-up.`
  - `### Step 3 — Target Setup` — Storage target = **NVMe** (`/dev/nvme0n1`); Pre-config = leave defaults; Username/password = pick something sane like user `mailbox` / password set at flash-time, but note these are placeholder-ish because `factory-prep-nvme.sh` (STAQPRO-409) re-sets hostname and regenerates SSH keys later.
  - `### Step 4 — Flash` — Takes ~20-30 min. End state: bootable Jetson, no GUI, ready for STAQPRO-410's `factory-bootstrap.sh`.
  - Include one more screenshot placeholder for Step 1 (`./screenshots/sdk-manager-step-1.png`) with the same TODO note.

- **## 4. First-boot verification** — Per §4. Disconnect recovery jumper, power-cycle. SSH in (note the chicken-and-egg: pre-bootstrap there's no mDNS yet — find IP via SDK Manager's reported IP, `arp -a` on the same LAN, or direct console). Sanity commands in fenced bash blocks: `uname -r`, `free -h` (expect ~1.5 GB free at idle), `df -h /` (rootfs free space). **Critical check** in its own fenced block: `dpkg -l | grep ubuntu-desktop` returns nothing — the desktop is NOT installed. This is the win vs the STAQPRO-201 post-purge path; call it out explicitly with a sentence like "This is the value-prop of Approach A: the desktop stack is not in the image to begin with, so there is nothing to purge."

- **## 5. Hand-off to STAQPRO-410 + STAQPRO-409** — Per §5. Run `scripts/factory-bootstrap.sh` (lands on master once STAQPRO-410 merges) — installs Docker, nvidia-container-toolkit, etc. Then power off, pull NVMe, capture as golden image per `docs/runbook/factory-image-pipeline.v0.1.0.md` (STAQPRO-409). Use a numbered hand-off checklist; cross-reference both runbook + Linear issue.

- **## 6. Recovery / reversal** — Per §6. Re-install desktop later: `sudo apt install ubuntu-desktop` (fenced block). Note: the value of this runbook is NOT installing it in the first place — but if a future use case demands a console, this is the way back. Mid-flash failure recovery: link to https://forums.developer.nvidia.com/c/agx-autonomous-machines/jetson-embedded-systems/70 and list common causes: USB cable too long, recovery jumper not seated, workstation USB power management putting the device to sleep.

- **## 7. Known footguns** — Per §7. Each footgun as a `### <Name>` sub-section with 1-2 paragraphs:
  - `### JetPack version drift` — pin SDK Manager JetPack version per appliance batch; golden image at 6.2.X will NOT bit-exactly restore over a 6.2.Y bootloader; re-do this runbook on JetPack updates.
  - `### NVMe brand-by-brand quirks` — Kingston and SPCC NVMes (the two brands in M1/M2 per CLAUDE.md "Hardware deltas") both work, but DRAM-less consumer NVMes may have firmware quirks under heavy writes. Document NVMe brand + part number per appliance.
  - `### SDK Manager auth gotcha` — login is per-SDK-Manager-session; if operator walks away mid-flash, session times out and flash aborts at "Pre-Config" stage. Don't multi-task during the 20-30 min flash window.

- **## 8. References** — Per §8. Bulleted list of cross-references: STAQPRO-225, STAQPRO-201, STAQPRO-202 (with the status-drift flag: "Linear marked Delivered but the file was net-new in STAQPRO-410's quick task 260518-vsx — flag for follow-up"), STAQPRO-409, STAQPRO-410, NVIDIA SDK Manager docs (https://docs.nvidia.com/sdk-manager/), L4T BSP archive (https://developer.nvidia.com/embedded/jetson-linux-r3640), `docs/runbook/factory-image-pipeline.v0.1.0.md`, `docs/runbook/provisioning.v0.1.0.md` (style sibling).

**Style requirements (enforced):**

- Use `## N. <Title>` for top-level numbered sections — matches provisioning.v0.1.0.md (NOT `### N.` as the original constraints suggested; provisioning is the canonical sibling).
- Every section starts with a **Goal:** one-liner.
- Commands in fenced ```bash blocks; inline commands in backticks.
- No emojis. No "Executive Summary." No throat-clearing.
- Versioning: filename is `factory-flash.v0.1.0.md`. Per user CLAUDE.md §6: version files for deliverables (semver-style for docs — this is v0.1.0 since it's the first cut).
- Cross-references to other docs use relative paths (e.g. `docs/runbook/factory-image-pipeline.v0.1.0.md`), NOT wikilinks (wikilinks are vault-only per `~/.claude/rules/vault-workflow.md`).
- Screenshot placeholders use markdown image syntax with relative paths `./screenshots/<name>.png` and have a TODO callout immediately below each placeholder.
- Length target: ~200-300 lines. Don't pad — match the density of provisioning.v0.1.0.md (which is ~306 lines covering 10 sections + appendices).

After writing, do NOT commit. The commit happens in the wrap-up step orchestrated by the parent workflow.
  </action>
  <verify>
    <automated>test -f docs/runbook/factory-flash.v0.1.0.md && wc -l docs/runbook/factory-flash.v0.1.0.md | awk '{ exit ($1 >= 150) ? 0 : 1 }' && grep -q "factory-image-pipeline.v0.1.0.md" docs/runbook/factory-flash.v0.1.0.md && grep -q "STAQPRO-410" docs/runbook/factory-flash.v0.1.0.md && grep -q "STAQPRO-409" docs/runbook/factory-flash.v0.1.0.md && grep -q "dpkg -l | grep ubuntu-desktop" docs/runbook/factory-flash.v0.1.0.md && grep -q "Jetson Linux" docs/runbook/factory-flash.v0.1.0.md && grep -q "./screenshots/" docs/runbook/factory-flash.v0.1.0.md && grep -qi "TODO" docs/runbook/factory-flash.v0.1.0.md</automated>
  </verify>
  <done>
- File exists at `docs/runbook/factory-flash.v0.1.0.md`
- File is ≥ 150 lines
- All 8 numbered sections present (## 1 through ## 8)
- Cross-reference to `docs/runbook/factory-image-pipeline.v0.1.0.md` present
- Cross-references to STAQPRO-410, STAQPRO-409, STAQPRO-201, STAQPRO-202, STAQPRO-225 all present
- The `dpkg -l | grep ubuntu-desktop` first-boot verification command is in §4
- At least two screenshot placeholders (`./screenshots/sdk-manager-step-1.png` and `./screenshots/sdk-manager-step-2.png`) with TODO callouts beneath each
- "Step 2 — Component selection (critical)" sub-section under §3 explicitly directs operator to UNCHECK "Jetson SDK Components" and KEEP CHECKED "Jetson Linux"
- No `git add` / `git commit` run by this task — commit is the orchestrator's job
  </done>
</task>

</tasks>

<verification>
After Task 1:

```bash
# File exists and is non-trivial
test -f docs/runbook/factory-flash.v0.1.0.md
wc -l docs/runbook/factory-flash.v0.1.0.md  # expect ≥ 150

# All 8 numbered sections
grep -c '^## [0-9]\. ' docs/runbook/factory-flash.v0.1.0.md  # expect 8

# Cross-references present
grep -E "STAQPRO-(225|409|410|201|202)" docs/runbook/factory-flash.v0.1.0.md
grep "factory-image-pipeline.v0.1.0.md" docs/runbook/factory-flash.v0.1.0.md

# Approach A specifics
grep -E "(UNCHECK|uncheck).*Jetson SDK Components" docs/runbook/factory-flash.v0.1.0.md
grep "dpkg -l | grep ubuntu-desktop" docs/runbook/factory-flash.v0.1.0.md

# Screenshot placeholders + TODOs
grep -c "./screenshots/" docs/runbook/factory-flash.v0.1.0.md  # expect ≥ 2
grep -ci "TODO" docs/runbook/factory-flash.v0.1.0.md  # expect ≥ 2
```

All commands must succeed.
</verification>

<success_criteria>
- `docs/runbook/factory-flash.v0.1.0.md` exists and is ready for review
- Procedure is end-to-end runnable: an operator following only this doc can flash a seed NVMe, verify no desktop is installed, and hand off to STAQPRO-410/409
- Style matches `docs/runbook/provisioning.v0.1.0.md` (frontmatter, section numbering, command blocks, TODO markers)
- All Linear cross-references resolve (STAQPRO-225, STAQPRO-409, STAQPRO-410, STAQPRO-201, STAQPRO-202)
- Screenshot placeholders are present with explicit TODO callouts — gating commit on screenshots would block the procedural review, so they land in a follow-up
- Zero functional code touched; zero schema migrations; zero workflow JSON edits — pure documentation deliverable
- Commit (out of scope for this task; handled by the orchestrator wrap-up): `docs(runbook): add factory-flash v0.1.0 — SDK Manager Jetson-Linux-only flow (STAQPRO-225)` on branch `feat/staqpro-225-sdk-manager-runbook` (already created off `origin/master`)
</success_criteria>

<output>
After completion, create `.planning/quick/260518-wfv-staqpro-225-sdk-manager-jetson-linux-onl/260518-wfv-SUMMARY.md` summarizing:
- File created (path, line count)
- Sections covered (1-8)
- Screenshot TODOs left for follow-up
- Linear cross-references included
- Branch + commit message used
- Any deviations from this PLAN
</output>
