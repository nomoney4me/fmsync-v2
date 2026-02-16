-- FM Sync Database Schema - Blackbaud
-- HubSpot schema in 01-hspot-schema.sql

-- Blackbaud checklist items (polled from Sky API)
CREATE TABLE IF NOT EXISTS checklist_items (
  id SERIAL PRIMARY KEY,
  user_id                BIGINT,
  first_name             TEXT,
  last_name              TEXT,
  checklist_id           BIGINT,
  checklist_name         TEXT,
  checklist_item_id      BIGINT,
  date_completed         DATE,
  checklist_item         TEXT,
  contract_status        TEXT,
  inactive_reason        TEXT,
  candidate_decision     TEXT,
  school_decision        TEXT,
  reason_declined        TEXT,
  inactive               TEXT,
  contract_year          TEXT,
  contract_send_date     DATE,
  contract_return_date   DATE,
  contract_publish_date  DATE,
  entering_grade         TEXT,
  candidate_entering_year TEXT,
  candidate_status       TEXT,
  date_requested         DATE,
  date_due               DATE,
  date_waived            DATE,
  test_rescheduled       DATE,
  test_no_show           DATE,
  contract_type          TEXT,
  test_short_description TEXT,
  contract_dep_rec_date  DATE,
  polled_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checklist_items_user_id ON checklist_items(user_id);
CREATE INDEX IF NOT EXISTS idx_checklist_items_checklist_item_id ON checklist_items(checklist_item_id);
CREATE INDEX IF NOT EXISTS idx_checklist_items_polled_at ON checklist_items(polled_at DESC);

-- Queue for HubSpot deal updates
DO $$ BEGIN
  CREATE TYPE queue_status AS ENUM ('pending', 'processing', 'success', 'failed', 'dead');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS hubspot_update_queue (
  id SERIAL PRIMARY KEY,
  deal_id VARCHAR(255) NOT NULL,
  payload_json JSONB NOT NULL,
  status queue_status NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_retry_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON hubspot_update_queue(status);
CREATE INDEX IF NOT EXISTS idx_queue_next_retry ON hubspot_update_queue(next_retry_at) WHERE status IN ('pending', 'failed');

-- Audit log for sync steps
CREATE TABLE IF NOT EXISTS sync_logs (
  id SERIAL PRIMARY KEY,
  step VARCHAR(50) NOT NULL,
  records_count INT,
  status VARCHAR(20) NOT NULL,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_step ON sync_logs(step);
CREATE INDEX IF NOT EXISTS idx_sync_logs_created ON sync_logs(created_at DESC);

-- Error log for debugging and retry
CREATE TABLE IF NOT EXISTS error_logs (
  id SERIAL PRIMARY KEY,
  source VARCHAR(100) NOT NULL,
  error_message TEXT NOT NULL,
  context_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_error_logs_source ON error_logs(source);
CREATE INDEX IF NOT EXISTS idx_error_logs_created ON error_logs(created_at DESC);
