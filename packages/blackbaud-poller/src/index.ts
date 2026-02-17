/**
 * Blackbaud Sky API Checklist Poller (Step 1)
 * Polls checklist items and upserts into checklist_items table.
 * Load .env first so LOG_LEVEL/LOG_FILE are set before the logger is created.
 */
import path from 'path';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
// eslint-disable-next-line import/order
import { config as loadEnv } from 'dotenv';

// Load .env from repo root or cwd so it works regardless of run directory
const envPaths = [
  path.resolve(__dirname, '../../../.env'),
  path.resolve(process.cwd(), '.env'),
];
const envLoaded = envPaths.some((p) => {
  if (existsSync(p)) {
    loadEnv({ path: p });
    return true;
  }
  return false;
});
if (!envLoaded && !process.env.DATABASE_URL) {
  console.warn('No .env found at', envPaths.join(' or '));
}
// Default log file to this package dir so fm-sync.log is next to the poller
if (!process.env.LOG_FILE) {
  process.env.LOG_FILE = path.join(__dirname, '..', 'fm-sync.log');
}

import cron from 'node-cron';
import { Pool } from 'pg';
import { createLogger } from '@fm-sync/shared';
import {
  fetchChecklistListPage,
  fetchCandidatesPage,
  fetchCandidateChecklist,
  loadStoredRefreshToken,
  type BlackbaudConfig,
  type CandidateResponse,
} from './blackbaud-client';
import type { CandidateChecklistResponse } from './blackbaud-client';
import type { ChecklistRow } from './map-to-checklist';
import { mapItemToChecklist } from './map-to-checklist';
import { mapCandidateAndChecklistToRows } from './map-from-candidate';

const log = createLogger('blackbaud-poller', 'bb');

const MAX_CONCURRENT_STORES = parseInt(process.env.BB_MAX_CONCURRENT_STORES || '5', 10);
const FETCH_CONCURRENCY = parseInt(process.env.BB_FETCH_CONCURRENCY || '5', 10);
const PAGE_SIZE = 1000;

const STATUS_DIR = path.resolve(__dirname, '../../../status');
const RUNNING_FILE =
  process.env.BB_RUNNING_FILE || path.join(STATUS_DIR, 'blackbaud-poller.running');

const RUNNING_STALE_MS =
  (parseInt(process.env.BB_RUNNING_STALE_HOURS || '1', 10) || 1) * 60 * 60 * 1000;

// Separate defaults for dev vs prod so they can be overridden independently (e.g. BLACKBAUD_POLL_CRON_DEV / BLACKBAUD_POLL_CRON_PROD)
const POLL_CRON_DEV = process.env.BLACKBAUD_POLL_CRON_DEV || '*/5 * * * *';
const POLL_CRON_PROD = process.env.BLACKBAUD_POLL_CRON_PROD || '*/5 * * * *';
const POLL_CRON =
  process.env.BLACKBAUD_POLL_CRON ||
  (process.env.NODE_ENV === 'production' ? POLL_CRON_PROD : POLL_CRON_DEV);

// When set (e.g. for system cron), run poll once and exit. Prevents multiple processes and memory growth.
const RUN_ONCE = process.env.RUN_ONCE === '1' || process.env.RUN_ONCE === 'true';

