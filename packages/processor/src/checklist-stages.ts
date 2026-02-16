/**
 * Reads checklist data and determines deal stage and substage
 * per stages.md logic (dealstage and substage rules).
 * Use CHECKLIST_TABLE=candidate_checklist_items when data comes from Candidates API; otherwise checklist_items (Advance list).
 */
import type { Pool } from 'pg';

const CHECKLIST_TABLE_OPTIONS = ['checklist_items', 'candidate_checklist_items'] as const;
export type ChecklistTableName = (typeof CHECKLIST_TABLE_OPTIONS)[number];

export function getChecklistTable(): ChecklistTableName {
  const v = process.env.CHECKLIST_TABLE;
  if (v === 'candidate_checklist_items' || v === 'checklist_items') return v;
  return 'checklist_items';
}

/** Minimal checklist row shape as returned from checklist_items / candidate_checklist_items (for stage logic). */
export interface ChecklistRowForStage {
  user_id: number | null;
  checklist_name: string | null;
  checklist_item: string | null;
  date_completed: string | null;
  date_requested: string | null;
  /** Step-level status from Candidates API (e.g. "Completed", "Waived"). When set, Waived/Completed count as complete. */
  step_status?: string | null;
  candidate_decision: string | null;
  school_decision: string | null;
  inactive: string | null;
  contract_publish_date: string | null;
  contract_return_date: string | null;
  contract_dep_rec_date: string | null;
  test_no_show: string | null;
  test_short_description: string | null;
}

/** Aggregated view per user (one row per user with checklists as a map). */
export interface DealView {
  user_id: number;
  /** Checklist name -> at least one item completed (date_completed set). */
  checklistsCompleted: Record<string, boolean>;
  /** Checklist item name -> status: 'requested' | 'complete'. Requested = date_requested set, no date_completed. Complete = date_completed set. */
  itemStatus: Array<{ name: string; status: 'requested' | 'complete' }>;
  /** No-show: any row with test_no_show truthy. */
  testNoShow: boolean;
  /** test_short_description from a row where we care (e.g. Assessment / Re-Assessment). */
  testShortDescription: string | null;
  candidate_decision: string | null;
  school_decision: string | null;
  inactive: boolean;
  contract_publish_date: string | null;
  contract_return_date: string | null;
  contract_dep_rec_date: string | null;
}

/** Result of stage/substage determination. */
export interface StageResult {
  stage: string | null;
  substage: number | null;
}

/** Human-readable substage id → label (for UI). */
export const SUBSTAGE_LABELS: Record<number, string> = {
  13: 'Application sent',
  14: 'Application received',
  15: 'Assessment scheduled',
  16: 'Assessment no show',
  17: 'Assessment completed',
  18: 'Re-assessment required',
  19: 'Re-assessment no show',
  20: 'Re-assessment completed',
  21: 'Waiting list application',
  22: 'Documents missing',
  23: 'Offer sent',
  24: 'Conditional offer sent',
  25: 'Offer accepted (pending payment)',
  26: 'Waiting list offer accepted',
  27: 'Enrolled',
  28: 'Recyclable',
};

/** Stage + substage with reasons for breakdown UI. */
export interface StageBreakdown {
  stage: string | null;
  substage: number | null;
  substageLabel: string | null;
  stageReason: string | null;
  substageReason: string | null;
}

const APPLICATION_FORM = 'Application Form';
const DECISION = 'Decision';
const ENROLLMENT_CONTRACT_RECEIVED = 'Enrollment Contract Received';
const FAIRMONT_ADMISSIONS_ASSESSMENT = 'Fairmont Admissions Assessment';
const FAIRMONT_ADMISSIONS_RE_ASSESSMENT = 'Fairmont Admissions Re-Assessment';

function normalize(s: string | null): string {
  if (s == null) return '';
  return String(s).trim();
}

function truthy(s: string | null | undefined): boolean {
  if (s == null || s === '') return false;
  const t = String(s).trim().toLowerCase();
  return t === 'true' || t === 'yes' || t === '1' || t.length > 0;
}

/**
 * Aggregate checklist_items rows into a per-user DealView.
 * Uses latest row per user for contract/decision fields when they differ.
 */
