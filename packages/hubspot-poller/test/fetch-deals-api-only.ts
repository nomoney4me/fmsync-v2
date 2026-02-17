/**
 * Quick test: fetch deals from HubSpot API only (no database).
 * Run from project root: npm run test:fetch-deals-api -w @fm-sync/hubspot-poller
 */
import { config as loadEnv } from 'dotenv';
import path from 'path';
import fs from 'fs';

// When run via npm -w, cwd is packages/hubspot-poller; .env lives at repo root
const rootEnv = path.resolve(process.cwd(), '../../.env');
const cwdEnv = path.resolve(process.cwd(), '.env');
loadEnv({ path: fs.existsSync(rootEnv) ? rootEnv : cwdEnv });

import { Client } from '@hubspot/api-client';
import { fetchDealsSearch } from '../src/fetch-deals';

const BLACKBAUD_PROP = process.env.HUBSPOT_DEAL_PROPERTY_BLACKBAUD_ID || 'blackbaud_user_id';

async function main() {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    console.error('Missing HUBSPOT_ACCESS_TOKEN in .env');
    process.exit(1);
  }

  const client = new Client({ accessToken: token });

  console.log('Fetching all deals with blackbaud_id from HubSpot (sort by modified desc)...');
  const allDeals = await fetchDealsSearch(client, {
    accessToken: token,
    blackbaudProperty: BLACKBAUD_PROP,
    limit: 200,
  });
  console.log('Fetched', allDeals.length, 'deals total\n');

  if (allDeals.length === 0) {
    console.log('No deals with blackbaud_id in this account.');
    return;
  }

  console.log('Sample (first 3):');
  allDeals.slice(0, 3).forEach((d, i) => {
    const p = d.properties ?? {};
    console.log(
      `  ${i + 1}. id=${d.id} dealname="${p.dealname ?? '-'}" dealstage=${p.dealstage ?? '-'} ${BLACKBAUD_PROP}=${p[BLACKBAUD_PROP] ?? '-'}`
    );
  });
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
