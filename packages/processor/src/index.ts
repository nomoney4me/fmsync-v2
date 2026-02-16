/**
 * Processor: match by blackbaud_id, transform, enqueue (Steps 3–5)
 * TODO: Implement in Phase 3
 */
import 'dotenv/config';
import { createLogger } from '@fm-sync/shared';

const log = createLogger('processor', 'proc');

async function main() {
  log.info('Service ready. Match/transform/enqueue logic coming in Phase 3.');
  setInterval(() => {}, 60000);
}

main().catch((err) => log.error({ err }, 'Fatal error'));
