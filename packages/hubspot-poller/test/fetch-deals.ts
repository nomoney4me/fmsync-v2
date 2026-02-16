/**
 * One-off test: fetch HubSpot deals and upsert to hubspot_deals.
 * Run from project root: npm run test:fetch-deals -w @fm-sync/hubspot-poller
 */
import { config as loadEnv } from 'dotenv';
import path from 'path';

loadEnv({ path: path.resolve(process.cwd(), '.env') });

import { Client } from '@hubspot/api-client';
import { Pool } from 'pg';
import { createLogger } from '@fm-sync/shared';

const log = createLogger('hubspot-poller-test', 'hs');
const BLACKBAUD_PROP = process.env.HUBSPOT_DEAL_PROPERTY_BLACKBAUD_ID || 'blackbaud_user_id';
const DEAL_PROPERTIES = [
  BLACKBAUD_PROP,
  'createdate',
  'deal_substage_new',
  'dealname',
  'dealstage',
  'hs_lastmodifieddate',
  'hs_object_id',
  'isp_entry_year',
  'pipeline',
];

async function main() {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    log.error('Missing HUBSPOT_ACCESS_TOKEN');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = new Client({ accessToken: token });

  try {
    log.info('Fetching deals from HubSpot...');
    const allDeals = await client.crm.deals.getAll(100, undefined, DEAL_PROPERTIES);
    log.info({ count: allDeals.length }, 'Fetched deals');

    if (allDeals.length === 0) {
      log.info('No deals to upsert');
      return;
    }

    const db = await pool.connect();
    try {
      let upserted = 0;
      const BATCH_SIZE = 100;
      const deals = allDeals as { id: string; properties?: Record<string, string> }[];

      for (let i = 0; i < deals.length; i += BATCH_SIZE) {
        const batch = deals.slice(i, i + BATCH_SIZE);
        const values: unknown[] = [];
        const placeholders: string[] = [];
        let param = 1;
        for (const r of batch) {
          const props = r.properties ?? {};
          const bbVal = props[BLACKBAUD_PROP];
          const bbId = bbVal ? (parseInt(bbVal, 10) || null) : null;
          placeholders.push(
            `($${param},$${param + 1},$${param + 2},$${param + 3},$${param + 4},$${param + 5},$${param + 6},$${param + 7},$${param + 8},$${param + 9},$${param + 10},NOW())`
          );
          values.push(
            r.id,
            bbId,
            props.createdate ?? null,
            props.deal_substage_new ?? null,
            props.dealname ?? null,
            props.dealstage ?? null,
            props.hs_lastmodifieddate ?? null,
            props.hs_object_id ?? null,
            props.isp_entry_year ?? null,
            props.pipeline ?? null
          );
          param += 11;
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
      log.info({ upserted }, 'Upserted to hubspot_deals');
    } finally {
      db.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  log.error({ err }, 'Failed');
  process.exit(1);
});
