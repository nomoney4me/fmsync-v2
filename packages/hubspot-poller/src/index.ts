/**
 * HubSpot Deals Poller (Step 2)
 * Fetches deals via @hubspot/api-client and upserts into hubspot_deals.
 * Matches checklist_items.user_id via hubspot_deals.blackbaud_user_id for processor.
 */
import { config as loadEnv } from 'dotenv';
import path from 'path';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';

loadEnv({ path: path.resolve(process.cwd(), '.env') });

import cron from 'node-cron';
import { Client } from '@hubspot/api-client';
import { Pool } from 'pg';
import { createLogger } from '@fm-sync/shared';
import { fetchDealsSearch } from './fetch-deals';

const log = createLogger('hubspot-poller', 'hs');

// Separate defaults for dev vs prod so they can be overridden independently (e.g. HUBSPOT_POLL_CRON_DEV / HUBSPOT_POLL_CRON_PROD)
const POLL_CRON_DEV = process.env.HUBSPOT_POLL_CRON_DEV || '*/5 * * * *';
const POLL_CRON_PROD = process.env.HUBSPOT_POLL_CRON_PROD || '*/5 * * * *';
const POLL_CRON =
  process.env.HUBSPOT_POLL_CRON ||
  (process.env.NODE_ENV === 'production' ? POLL_CRON_PROD : POLL_CRON_DEV);
const BLACKBAUD_PROP = process.env.HUBSPOT_DEAL_PROPERTY_BLACKBAUD_ID || 'blackbaud_user_id';

const STATUS_DIR = path.resolve(__dirname, '../../../status');
const RUNNING_FILE =
  process.env.HUBSPOT_RUNNING_FILE || path.join(STATUS_DIR, 'hubspot-poller.running');
const RUNNING_STALE_MS =
  (parseInt(process.env.HUBSPOT_RUNNING_STALE_HOURS || '1', 10) || 1) * 60 * 60 * 1000;

const BATCH_SIZE = 100;

interface DealRecord {
  deal_id: string;
  blackbaud_user_id: number | null;
  createdate: string | null;
  deal_substage_new: string | null;
  dealname: string | null;
  dealstage: string | null;
  hs_lastmodifieddate: string | null;
  hs_object_id: string | null;
  isp_entry_year: string | null;
  pipeline: string | null;
}

function parseDeal(r: { id: string; properties?: Record<string, string> }): DealRecord {
  const props = r.properties ?? {};
  const blackbaudUserId = props[BLACKBAUD_PROP];
  const bbNum = blackbaudUserId ? parseInt(blackbaudUserId, 10) : null;
  const bbId = bbNum != null && !isNaN(bbNum) ? bbNum : null;

  return {
    deal_id: r.id,
    blackbaud_user_id: bbId,
    createdate: props.createdate ?? null,
    deal_substage_new: props.deal_substage_new ?? null,
    dealname: props.dealname ?? null,
    dealstage: props.dealstage ?? null,
    hs_lastmodifieddate: props.hs_lastmodifieddate ?? null,
    hs_object_id: props.hs_object_id ?? null,
    isp_entry_year: props.isp_entry_year ?? null,
    pipeline: props.pipeline ?? null,
  };
}

