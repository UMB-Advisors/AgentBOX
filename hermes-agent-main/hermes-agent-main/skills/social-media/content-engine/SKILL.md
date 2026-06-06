---
name: content-engine
description: "Draft YES! brand/product content across channels (blog, X, email, Instagram, TikTok) as review-first drafts that learn from human edits. Sales Persona Job 1.3."
version: 0.1.0
author: AgentBOX
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Content, Social, CPG, Sales-Persona, Job-1.3]
prerequisites:
  toolsets: [content]
---

# Content Engine (Sales Persona — Job 1.3)

Repurpose YES! brand and product storytelling across channels — visual,
seasonal, story-led (this is a CPG brand, not B2B thought leadership). Every
piece is drafted as an **unsent artifact for human review (L0)**; the engine
learns from how the editor changes drafts and graduates autonomy per the shared
trust counter.

The implementation lives in the native `content` toolset
(`tools/content_engine.py`). The **blog** channel is handled by the separate
`shopify-blog` + blog-learning loop and is the reference pattern — do not
re-draft blog posts here.

## Channels

| Channel | Publish path | Draft destination |
|---|---|---|
| `blog` | Shopify (handled by blog-learning) | — (reference only) |
| `x` | xurl / X post | draft, operator posts/approves |
| `email` | `send_message` | draft for review |
| `instagram` | no API | `review/` folder file |
| `tiktok` | no API | `review/` folder file |

## How to draft

1. Read the channel's learned house style: `content_house_style(channel)`.
   Apply those recurring rules — they came from real editor corrections.
2. Pull the brief (brand voice, ICP, demand calendar) from the pre-run
   `## Script Output` block when running as a cron, or ask via `clarify` if a
   needed input is missing.
3. Write channel-appropriate content in the YES! brand voice:
   - **Brand rules (non-negotiable):** the brand is always **"YES!"**
     (capitalized, exclamation mark); the product line is always
     **"Celebrational Cacao"**.
   - Match the channel's native format (short hook + visual for IG/TikTok,
     thread or single for X, subject + skimmable body for email).
4. Save it with `save_content_draft(channel, content_id, body, title=, topic=,
   theme=)`. For instagram/tiktok/email this writes a review-folder file; the
   box does not post to those channels.
5. **Never publish.** Default is draft-and-approve. Prepend the returned
   `trust_header` to your summary so the operator sees the trust state.

## Compliance carve-out (always gated)

Any health/functional **claim** about Celebrational Cacao is a
`claims/compliance` matter and stays human-approved regardless of trust level —
do not let it graduate to autonomous. Flag claims explicitly for review.

## Learning loop

When the operator approves/edits/rejects a draft, the verdict is recorded with
`record_content_outcome(channel, content_id, ai_draft=, human_final=, rejected=,
structural_change=, lessons=[...])`. This writes channel editorial lessons to
gbrain, refreshes the channel house-style digest, and advances the shared Job
1.3 trust counter. Treat strategy/positioning/claim changes as
`structural_change=true` (material regardless of how few words changed).
