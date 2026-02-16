-- Candidate checklist items from AFE-EDEMS Candidates API + Checklist API.
-- Separate from checklist_items so the Advance list workflow is unchanged.
-- Run after 01-bb-schema.sql (and 02-checklist-diff.sql if using Advance list).

CREATE TABLE IF NOT EXISTS candidate_checklist_items (
  id SERIAL PRIMARY KEY,
  user_id                BIGINT,
  first_name             TEXT,
  last_name              TEXT,
  checklist_id           BIGINT,
  checklist_name         TEXT,
  checklist_item_id      BIGINT,
  checklist_item         TEXT,
  step_status            TEXT,
  date_completed         DATE,
  date_requested         DATE,
  date_due               DATE,
  date_waived            DATE,
  candidate_decision     TEXT,
  school_decision        TEXT,
  reason_declined        TEXT,
  contract_publish_date   DATE,
  contract_return_date    DATE,
  contract_dep_rec_date   DATE,
  entering_grade          TEXT,
  candidate_entering_year TEXT,
  candidate_status       TEXT,
  inactive               TEXT,
  test_no_show           TEXT,
  test_short_description TEXT,
  polled_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Uniqueness includes school year so same checklist/item in different years are separate rows
DROP INDEX IF EXISTS idx_candidate_checklist_items_unique_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_checklist_items_unique_key
  ON candidate_checklist_items (user_id, checklist_id, checklist_item_id, candidate_entering_year)
  WHERE user_id IS NOT NULL AND checklist_id IS NOT NULL AND checklist_item_id IS NOT NULL AND candidate_entering_year IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_candidate_checklist_items_user_id ON candidate_checklist_items(user_id);
CREATE INDEX IF NOT EXISTS idx_candidate_checklist_items_polled_at ON candidate_checklist_items(polled_at DESC);

-- Add step_status/date_waived for existing tables (idempotent)
ALTER TABLE candidate_checklist_items ADD COLUMN IF NOT EXISTS step_status TEXT;
ALTER TABLE candidate_checklist_items ADD COLUMN IF NOT EXISTS date_waived DATE;
