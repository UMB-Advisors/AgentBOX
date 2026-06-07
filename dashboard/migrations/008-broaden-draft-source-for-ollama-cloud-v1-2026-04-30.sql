-- 008-broaden-draft-source-for-ollama-cloud-v1-2026-04-30.sql
--
-- 02-07 cloud-path pivot (2026-04-30): the cloud escalation target moved from
-- direct Anthropic SDK calls to Ollama Cloud (same OpenAI-compatible chat
-- completions surface as the local Qwen3 path, just a different baseUrl + key).
-- That means draft_source needs to express coarse provenance ('local' vs
-- 'cloud') and the specific model name lives in the existing `model` column.
--
-- The previous CHECK pinned draft_source to ('local_qwen3', 'cloud_haiku') —
-- those values are preserved so historical rows from earlier migrations remain
-- valid. New rows from 04-draft-sub.json write the coarse value.

ALTER TABLE mailbox.drafts
  DROP CONSTRAINT IF EXISTS drafts_draft_source_check;

ALTER TABLE mailbox.drafts
  ADD CONSTRAINT drafts_draft_source_check
  CHECK (draft_source IS NULL OR draft_source = ANY (ARRAY[
    'local',
    'cloud',
    -- legacy values, preserved for historical rows
    'local_qwen3',
    'cloud_haiku'
  ]));
