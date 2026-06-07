-- scripts/seed-dev-data.sql — STAQPRO-155
--
-- Sample data for the dev compose stack. Inserts 6 inbox messages + drafts
-- spanning the active states (pending, awaiting_cloud, edited, approved,
-- failed, sent) so the dashboard's queue UI has something to render
-- without going through the full Gmail → classify → draft pipeline.
--
-- Idempotent: ON CONFLICT DO NOTHING for the inbox rows; drafts cascade
-- via FK if the inbox rows already exist.
--
-- Apply:
--   psql postgresql://mailbox:mailbox@localhost:5432/mailbox -f scripts/seed-dev-data.sql

BEGIN;

-- 1. pending — straightforward reorder, awaiting operator approval
INSERT INTO mailbox.inbox_messages
  (message_id, from_addr, to_addr, subject, body, received_at, classification, confidence, classified_at, model)
VALUES
  ('seed-dev-001', 'sarah@example-cpg.com', 'op@example.com',
   'Reorder: 200 cases for May restock',
   'Hi! Running low on the seltzer. Can we reorder 200 cases for May 15 delivery? Same SKU.',
   NOW() - interval '2 hours',
   'reorder', 0.94, NOW() - interval '2 hours', 'qwen3:4b-ctx4k')
ON CONFLICT (message_id) DO NOTHING;

INSERT INTO mailbox.drafts
  (inbox_message_id, draft_subject, draft_body, model, status,
   draft_source, classification_category, classification_confidence,
   from_addr, to_addr, subject, body_text, received_at)
SELECT m.id, 'Re: Reorder: 200 cases for May restock',
       E'Hi Sarah,\n\nThanks for the order — confirming 200 cases for May 15 delivery. Pricing matches Q1; PO to follow.\n\nThanks,\nOps',
       'qwen3:4b-ctx4k', 'pending', 'local', 'reorder', 0.94,
       m.from_addr, m.to_addr, m.subject, m.body, m.received_at
FROM mailbox.inbox_messages m
WHERE m.message_id = 'seed-dev-001'
  AND NOT EXISTS (SELECT 1 FROM mailbox.drafts WHERE inbox_message_id = m.id);

-- 2. awaiting_cloud — classify routed to cloud, draft call in flight
INSERT INTO mailbox.inbox_messages
  (message_id, from_addr, to_addr, subject, body, received_at, classification, confidence, classified_at, model)
VALUES
  ('seed-dev-002', 'mark@damaged-shipment.example', 'op@example.com',
   'URGENT: damaged shipment, missing units',
   'Half the cases arrived damaged and 30 units missing. Need replacement before Friday or we cancel.',
   NOW() - interval '15 minutes',
   'escalate', 0.96, NOW() - interval '15 minutes', 'qwen3:4b-ctx4k')
ON CONFLICT (message_id) DO NOTHING;

INSERT INTO mailbox.drafts
  (inbox_message_id, draft_body, model, status,
   draft_source, classification_category, classification_confidence,
   from_addr, to_addr, subject, body_text, received_at)
SELECT m.id, '(awaiting cloud draft…)',
       'gpt-oss:120b', 'awaiting_cloud', 'cloud', 'escalate', 0.96,
       m.from_addr, m.to_addr, m.subject, m.body, m.received_at
FROM mailbox.inbox_messages m
WHERE m.message_id = 'seed-dev-002'
  AND NOT EXISTS (SELECT 1 FROM mailbox.drafts WHERE inbox_message_id = m.id);

-- 3. edited — operator has tweaked the draft, ready to approve
INSERT INTO mailbox.inbox_messages
  (message_id, from_addr, to_addr, subject, body, received_at, classification, confidence, classified_at, model)
VALUES
  ('seed-dev-003', 'jamie@retailer.example', 'op@example.com',
   'Sample request for new sour line',
   'We''d love to taste the new sour line. Can you ship 2 cases to our HQ this week?',
   NOW() - interval '1 hour',
   'inquiry', 0.88, NOW() - interval '1 hour', 'qwen3:4b-ctx4k')
ON CONFLICT (message_id) DO NOTHING;

INSERT INTO mailbox.drafts
  (inbox_message_id, draft_subject, draft_body, model, status,
   draft_source, classification_category, classification_confidence,
   from_addr, to_addr, subject, body_text, received_at)
SELECT m.id, 'Re: Sample request for new sour line',
       E'Hi Jamie,\n\n[Operator tweak] Happy to get samples out — shipping 2 cases of the sour line via FedEx tomorrow. Tracking will follow.\n\nBest,\nOps',
       'qwen3:4b-ctx4k', 'edited', 'local', 'inquiry', 0.88,
       m.from_addr, m.to_addr, m.subject, m.body, m.received_at
FROM mailbox.inbox_messages m
WHERE m.message_id = 'seed-dev-003'
  AND NOT EXISTS (SELECT 1 FROM mailbox.drafts WHERE inbox_message_id = m.id);

