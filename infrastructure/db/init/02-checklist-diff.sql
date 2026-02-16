-- Diff detection: unique constraint + queue for new/changed checklist rows
--
-- Flow:
-- 1. Poll checklist data (current) -> stored in checklist_items
-- 2. Next poll = new data; upsert into checklist_items; if diff (new or changed),
--    log (user_id, checklist_id, checklist_item_id) to checklist_diff_queue
-- 3. Processor reads checklist_diff_queue, runs dealstage_transformer for that user_id
-- 4. Processor pushes calculated (dealstage, subdealstage) to hubspot_update_queue
--
-- Run manually if DB already initialized: psql $DATABASE_URL -f infrastructure/db/init/02-checklist-diff.sql

-- Dedupe: keep latest row per (user_id, checklist_id, checklist_item_id)
DELETE FROM checklist_items a
USING checklist_items b
WHERE a.id < b.id
  AND a.user_id IS NOT DISTINCT FROM b.user_id
  AND a.checklist_id IS NOT DISTINCT FROM b.checklist_id
  AND a.checklist_item_id IS NOT DISTINCT FROM b.checklist_item_id
  AND a.user_id IS NOT NULL
  AND a.checklist_id IS NOT NULL
  AND a.checklist_item_id IS NOT NULL;

-- Unique constraint for upsert (exclude rows with nulls in key columns)
CREATE UNIQUE INDEX IF NOT EXISTS idx_checklist_items_unique_key
  ON checklist_items (user_id, checklist_id, checklist_item_id)
  WHERE user_id IS NOT NULL AND checklist_id IS NOT NULL AND checklist_item_id IS NOT NULL;

-- Queue for rows that need dealstage processing (new or changed)
CREATE TABLE IF NOT EXISTS checklist_diff_queue (
  id SERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  checklist_id BIGINT NOT NULL,
  checklist_item_id BIGINT NOT NULL,
  checklist_row_id INT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, checklist_id, checklist_item_id)
);

CREATE INDEX IF NOT EXISTS idx_checklist_diff_queue_status ON checklist_diff_queue(status);

-- Trigger: enqueue new or changed rows for dealstage processing
CREATE OR REPLACE FUNCTION checklist_diff_enqueue_fn() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO checklist_diff_queue (user_id, checklist_id, checklist_item_id, checklist_row_id, status)
    VALUES (NEW.user_id, NEW.checklist_id, NEW.checklist_item_id, NEW.id, 'pending')
    ON CONFLICT (user_id, checklist_id, checklist_item_id)
    DO UPDATE SET status = 'pending', checklist_row_id = EXCLUDED.checklist_row_id, created_at = NOW();
  ELSIF TG_OP = 'UPDATE' AND (
    OLD.first_name IS DISTINCT FROM NEW.first_name
    OR OLD.last_name IS DISTINCT FROM NEW.last_name
    OR OLD.date_completed IS DISTINCT FROM NEW.date_completed
    OR OLD.checklist_item IS DISTINCT FROM NEW.checklist_item
    OR OLD.contract_status IS DISTINCT FROM NEW.contract_status
    OR OLD.inactive_reason IS DISTINCT FROM NEW.inactive_reason
    OR OLD.candidate_decision IS DISTINCT FROM NEW.candidate_decision
    OR OLD.school_decision IS DISTINCT FROM NEW.school_decision
    OR OLD.reason_declined IS DISTINCT FROM NEW.reason_declined
    OR OLD.inactive IS DISTINCT FROM NEW.inactive
    OR OLD.contract_year IS DISTINCT FROM NEW.contract_year
    OR OLD.contract_send_date IS DISTINCT FROM NEW.contract_send_date
    OR OLD.contract_return_date IS DISTINCT FROM NEW.contract_return_date
    OR OLD.contract_publish_date IS DISTINCT FROM NEW.contract_publish_date
    OR OLD.entering_grade IS DISTINCT FROM NEW.entering_grade
    OR OLD.candidate_entering_year IS DISTINCT FROM NEW.candidate_entering_year
    OR OLD.candidate_status IS DISTINCT FROM NEW.candidate_status
    OR OLD.date_requested IS DISTINCT FROM NEW.date_requested
    OR OLD.date_due IS DISTINCT FROM NEW.date_due
    OR OLD.date_waived IS DISTINCT FROM NEW.date_waived
    OR OLD.test_rescheduled IS DISTINCT FROM NEW.test_rescheduled
    OR OLD.test_no_show IS DISTINCT FROM NEW.test_no_show
    OR OLD.contract_type IS DISTINCT FROM NEW.contract_type
    OR OLD.test_short_description IS DISTINCT FROM NEW.test_short_description
    OR OLD.contract_dep_rec_date IS DISTINCT FROM NEW.contract_dep_rec_date
  ) THEN
    INSERT INTO checklist_diff_queue (user_id, checklist_id, checklist_item_id, checklist_row_id, status)
    VALUES (NEW.user_id, NEW.checklist_id, NEW.checklist_item_id, NEW.id, 'pending')
    ON CONFLICT (user_id, checklist_id, checklist_item_id)
    DO UPDATE SET status = 'pending', checklist_row_id = EXCLUDED.checklist_row_id, created_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS checklist_diff_trigger ON checklist_items;
CREATE TRIGGER checklist_diff_trigger
  AFTER INSERT OR UPDATE ON checklist_items
  FOR EACH ROW
  WHEN (
    NEW.user_id IS NOT NULL AND NEW.checklist_id IS NOT NULL AND NEW.checklist_item_id IS NOT NULL
  )
  EXECUTE PROCEDURE checklist_diff_enqueue_fn();
