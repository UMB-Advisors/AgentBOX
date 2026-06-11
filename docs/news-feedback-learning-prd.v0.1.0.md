# News Feedback Learning + Daily Source Discovery — PRD v0.1.0

**TL;DR:** The Daily Digest news feed learns from the operator. Every article gets
thumbs up / thumbs down; a downvote asks "why didn't you like this?" (reason picker).
Feedback deterministically reranks the news stream server-side (hide downvoted
articles, demote disliked sources/topics, boost liked ones) and is ingested into
gbrain as recallable taste pages. Each day the digest also surfaces **two new
relevant news sources** from a server-side curated catalog — picked by learned
tag affinity — and merges their stories into the feed with Keep / Dismiss controls.

Date: 2026-06-11 · Surface: hermes dashboard (`hermes-agent-main/web` + `hermes_cli/web_server.py`) · Related: [[agentbox-daily-digest-tab]], gbrain memory integration PRD.

## Goals

1. Per-article 👍/👎 on every story in the "Your briefing" feed (lead, rows).
2. 👎 opens a reason picker: not interested · don't like this source · already
   seen · sensational/low quality · something else.
3. The news stream visibly reflects feedback: downvoted articles disappear,
   sources/topics the operator dislikes sink, liked ones rise.
4. gbrain learns: every vote becomes a page; an aggregate **taste profile** page
   is kept current so any agent (chat, cron, digest) can recall news preferences.
5. Daily discovery: each day 2 catalog sources not in the operator's selection
   are surfaced in the feed (badged "New source", banner with Keep / Dismiss).

## Non-goals (v1)

- LLM-based semantic reranking (deterministic token/tag scoring only; gbrain
  recall can power a v2 semantic layer).
- Live web search for brand-new sources — discovery picks from a server-side
  curated catalog (same SSRF posture as the existing whitelist).
- Multi-user feedback (single-operator box).

## Design

### Storage (HERMES_HOME, JSON — matches digest-prefs pattern)

- `news-feedback.json` — `{next_id, events[], votes{}}`. `events` is append-only
  (capped at 2000) with monotonic integer ids → the gbrain ingest watermark.
  `votes` maps article link → current state `{vote, reason, title, source_id, ...}`.
- `news-discovery.json` — `{date, suggestions[], history{src: date}, dismissed[], kept[]}`.

### Backend (`web_server.py`)

- `_NEWS_CATALOG`: ~16 additional curated feeds with topic tags (tech/ai/security/
  business/cpg/science/world/...). Catalog ids join the selectable universe
  (settings picker, prefs validation) — same server-side whitelist guarantees.
- `POST /api/digest/news/feedback` `{link, vote: up|down|null, reason?, title?,
  source_id?, source?, published?}` — upserts `votes`, appends an event.
- `POST /api/digest/news/discovery` `{id, action: keep|dismiss}` — keep adds the
  source to `news_sources` prefs; dismiss drops it from today's feed and blocks
  re-suggestion.
- `GET /api/digest/news` now: merges today's discovery sources into the fetch
  set, drops downvoted links and muted sources, applies a **time-warp rerank**
  (sort key = `published_ts` + adjustment seconds), annotates each item with
  `vote` and `discovery`, and returns `discovery: [{id,label,tags}]`.

Rerank weights (deterministic, recency still dominates):
- Source affinity: net votes per source, "don't like this source" counts −3;
  clamp ±4, ×30 min. Source with ≥3 source-reason downvotes ⇒ muted entirely.
- Topic tokens: title tokens (≥4 chars, stopword-filtered) from downvoted
  titles penalize matching items (up to −135 min); upvoted titles boost (+ up
  to 40 min).

### Daily discovery

On the first news fetch of each day: candidates = catalog ∪ builtins, minus
selected, dismissed, and anything suggested in the last 14 days. Score by tag
affinity (tags of sources the operator up/downvoted), deterministic date-hash
tiebreak; pick 2; persist. Their stories merge into the feed (badged); banner
offers Keep / Dismiss per source.

### gbrain ingest (`gbrain-ingest/ingest_news_feedback.py`)

Mirrors `ingest_feedback.py`: deterministic (no LLM), reads the events ledger
with an integer watermark (`news-feedback.watermark`), one page per event
(`news-feedback/<id>`, source `personal` by default — operator taste, not
entity work), titles secret-redacted. Additionally rebuilds a single upserted
**`news-feedback/taste-profile`** page (source affinities, muted sources, top
liked/disliked topics) so semantic recall gets a current, compact preference
summary. Watermark advances to the last id before the first failure; any row
error exits non-zero (systemd oneshot visibility). Timer `*:21/30` (offset from
the draft-feedback ingest), serialized by the shared flock.

### Frontend (`HomePage.tsx`, `lib/api.ts`)

- `VoteControls` (ThumbsUp/ThumbsDown) on the lead card and story rows; the
  card anchors are restructured so buttons aren't nested in `<a>`.
- 👎 opens an inline reason menu; choosing posts the vote and the card collapses
  to "Got it — you'll see less like this" with **Undo** (clears the vote).
- 👍 toggles; current vote state comes back from the server on every page.
- Discovery banner above Top stories: "New sources today" with Keep / Dismiss.
  Keep updates prefs locally (feed refetches with the source now permanent).

## Acceptance

- Voting persists across reloads (server-annotated `vote`).
- A downvoted article never reappears in the feed.
- 3× "don't like this source" hides that source's stories.
- Two suggestions appear per day, change daily, never repeat within 14 days,
  and respect Keep / Dismiss.
- `ingest_news_feedback.py --dry-run` lists pending events; a run writes pages
  + taste profile and advances the watermark; gbrain recall in `personal`
  returns the taste profile.
- `tsc -b && vite build` green; gbrain-ingest pytest green; `py_compile
  web_server.py` green.

## Deploy notes

- Frontend + `web_server.py` ship via `bin/deploy-dashboard.sh` — ⚠️ box
  `web_server.py` carries local hotfixes not in the monorepo (see
  [[agentbox-gbrain-memory-integration]] Phase 3); deploy as a 3-way patch, not
  a blind overwrite.
- Ingest: scp `ingest_news_feedback.py` + tests + the two systemd units,
  `systemctl --user daemon-reload && systemctl --user enable --now
  gbrain-ingest-news-feedback.timer`, then `--backfill --dry-run` → `--backfill`.
