/**
 * Test script: fetch a single page from the Blackbaud Advance list.
 * Uses the same tools and methods as the blackbaud-poller.
 *
 * Usage:
 *   npm run test:fetch-page -w @fm-sync/blackbaud-poller           # fetches page 100
 *   npm run test:fetch-page -w @fm-sync/blackbaud-poller -- --page 5  # fetches page 5
 *   TEST_PAGE=50 npm run test:fetch-page -w @fm-sync/blackbaud-poller
 */
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'fs';
import path from 'path';

// Load .env from project root (try cwd first, then relative to this file)
const envPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../.env'),
];
const envPath = envPaths.find((p) => existsSync(p));
if (!envPath) {
  console.error(`.env not found. Tried: ${envPaths.join(', ')} (cwd: ${process.cwd()})`);
  process.exit(1);
}
loadEnv({ path: envPath });

import { fetchChecklistListPage, loadStoredRefreshToken } from '../src/blackbaud-client';
import { mapItemToChecklist } from '../src/map-to-checklist';

async function main() {
  const pageArg = process.argv.find((a) => a.startsWith('--page'));
  let pageFromArg: number | null = null;
  if (pageArg) {
    if (pageArg.includes('=')) pageFromArg = parseInt(pageArg.split('=')[1], 10);
    else {
      const i = process.argv.indexOf('--page');
      if (i >= 0 && process.argv[i + 1]) pageFromArg = parseInt(process.argv[i + 1], 10);
    }
  }
  const page = pageFromArg ?? parseInt(process.env.TEST_PAGE || '100', 10);

  const config = {
    clientId: process.env.BLACKBAUD_CLIENT_ID!,
    clientSecret: process.env.BLACKBAUD_CLIENT_SECRET!,
    refreshToken: loadStoredRefreshToken() || '',
    apiBaseUrl: process.env.BLACKBAUD_API_BASE_URL || 'https://api.sky.blackbaud.com',
    subscriptionKey: process.env.BB_API_SUBSCRIPTION_KEY1 || process.env.BB_API_SUBSCRIPTION_KEY2 || process.env.BLACKBAUD_SUBSCRIPTION_KEY!,
    listId: process.env.BB_CHECKLIST_ADVANCE_LIST_ID || process.env.BLACKBAUD_CHECKLIST_LIST_ID!,
  };

  if (!config.refreshToken || !config.subscriptionKey || !config.listId) {
    console.error('Missing env: BLACKBAUD_REFRESH_TOKEN, BB_API_SUBSCRIPTION_KEY1/2, BB_CHECKLIST_ADVANCE_LIST_ID');
    process.exit(1);
  }

  console.log(`Fetching page ${page}...`);
  const items = await fetchChecklistListPage(config, page);
  console.log(`Fetched ${items.length} raw items`);

  const rows = items.map((item) => mapItemToChecklist(item));
  console.log(`Mapped to ${rows.length} checklist rows`);

  if (rows.length > 0) {
    console.log('\nSample row (first):');
    console.log(JSON.stringify(rows[0], null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
