/**
 * Test script: fetch a specific candidate's checklist.
 * Uses the AFE-EDEMS API: GET /afe-edems/v1/checklists/{candidate_id}?entering_year=...
 *
 * Usage:
 *   npm run test:fetch-candidate -- --candidate 1234 --year "2024 - 2025"
 */
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'fs';
import path from 'path';

const envPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../.env'),
];
const envPath = envPaths.find((p) => existsSync(p));
if (!envPath) {
  console.error('.env not found');
  process.exit(1);
}
loadEnv({ path: envPath });

import { fetchCandidateChecklist, loadStoredRefreshToken } from '../src/blackbaud-client';

async function main() {
  const args = process.argv.slice(2);
  let candidateId: string | number | null = null;
  let enteringYear: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--candidate' && args[i + 1]) {
      candidateId = args[i + 1];
      const n = parseInt(candidateId, 10);
      if (!isNaN(n)) candidateId = n;
      i++;
    } else if (args[i] === '--year' && args[i + 1]) {
      enteringYear = args[i + 1];
      i++;
    }
  }

  if (!candidateId || !enteringYear) {
    console.error('Usage: --candidate <id> --year "2024 - 2025"');
    process.exit(1);
  }

  const config = {
    clientId: process.env.BLACKBAUD_CLIENT_ID!,
    clientSecret: process.env.BLACKBAUD_CLIENT_SECRET!,
    refreshToken: loadStoredRefreshToken() || '',
    apiBaseUrl: process.env.BLACKBAUD_API_BASE_URL || 'https://api.sky.blackbaud.com',
    subscriptionKey:
      process.env.BB_API_SUBSCRIPTION_KEY1 ||
      process.env.BB_API_SUBSCRIPTION_KEY2 ||
      process.env.BLACKBAUD_SUBSCRIPTION_KEY!,
  };

  if (!config.refreshToken || !config.subscriptionKey) {
    console.error('Missing env: BLACKBAUD_REFRESH_TOKEN, BB_API_SUBSCRIPTION_KEY1/2');
    process.exit(1);
  }

  console.log(`Fetching checklist for candidate ${candidateId}, year: ${enteringYear}...`);
  const result = await fetchCandidateChecklist(config, candidateId, enteringYear);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
