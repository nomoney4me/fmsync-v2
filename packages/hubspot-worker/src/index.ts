/**
 * HubSpot Update Worker (Step 6): consume queue, POST to HubSpot, retry on failure
 * TODO: Implement in Phase 3
 */
import 'dotenv/config';
import { createLogger } from '@fm-sync/shared';

const log = createLogger('hubspot-worker', 'hs');

async function main() {
  log.info('Service ready. Queue consumer logic coming in Phase 3.');
  setInterval(() => {}, 60000);
}

main().catch((err) => log.error({ err }, 'Fatal error'));
