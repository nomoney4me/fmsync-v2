/**
 * Map Blackbaud API response items to checklist_items schema.
 * Adapt field mapping to match your list output columns.
 */

export interface ChecklistRow {
  user_id: number | null;
  first_name: string | null;
  last_name: string | null;
  checklist_id: number | null;
  checklist_name: string | null;
  checklist_item_id: number | null;
  date_completed: string | null;
  checklist_item: string | null;
  /** Step-level status from API (e.g. "Waived", "Complete"). Used by Candidates API flow. */
  step_status: string | null;
  contract_status: string | null;
  inactive_reason: string | null;
  candidate_decision: string | null;
  school_decision: string | null;
  reason_declined: string | null;
  inactive: string | null;
  contract_year: string | null;
  contract_send_date: string | null;
  contract_return_date: string | null;
  contract_publish_date: string | null;
  entering_grade: string | null;
  candidate_entering_year: string | null;
  candidate_status: string | null;
  date_requested: string | null;
  date_due: string | null;
  date_waived: string | null;
  test_rescheduled: string | null;
  test_no_show: string | null;
  contract_type: string | null;
  test_short_description: string | null;
  contract_dep_rec_date: string | null;
}

function toDate(val: unknown): string | null {
  if (val == null) return null;
  if (typeof val === 'boolean') return null;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (s === 'true' || s === 'false') return null;
    const d = val.split('T')[0];
    if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return null;
    return d;
  }
  if (val instanceof Date) return val.toISOString().split('T')[0];
  return null;
}

function toNum(val: unknown): number | null {
  if (val == null || val === '') return null;
  const n = typeof val === 'number' ? val : parseInt(String(val), 10);
  return isNaN(n) ? null : n;
}

function toStr(val: unknown): string | null {
  if (val == null || val === '') return null;
  return String(val).trim() || null;
}

/** Normalize keys: support camelCase, snake_case from API */
function get(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    const snake = k.replace(/([A-Z])/g, '_$1').toLowerCase();
    if (obj[snake] !== undefined && obj[snake] !== null) return obj[snake];
    const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (obj[camel] !== undefined && obj[camel] !== null) return obj[camel];
  }
  return undefined;
}

/**
 * Map a single API item to checklist_items row.
 * Customize key mapping to match your Blackbaud list output.
 */
export function mapItemToChecklist(item: Record<string, unknown>): ChecklistRow {
  const g = (...keys: string[]) => get(item, ...keys);

  return {
    user_id: toNum(g('user_id', 'UserId', 'system_record_id')) ?? toNum(g('constituent_summary', 'system_record_id')),
    first_name: toStr(g('first_name', 'FirstName')) ?? toStr((g('constituent_summary') as Record<string, unknown>)?.formatted_name),
    last_name: toStr(g('last_name', 'LastName')) ?? toStr((g('constituent_summary') as Record<string, unknown>)?.sort_name),
    checklist_id: toNum(g('checklist_id', 'ChecklistId')),
    checklist_name: toStr(g('checklist_name', 'ChecklistName')),
    checklist_item_id: toNum(g('checklist_item_id', 'ChecklistItemId', 'id')),
    date_completed: toDate(g('date_completed', 'DateCompleted')),
    checklist_item: toStr(g('checklist_item', 'ChecklistItem')),
    step_status: toStr(g('step_status', 'StepStatus')) ?? null,
    contract_status: toStr(g('contract_status', 'ContractStatus')),
    inactive_reason: toStr(g('inactive_reason', 'InactiveReason')),
    candidate_decision: toStr(g('candidate_decision', 'CandidateDecision')),
    school_decision: toStr(g('school_decision', 'SchoolDecision')),
    reason_declined: toStr(g('reason_declined', 'ReasonDeclined')),
    inactive: toStr(g('inactive', 'Inactive')),
    contract_year: toStr(g('contract_year', 'ContractYear')),
    contract_send_date: toDate(g('contract_send_date', 'ContractSendDate')),
    contract_return_date: toDate(g('contract_return_date', 'ContractReturnDate')),
    contract_publish_date: toDate(g('contract_publish_date', 'ContractPublishDate')),
    entering_grade: toStr(g('entering_grade', 'EnteringGrade')),
    candidate_entering_year: toStr(g('candidate_entering_year', 'entering_year', 'CandidateEnteringYear')),
    candidate_status: toStr(g('candidate_status', 'CandidateStatus')),
    date_requested: toDate(g('date_requested', 'DateRequested')),
    date_due: toDate(g('date_due', 'DateDue')),
    date_waived: toDate(g('date_waived', 'DateWaived')),
    test_rescheduled: toDate(g('test_rescheduled', 'TestRescheduled')),
    test_no_show: toDate(g('test_no_show', 'TestNoShow')),
    contract_type: toStr(g('contract_type', 'ContractType')),
    test_short_description: toStr(g('test_short_description', 'TestShortDescription')),
    contract_dep_rec_date: toDate(g('contract_dep_rec_date', 'ContractDepRecDate')),
  };
}