// Use AFE-EDEMS candidates API instead of Advance list (GET /afe-edems/v1/candidates).
const USE_CANDIDATES_API = process.env.BB_USE_CANDIDATES_API === '1' || process.env.BB_USE_CANDIDATES_API === 'true';
const CANDIDATES_PAGE_SIZE = parseInt(process.env.BB_CANDIDATES_SIZE || '3000', 10) || 3000;
const STORE_BATCH_SIZE = parseInt(process.env.BB_STORE_BATCH_SIZE || '500', 10) || 500;
// Only fetch checklist details for candidates modified within this many hours (reduces /checklists calls).
const CHECKLIST_FETCH_MODIFIED_HOURS = parseInt(process.env.BB_CHECKLIST_FETCH_MODIFIED_HOURS || '24', 10) || 24;

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

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const config: BlackbaudConfig = {
    clientId: process.env.BLACKBAUD_CLIENT_ID!,
    clientSecret: process.env.BLACKBAUD_CLIENT_SECRET!,
    refreshToken: loadStoredRefreshToken() || '',
    apiBaseUrl: process.env.BLACKBAUD_API_BASE_URL || 'https://api.sky.blackbaud.com',
    subscriptionKey: process.env.BB_API_SUBSCRIPTION_KEY1 || process.env.BB_API_SUBSCRIPTION_KEY2 || process.env.BLACKBAUD_SUBSCRIPTION_KEY!,
    listId: process.env.BB_CHECKLIST_ADVANCE_LIST_ID || process.env.BLACKBAUD_CHECKLIST_LIST_ID || '',
  };

  if (!config.refreshToken || !config.subscriptionKey) {
    log.error({ env: 'missing' }, 'Missing env: BLACKBAUD_REFRESH_TOKEN, BB_API_SUBSCRIPTION_KEY1 or BB_API_SUBSCRIPTION_KEY2');
    await pool.end();
    return;
  }
  if (!USE_CANDIDATES_API && !config.listId) {
    log.error({ env: 'missing' }, 'Missing env: BB_CHECKLIST_ADVANCE_LIST_ID (or set BB_USE_CANDIDATES_API=1)');
    await pool.end();
    return;
  }

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
    let inFlight = 0;
    const waitQueue: Array<() => void> = [];

    async function withLimit<T>(fn: () => Promise<T>): Promise<T> {
      while (inFlight >= MAX_CONCURRENT_STORES) {
        await new Promise<void>((r) => waitQueue.push(r));
      }
      inFlight++;
      try {
        return await fn();
      } finally {
        inFlight--;
        const next = waitQueue.shift();
        if (next) next();
      }
    }

    // Advance list: full checklist_items table (unchanged)
    const COLS =
      'user_id, first_name, last_name, checklist_id, checklist_name, checklist_item_id,' +
      'date_completed, checklist_item, contract_status, inactive_reason, candidate_decision,' +
      'school_decision, reason_declined, inactive, contract_year, contract_send_date,' +
      'contract_return_date, contract_publish_date, entering_grade, candidate_entering_year,' +
      'candidate_status, date_requested, date_due, date_waived, test_rescheduled, test_no_show,' +
      'contract_type, test_short_description, contract_dep_rec_date, polled_at';
    const CONFLICT_TARGET = '(user_id, checklist_id, checklist_item_id) WHERE (user_id IS NOT NULL AND checklist_id IS NOT NULL AND checklist_item_id IS NOT NULL)';

    // Candidates API: candidate_checklist_items table (schema matches new API only)
    const CANDIDATE_COLS =
      'user_id, first_name, last_name, checklist_id, checklist_name, checklist_item_id, checklist_item,' +
      'step_status, date_completed, date_requested, date_due, date_waived, candidate_decision, school_decision, reason_declined,' +
      'contract_publish_date, contract_return_date, contract_dep_rec_date, entering_grade,' +
      'candidate_entering_year, candidate_status, inactive, test_no_show, test_short_description, polled_at';
    const CANDIDATE_DATA_CHANGED =
      'candidate_checklist_items.first_name IS DISTINCT FROM EXCLUDED.first_name OR candidate_checklist_items.last_name IS DISTINCT FROM EXCLUDED.last_name OR ' +
      'candidate_checklist_items.checklist_name IS DISTINCT FROM EXCLUDED.checklist_name OR candidate_checklist_items.date_completed IS DISTINCT FROM EXCLUDED.date_completed OR ' +
      'candidate_checklist_items.checklist_item IS DISTINCT FROM EXCLUDED.checklist_item OR candidate_checklist_items.step_status IS DISTINCT FROM EXCLUDED.step_status OR ' +
      'candidate_checklist_items.date_waived IS DISTINCT FROM EXCLUDED.date_waived OR candidate_checklist_items.candidate_decision IS DISTINCT FROM EXCLUDED.candidate_decision OR ' +
      'candidate_checklist_items.school_decision IS DISTINCT FROM EXCLUDED.school_decision OR candidate_checklist_items.reason_declined IS DISTINCT FROM EXCLUDED.reason_declined OR ' +
      'candidate_checklist_items.contract_publish_date IS DISTINCT FROM EXCLUDED.contract_publish_date OR candidate_checklist_items.contract_return_date IS DISTINCT FROM EXCLUDED.contract_return_date OR ' +
      'candidate_checklist_items.contract_dep_rec_date IS DISTINCT FROM EXCLUDED.contract_dep_rec_date OR candidate_checklist_items.entering_grade IS DISTINCT FROM EXCLUDED.entering_grade OR ' +
      'candidate_checklist_items.candidate_entering_year IS DISTINCT FROM EXCLUDED.candidate_entering_year OR candidate_checklist_items.candidate_status IS DISTINCT FROM EXCLUDED.candidate_status OR ' +
      'candidate_checklist_items.date_requested IS DISTINCT FROM EXCLUDED.date_requested OR candidate_checklist_items.date_due IS DISTINCT FROM EXCLUDED.date_due OR ' +
      'candidate_checklist_items.inactive IS DISTINCT FROM EXCLUDED.inactive OR candidate_checklist_items.test_no_show IS DISTINCT FROM EXCLUDED.test_no_show OR ' +
      'candidate_checklist_items.test_short_description IS DISTINCT FROM EXCLUDED.test_short_description';
    const CANDIDATE_DO_UPDATE_SET =
      'first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,checklist_name=EXCLUDED.checklist_name,' +
      'date_completed=EXCLUDED.date_completed,checklist_item=EXCLUDED.checklist_item,step_status=EXCLUDED.step_status,' +
      'date_waived=EXCLUDED.date_waived,candidate_decision=EXCLUDED.candidate_decision,' +
      'school_decision=EXCLUDED.school_decision,reason_declined=EXCLUDED.reason_declined,contract_publish_date=EXCLUDED.contract_publish_date,' +
      'contract_return_date=EXCLUDED.contract_return_date,contract_dep_rec_date=EXCLUDED.contract_dep_rec_date,' +
      'entering_grade=EXCLUDED.entering_grade,candidate_entering_year=EXCLUDED.candidate_entering_year,candidate_status=EXCLUDED.candidate_status,' +
      'date_requested=EXCLUDED.date_requested,date_due=EXCLUDED.date_due,inactive=EXCLUDED.inactive,' +
      'test_no_show=EXCLUDED.test_no_show,test_short_description=EXCLUDED.test_short_description,' +
      'polled_at=CASE WHEN (' + CANDIDATE_DATA_CHANGED + ') THEN EXCLUDED.polled_at ELSE candidate_checklist_items.polled_at END';
    // Only update polled_at when at least one data column changed (IS DISTINCT FROM handles nulls).
    const DATA_CHANGED =
      'checklist_items.first_name IS DISTINCT FROM EXCLUDED.first_name OR checklist_items.last_name IS DISTINCT FROM EXCLUDED.last_name OR ' +
      'checklist_items.checklist_name IS DISTINCT FROM EXCLUDED.checklist_name OR checklist_items.date_completed IS DISTINCT FROM EXCLUDED.date_completed OR ' +
      'checklist_items.checklist_item IS DISTINCT FROM EXCLUDED.checklist_item OR checklist_items.contract_status IS DISTINCT FROM EXCLUDED.contract_status OR ' +
      'checklist_items.inactive_reason IS DISTINCT FROM EXCLUDED.inactive_reason OR checklist_items.candidate_decision IS DISTINCT FROM EXCLUDED.candidate_decision OR ' +
      'checklist_items.school_decision IS DISTINCT FROM EXCLUDED.school_decision OR checklist_items.reason_declined IS DISTINCT FROM EXCLUDED.reason_declined OR ' +
      'checklist_items.inactive IS DISTINCT FROM EXCLUDED.inactive OR checklist_items.contract_year IS DISTINCT FROM EXCLUDED.contract_year OR ' +
      'checklist_items.contract_send_date IS DISTINCT FROM EXCLUDED.contract_send_date OR checklist_items.contract_return_date IS DISTINCT FROM EXCLUDED.contract_return_date OR ' +
      'checklist_items.contract_publish_date IS DISTINCT FROM EXCLUDED.contract_publish_date OR checklist_items.entering_grade IS DISTINCT FROM EXCLUDED.entering_grade OR ' +
      'checklist_items.candidate_entering_year IS DISTINCT FROM EXCLUDED.candidate_entering_year OR checklist_items.candidate_status IS DISTINCT FROM EXCLUDED.candidate_status OR ' +
      'checklist_items.date_requested IS DISTINCT FROM EXCLUDED.date_requested OR checklist_items.date_due IS DISTINCT FROM EXCLUDED.date_due OR ' +
      'checklist_items.date_waived IS DISTINCT FROM EXCLUDED.date_waived OR checklist_items.test_rescheduled IS DISTINCT FROM EXCLUDED.test_rescheduled OR ' +
      'checklist_items.test_no_show IS DISTINCT FROM EXCLUDED.test_no_show OR checklist_items.contract_type IS DISTINCT FROM EXCLUDED.contract_type OR ' +
      'checklist_items.test_short_description IS DISTINCT FROM EXCLUDED.test_short_description OR checklist_items.contract_dep_rec_date IS DISTINCT FROM EXCLUDED.contract_dep_rec_date';
    const DO_UPDATE_SET =
      'first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,checklist_name=EXCLUDED.checklist_name,' +
      'date_completed=EXCLUDED.date_completed,checklist_item=EXCLUDED.checklist_item,contract_status=EXCLUDED.contract_status,' +
      'inactive_reason=EXCLUDED.inactive_reason,candidate_decision=EXCLUDED.candidate_decision,school_decision=EXCLUDED.school_decision,' +
      'reason_declined=EXCLUDED.reason_declined,inactive=EXCLUDED.inactive,contract_year=EXCLUDED.contract_year,' +
      'contract_send_date=EXCLUDED.contract_send_date,contract_return_date=EXCLUDED.contract_return_date,' +
      'contract_publish_date=EXCLUDED.contract_publish_date,entering_grade=EXCLUDED.entering_grade,' +
      'candidate_entering_year=EXCLUDED.candidate_entering_year,candidate_status=EXCLUDED.candidate_status,' +
      'date_requested=EXCLUDED.date_requested,date_due=EXCLUDED.date_due,date_waived=EXCLUDED.date_waived,' +
      'test_rescheduled=EXCLUDED.test_rescheduled,test_no_show=EXCLUDED.test_no_show,contract_type=EXCLUDED.contract_type,' +
      'test_short_description=EXCLUDED.test_short_description,contract_dep_rec_date=EXCLUDED.contract_dep_rec_date,' +
      'polled_at=CASE WHEN (' +
      DATA_CHANGED +
      ') THEN EXCLUDED.polled_at ELSE checklist_items.polled_at END';

    function rowToValues(row: ChecklistRow): unknown[] {
      return [
        row.user_id, row.first_name, row.last_name, row.checklist_id, row.checklist_name, row.checklist_item_id,
        row.date_completed, row.checklist_item, row.contract_status, row.inactive_reason, row.candidate_decision,
        row.school_decision, row.reason_declined, row.inactive, row.contract_year, row.contract_send_date,
        row.contract_return_date, row.contract_publish_date, row.entering_grade, row.candidate_entering_year,
        row.candidate_status, row.date_requested, row.date_due, row.date_waived, row.test_rescheduled, row.test_no_show,
        row.contract_type, row.test_short_description, row.contract_dep_rec_date,
      ];
    }

    /** Values for candidate_checklist_items (subset of ChecklistRow columns). */
    function rowToCandidateValues(row: ChecklistRow): unknown[] {
      return [
        row.user_id, row.first_name, row.last_name, row.checklist_id, row.checklist_name, row.checklist_item_id,
        row.checklist_item, row.step_status ?? null, row.date_completed, row.date_requested, row.date_due,
        row.date_waived ?? null, row.candidate_decision, row.school_decision, row.reason_declined,
        row.contract_publish_date, row.contract_return_date, row.contract_dep_rec_date, row.entering_grade,
        row.candidate_entering_year, row.candidate_status, row.inactive, row.test_no_show ?? null, row.test_short_description,
      ];
    }

    function dedupeByKey(rows: ChecklistRow[]): ChecklistRow[] {
      const seen = new Map<string, ChecklistRow>();
      for (const row of rows) {
        const year = row.candidate_entering_year ?? '';
        const key = `${row.user_id}\0${row.checklist_id}\0${row.checklist_item_id}\0${year}`;
        seen.set(key, row);
      }
      return [...seen.values()];
    }

    async function storeRows(rows: ChecklistRow[], batchId: number): Promise<number> {
      return withLimit(async () => {
        // Only insert rows that have a valid unique key (all three NOT NULL) so ON CONFLICT works.
        const valid = rows.filter(
          (r) => r.user_id != null && r.checklist_id != null && r.checklist_item_id != null
        );
        const skipped = rows.length - valid.length;
        if (skipped > 0) {
          log.warn({ batchId, skipped, total: rows.length }, 'Skipped rows with null user_id/checklist_id/checklist_item_id');
        }
        const deduped = dedupeByKey(valid);
        if (deduped.length === 0) {
          log.info({ batchId, rows: 0 }, 'Insert batch (empty)');
          return 0;
        }
        const uniqueUserIds = new Set(deduped.map((r) => r.user_id).filter((id) => id != null));
        const sample = deduped.slice(0, 5).map((r) => ({
          user_id: r.user_id,
          checklist_name: r.checklist_name,
          checklist_item: r.checklist_item,
        }));
        log.info(
          {
            batchId,
            table: 'checklist_items',
            rows: deduped.length,
            uniqueUserIds: uniqueUserIds.size,
            sample,
          },
          'Inserting into checklist_items'
        );
        const values: unknown[] = [];
        const placeholders: string[] = [];
        let param = 1;
        for (const row of deduped) {
          placeholders.push(
            `($${param},$${param + 1},$${param + 2},$${param + 3},$${param + 4},$${param + 5},$${param + 6},$${param + 7},$${param + 8},$${param + 9},$${param + 10},$${param + 11},$${param + 12},$${param + 13},$${param + 14},$${param + 15},$${param + 16},$${param + 17},$${param + 18},$${param + 19},$${param + 20},$${param + 21},$${param + 22},$${param + 23},$${param + 24},$${param + 25},$${param + 26},$${param + 27},$${param + 28},NOW())`
          );
          values.push(...rowToValues(row));
          param += 29;
        }
        const client = await pool.connect();
        try {
          await client.query(
            `INSERT INTO checklist_items (${COLS}) VALUES ${placeholders.join(',')}
             ON CONFLICT ${CONFLICT_TARGET} DO UPDATE SET ${DO_UPDATE_SET}`,
            values
          );
          log.info({ batchId, rows: deduped.length }, 'Insert complete');
          return deduped.length;
        } finally {
          client.release();
        }
      });
    }

    const CANDIDATE_CONFLICT =
      '(user_id, checklist_id, checklist_item_id, candidate_entering_year) WHERE (user_id IS NOT NULL AND checklist_id IS NOT NULL AND checklist_item_id IS NOT NULL AND candidate_entering_year IS NOT NULL)';

    async function storeCandidateRows(rows: ChecklistRow[], batchId: number): Promise<number> {
      return withLimit(async () => {
        const valid = rows.filter(
          (r) =>
            r.user_id != null &&
            r.checklist_id != null &&
            r.checklist_item_id != null &&
            r.candidate_entering_year != null &&
            String(r.candidate_entering_year).trim() !== ''
        );
        const skipped = rows.length - valid.length;
        if (skipped > 0) {
          log.warn({ batchId, skipped, total: rows.length }, 'Skipped rows with null user_id/checklist_id/checklist_item_id/candidate_entering_year');
        }
        const deduped = dedupeByKey(valid);
        if (deduped.length === 0) {
          log.info({ batchId, rows: 0 }, 'Insert batch candidate_checklist_items (empty)');
          return 0;
        }
        const uniqueUserIds = new Set(deduped.map((r) => r.user_id).filter((id) => id != null));
        const sample = deduped.slice(0, 5).map((r) => ({
          user_id: r.user_id,
          checklist_name: r.checklist_name,
          checklist_item: r.checklist_item,
        }));
        log.info(
          { batchId, table: 'candidate_checklist_items', rows: deduped.length, uniqueUserIds: uniqueUserIds.size, sample },
          'Inserting into candidate_checklist_items'
        );
        const CANDIDATE_PARAMS_PER_ROW = 24; // 24 data columns + polled_at (NOW()) = 25 columns
        const values: unknown[] = [];
        const placeholders: string[] = [];
        let param = 1;
        for (const row of deduped) {
          placeholders.push(
            `(${Array.from({ length: CANDIDATE_PARAMS_PER_ROW }, (_, i) => `$${param + i}`).join(',')},NOW())`
          );
          values.push(...rowToCandidateValues(row));
          param += CANDIDATE_PARAMS_PER_ROW;
        }
        const client = await pool.connect();
        try {
          await client.query(
            `INSERT INTO candidate_checklist_items (${CANDIDATE_COLS}) VALUES ${placeholders.join(',')}
             ON CONFLICT ${CANDIDATE_CONFLICT} DO UPDATE SET ${CANDIDATE_DO_UPDATE_SET}`,
            values
          );
          log.info({ batchId, rows: deduped.length }, 'Insert complete (candidate_checklist_items)');
          return deduped.length;
        } finally {
          client.release();
        }
      });
    }

    let totalInserted = 0;
    let totalPages = 0;

    if (USE_CANDIDATES_API) {
      const candidatesParams = {
        size: CANDIDATES_PAGE_SIZE,
        school_year: process.env.BB_CANDIDATES_SCHOOL_YEAR || undefined,
        status: process.env.BB_CANDIDATES_STATUS || undefined,
        modified_date: process.env.BB_CANDIDATES_MODIFIED_DATE || undefined,
        school_level: process.env.BB_CANDIDATES_SCHOOL_LEVEL ? parseInt(process.env.BB_CANDIDATES_SCHOOL_LEVEL, 10) : undefined,
      };
      log.info({ size: CANDIDATES_PAGE_SIZE }, 'Fetching candidates (AFE-EDEMS)');
      let page = 1;
      let batchId = 0;
      for (;;) {
        const res = await fetchCandidatesPage(config, { ...candidatesParams, page });
        const candidates = res.value ?? [];
        if (candidates.length === 0) break;
        totalPages = page;

        // 2. Candidates to fetch checklist for: only those modified in the last N hours.
        const modifiedCutoff = Date.now() - CHECKLIST_FETCH_MODIFIED_HOURS * 60 * 60 * 1000;
        const candidatesNeedingChecklist = candidates.filter((c: CandidateResponse) => {
          const modified = c.modified ? new Date(c.modified).getTime() : 0;
          return modified >= modifiedCutoff;
        });
        log.info(
          { page, total: candidates.length, fetchChecklist: candidatesNeedingChecklist.length, modifiedWithinHours: CHECKLIST_FETCH_MODIFIED_HOURS },
          'Candidates to fetch checklist details'
        );

        // 3. Fetch checklist only for candidates modified in last N hours.
        const checklistByUserId = new Map<number, CandidateChecklistResponse>();
        await Promise.all(
          candidatesNeedingChecklist.map(async (c: CandidateResponse) => {
            const uid = c.user?.id ?? 0;
            const year = c.entering_year?.description?.trim();
            if (!year) return;
            try {
              const checklist = await fetchCandidateChecklist(config, uid, year);
              checklistByUserId.set(uid, checklist);
            } catch (err) {
              log.warn({ userId: uid, err }, 'Checklist fetch failed, using candidate data only');
            }
          })
        );

        // 4. Map every candidate to rows: use checklist when we have it, else candidate-only.
        const allRows: ChecklistRow[] = candidates.flatMap((c: CandidateResponse) => {
          const uid = c.user?.id ?? 0;
          const checklist = checklistByUserId.get(uid) ?? null;
          return mapCandidateAndChecklistToRows(c, checklist);
        });
        log.info({ page, candidateCount: candidates.length, rowsToInsert: allRows.length }, 'Candidates mapped, inserting into candidate_checklist_items');
        for (let j = 0; j < allRows.length; j += STORE_BATCH_SIZE) {
          const batch = allRows.slice(j, j + STORE_BATCH_SIZE);
          totalInserted += await storeCandidateRows(batch, batchId++);
        }
        if (candidates.length < CANDIDATES_PAGE_SIZE) break;
        page++;
      }
    } else {
      async function storePage(pageItems: unknown[], page: number): Promise<number> {
        const mapped = (pageItems as Record<string, unknown>[]).map((item) => mapItemToChecklist(item));
        return storeRows(mapped, page);
      }
      let nextPage = 1;
      let done = false;
      const insertCounts: number[] = [];

      function getNextPage(): number {
        return nextPage++;
      }

      async function worker(): Promise<void> {
        while (!done) {
          const page = getNextPage();
          let rows: Record<string, unknown>[];
          try {
            rows = await fetchChecklistListPage(config, page);
          } catch (err) {
            log.error({ err, page }, 'Fetch failed');
            done = true;
            break;
          }
          if (rows.length === 0 || rows.length < PAGE_SIZE) done = true;
          if (rows.length > 0) {
            const count = await storePage(rows, page);
            insertCounts.push(count);
          }
          if (rows.length === 0) break;
        }
      }

      log.info({ listId: config.listId, concurrency: FETCH_CONCURRENCY }, 'Fetching Advance list (parallel)');
      const workers = Array.from({ length: FETCH_CONCURRENCY }, () => worker());
      await Promise.all(workers);
      totalInserted = insertCounts.reduce((a, b) => a + b, 0);
      totalPages = nextPage - 1;
    }

    if (totalInserted === 0) {
      log.info('Poll complete: 0 items returned');
    } else {
      log.info({ itemsCount: totalInserted, inserted: totalInserted, totalPages }, 'Poll complete');
    }

    await pool.query(
      `INSERT INTO sync_logs (step, records_count, status, message) VALUES ($1, $2, $3, $4)`,
      ['blackbaud-poller', totalInserted, 'ok', `Inserted ${totalInserted}`]
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Poll failed');
    await pool.query(
      `INSERT INTO sync_logs (step, records_count, status, message) VALUES ($1, $2, $3, $4)`,
      ['blackbaud-poller', 0, 'error', msg]
    );
    await pool.query(
      `INSERT INTO error_logs (source, error_message, context_json) VALUES ($1, $2, $3)`,
      ['blackbaud-poller', msg, JSON.stringify({ stack: err instanceof Error ? err.stack : undefined })]
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
  if (RUN_ONCE) {
    log.info('Starting (one-shot: poll then exit for system cron)');
    poll()
      .then(() => {
        log.info('Exiting after poll complete');
        process.exit(0);
      })
      .catch((err) => {
        log.error({ err }, 'Poll failed, exiting');
        process.exit(1);
      });
    return;
  }

  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) {
    log.info({ schedule: POLL_CRON }, 'Starting (cron + initial poll)');
    cron.schedule(POLL_CRON, poll);
  } else {
    log.info('Starting (dev: initial poll only, no cron)');
  }
  poll().catch((err) => {
    log.error({ err }, 'Initial poll error');
  });
}

main();