-- 4. approved — webhook fired, send in flight (still pending sent_at)
INSERT INTO mailbox.inbox_messages
  (message_id, from_addr, to_addr, subject, body, received_at, classification, confidence, classified_at, model)
VALUES
  ('seed-dev-004', 'tina@scheduler.example', 'op@example.com',
   'Tasting next Tuesday at 2pm?',
   'Can we lock in a tasting for next Tuesday 2pm at your warehouse?',
   NOW() - interval '3 hours',
   'scheduling', 0.91, NOW() - interval '3 hours', 'qwen3:4b-ctx4k')
ON CONFLICT (message_id) DO NOTHING;

INSERT INTO mailbox.drafts
  (inbox_message_id, draft_subject, draft_body, model, status,
   draft_source, classification_category, classification_confidence, approved_at,
   from_addr, to_addr, subject, body_text, received_at)
SELECT m.id, 'Re: Tasting next Tuesday at 2pm?',
       E'Hi Tina,\n\nTuesday 2pm works — see you at the warehouse.\n\nBest,\nOps',
       'qwen3:4b-ctx4k', 'approved', 'local', 'scheduling', 0.91, NOW() - interval '5 minutes',
       m.from_addr, m.to_addr, m.subject, m.body, m.received_at
FROM mailbox.inbox_messages m
WHERE m.message_id = 'seed-dev-004'
  AND NOT EXISTS (SELECT 1 FROM mailbox.drafts WHERE inbox_message_id = m.id);

-- 5. failed — Gmail send failed, surfaces in the Failed Sends panel for retry
INSERT INTO mailbox.inbox_messages
  (message_id, from_addr, to_addr, subject, body, received_at, classification, confidence, classified_at, model)
VALUES
  ('seed-dev-005', 'lee@vendor.example', 'op@example.com',
   'Q2 pricing update',
   'Heads up: Q2 pricing is up 4%. Reply to confirm acceptance.',
   NOW() - interval '6 hours',
   'follow_up', 0.82, NOW() - interval '6 hours', 'qwen3:4b-ctx4k')
ON CONFLICT (message_id) DO NOTHING;

INSERT INTO mailbox.drafts
  (inbox_message_id, draft_subject, draft_body, model, status, error_message,
   draft_source, classification_category, classification_confidence,
   from_addr, to_addr, subject, body_text, received_at)
SELECT m.id, 'Re: Q2 pricing update',
       E'Hi Lee,\n\nAcknowledged — will review and confirm by Friday.\n\nBest,\nOps',
       'qwen3:4b-ctx4k', 'failed',
       'Webhook returned 502: gmail token refresh failed (test-mode error)',
       'local', 'follow_up', 0.82,
       m.from_addr, m.to_addr, m.subject, m.body, m.received_at
FROM mailbox.inbox_messages m
WHERE m.message_id = 'seed-dev-005'
  AND NOT EXISTS (SELECT 1 FROM mailbox.drafts WHERE inbox_message_id = m.id);

-- 6. sent — completed historic draft (sent_at populated)
INSERT INTO mailbox.inbox_messages
  (message_id, from_addr, to_addr, subject, body, received_at, classification, confidence, classified_at, model)
VALUES
  ('seed-dev-006', 'priya@brand.example', 'op@example.com',
   'Reorder confirmed — thanks',
   'Confirming our reorder of 50 cases. Appreciate the fast turnaround.',
   NOW() - interval '2 days',
   'reorder', 0.95, NOW() - interval '2 days', 'qwen3:4b-ctx4k')
ON CONFLICT (message_id) DO NOTHING;

INSERT INTO mailbox.drafts
  (inbox_message_id, draft_subject, draft_body, model, status,
   draft_source, classification_category, classification_confidence,
   approved_at, sent_at,
   from_addr, to_addr, subject, body_text, received_at)
SELECT m.id, 'Re: Reorder confirmed — thanks',
       E'Hi Priya,\n\nGlad it worked out — invoice in your inbox shortly.\n\nBest,\nOps',
       'qwen3:4b-ctx4k', 'sent', 'local', 'reorder', 0.95,
       NOW() - interval '2 days' + interval '3 minutes',
       NOW() - interval '2 days' + interval '4 minutes',
       m.from_addr, m.to_addr, m.subject, m.body, m.received_at
FROM mailbox.inbox_messages m
WHERE m.message_id = 'seed-dev-006'
  AND NOT EXISTS (SELECT 1 FROM mailbox.drafts WHERE inbox_message_id = m.id);

COMMIT;

-- Quick check:
SELECT d.id, d.status, d.classification_category, d.draft_source, m.from_addr, m.subject
FROM mailbox.drafts d
JOIN mailbox.inbox_messages m ON m.id = d.inbox_message_id
WHERE m.message_id LIKE 'seed-dev-%'
ORDER BY d.id;