/** Normalize user_id to number (pg returns BIGINT as string). */
function toUserId(val: number | string | null | undefined): number | null {
  if (val == null) return null;
  const n = typeof val === 'number' ? val : parseInt(String(val), 10);
  return isNaN(n) ? null : n;
}

export function aggregateChecklistRowsByUser(rows: ChecklistRowForStage[]): Map<number, DealView> {
  const byUser = new Map<number, DealView>();

  for (const r of rows) {
    const uid = toUserId(r.user_id);
    if (uid == null) continue;

    let deal = byUser.get(uid);
    if (!deal) {
      deal = {
        user_id: uid,
        checklistsCompleted: {},
        itemStatus: [],
        testNoShow: false,
        testShortDescription: r.test_short_description ?? null,
        candidate_decision: r.candidate_decision ?? null,
        school_decision: r.school_decision ?? null,
        inactive: truthy(r.inactive),
        contract_publish_date: r.contract_publish_date ?? null,
        contract_return_date: r.contract_return_date ?? null,
        contract_dep_rec_date: r.contract_dep_rec_date ?? null,
      };
      byUser.set(uid, deal);
    }

    const stepStatus = (r as ChecklistRowForStage).step_status?.trim() || null;
    const countsAsComplete = Boolean(r.date_completed || stepStatus === 'Completed' || stepStatus === 'Waived');

    const checklistName = normalize(r.checklist_name);
    const itemName = normalize(r.checklist_item);
    if (checklistName && (r.date_completed || countsAsComplete)) {
      deal.checklistsCompleted[checklistName] = true;
    }
    // Also key by item name so stage logic works when items are "Application Form", "Decision", "Enrollment Contract Received" (Candidates API)
    if (itemName && (r.date_completed || countsAsComplete)) {
      deal.checklistsCompleted[itemName] = true;
    }

    if (itemName) {
      const status: 'requested' | 'complete' | null = countsAsComplete ? 'complete' : r.date_requested ? 'requested' : null;
      if (status) {
        const existing = deal.itemStatus.find((x) => x.name === itemName);
        if (!existing) deal.itemStatus.push({ name: itemName, status });
        else if (status === 'complete') existing.status = 'complete';
      }
    }

    if (truthy(r.test_no_show)) deal.testNoShow = true;
    if (r.test_short_description) deal.testShortDescription = r.test_short_description;
    if (r.candidate_decision != null) deal.candidate_decision = r.candidate_decision;
    if (r.school_decision != null) deal.school_decision = r.school_decision;
    if (r.inactive != null) deal.inactive = deal.inactive || truthy(r.inactive);
    if (r.contract_publish_date != null) deal.contract_publish_date = r.contract_publish_date;
    if (r.contract_return_date != null) deal.contract_return_date = r.contract_return_date;
    if (r.contract_dep_rec_date != null) deal.contract_dep_rec_date = r.contract_dep_rec_date;
  }

  return byUser;
}

/**
 * Determine deal stage from stages.md:
 * - Closed Lost: inactive OR candidate_decision 'I Decline' OR school_decision 'Denied'
 * - Closed Won: Enrollment Contract Received completed
 * - Contract Sent: contract_publish_date set
 * - Decision: Decision checklist completed
 * - Application: Application Form checklist completed
 */
export function determineDealStage(deal: DealView): string | null {
  if (deal.inactive) return 'Closed Lost';
  const cd = normalize(deal.candidate_decision ?? '');
  const sd = normalize(deal.school_decision ?? '');
  if (cd === 'I Decline' || sd === 'Denied') return 'Closed Lost';

  if (deal.checklistsCompleted[ENROLLMENT_CONTRACT_RECEIVED]) return 'Closed Won';
  if (deal.contract_publish_date) return 'Contract Sent';
  if (deal.checklistsCompleted[DECISION]) return 'Decision';
  if (deal.checklistsCompleted[APPLICATION_FORM]) return 'Application';

  return null;
}

/**
 * Determine substage id (13-28) from stages.md. Evaluates from highest to lowest
 * and returns the first match so the "most advanced" substage wins.
 */