async function poll(): Promise<void> {
  if (existsSync(RUNNING_FILE)) {
    try {
      const data = JSON.parse(readFileSync(RUNNING_FILE, 'utf8'));
      const started = data.started_at ? new Date(data.started_at).getTime() : 0;
      if (Date.now() - started >= RUNNING_STALE_MS) {
        try {
          unlinkSync(RUNNING_FILE);
        } catch {
          log.warn({ path: RUNNING_FILE }, 'Could not remove stale .running file');
          return;
        }
        log.info({ started_at: data.started_at }, 'Removed stale .running file, starting poll');
      } else {
        log.info('Poll already in progress, skipping');
        return;
      }
    } catch {
      try {
        unlinkSync(RUNNING_FILE);
      } catch {
        log.warn({ path: RUNNING_FILE }, 'Could not remove invalid .running file');
        return;
      }
      log.info('Removed invalid .running file, starting poll');
    }
  }

  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    log.error('Missing HUBSPOT_ACCESS_TOKEN');
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    mkdirSync(STATUS_DIR, { recursive: true });
  } catch (e) {
    log.warn({ dir: STATUS_DIR, err: e }, 'Could not create status dir');
  }
  writeFileSync(
    RUNNING_FILE,
    JSON.stringify({ started_at: new Date().toISOString(), status: 'running' }, null, 2),
    'utf8'
  );

  try {
    const client = new Client({ accessToken: token });
    const modifiedAfter = process.env.HUBSPOT_MODIFIED_AFTER
      ? parseInt(process.env.HUBSPOT_MODIFIED_AFTER, 10)
      : undefined;
    const allDeals = await fetchDealsSearch(client, {
      accessToken: token,
      blackbaudProperty: BLACKBAUD_PROP,
      limit: 100,
      modifiedAfter: Number.isFinite(modifiedAfter) ? modifiedAfter : undefined,
    });

    if (allDeals.length === 0) {
      await pool.query(
        `INSERT INTO sync_logs (step, records_count, status, message) VALUES ($1, $2, $3, $4)`,
        ['hubspot-poller', 0, 'ok', 'No deals returned']
      );
      log.info('Poll complete: 0 deals');
      return;
    }

    const records: DealRecord[] = allDeals.map((r) => parseDeal(r));

    const db = await pool.connect();
    let upserted = 0;
    try {
      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);
        const values: unknown[] = [];
        const placeholders: string[] = [];
        let param = 1;
        for (const row of batch) {
          placeholders.push(
            `($${param},$${param + 1},$${param + 2},$${param + 3},$${param + 4},$${param + 5},$${param + 6},$${param + 7},$${param + 8},$${param + 9},NOW())`
          );
          values.push(
            row.deal_id,
            row.blackbaud_user_id,
            row.createdate,
            row.deal_substage_new,
            row.dealname,
            row.dealstage,
            row.hs_lastmodifieddate,
            row.hs_object_id,
            row.isp_entry_year,
            row.pipeline
          );
          param += 10;
        }

        await db.query(
          `INSERT INTO hubspot_deals (
            deal_id, blackbaud_user_id, createdate, deal_substage_new, dealname, dealstage,
            hs_lastmodifieddate, hs_object_id, isp_entry_year, pipeline, polled_at
          ) VALUES ${placeholders.join(',')}
          ON CONFLICT (deal_id) DO UPDATE SET
            blackbaud_user_id = EXCLUDED.blackbaud_user_id,
            createdate = EXCLUDED.createdate,
            deal_substage_new = EXCLUDED.deal_substage_new,
            dealname = EXCLUDED.dealname,
            dealstage = EXCLUDED.dealstage,
            hs_lastmodifieddate = EXCLUDED.hs_lastmodifieddate,
            hs_object_id = EXCLUDED.hs_object_id,
            isp_entry_year = EXCLUDED.isp_entry_year,
            pipeline = EXCLUDED.pipeline,
            polled_at = NOW()`,
          values
        );
        upserted += batch.length;
      }

      await db.query(
        `INSERT INTO sync_logs (step, records_count, status, message) VALUES ($1, $2, $3, $4)`,
        ['hubspot-poller', upserted, 'ok', `Upserted ${upserted} deals`]
      );
      log.info({ dealsCount: records.length, upserted }, 'Poll complete');
    } finally {
      db.release();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Poll failed');
    await pool.query(
      `INSERT INTO sync_logs (step, records_count, status, message) VALUES ($1, $2, $3, $4)`,
      ['hubspot-poller', 0, 'error', msg]
    );
    await pool.query(
      `INSERT INTO error_logs (source, error_message, context_json) VALUES ($1, $2, $3)`,
      ['hubspot-poller', msg, JSON.stringify({ stack: err instanceof Error ? err.stack : undefined })]
    );
  } finally {
    await pool.end();
    try {
      unlinkSync(RUNNING_FILE);
    } catch {
      log.warn({ path: RUNNING_FILE }, 'Could not remove .running file');
    }
  }
}

function main() {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) {
    log.info({ schedule: POLL_CRON }, 'Starting (cron + initial poll)');
    cron.schedule(POLL_CRON, poll);
  } else {
    log.info('Starting (dev: initial poll only, no cron)');
  }
  poll().catch((err) => log.error({ err }, 'Initial poll error'));
}

main();
