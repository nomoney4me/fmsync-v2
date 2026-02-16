/**
 * Dev server to test stage/substage logic: look up a user by blackbaud user_id
 * and see checklist data + calculation breakdown.
 *
 * Run: npm run test:stages -w @fm-sync/processor
 * Open: http://localhost:3002
 */
import { config as loadEnv } from 'dotenv';
import path from 'path';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { Pool } from 'pg';
import {
  loadChecklistDataByUser,
  aggregateChecklistRowsByUser,
  getStageAndSubstageWithBreakdown,
  getChecklistTable,
  type ChecklistRowForStage,
} from './checklist-stages';

loadEnv({ path: path.resolve(__dirname, '../../../.env') });

const PORT = parseInt(process.env.STAGES_TEST_PORT || '3002', 10);

/** Rows with display fields and optional step_status/date_waived for the UI. */
interface ChecklistRowDisplay extends ChecklistRowForStage {
  first_name?: string | null;
  last_name?: string | null;
  step_status?: string | null;
  date_waived?: string | null;
}

async function getHandler(
  pool: Pool,
  userId: string
): Promise<{ ok: true; data: object } | { ok: false; error: string }> {
  const id = parseInt(userId, 10);
  if (isNaN(id) || id < 0) {
    return { ok: false, error: 'Invalid user_id' };
  }

  const table = getChecklistTable();
  const extraCols = table === 'candidate_checklist_items' ? ', step_status, date_waived::text' : '';
  const { rows } = await pool.query<ChecklistRowDisplay>(
    `SELECT user_id, first_name, last_name, checklist_name, checklist_item, date_completed::text, date_requested::text,
            candidate_decision, school_decision, inactive, contract_publish_date::text,
            contract_return_date::text, contract_dep_rec_date::text, test_no_show::text,
            test_short_description${extraCols}
     FROM ${table} WHERE user_id = $1`,
    [id]
  );

  const forStage: ChecklistRowForStage[] = rows.map((r) => ({
    user_id: r.user_id,
    checklist_name: r.checklist_name,
    checklist_item: r.checklist_item,
    date_completed: r.date_completed,
    date_requested: r.date_requested,
    step_status: r.step_status ?? null,
    candidate_decision: r.candidate_decision,
    school_decision: r.school_decision,
    inactive: r.inactive,
    contract_publish_date: r.contract_publish_date,
    contract_return_date: r.contract_return_date,
    contract_dep_rec_date: r.contract_dep_rec_date,
    test_no_show: r.test_no_show,
    test_short_description: r.test_short_description,
  }));

  const byUser = aggregateChecklistRowsByUser(forStage);
  const deal = byUser.get(id);

  if (!deal) {
    return {
      ok: true,
      data: {
        userId: id,
        checklistTable: table,
        checklistRows: rows,
        message: 'No checklist data found for this user.',
        dealView: null,
        breakdown: null,
      },
    };
  }

  const breakdown = getStageAndSubstageWithBreakdown(deal);

  return {
    ok: true,
    data: {
      userId: id,
      checklistTable: table,
      firstName: rows[0]?.first_name ?? null,
      lastName: rows[0]?.last_name ?? null,
      checklistRows: rows,
      dealView: {
        checklistsCompleted: deal.checklistsCompleted,
        itemStatus: deal.itemStatus,
        testNoShow: deal.testNoShow,
        testShortDescription: deal.testShortDescription,
        candidate_decision: deal.candidate_decision,
        school_decision: deal.school_decision,
        inactive: deal.inactive,
        contract_publish_date: deal.contract_publish_date,
        contract_return_date: deal.contract_return_date,
        contract_dep_rec_date: deal.contract_dep_rec_date,
      },
      breakdown: {
        stage: breakdown.stage,
        substage: breakdown.substage,
        substageLabel: breakdown.substageLabel,
        stageReason: breakdown.stageReason,
        substageReason: breakdown.substageReason,
      },
    },
  };
}

function serveHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function serveJson(res: ServerResponse, data: object): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function serveError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Add it to .env');
    process.exit(1);
  }

  const htmlPath = path.join(__dirname, 'public', 'stages-test.html');
  let html: string;
  if (existsSync(htmlPath)) {
    html = readFileSync(htmlPath, 'utf8');
  } else {
    html = '<!DOCTYPE html><html><body><p>Missing public/stages-test.html</p></body></html>';
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    if (req.method !== 'GET') {
      serveError(res, 405, 'Method not allowed');
      return;
    }

    const match = url.pathname.match(/^\/api\/user\/(\d+)$/);
    if (match) {
      const result = await getHandler(pool, match[1]);
      if (result.ok) serveJson(res, result.data);
      else serveError(res, 400, result.error);
      return;
    }

    if (url.pathname === '/' || url.pathname === '/stages-test' || url.pathname === '/index.html') {
      serveHtml(res, html);
      return;
    }

    serveError(res, 404, 'Not found');
  });

  server.listen(PORT, () => {
    console.log(`Stages test server: http://localhost:${PORT}`);
    console.log(`Look up a user_id (Blackbaud ID) to see checklist data and stage/substage breakdown.`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
