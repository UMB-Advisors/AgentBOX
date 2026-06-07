--
-- mailbox schema snapshot — used by CI to bootstrap the test Postgres.
-- Captured from customer #1 production (Bob) on 2026-05-01 with:
--   ssh mailbox1 'cd ~/mailbox && docker compose exec -T postgres \
--     pg_dump -U mailbox -d mailbox -n mailbox -s --no-owner --no-privileges' \
--     > dashboard/test/fixtures/schema.sql
-- Refresh whenever new migrations land. The schema-invariants tests rely on
-- the CHECK constraints here matching the live appliance.
--
-- PostgreSQL database dump
--

\restrict jsPo17P9Gn0vDqUWcxp0cOYofwJdgqmmXLfc7CA6tqz1TOw4iON2UeFaJdgOXW3

-- Dumped from database version 17.9
-- Dumped by pg_dump version 17.9

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: mailbox; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA mailbox;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: classification_log; Type: TABLE; Schema: mailbox; Owner: -
--

CREATE TABLE mailbox.classification_log (
    id bigint NOT NULL,
    inbox_message_id integer NOT NULL,
    category text NOT NULL,
    confidence real NOT NULL,
    model_version text NOT NULL,
    latency_ms integer,
    raw_output text,
    json_parse_ok boolean NOT NULL,
    think_stripped boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT classification_log_category_check CHECK ((category = ANY (ARRAY['inquiry'::text, 'reorder'::text, 'scheduling'::text, 'follow_up'::text, 'internal'::text, 'spam_marketing'::text, 'escalate'::text, 'unknown'::text])))
);


--
-- Name: classification_log_id_seq; Type: SEQUENCE; Schema: mailbox; Owner: -
--

CREATE SEQUENCE mailbox.classification_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: classification_log_id_seq; Type: SEQUENCE OWNED BY; Schema: mailbox; Owner: -
--

ALTER SEQUENCE mailbox.classification_log_id_seq OWNED BY mailbox.classification_log.id;


--
-- Name: drafts; Type: TABLE; Schema: mailbox; Owner: -
--

CREATE TABLE mailbox.drafts (
    id integer NOT NULL,
    inbox_message_id integer NOT NULL,
    draft_subject text,
    draft_body text NOT NULL,
    model text NOT NULL,
    input_tokens integer,
    output_tokens integer,
    cost_usd numeric(10,6),
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    error_message text,
    approved_at timestamp with time zone,
    sent_at timestamp with time zone,
    draft_source text,
    classification_category text,
    classification_confidence real,
    rag_context_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    auto_send_blocked boolean DEFAULT false NOT NULL,
    from_addr text,
    to_addr text,
    subject text,
    body_text text,
    received_at timestamp with time zone,
    message_id text,
    thread_id text,
    in_reply_to text,
    "references" text,
    CONSTRAINT drafts_classification_category_check CHECK (((classification_category IS NULL) OR (classification_category = ANY (ARRAY['inquiry'::text, 'reorder'::text, 'scheduling'::text, 'follow_up'::text, 'internal'::text, 'spam_marketing'::text, 'escalate'::text, 'unknown'::text])))),
    CONSTRAINT drafts_draft_source_check CHECK (((draft_source IS NULL) OR (draft_source = ANY (ARRAY['local'::text, 'cloud'::text, 'local_qwen3'::text, 'cloud_haiku'::text])))),
    CONSTRAINT drafts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'awaiting_cloud'::text, 'approved'::text, 'rejected'::text, 'edited'::text, 'sent'::text])))
);


--
-- Name: drafts_id_seq; Type: SEQUENCE; Schema: mailbox; Owner: -
--

CREATE SEQUENCE mailbox.drafts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: drafts_id_seq; Type: SEQUENCE OWNED BY; Schema: mailbox; Owner: -
--

ALTER SEQUENCE mailbox.drafts_id_seq OWNED BY mailbox.drafts.id;


--
-- Name: inbox_messages; Type: TABLE; Schema: mailbox; Owner: -
--

CREATE TABLE mailbox.inbox_messages (
    id integer NOT NULL,
    message_id text NOT NULL,
    thread_id text,
    from_addr text,
    to_addr text,
    subject text,
    received_at timestamp with time zone,
    snippet text,
    body text,
    classification text,
    confidence numeric(4,3),
    classified_at timestamp with time zone,
    model text,
    created_at timestamp with time zone DEFAULT now(),
    draft_id integer,
    in_reply_to text,
    "references" text
);


--
-- Name: inbox_messages_id_seq; Type: SEQUENCE; Schema: mailbox; Owner: -
--

CREATE SEQUENCE mailbox.inbox_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inbox_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: mailbox; Owner: -
--

ALTER SEQUENCE mailbox.inbox_messages_id_seq OWNED BY mailbox.inbox_messages.id;


--
-- Name: migrations; Type: TABLE; Schema: mailbox; Owner: -
--

CREATE TABLE mailbox.migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: onboarding; Type: TABLE; Schema: mailbox; Owner: -
--

CREATE TABLE mailbox.onboarding (
    id integer NOT NULL,
    customer_key text DEFAULT 'default'::text NOT NULL,
    stage text DEFAULT 'pending_admin'::text NOT NULL,
    admin_username text,
    admin_password_hash text,
    email_address text,
    ingest_progress_total integer,
    ingest_progress_done integer DEFAULT 0 NOT NULL,
    tuning_sample_count integer DEFAULT 0 NOT NULL,
    tuning_rated_count integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    lived_at timestamp with time zone,
    CONSTRAINT onboarding_stage_check CHECK ((stage = ANY (ARRAY['pending_admin'::text, 'pending_email'::text, 'ingesting'::text, 'pending_tuning'::text, 'tuning_in_progress'::text, 'live'::text])))
);


--
-- Name: onboarding_id_seq; Type: SEQUENCE; Schema: mailbox; Owner: -
--

CREATE SEQUENCE mailbox.onboarding_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: onboarding_id_seq; Type: SEQUENCE OWNED BY; Schema: mailbox; Owner: -
--

ALTER SEQUENCE mailbox.onboarding_id_seq OWNED BY mailbox.onboarding.id;


--
-- Name: persona; Type: TABLE; Schema: mailbox; Owner: -
--

