-- MailBox One: Postgres Schema Initialization
-- Runs only on first volume creation via /docker-entrypoint-initdb.d/
-- n8n uses the public schema (default, no action needed)
-- Application data uses the mailbox schema

CREATE SCHEMA IF NOT EXISTS mailbox;

-- Ensure the default user has full access to both schemas
GRANT ALL ON SCHEMA mailbox TO CURRENT_USER;
GRANT ALL ON SCHEMA public TO CURRENT_USER;
