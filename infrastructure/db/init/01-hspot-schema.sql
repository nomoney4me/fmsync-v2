-- FM Sync Database Schema - HubSpot
-- Polled deal data; blackbaud_user_id matches checklist_items.user_id

CREATE TABLE IF NOT EXISTS hubspot_deals (
  id SERIAL PRIMARY KEY,
  deal_id               TEXT NOT NULL UNIQUE,
  blackbaud_user_id     BIGINT,
  createdate            TEXT,
  deal_substage_new     TEXT,
  deal_substage_new_lastupdated TIMESTAMPTZ,
  dealname              TEXT,
  dealstage             TEXT,
  deal_stage_lastupdated TIMESTAMPTZ,
  hs_lastmodifieddate   TEXT,
  hs_object_id          TEXT,
  isp_entry_year        TEXT,
  pipeline              TEXT,
  polled_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hubspot_deals_blackbaud_user_id ON hubspot_deals(blackbaud_user_id);
CREATE INDEX IF NOT EXISTS idx_hubspot_deals_deal_id ON hubspot_deals(deal_id);
CREATE INDEX IF NOT EXISTS idx_hubspot_deals_polled_at ON hubspot_deals(polled_at DESC);