CREATE TABLE mailbox.persona (
    id integer NOT NULL,
    customer_key text DEFAULT 'default'::text NOT NULL,
    statistical_markers jsonb DEFAULT '{}'::jsonb NOT NULL,
    category_exemplars jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_email_count integer DEFAULT 0 NOT NULL,
    last_refreshed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: persona_id_seq; Type: SEQUENCE; Schema: mailbox; Owner: -
--

CREATE SEQUENCE mailbox.persona_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: persona_id_seq; Type: SEQUENCE OWNED BY; Schema: mailbox; Owner: -
--

ALTER SEQUENCE mailbox.persona_id_seq OWNED BY mailbox.persona.id;


--
-- Name: rejected_history; Type: TABLE; Schema: mailbox; Owner: -
--

CREATE TABLE mailbox.rejected_history (
    id bigint NOT NULL,
    draft_id integer NOT NULL,
    inbox_message_id integer NOT NULL,
    from_addr text NOT NULL,
    subject text,
    classification_category text NOT NULL,
    classification_confidence real NOT NULL,
    draft_original text,
    rejected_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rejected_history_category_check CHECK ((classification_category = ANY (ARRAY['inquiry'::text, 'reorder'::text, 'scheduling'::text, 'follow_up'::text, 'internal'::text, 'spam_marketing'::text, 'escalate'::text, 'unknown'::text])))
);


--
-- Name: rejected_history_id_seq; Type: SEQUENCE; Schema: mailbox; Owner: -
--

CREATE SEQUENCE mailbox.rejected_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rejected_history_id_seq; Type: SEQUENCE OWNED BY; Schema: mailbox; Owner: -
--

ALTER SEQUENCE mailbox.rejected_history_id_seq OWNED BY mailbox.rejected_history.id;


--
-- Name: sent_history; Type: TABLE; Schema: mailbox; Owner: -
--

CREATE TABLE mailbox.sent_history (
    id bigint NOT NULL,
    draft_id integer NOT NULL,
    inbox_message_id integer NOT NULL,
    from_addr text NOT NULL,
    to_addr text NOT NULL,
    subject text,
    body_text text,
    thread_id text,
    draft_original text,
    draft_sent text NOT NULL,
    draft_source text NOT NULL,
    classification_category text NOT NULL,
    classification_confidence real NOT NULL,
    rag_context_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    sent_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sent_history_category_check CHECK ((classification_category = ANY (ARRAY['inquiry'::text, 'reorder'::text, 'scheduling'::text, 'follow_up'::text, 'internal'::text, 'spam_marketing'::text, 'escalate'::text, 'unknown'::text]))),
    CONSTRAINT sent_history_draft_source_check CHECK ((draft_source = ANY (ARRAY['local'::text, 'cloud'::text, 'local_qwen3'::text, 'cloud_haiku'::text])))
);


--
-- Name: sent_history_id_seq; Type: SEQUENCE; Schema: mailbox; Owner: -
--

CREATE SEQUENCE mailbox.sent_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sent_history_id_seq; Type: SEQUENCE OWNED BY; Schema: mailbox; Owner: -
--

ALTER SEQUENCE mailbox.sent_history_id_seq OWNED BY mailbox.sent_history.id;


--
-- Name: classification_log id; Type: DEFAULT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.classification_log ALTER COLUMN id SET DEFAULT nextval('mailbox.classification_log_id_seq'::regclass);


--
-- Name: drafts id; Type: DEFAULT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.drafts ALTER COLUMN id SET DEFAULT nextval('mailbox.drafts_id_seq'::regclass);


--
-- Name: inbox_messages id; Type: DEFAULT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.inbox_messages ALTER COLUMN id SET DEFAULT nextval('mailbox.inbox_messages_id_seq'::regclass);


--
-- Name: onboarding id; Type: DEFAULT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.onboarding ALTER COLUMN id SET DEFAULT nextval('mailbox.onboarding_id_seq'::regclass);


--
-- Name: persona id; Type: DEFAULT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.persona ALTER COLUMN id SET DEFAULT nextval('mailbox.persona_id_seq'::regclass);


--
-- Name: rejected_history id; Type: DEFAULT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.rejected_history ALTER COLUMN id SET DEFAULT nextval('mailbox.rejected_history_id_seq'::regclass);


--
-- Name: sent_history id; Type: DEFAULT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.sent_history ALTER COLUMN id SET DEFAULT nextval('mailbox.sent_history_id_seq'::regclass);


--
-- Name: classification_log classification_log_pkey; Type: CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.classification_log
    ADD CONSTRAINT classification_log_pkey PRIMARY KEY (id);


--
-- Name: drafts drafts_pkey; Type: CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.drafts
    ADD CONSTRAINT drafts_pkey PRIMARY KEY (id);


--
-- Name: inbox_messages inbox_messages_message_id_key; Type: CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.inbox_messages
    ADD CONSTRAINT inbox_messages_message_id_key UNIQUE (message_id);


--
-- Name: inbox_messages inbox_messages_pkey; Type: CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.inbox_messages
    ADD CONSTRAINT inbox_messages_pkey PRIMARY KEY (id);


--
-- Name: migrations migrations_pkey; Type: CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.migrations
    ADD CONSTRAINT migrations_pkey PRIMARY KEY (version);


--
-- Name: onboarding onboarding_pkey; Type: CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.onboarding
    ADD CONSTRAINT onboarding_pkey PRIMARY KEY (id);


--
-- Name: persona persona_pkey; Type: CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.persona
    ADD CONSTRAINT persona_pkey PRIMARY KEY (id);


--
-- Name: rejected_history rejected_history_pkey; Type: CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.rejected_history
    ADD CONSTRAINT rejected_history_pkey PRIMARY KEY (id);


--
-- Name: sent_history sent_history_pkey; Type: CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.sent_history
    ADD CONSTRAINT sent_history_pkey PRIMARY KEY (id);


--
-- Name: classification_log_category_idx; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX classification_log_category_idx ON mailbox.classification_log USING btree (category);


--
-- Name: classification_log_message_idx; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX classification_log_message_idx ON mailbox.classification_log USING btree (inbox_message_id);


--
-- Name: drafts_category_idx; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX drafts_category_idx ON mailbox.drafts USING btree (classification_category);


--
-- Name: drafts_rag_refs_gin; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX drafts_rag_refs_gin ON mailbox.drafts USING gin (rag_context_refs);


--
-- Name: drafts_received_at_idx; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX drafts_received_at_idx ON mailbox.drafts USING btree (received_at DESC);


--
-- Name: idx_drafts_message; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX idx_drafts_message ON mailbox.drafts USING btree (inbox_message_id);


--
-- Name: idx_drafts_status; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX idx_drafts_status ON mailbox.drafts USING btree (status);


--
-- Name: idx_inbox_messages_classification; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX idx_inbox_messages_classification ON mailbox.inbox_messages USING btree (classification);


--
-- Name: idx_inbox_messages_received_at; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX idx_inbox_messages_received_at ON mailbox.inbox_messages USING btree (received_at DESC);


--
-- Name: onboarding_customer_key_uq; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE UNIQUE INDEX onboarding_customer_key_uq ON mailbox.onboarding USING btree (customer_key);


--
-- Name: onboarding_stage_idx; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX onboarding_stage_idx ON mailbox.onboarding USING btree (stage);


--
-- Name: persona_customer_key_uq; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE UNIQUE INDEX persona_customer_key_uq ON mailbox.persona USING btree (customer_key);


--
-- Name: rejected_history_rejected_at_idx; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX rejected_history_rejected_at_idx ON mailbox.rejected_history USING btree (rejected_at DESC);


--
-- Name: sent_history_category_idx; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX sent_history_category_idx ON mailbox.sent_history USING btree (classification_category);


--
-- Name: sent_history_sent_at_idx; Type: INDEX; Schema: mailbox; Owner: -
--

CREATE INDEX sent_history_sent_at_idx ON mailbox.sent_history USING btree (sent_at DESC);


--
-- Name: classification_log classification_log_inbox_message_id_fkey; Type: FK CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.classification_log
    ADD CONSTRAINT classification_log_inbox_message_id_fkey FOREIGN KEY (inbox_message_id) REFERENCES mailbox.inbox_messages(id) ON DELETE CASCADE;


--
-- Name: drafts drafts_inbox_message_id_fkey; Type: FK CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.drafts
    ADD CONSTRAINT drafts_inbox_message_id_fkey FOREIGN KEY (inbox_message_id) REFERENCES mailbox.inbox_messages(id) ON DELETE CASCADE;


--
-- Name: inbox_messages inbox_messages_draft_id_fkey; Type: FK CONSTRAINT; Schema: mailbox; Owner: -
--

ALTER TABLE ONLY mailbox.inbox_messages
    ADD CONSTRAINT inbox_messages_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES mailbox.drafts(id);


--
-- Migration 009 — STAQPRO-185 state_transitions log + trigger.
-- Appended manually to the snapshot until the next pg_dump refresh on Bob.
--

CREATE TABLE mailbox.state_transitions (
    id          bigserial PRIMARY KEY,
    draft_id    integer NOT NULL REFERENCES mailbox.drafts(id) ON DELETE CASCADE,
    from_status text NOT NULL,
    to_status   text NOT NULL,
    transitioned_at timestamptz NOT NULL DEFAULT NOW(),
    actor       text NOT NULL DEFAULT 'system',
    reason      text,
    hash_chain  text
);

CREATE INDEX state_transitions_draft_id_idx
    ON mailbox.state_transitions (draft_id, transitioned_at DESC);

CREATE INDEX state_transitions_transitioned_at_idx
    ON mailbox.state_transitions (transitioned_at DESC);

CREATE OR REPLACE FUNCTION mailbox.log_draft_state_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO mailbox.state_transitions (draft_id, from_status, to_status, actor, reason)
        VALUES (
            NEW.id,
            OLD.status,
            NEW.status,
            COALESCE(NULLIF(current_setting('mailbox.actor', true), ''), 'system'),
            NULLIF(current_setting('mailbox.transition_reason', true), '')
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drafts_log_state_transition
    AFTER UPDATE OF status ON mailbox.drafts
    FOR EACH ROW
    EXECUTE FUNCTION mailbox.log_draft_state_transition();

-- STAQPRO-189: archive draft to sent_history on status -> 'sent' (mirrors
-- migration 010-fix-sent-history-and-archive-trigger).
CREATE OR REPLACE FUNCTION mailbox.archive_draft_to_sent_history()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent' THEN
        IF EXISTS (SELECT 1 FROM mailbox.sent_history WHERE draft_id = NEW.id) THEN
            RETURN NEW;
        END IF;

        INSERT INTO mailbox.sent_history (
            draft_id,
            inbox_message_id,
            from_addr,
            to_addr,
            subject,
            body_text,
            thread_id,
            draft_original,
            draft_sent,
            draft_source,
            classification_category,
            classification_confidence,
            sent_at
        ) VALUES (
            NEW.id,
            NEW.inbox_message_id,
            COALESCE(NEW.from_addr, ''),
            COALESCE(NEW.to_addr, ''),
            NEW.subject,
            NEW.body_text,
            NEW.thread_id,
            NEW.draft_body,
            NEW.draft_body,
            COALESCE(NEW.draft_source, 'local'),
            COALESCE(NEW.classification_category, 'unknown'),
            COALESCE(NEW.classification_confidence, 0.0),
            COALESCE(NEW.sent_at, NOW())
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drafts_archive_to_sent_history
    AFTER UPDATE OF status ON mailbox.drafts
    FOR EACH ROW
    EXECUTE FUNCTION mailbox.archive_draft_to_sent_history();

-- Migration 011 — STAQPRO-193 sent_history extensions for Gmail Sent backfill.
-- (1) message_id for idempotent UPSERT on backfilled rows. (2) Relax NOT NULL
-- on draft_id + inbox_message_id (backfill rows have neither). (3) source
-- discriminator ('live' vs 'backfill') so persona/RAG read paths can stay
-- aware of provenance.

ALTER TABLE mailbox.sent_history ADD COLUMN message_id TEXT;
CREATE UNIQUE INDEX sent_history_message_id_unique
    ON mailbox.sent_history(message_id) WHERE message_id IS NOT NULL;
ALTER TABLE mailbox.sent_history ALTER COLUMN draft_id DROP NOT NULL;
ALTER TABLE mailbox.sent_history ALTER COLUMN inbox_message_id DROP NOT NULL;
ALTER TABLE mailbox.sent_history ADD COLUMN source TEXT NOT NULL DEFAULT 'live';
ALTER TABLE mailbox.sent_history
    ADD CONSTRAINT sent_history_source_check
    CHECK (source = ANY (ARRAY['live'::text,'backfill'::text]));
CREATE INDEX sent_history_source_idx ON mailbox.sent_history(source);

-- Migration 012 — STAQPRO-121 capture-side: snapshot LLM original before edit.
ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS original_draft_body TEXT;

CREATE OR REPLACE FUNCTION mailbox.archive_draft_to_sent_history()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent' THEN
        IF EXISTS (SELECT 1 FROM mailbox.sent_history WHERE draft_id = NEW.id) THEN
            RETURN NEW;
        END IF;

        INSERT INTO mailbox.sent_history (
            draft_id,
            inbox_message_id,
            from_addr,
            to_addr,
            subject,
            body_text,
            thread_id,
            draft_original,
            draft_sent,
            draft_source,
            classification_category,
            classification_confidence,
            sent_at
        ) VALUES (
            NEW.id,
            NEW.inbox_message_id,
            COALESCE(NEW.from_addr, ''),
            COALESCE(NEW.to_addr, ''),
            NEW.subject,
            NEW.body_text,
            NEW.thread_id,
            COALESCE(NEW.original_draft_body, NEW.draft_body),
            NEW.draft_body,
            COALESCE(NEW.draft_source, 'local'),
            COALESCE(NEW.classification_category, 'unknown'),
            COALESCE(NEW.classification_confidence, 0.0),
            COALESCE(NEW.sent_at, NOW())
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Migration 013 — STAQPRO-191 rag_retrieval_reason column + trigger carry of
-- rag_context_refs / rag_retrieval_reason from drafts → sent_history.
ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS rag_retrieval_reason TEXT NOT NULL DEFAULT 'none';
ALTER TABLE mailbox.sent_history
  ADD COLUMN IF NOT EXISTS rag_retrieval_reason TEXT NOT NULL DEFAULT 'none';

CREATE OR REPLACE FUNCTION mailbox.archive_draft_to_sent_history()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent' THEN
        IF EXISTS (SELECT 1 FROM mailbox.sent_history WHERE draft_id = NEW.id) THEN
            RETURN NEW;
        END IF;

        INSERT INTO mailbox.sent_history (
            draft_id,
            inbox_message_id,
            from_addr,
            to_addr,
            subject,
            body_text,
            thread_id,
            draft_original,
            draft_sent,
            draft_source,
            classification_category,
            classification_confidence,
            sent_at,
            rag_context_refs,
            rag_retrieval_reason
        ) VALUES (
            NEW.id,
            NEW.inbox_message_id,
            COALESCE(NEW.from_addr, ''),
            COALESCE(NEW.to_addr, ''),
            NEW.subject,
            NEW.body_text,
            NEW.thread_id,
            COALESCE(NEW.original_draft_body, NEW.draft_body),
            NEW.draft_body,
            COALESCE(NEW.draft_source, 'local'),
            COALESCE(NEW.classification_category, 'unknown'),
            COALESCE(NEW.classification_confidence, 0.0),
            COALESCE(NEW.sent_at, NOW()),
            COALESCE(NEW.rag_context_refs, '[]'::jsonb),
            COALESCE(NEW.rag_retrieval_reason, 'none')
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── STAQPRO-148 (migration 014): kb_documents + kb_context_refs ──────────
-- Hand-applied to fixture pending next pg_dump refresh from Bob.

CREATE TABLE IF NOT EXISTS mailbox.kb_documents (
  id                    SERIAL PRIMARY KEY,
  title                 TEXT NOT NULL,
  filename              TEXT NOT NULL,
  mime_type             TEXT NOT NULL,
  size_bytes            BIGINT NOT NULL,
  sha256                TEXT NOT NULL,
  chunk_count           INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'processing',
  error_message         TEXT,
  uploaded_by           TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  uploaded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at              TIMESTAMPTZ,
  CONSTRAINT kb_documents_sha256_unique UNIQUE (sha256),
  CONSTRAINT kb_documents_status_check CHECK (status = ANY (ARRAY[
    'processing',
    'ready',
    'failed'
  ])),
  CONSTRAINT kb_documents_size_positive CHECK (size_bytes > 0),
  CONSTRAINT kb_documents_chunk_count_nonneg CHECK (chunk_count >= 0)
);

CREATE INDEX IF NOT EXISTS kb_documents_status_idx
  ON mailbox.kb_documents (status);

CREATE INDEX IF NOT EXISTS kb_documents_uploaded_at_idx
  ON mailbox.kb_documents (uploaded_at DESC);

CREATE INDEX IF NOT EXISTS kb_documents_processing_started_idx
  ON mailbox.kb_documents (processing_started_at)
  WHERE status = 'processing';

ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS kb_context_refs JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE mailbox.sent_history
  ADD COLUMN IF NOT EXISTS kb_context_refs JSONB NOT NULL DEFAULT '[]'::jsonb;

-- v014 trigger function: extends 013 to also carry kb_context_refs.
CREATE OR REPLACE FUNCTION mailbox.archive_draft_to_sent_history()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent' THEN
        IF EXISTS (SELECT 1 FROM mailbox.sent_history WHERE draft_id = NEW.id) THEN
            RETURN NEW;
        END IF;

        INSERT INTO mailbox.sent_history (
            draft_id, inbox_message_id, from_addr, to_addr, subject, body_text,
            thread_id, draft_original, draft_sent, draft_source,
            classification_category, classification_confidence, sent_at,
            rag_context_refs, rag_retrieval_reason, kb_context_refs
        ) VALUES (
            NEW.id, NEW.inbox_message_id,
            COALESCE(NEW.from_addr, ''), COALESCE(NEW.to_addr, ''),
            NEW.subject, NEW.body_text, NEW.thread_id,
            COALESCE(NEW.original_draft_body, NEW.draft_body),
            NEW.draft_body,
            COALESCE(NEW.draft_source, 'local'),
            COALESCE(NEW.classification_category, 'unknown'),
            COALESCE(NEW.classification_confidence, 0.0),
            COALESCE(NEW.sent_at, NOW()),
            COALESCE(NEW.rag_context_refs, '[]'::jsonb),
            COALESCE(NEW.rag_retrieval_reason, 'none'),
            COALESCE(NEW.kb_context_refs, '[]'::jsonb)
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── STAQPRO-227 (migration 017): drafts.last_retry_at ─────────────────
-- Hand-applied to fixture pending next pg_dump refresh. Server-side cooldown
-- column for the dashboard /retry route — avoids the operator-driven
-- feedback loop that retripped Gmail probation today.
ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ NULL;

-- ── STAQPRO-227 stretch (migration 018): system-wide Gmail cooldown ───
-- Hand-applied to fixture pending next pg_dump refresh. Singleton table for
-- system flags — first column is gmail_rate_limit_until, written by
-- lib/jobs/gmail-ratelimit-sweeper.ts and read by /retry + future MailBOX
-- cycle gates so the schedule trigger doesn't self-perpetuate probation.
CREATE TABLE IF NOT EXISTS mailbox.system_state (
  id                          INT PRIMARY KEY DEFAULT 1,
  gmail_rate_limit_until      TIMESTAMPTZ NULL,
  gmail_rate_limit_set_at     TIMESTAMPTZ NULL,
  CONSTRAINT system_state_singleton CHECK (id = 1)
);
INSERT INTO mailbox.system_state (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ── STAQPRO-226 (migration 022): Gmail bootstrap mode for first-install ──
-- Hand-applied to fixture pending next pg_dump refresh. Throttles Gmail Get
-- on a fresh appliance so the first-install backlog doesn't trip Google's
-- 250 unit/sec per-user quota.
ALTER TABLE mailbox.system_state
  ADD COLUMN IF NOT EXISTS bootstrap_complete BOOL NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bootstrap_started_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS bootstrap_messages_seen INT NOT NULL DEFAULT 0;

-- ── STAQPRO-234 (migration 020): drafts.exemplar_refs sibling column ───
-- Hand-applied to fixture pending next pg_dump refresh. Few-shot exemplars
-- from sent_history (Phase 1 of KB plan).
ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS exemplar_refs JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE mailbox.sent_history
  ADD COLUMN IF NOT EXISTS exemplar_refs JSONB NOT NULL DEFAULT '[]'::jsonb;
-- ── STAQPRO-233 (migration 019): drafting telemetry views ─────────────
-- Hand-applied to fixture pending next pg_dump refresh from Bob. Two
-- read-only views over mailbox.drafts powering the /status "Drafting routes"
-- card and STAQPRO-235's metric-driven KB nudges.
CREATE OR REPLACE VIEW mailbox.v_drafting_metrics AS
SELECT
  date_trunc('day', d.created_at)::date AS day,
  d.draft_source,
  d.classification_category,
  d.status,
  COUNT(*)::bigint AS n
FROM mailbox.drafts d
WHERE d.created_at IS NOT NULL
GROUP BY 1, 2, 3, 4;

CREATE OR REPLACE VIEW mailbox.v_override_rate AS
SELECT
  d.classification_category,
  d.draft_source,
  COUNT(*) FILTER (WHERE d.status = 'edited')::bigint                                  AS edited,
  COUNT(*) FILTER (WHERE d.status = 'rejected')::bigint                                AS rejected,
  COUNT(*) FILTER (WHERE d.status IN ('approved','edited','sent'))::bigint             AS approved_like,
  COUNT(*) FILTER (WHERE d.status IN ('approved','edited','sent','rejected'))::bigint  AS disposed,
  CASE
    WHEN COUNT(*) FILTER (WHERE d.status IN ('approved','edited','sent','rejected')) = 0 THEN NULL
    ELSE (
      COUNT(*) FILTER (WHERE d.status IN ('edited','rejected'))::numeric
      / NULLIF(COUNT(*) FILTER (WHERE d.status IN ('approved','edited','sent','rejected')), 0)
    )
  END AS edit_reject_rate
FROM mailbox.drafts d
WHERE d.created_at > NOW() - INTERVAL '14 days'
  AND d.classification_category IS NOT NULL
GROUP BY 1, 2;

-- ── STAQPRO-331 #1 (migration 023): draft_feedback table ──────────────
-- Hand-applied to fixture pending next pg_dump refresh. Structured reject
-- reasons feeding the learning loop (persona, RAG, classifier signals).
CREATE TABLE IF NOT EXISTS mailbox.draft_feedback (
  id           SERIAL PRIMARY KEY,
  draft_id     INTEGER NOT NULL REFERENCES mailbox.drafts(id) ON DELETE CASCADE,
  reason_code  TEXT NOT NULL,
  free_text    TEXT,
  operator_id  TEXT,
  rejected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT draft_feedback_reason_code_check CHECK (
    reason_code IN (
      'wrong_tone',
      'factually_inaccurate',
      'missing_context',
      'should_reply_myself',
      'dont_reply',
      'other'
    )
  ),
  CONSTRAINT draft_feedback_other_requires_text CHECK (
    reason_code <> 'other' OR (free_text IS NOT NULL AND length(trim(free_text)) > 0)
  )
);
CREATE INDEX IF NOT EXISTS draft_feedback_draft_id_idx
  ON mailbox.draft_feedback(draft_id);
CREATE INDEX IF NOT EXISTS draft_feedback_reason_code_idx
  ON mailbox.draft_feedback(reason_code);

-- migration 024 — audit 2026-05-15
CREATE TABLE IF NOT EXISTS mailbox.job_runs (
  id              BIGSERIAL PRIMARY KEY,
  job_name        TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL,
  finished_at     TIMESTAMPTZ NOT NULL,
  duration_ms     INTEGER NOT NULL,
  status          TEXT NOT NULL,
  rows_processed  INTEGER NOT NULL DEFAULT 0,
  result_json     JSONB,
  error_message   TEXT,
  host            TEXT,
  CONSTRAINT job_runs_status_check CHECK (
    status IN ('completed', 'partial', 'failed', 'skipped')
  )
);
CREATE INDEX IF NOT EXISTS job_runs_job_name_started_at_idx
  ON mailbox.job_runs(job_name, started_at DESC);
CREATE INDEX IF NOT EXISTS job_runs_failures_idx
  ON mailbox.job_runs(finished_at DESC)
  WHERE status IN ('failed', 'partial');

-- migration 015 catch-up — STAQPRO-202 sent_gmail_message_id outbound idempotency key
-- (Migration shipped to prod 2026-05-03 but the fixture was never updated. Caught
--  during 2026-05-22 hand-patch of schema.ts which also lacked the column.)
ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS sent_gmail_message_id TEXT;

-- migration 025 — STAQPRO-IDEM-2026-05-22 send-attempt CAS lock
ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS send_attempt_at TIMESTAMPTZ NULL;
CREATE INDEX IF NOT EXISTS idx_drafts_send_attempt_at
  ON mailbox.drafts (send_attempt_at)
  WHERE send_attempt_at IS NOT NULL;

-- migration 026 — MBOX-133 operator filter/sort preference persistence
CREATE TABLE IF NOT EXISTS mailbox.user_filter_preferences (
  id           SERIAL PRIMARY KEY,
  operator_id  TEXT,
  key          TEXT NOT NULL,
  value        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_filter_preferences_key_not_blank CHECK (length(trim(key)) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_filter_preferences_default_key_uidx
  ON mailbox.user_filter_preferences(key)
  WHERE operator_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS user_filter_preferences_operator_key_uidx
  ON mailbox.user_filter_preferences(operator_id, key)
  WHERE operator_id IS NOT NULL;

-- migration 027 — MBOX-285 chat history persistence (conversations + messages)
CREATE TABLE IF NOT EXISTS mailbox.chat_conversations (
  id          SERIAL PRIMARY KEY,
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS mailbox.chat_messages (
  id                   SERIAL PRIMARY KEY,
  conversation_id      INTEGER NOT NULL
                         REFERENCES mailbox.chat_conversations(id) ON DELETE CASCADE,
  role                 TEXT NOT NULL,
  content              TEXT NOT NULL,
  model                TEXT,
  input_tokens         INTEGER,
  output_tokens        INTEGER,
  rag_context_refs     JSONB NOT NULL DEFAULT '[]'::jsonb,
  rag_retrieval_reason TEXT NOT NULL DEFAULT 'none',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_messages_role_check CHECK (
    role IN ('user', 'assistant', 'system')
  ),
  CONSTRAINT chat_messages_content_not_blank CHECK (length(trim(content)) > 0)
);
CREATE INDEX IF NOT EXISTS chat_messages_conversation_id_created_at_idx
  ON mailbox.chat_messages(conversation_id, created_at);

-- migration 028 — MBOX-134 VIP sender list (urgency engine backing table)
CREATE TABLE IF NOT EXISTS mailbox.vip_senders (
  id              SERIAL PRIMARY KEY,
  email_or_domain TEXT NOT NULL,
  kind            TEXT NOT NULL,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by        TEXT,
  note            TEXT,
  CONSTRAINT vip_senders_kind_check CHECK (kind IN ('email', 'domain')),
  CONSTRAINT vip_senders_value_not_blank CHECK (length(trim(email_or_domain)) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS vip_senders_value_kind_uidx
  ON mailbox.vip_senders(email_or_domain, kind);
CREATE INDEX IF NOT EXISTS vip_senders_kind_idx
  ON mailbox.vip_senders(kind);

-- migration 029 — MBOX-132 daily digest send ledger (once-per-day de-dupe guard)
CREATE TABLE IF NOT EXISTS mailbox.digest_sends (
  id          SERIAL PRIMARY KEY,
  sent_on     DATE NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recipient   TEXT,
  subject     TEXT,
  CONSTRAINT digest_sends_sent_on_uniq UNIQUE (sent_on)
);

-- ── MBOX-131 (migration 030): drafts.action_items + sent_history carry ───
-- Hand-applied to fixture pending next pg_dump refresh. Structured action
-- items ({ text, type, due_at, source, confidence }) extracted from the
-- inbound + draft reply post-draft-finalize. Mirrored onto sent_history at
-- archival time.
ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS action_items JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE mailbox.sent_history
  ADD COLUMN IF NOT EXISTS action_items JSONB NOT NULL DEFAULT '[]'::jsonb;

-- v030 trigger function: extends 020 to also carry action_items.
-- (NOTE: this fixture's prior trigger definition above is the v014 shape and
-- predates the migration-020 exemplar_refs carry — this definition brings the
-- fixture trigger current with prod by carrying BOTH exemplar_refs and the new
-- action_items, matching migrations/030-add-draft-action-items-v1-2026-05-24.sql.)
CREATE OR REPLACE FUNCTION mailbox.archive_draft_to_sent_history()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent' THEN
        IF EXISTS (SELECT 1 FROM mailbox.sent_history WHERE draft_id = NEW.id) THEN
            RETURN NEW;
        END IF;
        INSERT INTO mailbox.sent_history (
            account_id,
            draft_id, inbox_message_id, from_addr, to_addr, subject, body_text,
            thread_id, draft_original, draft_sent, draft_source,
            classification_category, classification_confidence, sent_at,
            rag_context_refs, rag_retrieval_reason, kb_context_refs, exemplar_refs,
            action_items
        ) VALUES (
            NEW.account_id,
            NEW.id, NEW.inbox_message_id,
            COALESCE(NEW.from_addr, ''), COALESCE(NEW.to_addr, ''),
            NEW.subject, NEW.body_text, NEW.thread_id,
            COALESCE(NEW.original_draft_body, NEW.draft_body),
            NEW.draft_body,
            COALESCE(NEW.draft_source, 'local'),
            COALESCE(NEW.classification_category, 'unknown'),
            COALESCE(NEW.classification_confidence, 0.0),
            COALESCE(NEW.sent_at, NOW()),
            COALESCE(NEW.rag_context_refs, '[]'::jsonb),
            COALESCE(NEW.rag_retrieval_reason, 'none'),
            COALESCE(NEW.kb_context_refs, '[]'::jsonb),
            COALESCE(NEW.exemplar_refs, '[]'::jsonb),
            COALESCE(NEW.action_items, '[]'::jsonb)
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── MBOX-16 (migration 032): configurable auto-send rules + audit trail ──────
-- Hand-applied to fixture pending next pg_dump refresh. Mirrors
-- migrations/032-create-auto-send-rules-v1-2026-05-24.sql (renumbered from 031
-- to avoid collision with MBOX-130 + MBOX-129 oauth_tokens migration).
CREATE TABLE IF NOT EXISTS mailbox.auto_send_rules (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  priority        INTEGER NOT NULL DEFAULT 100,
  action          TEXT NOT NULL,
  category        TEXT,
  sender_domain   TEXT,
  min_confidence  NUMERIC(4,3),
  active_from_min INTEGER,
  active_to_min   INTEGER,
  shadow_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      TEXT,
  CONSTRAINT auto_send_rules_action_check
    CHECK (action IN ('auto_send', 'queue', 'drop')),
  CONSTRAINT auto_send_rules_name_not_blank
    CHECK (length(trim(name)) > 0),
  CONSTRAINT auto_send_rules_category_check
    CHECK (category IS NULL OR category IN (
      'inquiry', 'reorder', 'scheduling', 'follow_up',
      'internal', 'spam_marketing', 'escalate', 'unknown')),
  CONSTRAINT auto_send_rules_min_confidence_range
    CHECK (min_confidence IS NULL OR (min_confidence >= 0 AND min_confidence <= 1)),
  CONSTRAINT auto_send_rules_time_window_range
    CHECK (
      (active_from_min IS NULL AND active_to_min IS NULL)
      OR (active_from_min BETWEEN 0 AND 1439 AND active_to_min BETWEEN 0 AND 1439)
    )
);
CREATE INDEX IF NOT EXISTS auto_send_rules_enabled_priority_idx
  ON mailbox.auto_send_rules(priority, id)
  WHERE enabled = TRUE;
CREATE TABLE IF NOT EXISTS mailbox.auto_send_audit (
  id               BIGSERIAL PRIMARY KEY,
  draft_id         INTEGER NOT NULL REFERENCES mailbox.drafts(id) ON DELETE CASCADE,
  rule_id          INTEGER REFERENCES mailbox.auto_send_rules(id) ON DELETE SET NULL,
  rule_name        TEXT,
  matched_action   TEXT NOT NULL,
  effective_action TEXT NOT NULL,
  shadow           BOOLEAN NOT NULL DEFAULT FALSE,
  reason           TEXT NOT NULL,
  evaluated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT auto_send_audit_matched_action_check
    CHECK (matched_action IN ('auto_send', 'queue', 'drop')),
  CONSTRAINT auto_send_audit_effective_action_check
    CHECK (effective_action IN ('auto_send', 'queue', 'drop'))
);
CREATE INDEX IF NOT EXISTS auto_send_audit_draft_id_idx
  ON mailbox.auto_send_audit(draft_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS auto_send_audit_rule_id_idx
  ON mailbox.auto_send_audit(rule_id);

-- ── MBOX-130 + MBOX-129 (migration 031): shared Google OAuth token storage ──
-- Hand-applied to fixture pending next pg_dump refresh. oauth_tokens holds one
-- row per Google provider (AES-256-GCM-encrypted refresh token); drafts gets a
-- scheduling_calendar_unavailable flag set when a scheduling draft's calendar
-- pre-read failed.
CREATE TABLE IF NOT EXISTS mailbox.oauth_tokens (
  provider              TEXT PRIMARY KEY,
  refresh_token_enc     TEXT,
  scope                 TEXT,
  account_email         TEXT,
  last_fetched_at       TIMESTAMPTZ,
  connected_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT oauth_tokens_provider_not_blank CHECK (length(trim(provider)) > 0)
);

ALTER TABLE mailbox.drafts
  ADD COLUMN IF NOT EXISTS scheduling_calendar_unavailable BOOLEAN NOT NULL DEFAULT false;

-- ── MBOX-348 (migration 033): multi-account — accounts table + account_id ─────
-- Hand-applied to fixture pending next pg_dump refresh. Mirrors
-- migrations/033-add-account-id-multi-account-v1-2026-05-28.sql so codegen
-- (lib/db/schema.ts) and the test bootstrap reflect the multi-account shape.
CREATE TABLE IF NOT EXISTS mailbox.accounts (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_address text NOT NULL UNIQUE,
  display_label text,
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- migration 037 (MBOX-356 / DR-57): mail-transport provider dimension.
  -- SoT for the CHECK = MAIL_PROVIDERS in lib/types.ts. Distinct from
  -- oauth_tokens.provider (Google OAuth grant key).
  provider        text NOT NULL DEFAULT 'gmail'
    CHECK (provider IN ('gmail', 'imap', 'microsoft')),
  provider_config jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_one_default
  ON mailbox.accounts (is_default) WHERE is_default;

DO $$
DECLARE
  default_acct  integer;
  default_email text;
  t             text;
  scoped_tables text[] := ARRAY[
    'inbox_messages', 'drafts', 'classification_log', 'sent_history',
    'kb_documents', 'vip_senders', 'auto_send_rules', 'auto_send_audit',
    'chat_conversations', 'chat_messages', 'oauth_tokens', 'draft_feedback',
    'rejected_history'
  ];
BEGIN
  SELECT email_address INTO default_email
    FROM mailbox.onboarding
    WHERE email_address IS NOT NULL
    ORDER BY id
    LIMIT 1;
  IF default_email IS NULL THEN
    default_email := 'primary@appliance.local';
  END IF;

  INSERT INTO mailbox.accounts (email_address, display_label, is_default)
  VALUES (default_email, 'Primary (backfilled)', true)
  RETURNING id INTO default_acct;

  FOREACH t IN ARRAY scoped_tables LOOP
    EXECUTE format('ALTER TABLE mailbox.%I ADD COLUMN account_id integer', t);
    EXECUTE format('UPDATE mailbox.%I SET account_id = %s WHERE account_id IS NULL', t, default_acct);
    EXECUTE format('ALTER TABLE mailbox.%I ALTER COLUMN account_id SET DEFAULT %s', t, default_acct);
    EXECUTE format('ALTER TABLE mailbox.%I ALTER COLUMN account_id SET NOT NULL', t);
    EXECUTE format(
      'ALTER TABLE mailbox.%I ADD CONSTRAINT %I FOREIGN KEY (account_id) REFERENCES mailbox.accounts(id)',
      t, t || '_account_fk'
    );
  END LOOP;
END $$;

ALTER TABLE mailbox.inbox_messages DROP CONSTRAINT inbox_messages_message_id_key;
ALTER TABLE mailbox.inbox_messages
  ADD CONSTRAINT inbox_messages_account_message_uq UNIQUE (account_id, message_id);

DROP INDEX mailbox.sent_history_message_id_unique;
CREATE UNIQUE INDEX sent_history_account_message_unique
  ON mailbox.sent_history (account_id, message_id) WHERE message_id IS NOT NULL;

ALTER TABLE mailbox.oauth_tokens DROP CONSTRAINT oauth_tokens_pkey;
ALTER TABLE mailbox.oauth_tokens ADD CONSTRAINT oauth_tokens_pkey PRIMARY KEY (provider, account_id);

CREATE INDEX IF NOT EXISTS drafts_account_id_idx ON mailbox.drafts (account_id);
CREATE INDEX IF NOT EXISTS classification_log_account_id_idx ON mailbox.classification_log (account_id);

-- ── MBOX-349 (migration 034): per-update OTA audit log ──────────────────────
-- Hand-applied to fixture pending next pg_dump refresh. Append-only ledger of
-- customer-initiated "Update now" attempts (one row per attempt, 'started' →
-- terminal). See dashboard/migrations/034-create-ota-update-attempts-v1.
CREATE TABLE IF NOT EXISTS mailbox.ota_update_attempts (
  id          SERIAL PRIMARY KEY,
  from_digest TEXT,
  to_digest   TEXT,
  result      TEXT NOT NULL DEFAULT 'started',
  detail      TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT ota_update_attempts_result_check
    CHECK (result IN ('started', 'succeeded', 'rolled_back', 'failed'))
);
CREATE INDEX IF NOT EXISTS ota_update_attempts_started_at_idx
  ON mailbox.ota_update_attempts (started_at DESC);

-- ── MBOX-185 (migration 035): FR-22 threshold-alert email ledger ────────────
-- Hand-applied to fixture pending next pg_dump refresh. Once-per-code-per-day
-- de-dupe guard for the email threshold-alert push path (mirrors digest_sends).
-- See dashboard/migrations/035-create-alert-sends-v1.
CREATE TABLE IF NOT EXISTS mailbox.alert_sends (
  id          SERIAL PRIMARY KEY,
  alert_key   TEXT NOT NULL,
  code        TEXT NOT NULL,
  severity    TEXT NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recipient   TEXT,
  subject     TEXT,
  CONSTRAINT alert_sends_alert_key_uniq UNIQUE (alert_key)
);

-- ── MBOX-352 (migration 036): MBOX-162 V2 per-account isolation, SQL layer ──
-- Hand-applied to fixture pending next pg_dump refresh. Adds account_id to
-- persona (the table 033 skipped) + reshapes the persona and kb_documents dedup
-- keys to be account-scoped. See dashboard/migrations/036-account-scope-*.
DO $$
DECLARE
  default_acct integer;
BEGIN
  SELECT id INTO default_acct FROM mailbox.accounts WHERE is_default;
  IF default_acct IS NULL THEN
    RAISE EXCEPTION 'no default account — migration 033 must run before 036';
  END IF;

  ALTER TABLE mailbox.persona ADD COLUMN IF NOT EXISTS account_id integer;
  UPDATE mailbox.persona SET account_id = default_acct WHERE account_id IS NULL;
  EXECUTE format('ALTER TABLE mailbox.persona ALTER COLUMN account_id SET DEFAULT %s', default_acct);
  ALTER TABLE mailbox.persona ALTER COLUMN account_id SET NOT NULL;
  ALTER TABLE mailbox.persona
    ADD CONSTRAINT persona_account_fk FOREIGN KEY (account_id) REFERENCES mailbox.accounts(id);
END $$;

DROP INDEX mailbox.persona_customer_key_uq;
CREATE UNIQUE INDEX persona_account_customer_key_uq
  ON mailbox.persona (account_id, customer_key);

ALTER TABLE mailbox.kb_documents DROP CONSTRAINT kb_documents_sha256_unique;
ALTER TABLE mailbox.kb_documents
  ADD CONSTRAINT kb_documents_account_sha256_unique UNIQUE (account_id, sha256);

-- ── MBOX-162 P4 (migration 038): operator workspace settings singleton ──────
-- Hand-applied to fixture pending next pg_dump refresh. Singleton (id=1) holding
-- the right-pane Calendar/Drive embed config + scheduling link. Mirrors
-- mailbox.system_state. See dashboard/migrations/038-create-operator-settings-*.
CREATE TABLE IF NOT EXISTS mailbox.operator_settings (
  id                  INT PRIMARY KEY DEFAULT 1,
  booking_link        TEXT NOT NULL DEFAULT '',
  calendar_embed_src  TEXT NOT NULL DEFAULT '',
  drive_folder_id     TEXT NOT NULL DEFAULT '',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT operator_settings_singleton CHECK (id = 1)
);
INSERT INTO mailbox.operator_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ── MBOX-357 (migration 039): per-(account_id, provider) mail cooldowns ─────
-- Hand-applied to fixture pending next pg_dump refresh. Keyed cooldown bucket
-- per mailbox×transport (a Gmail 429 must not pause IMAP). The Gmail cooldown
-- helpers (lib/queries-system-state.ts) read/write the (default account,'gmail')
-- row here since 039; system_state.gmail_rate_limit_until stays as read-compat.
-- Also adds drafts.provider_message_id (provider-neutral sent id).
-- See dashboard/migrations/039-create-mail-cooldowns-and-provider-message-id-*.
CREATE TABLE IF NOT EXISTS mailbox.mail_cooldowns (
  account_id integer NOT NULL REFERENCES mailbox.accounts(id),
  provider   text NOT NULL CHECK (provider IN ('gmail', 'imap', 'microsoft')),
  until      timestamptz,
  set_at     timestamptz,
  PRIMARY KEY (account_id, provider)
);
ALTER TABLE mailbox.drafts ADD COLUMN IF NOT EXISTS provider_message_id text;

-- ── MBOX-357 (migration 040): IMAP/SMTP credential at rest ──────────────────
-- Hand-applied to fixture pending next pg_dump refresh. Nullable; holds the
-- AES-256-GCM-encrypted IMAP/SMTP app-password (iv.tag.ciphertext via
-- lib/oauth/google.ts:encryptToken). Non-secret params live in provider_config.
-- Gmail rows leave it NULL. See dashboard/migrations/040-add-account-provider-secret-*.
ALTER TABLE mailbox.accounts ADD COLUMN IF NOT EXISTS provider_secret_enc text;

-- ── MBOX-370 (migrations 041→043): per-sender never-spam allowlist ──────────
-- Hand-applied to fixture pending next pg_dump refresh. One row per sender email
-- the operator chose to "reclassify automatically" from /classifications. It is
-- NOT a force-to-category rule (that was MBOX-368/041, reverted by 043) — it only
-- means "never let this sender be dropped as spam." The classifier
-- (lib/classification/sender-allowlist.ts, consulted by the classification-
-- normalize route + classifyOne) overrides a spam_marketing verdict (model or
-- noreply heuristic) to unknown→cloud for these senders, surfacing instead of
-- dropping. Global (no account_id) — single live appliance / single operator.
-- See migrations 041-create-sender-classification-overrides + 043-rename-*.
CREATE TABLE IF NOT EXISTS mailbox.sender_never_spam (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  TEXT NOT NULL DEFAULT 'operator',
  CONSTRAINT sender_never_spam_email_not_blank
    CHECK (length(trim(email)) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS sender_never_spam_email_uidx
  ON mailbox.sender_never_spam(email);

-- ── MBOX-369 (migration 042): per-row Gmail queue actions ───────────────────
-- Hand-applied to fixture pending next pg_dump refresh. Disposition state on
-- inbox_messages backing archive / delete / mark-read / snooze row actions.
-- See dashboard/migrations/042-add-inbox-message-actions-v1.
ALTER TABLE mailbox.inbox_messages
  ADD COLUMN IF NOT EXISTS archived_at        TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS deleted_at         TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS snooze_until       TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS is_read            BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gmail_action_state TEXT NULL;
ALTER TABLE mailbox.inbox_messages
  DROP CONSTRAINT IF EXISTS inbox_messages_gmail_action_state_check;
ALTER TABLE mailbox.inbox_messages
  ADD CONSTRAINT inbox_messages_gmail_action_state_check
  CHECK (gmail_action_state IS NULL OR gmail_action_state IN ('pending', 'ok', 'failed'));
CREATE INDEX IF NOT EXISTS inbox_messages_snooze_until_idx
  ON mailbox.inbox_messages (snooze_until)
  WHERE snooze_until IS NOT NULL;

-- ── MBOX-162 P5b (migration 044): operator drafting guidelines (prompt_rules) ─
-- Hand-applied to fixture pending next pg_dump refresh. Account-scoped operator
-- rules rendered into the per-operator system prompt by rulesSystemBlock. New
-- empty table → account_id is NOT NULL with no DEFAULT (the CRUD route supplies
-- it). version bumps on content edits; toggling enabled does not.
-- See dashboard/migrations/044-create-prompt-rules-v1-2026-05-30.sql.
CREATE TABLE IF NOT EXISTS mailbox.prompt_rules (
  id          SERIAL PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES mailbox.accounts(id),
  scope       TEXT NOT NULL,
  rule        TEXT NOT NULL,
  rationale   TEXT NOT NULL DEFAULT '',
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  version     INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prompt_rules_scope_check CHECK (scope IN ('always', 'prefer', 'avoid', 'never')),
  CONSTRAINT prompt_rules_rule_not_blank CHECK (length(trim(rule)) > 0)
);
CREATE INDEX IF NOT EXISTS prompt_rules_account_enabled_idx
  ON mailbox.prompt_rules (account_id, enabled);

--
-- PostgreSQL database dump complete
--

\unrestrict jsPo17P9Gn0vDqUWcxp0cOYofwJdgqmmXLfc7CA6tqz1TOw4iON2UeFaJdgOXW3

