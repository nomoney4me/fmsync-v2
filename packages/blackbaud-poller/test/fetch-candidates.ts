/**
 * Test script: fetch candidates from AFE-EDEMS API.
 * GET https://api.sky.blackbaud.com/afe-edems/v1/candidates
 *
 * Credentials from .env (repo root). Params from CLI or env (BB_CANDIDATES_*).
 *
 * Usage (no args; uses .env and default size=10, page=1):
 *   npm run test:fetch-candidates
 *
 * With params use -- before script args (so npm doesn't eat them):
 *   npm run test:fetch-candidates -- --school_year "2024 - 2025" --size 5
 * Or set in .env: BB_CANDIDATES_SCHOOL_YEAR=2024 - 2025
 */
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'fs';
import path from 'path';

// .env is at repo root; from package cwd use ../../ for root
const envPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
  path.resolve(__dirname, '../../../.env'),
  path.resolve(__dirname, '../../.env'),
];
const envPath = envPaths.find((p) => existsSync(p));
if (!envPath) {
  console.error('.env not found. Tried:', envPaths);
  process.exit(1);
}
loadEnv({ path: envPath });

import { fetchCandidatesPage, loadStoredRefreshToken } from '../src/blackbaud-client';
import type { CandidatesQueryParams } from '../src/blackbaud-client';

function parseArgs(): CandidatesQueryParams {
  // Prefer .env: BB_CANDIDATES_SCHOOL_YEAR, BB_CANDIDATES_STATUS, etc.
  const params: CandidatesQueryParams = {
    school_year: process.env.BB_CANDIDATES_SCHOOL_YEAR || undefined,
    status: process.env.BB_CANDIDATES_STATUS || undefined,
    modified_date: process.env.BB_CANDIDATES_MODIFIED_DATE || undefined,
    size: process.env.BB_CANDIDATES_SIZE ? parseInt(process.env.BB_CANDIDATES_SIZE, 10) : undefined,
    page: process.env.BB_CANDIDATES_PAGE ? parseInt(process.env.BB_CANDIDATES_PAGE, 10) : undefined,
    school_level: process.env.BB_CANDIDATES_SCHOOL_LEVEL ? parseInt(process.env.BB_CANDIDATES_SCHOOL_LEVEL, 10) : undefined,
  };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--school_year' && args[i + 1]) {
      params.school_year = args[i + 1];
      i++;
    } else if (args[i] === '--status' && args[i + 1]) {
      params.status = args[i + 1];
      i++;
    } else if (args[i] === '--modified_date' && args[i + 1]) {
      params.modified_date = args[i + 1];
      i++;
    } else if (args[i] === '--size' && args[i + 1]) {
      params.size = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--page' && args[i + 1]) {
      params.page = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--school_level' && args[i + 1]) {
      params.school_level = parseInt(args[i + 1], 10);
      i++;
    }
  }
  return params;
}

async function main() {
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
    console.error('Missing env: BLACKBAUD_REFRESH_TOKEN, BB_API_SUBSCRIPTION_KEY1 or BB_API_SUBSCRIPTION_KEY2');
    process.exit(1);
  }
  if (!config.clientId || !config.clientSecret) {
    console.error('Missing env: BLACKBAUD_CLIENT_ID, BLACKBAUD_CLIENT_SECRET');
    process.exit(1);
  }

  const params = parseArgs();
  params.size = params.size ?? 10;
  params.page = params.page ?? 1;

  console.log('Fetching candidates with params:', JSON.stringify(params, null, 2));
  const result = await fetchCandidatesPage(config, params);

  const count = result.count ?? result.value?.length ?? 0;
  const list = result.value ?? [];
  console.log('\nResponse count:', count);
  console.log('Candidates in this page:', list.length);
  if (list.length > 0) {
    console.log('\nFirst candidate (summary):');
    const c = list[0];
    console.log(
      JSON.stringify(
        {
          user_id: c.user?.id,
          first_name: c.user?.first_name,
          last_name: c.user?.last_name,
          entering_year: c.entering_year?.description,
          candidate_status: c.candidate_status,
          school_decision: c.school_decision?.decision?.description,
          candidate_checklist: c.candidate_checklist,
        },
        null,
        2
      )
    );
    if (list.length > 1) {
      console.log('\n... and', list.length - 1, 'more candidate(s).');
    }
  }
  if (process.argv.includes('--full')) {
    console.log('\nFull response:');
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
