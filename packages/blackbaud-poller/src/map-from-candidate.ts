/**
 * Map AFE-EDEMS candidate + checklist response to checklist_items rows.
 * One ChecklistRow per checklist step, with candidate-level fields merged in.
 */
import type { CandidateResponse } from './blackbaud-client';
import type { CandidateChecklistResponse, CandidateChecklistStep } from './blackbaud-client';
import type { ChecklistRow } from './map-to-checklist';

function toDate(val: string | null | undefined): string | null {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  const d = s.split('T')[0];
  return d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d : null;
}

function toNum(val: number | string | null | undefined): number | null {
  if (val == null || val === '') return null;
  const n = typeof val === 'number' ? val : parseInt(String(val), 10);
  return isNaN(n) ? null : n;
}

function toStr(val: string | null | undefined): string | null {
  if (val == null || val === '') return null;
  return String(val).trim() || null;
}

/**
 * Build one ChecklistRow from a candidate and a single checklist step.
 * Uses 0 for checklist_id/item_id when API omits them so the row participates in the unique index and upserts correctly.
 */
function stepToRow(
  candidate: CandidateResponse,
  step: CandidateChecklistStep,
  checklist: CandidateChecklistResponse,
  stepIndex: number
): ChecklistRow {
  const userId = toNum(candidate.user?.id) ?? null;
  // Use checklist type id from the checklist response so all steps from this checklist share the same key (avoids mixing instance id with type id).
  const checklistId = toNum(checklist.type?.id) ?? toNum(candidate.candidate_checklist?.id) ?? 0;
  const checklistName = toStr(checklist.type?.name) ?? toStr(candidate.candidate_checklist?.name) ?? null;
  const stepType = step.type;
  // Use step.type.id (type id) as checklist_item_id so each step type gets one row (API often reuses step.id across different steps).
  const itemId = toNum(stepType?.id) ?? toNum(step.id) ?? (1000000 + stepIndex);
  // Step name may be on type.name or on the step itself (API varies)
  const itemName = toStr(stepType?.name) ?? toStr((step as { name?: string }).name) ?? null;

  return {
    user_id: userId,
    first_name: toStr(candidate.user?.first_name) ?? null,
    last_name: toStr(candidate.user?.last_name) ?? null,
    checklist_id: checklistId,
    checklist_name: checklistName,
    checklist_item_id: itemId,
    date_completed: toDate(step.date_completed ?? null),
    checklist_item: itemName,
    step_status: toStr(step.status) ?? null,
    contract_status: null,
    inactive_reason: null,
    candidate_decision: toStr(candidate.school_decision?.candidate_response?.response?.description) ?? null,
    school_decision: toStr(candidate.school_decision?.decision?.description) ?? null,
    reason_declined: toStr(candidate.school_decision?.candidate_response?.decline_reason?.description) ?? null,
    inactive: null,
    contract_year: null,
    contract_send_date: null,
    contract_return_date: null,
    contract_publish_date: toDate(candidate.school_decision?.publish_date ?? null),
    entering_grade: toStr(candidate.entering_grade?.abbreviation) ?? toStr(candidate.entering_grade?.description) ?? null,
    candidate_entering_year: toStr(candidate.entering_year?.description) ?? null,
    candidate_status: toStr(candidate.candidate_status) ?? null,
    date_requested: toDate(step.date_requested ?? step.due_date ?? null),
    date_due: toDate(step.due_date ?? null),
    date_waived: toDate((step as { date_waived?: string }).date_waived ?? null),
    test_rescheduled: null,
    test_no_show: null,
    contract_type: null,
    test_short_description: null,
    contract_dep_rec_date: null,
  };
}

/**
 * Convert one candidate and their checklist response into ChecklistRow[] (one per step).
 * If the candidate has no checklist or no steps, returns a single row with candidate-level
 * data only (so we still have one row per user for stage logic when there are no steps).
 */
export function mapCandidateAndChecklistToRows(
  candidate: CandidateResponse,
  checklist: CandidateChecklistResponse | null
): ChecklistRow[] {
  const userId = toNum(candidate.user?.id) ?? null;
  // Prefer checklist type id from response so keys match step rows; fall back to candidate checklist id for summary row when no checklist fetched.
  const checklistId =
    (checklist?.type?.id != null ? Number(checklist.type.id) : null) ?? toNum(candidate.candidate_checklist?.id) ?? null;
  const checklistName = toStr(checklist?.type?.name) ?? toStr(candidate.candidate_checklist?.name) ?? null;

  const baseRow: ChecklistRow = {
    user_id: userId,
    first_name: toStr(candidate.user?.first_name) ?? null,
    last_name: toStr(candidate.user?.last_name) ?? null,
    checklist_id: checklistId,
    checklist_name: checklistName,
    checklist_item_id: null,
    date_completed: null,
    checklist_item: null,
    step_status: null,
    contract_status: null,
    inactive_reason: null,
    candidate_decision: toStr(candidate.school_decision?.candidate_response?.response?.description) ?? null,
    school_decision: toStr(candidate.school_decision?.decision?.description) ?? null,
    reason_declined: toStr(candidate.school_decision?.candidate_response?.decline_reason?.description) ?? null,
    inactive: null,
    contract_year: null,
    contract_send_date: null,
    contract_return_date: null,
    contract_publish_date: toDate(candidate.school_decision?.publish_date ?? null),
    entering_grade: toStr(candidate.entering_grade?.abbreviation) ?? toStr(candidate.entering_grade?.description) ?? null,
    candidate_entering_year: toStr(candidate.entering_year?.description) ?? null,
    candidate_status: toStr(candidate.candidate_status) ?? null,
    date_requested: null,
    date_due: null,
    date_waived: null,
    test_rescheduled: null,
    test_no_show: null,
    contract_type: null,
    test_short_description: null,
    contract_dep_rec_date: null,
  };

  if (!checklist?.steps?.length) {
    // One row per user with candidate-level data only; use synthetic ids so row participates in unique index.
    baseRow.checklist_id = checklistId !== null ? checklistId : 0;
    baseRow.checklist_item_id = 0;
    return [baseRow];
  }

  return checklist.steps.map((step, stepIndex) => stepToRow(candidate, step, checklist, stepIndex));
}