export function determineSubstage(deal: DealView): number | null {
  const sd = normalize(deal.school_decision ?? '');
  const cd = normalize(deal.candidate_decision ?? '');

  const itemStatus = (name: string): 'requested' | 'complete' | null => {
    const item = deal.itemStatus.find(
      (x) => x.name === name || x.name.includes(name) || name.includes(x.name)
    );
    return item ? item.status : null;
  };
  const assessmentRequested = itemStatus(FAIRMONT_ADMISSIONS_ASSESSMENT) === 'requested';
  const assessmentComplete = itemStatus(FAIRMONT_ADMISSIONS_ASSESSMENT) === 'complete';
  const reAssessmentRequested = itemStatus(FAIRMONT_ADMISSIONS_RE_ASSESSMENT) === 'requested';
  const reAssessmentComplete = itemStatus(FAIRMONT_ADMISSIONS_RE_ASSESSMENT) === 'complete';
  const enrollmentContractComplete = deal.checklistsCompleted[ENROLLMENT_CONTRACT_RECEIVED];
  const testDesc = normalize(deal.testShortDescription ?? '');

  // 28 - Recyclable (Closed Lost)
  if (deal.inactive || cd === 'I Decline' || sd === 'Denied') return 28;

  // 27 - Enrolled
  if (enrollmentContractComplete) return 27;

  // 26 - Waiting list offer accepted
  if (sd === 'Waitlist w/ Deposit Paid') return 26;

  // 25 - Offer accepted (pending payment)
  if (
    !enrollmentContractComplete &&
    deal.contract_return_date != null &&
    (deal.contract_dep_rec_date == null || deal.contract_dep_rec_date === '')
  ) {
    return 25;
  }

  // 24 - Conditional offer sent
  if (sd === 'Accepted w/ Conditions') return 24;

  // 23 - Offer sent
  if (sd === 'Accepted') return 23;

  // 22 - Documents missing (TBD in stages.md - skip or generic)
  // 21 - Waiting list application
  if (sd === 'Waitlist') return 21;

  // 20 - Re-assessment completed
  if (reAssessmentComplete) return 20;

  // 19 - Re-assessment no show
  if (deal.testNoShow && testDesc.includes('Re-Assessment')) return 19;

  // 18 - Re-assessment required
  if (reAssessmentRequested) return 18;

  // 17 - Assessment completed
  if (assessmentComplete) return 17;

  // 16 - Assessment no show
  if (deal.testNoShow && testDesc.includes('Assessment') && !testDesc.includes('Re-Assessment')) return 16;

  // 15 - Assessment scheduled
  if (assessmentRequested) return 15;

  // 14 - Application received (Application checklist item completed)
  if (deal.checklistsCompleted[APPLICATION_FORM]) return 14;

  // 13 - Application sent (manual in HubSpot; we don't auto-set from checklist)
  return null;
}

/**
 * Get stage and substage for a single deal view.
 */
export function getStageAndSubstage(deal: DealView): StageResult {
  return {
    stage: determineDealStage(deal),
    substage: determineSubstage(deal),
  };
}

/**
 * Get stage, substage, and human-readable reasons (for breakdown UI).
 */
export function getStageAndSubstageWithBreakdown(deal: DealView): StageBreakdown {
  const stage = determineDealStage(deal);
  const substage = determineSubstage(deal);
  const sd = normalize(deal.school_decision ?? '');
  const cd = normalize(deal.candidate_decision ?? '');

  let stageReason: string | null = null;
  if (deal.inactive) stageReason = 'inactive is true';
  else if (cd === 'I Decline') stageReason = "candidate_decision = 'I Decline'";
  else if (sd === 'Denied') stageReason = "school_decision = 'Denied'";
  else if (deal.checklistsCompleted[ENROLLMENT_CONTRACT_RECEIVED]) stageReason = `checklist '${ENROLLMENT_CONTRACT_RECEIVED}' has at least one item completed`;
  else if (deal.contract_publish_date) stageReason = 'contract_publish_date is set';
  else if (deal.checklistsCompleted[DECISION]) stageReason = `checklist '${DECISION}' has at least one item completed`;
  else if (deal.checklistsCompleted[APPLICATION_FORM]) stageReason = `checklist '${APPLICATION_FORM}' has at least one item completed`;

  const substageReasons: Record<number, string> = {
    28: 'inactive, or candidate_decision = I Decline, or school_decision = Denied',
    27: `checklist '${ENROLLMENT_CONTRACT_RECEIVED}' completed`,
    26: "school_decision = 'Waitlist w/ Deposit Paid'",
    25: 'Enrollment Contract not complete, contract_return_date set, contract_dep_rec_date not set',
    24: "school_decision = 'Accepted w/ Conditions'",
    23: "school_decision = 'Accepted'",
    21: "school_decision = 'Waitlist'",
    20: "checklist item 'Fairmont Admissions Re-Assessment' = complete",
    19: 'test_no_show true and test_short_description contains Re-Assessment',
    18: "checklist item 'Fairmont Admissions Re-Assessment' = requested",
    17: "checklist item 'Fairmont Admissions Assessment' = complete",
    16: 'test_no_show true and test_short_description is Fairmont Admissions Assessment',
    15: "checklist item 'Fairmont Admissions Assessment' = requested",
    14: `checklist '${APPLICATION_FORM}' has at least one item completed`,
  };

  return {
    stage,
    substage,
    substageLabel: substage != null ? SUBSTAGE_LABELS[substage] ?? `Substage ${substage}` : null,
    stageReason,
    substageReason: substage != null ? substageReasons[substage] ?? null : null,
  };
}

const CHECKLIST_SELECT_COLS = `user_id, checklist_name, checklist_item, date_completed::text, date_requested::text,
            candidate_decision, school_decision, inactive, contract_publish_date::text,
            contract_return_date::text, contract_dep_rec_date::text, test_no_show::text,
            test_short_description`;

/** SELECT columns for candidate_checklist_items (adds step_status so Waived/Completed count as complete). */
const CANDIDATE_CHECKLIST_SELECT_COLS = CHECKLIST_SELECT_COLS + ', step_status';

function getSelectColsForTable(): string {
  return getChecklistTable() === 'candidate_checklist_items' ? CANDIDATE_CHECKLIST_SELECT_COLS : CHECKLIST_SELECT_COLS;
}

/**
 * Load checklist data for one user from the database.
 * Table is checklist_items (Advance list) or candidate_checklist_items (Candidates API) per CHECKLIST_TABLE env.
 */
export async function loadChecklistDataByUser(
  pool: Pool,
  userId: number
): Promise<ChecklistRowForStage[]> {
  const table = getChecklistTable();
  const cols = getSelectColsForTable();
  const { rows } = await pool.query<ChecklistRowForStage>(
    `SELECT ${cols} FROM ${table} WHERE user_id = $1`,
    [userId]
  );
  return rows;
}

/**
 * Load all checklist data (for batch stage/substage computation).
 * Table is checklist_items or candidate_checklist_items per CHECKLIST_TABLE env.
 */
export async function loadAllChecklistData(pool: Pool): Promise<ChecklistRowForStage[]> {
  const table = getChecklistTable();
  const cols = getSelectColsForTable();
  const { rows } = await pool.query<ChecklistRowForStage>(
    `SELECT ${cols} FROM ${table}`
  );
  return rows;
}

/**
 * Read checklist data for a user and return stage + substage.
 */
export async function getStageAndSubstageForUser(
  pool: Pool,
  userId: number
): Promise<StageResult> {
  const rows = await loadChecklistDataByUser(pool, userId);
  const byUser = aggregateChecklistRowsByUser(rows);
  const deal = byUser.get(userId);
  if (!deal) return { stage: null, substage: null };
  return getStageAndSubstage(deal);
}

/**
 * Read all checklist data and return stage + substage per user_id.
 */
export async function getStageAndSubstageForAllUsers(
  pool: Pool
): Promise<Map<number, StageResult>> {
  const rows = await loadAllChecklistData(pool);
  const byUser = aggregateChecklistRowsByUser(rows);
  const result = new Map<number, StageResult>();
  for (const [uid, deal] of byUser) {
    result.set(uid, getStageAndSubstage(deal));
  }
  return result;
}
