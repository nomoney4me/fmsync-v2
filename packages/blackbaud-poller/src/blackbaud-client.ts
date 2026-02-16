/**
 * Blackbaud Sky API client - OAuth + Advance list fetch
 * Uses GET /school/v1/lists/advanced/{listId} with pagination
 *
 * Refresh token persistence: Blackbaud returns a new refresh_token when you refresh.
 * We persist it so you only need to run the OAuth flow once.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import path from 'path';
import { createLogger } from '@fm-sync/shared';

const log = createLogger('blackbaud-client', 'bb');

const TOKEN_URL = 'https://oauth2.sky.blackbaud.com/token';

/** Resolve .env path: explicit env, then repo root, then cwd (for different run directories). */
function resolveEnvPath(): string {
  if (process.env.BLACKBAUD_ENV_FILE) return process.env.BLACKBAUD_ENV_FILE;
  const candidates = [
    path.resolve(__dirname, '../../../.env'),
    path.resolve(process.cwd(), '.env'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}
const ENV_PATH = resolveEnvPath();

export interface BlackbaudConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  apiBaseUrl: string;
  subscriptionKey: string;
  listId: string;
}

/** Query params for GET /afe-edems/v1/candidates */
export interface CandidatesQueryParams {
  school_year?: string;
  status?: string;
  modified_date?: string; // ISO-8601 e.g. 2025-04-30
  size?: number;
  page?: number;
  school_level?: number;
}

/** Minimal candidate shape from GET /afe-edems/v1/candidates (value[].*) */
export interface CandidateResponse {
  user?: { id?: number; first_name?: string; last_name?: string };
  entering_year?: { id?: number; description?: string };
  entering_grade?: { id?: number; abbreviation?: string; description?: string };
  candidate_status?: string;
  status?: { id?: number; description?: string; date?: string };
  school_decision?: {
    id?: number;
    decision?: { id?: number; description?: string };
    date?: string;
    publish_date?: string;
    expire_date?: string;
    candidate_response?: {
      id?: number;
      response?: { description?: string };
      date?: string;
      decline_reason?: { id?: number; description?: string };
    };
  };
  application?: {
    id?: number;
    form?: { id?: number; description?: string };
    date_submitted?: string;
    date_processed?: string;
  };
  candidate_checklist?: { id?: number; name?: string };
  modified?: string;
  created?: string;
}

export interface CandidatesApiResponse {
  count?: number;
  value?: CandidateResponse[];
}

const LEGACY_TOKENS_FILE = path.resolve(__dirname, '../.blackbaud-tokens.json');

/** Get refresh token from env (loaded by caller from .env). Migrates from legacy .json if present. */
export function loadStoredRefreshToken(): string | null {
  // One-time migration: .json has the latest rotated token; prefer it if present
  try {
    if (existsSync(LEGACY_TOKENS_FILE)) {
      const data = JSON.parse(readFileSync(LEGACY_TOKENS_FILE, 'utf8'));
      const token = data.refresh_token;
      if (token) {
        storeRefreshToken(token);
        try { unlinkSync(LEGACY_TOKENS_FILE); } catch { /* ignore */ }
        return token;
      }
    }
  } catch { /* ignore */ }
  const t = process.env.BLACKBAUD_REFRESH_TOKEN;
  return (typeof t === 'string' && t.trim()) ? t.trim() : null;
}

/** Persist refresh token to .env (Blackbaud rotates it on each refresh). */
export function storeRefreshToken(refreshToken: string): void {
  try {
    if (!existsSync(ENV_PATH)) {
      log.warn({ path: ENV_PATH }, 'Cannot persist token: .env not found');
      return;
    }
    let content = readFileSync(ENV_PATH, 'utf8');
    const line = `BLACKBAUD_REFRESH_TOKEN=${refreshToken}`;
    if (/^BLACKBAUD_REFRESH_TOKEN=/m.test(content)) {
      content = content.replace(/^BLACKBAUD_REFRESH_TOKEN=.*$/m, line);
    } else {
      content = content.trimEnd() + (content.endsWith('\n') ? '' : '\n') + `\n${line}\n`;
    }
    writeFileSync(ENV_PATH, content, 'utf8');
    process.env.BLACKBAUD_REFRESH_TOKEN = refreshToken;
    log.info('Refresh token persisted to .env');
  } catch (err) {
    log.warn({ err }, 'Failed to persist refresh token');
  }
}

let cachedToken: { access_token: string; expires_at: number } | null = null;
let refreshInProgress: Promise<string> | null = null;

export async function getAccessToken(
  config: Pick<BlackbaudConfig, 'clientId' | 'clientSecret' | 'refreshToken'>
): Promise<string> {
  if (cachedToken && cachedToken.expires_at > Date.now()) {
    log.debug('Using cached access token');
    return cachedToken.access_token;
  }

  // Serialize concurrent refresh: if one worker is already refreshing, wait for it
  if (refreshInProgress) {
    return refreshInProgress;
  }

  const refreshToken = config.refreshToken;
  if (!refreshToken) {
    throw new Error('No refresh token. Run `npm run bb:auth` to obtain one.');
  }

  log.info('Refreshing access token');
  const refreshPromise = (async () => {
    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });

      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Blackbaud token refresh failed: ${res.status} ${text}`);
      }

      const json = (await res.json()) as {
        access_token: string;
        expires_in: number;
        refresh_token?: string;
      };
      const expiresIn = json.expires_in ?? 3600;
      cachedToken = {
        access_token: json.access_token,
        expires_at: Date.now() + expiresIn * 1000,
      };

      if (json.refresh_token) {
        storeRefreshToken(json.refresh_token);
        log.info('Access token refreshed, new refresh token persisted');
      } else {
        log.info('Access token refreshed');
      }

      return cachedToken!.access_token;
    } finally {
      refreshInProgress = null;
    }
  })();

  refreshInProgress = refreshPromise;
  return refreshPromise;
}

interface AdvanceListRow {
  columns: Array<{ name: string; value: unknown }>;
}

interface AdvanceListResponse {
  results?: {
    rows?: AdvanceListRow[];
  };
}

/** Transform column name to key: replace spaces with _, lowercase, handle candidate_entering_year */
function columnNameToKey(name: string): string {
  let key = name.replace(/ /g, '_').toLowerCase();
  if (key === 'candidate_entering_year') key = 'entering_year';
  return key;
}

/** Convert Advance list row (columns array) to plain object */
function rowToObject(row: AdvanceListRow): Record<string, unknown> {
  return row.columns.reduce(
    (acc, cur) => {
      const key = columnNameToKey(cur.name);
      acc[key] = cur.value;
      return acc;
    },
    {} as Record<string, unknown>
  );
}

/**
 * Fetch a single page of checklist items by page number.
 * Use for testing or ad-hoc page retrieval.
 */
export async function fetchChecklistListPage(
  config: BlackbaudConfig,
  pageNumber: number
): Promise<Record<string, unknown>[]> {
  const token = await getAccessToken(config);
  const baseUrl = config.apiBaseUrl.replace(/\/$/, '');
  const listId = config.listId;
  const url = `${baseUrl}/school/v1/lists/advanced/${listId}?page=${pageNumber}`;

  log.info({ page: pageNumber, listId }, 'Fetching list page');

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Bb-Api-Subscription-Key': config.subscriptionKey,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Blackbaud list fetch failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as AdvanceListResponse;
  const rows = json.results?.rows ?? [];
  const items = rows.map((row) => rowToObject(row));

  log.info({ page: pageNumber, rowsInPage: items.length }, 'List page fetched');

  return items;
}

/**
 * Async generator that yields each page of checklist items.
 * Use this to process pages incrementally and avoid loading everything into memory.
 */
export async function* fetchChecklistListPages(
  config: BlackbaudConfig
): AsyncGenerator<unknown[], void, unknown> {
  const token = await getAccessToken(config);
  const baseUrl = config.apiBaseUrl.replace(/\/$/, '');
  const listId = config.listId;

  log.info({ listId }, 'Fetching Advance list');

  let page = 1;
  const maxPages = 100; // safety limit

  while (page <= maxPages) {
    const url = `${baseUrl}/school/v1/lists/advanced/${listId}?page=${page}`;
    log.debug({ page }, 'Fetching list page');

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Bb-Api-Subscription-Key': config.subscriptionKey,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Blackbaud list fetch failed: ${res.status} ${text}`);
    }

    const json = (await res.json()) as AdvanceListResponse;
    const rows = json.results?.rows ?? [];
    const items = rows.map((row) => rowToObject(row));

    log.info({ page, rowsInPage: items.length }, 'List page fetched');

    if (items.length > 0) yield items;
    if (rows.length === 0) break;
    page++;
  }

  log.info({ totalPages: page - 1 }, 'Advance list fetch complete');
}

/** Minimal config for auth-only requests (e.g. candidate checklist). */
export interface BlackbaudAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  apiBaseUrl: string;
  subscriptionKey: string;
}

/** Checklist step from AFE-EDEMS API (may be top-level or under a milestone) */
export interface CandidateChecklistStep {
  id?: number;
  type?: {
    id?: number;
    name?: string;
    type?: string;
    milestone?: string;
    due_date_default?: string;
    publishing_options?: Record<string, unknown>;
  };
  status?: string;
  due_date?: string;
  date_completed?: string | null;
  date_requested?: string | null;
  comment?: string | null;
}

/** Milestone/section in checklist (e.g. Inquiry, Applicant, Contract) - API may return steps under these */
export interface CandidateChecklistMilestone {
  id?: number;
  name?: string;
  type?: { id?: number; name?: string };
  steps?: CandidateChecklistStep[];
  items?: CandidateChecklistStep[]; // some APIs use items instead of steps
}

/** Raw API response: steps may be top-level and/or nested under milestones */
export interface CandidateChecklistResponseRaw {
  type?: {
    id?: number;
    name?: string;
    is_inactive?: boolean;
    is_archived?: boolean;
  };
  steps?: CandidateChecklistStep[];
  milestones?: CandidateChecklistMilestone[];
}

/** Normalized checklist response with a single flat steps array for mapping */
export interface CandidateChecklistResponse {
  type: {
    id: number;
    name: string;
    is_inactive?: boolean;
    is_archived?: boolean;
  };
  steps: CandidateChecklistStep[];
}

/**
 * Fetch a specific candidate's checklist.
 * GET /afe-edems/v1/checklists/{candidate_id}?entering_year=...
 * entering_year is required (e.g. "2024 - 2025")
 */
export async function fetchCandidateChecklist(
  config: BlackbaudAuthConfig | BlackbaudConfig,
  candidateId: number | string,
  enteringYear: string
): Promise<CandidateChecklistResponse> {
  const token = await getAccessToken(config);
  const baseUrl = config.apiBaseUrl.replace(/\/$/, '');
  const year = enteringYear.trim();
  if (!year) {
    throw new Error('entering_year is required for fetchCandidateChecklist');
  }
  const url = `${baseUrl}/afe-edems/v1/checklists/${encodeURIComponent(String(candidateId))}?entering_year=${encodeURIComponent(year)}`;

  log.debug({ candidateId, enteringYear, url }, 'GET candidate checklist');

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Bb-Api-Subscription-Key': config.subscriptionKey,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Candidate checklist fetch failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as CandidateChecklistResponseRaw;

  // Flatten steps: API may return top-level steps and/or steps nested under milestones (Inquiry, Applicant, Contract, etc.)
  const topLevelSteps = Array.isArray(json.steps) ? json.steps : [];
  const milestoneSteps = (Array.isArray(json.milestones) ? json.milestones : []).flatMap(
    (m) => (Array.isArray(m.steps) ? m.steps : Array.isArray((m as { items?: CandidateChecklistStep[] }).items) ? (m as { items: CandidateChecklistStep[] }).items : []) as CandidateChecklistStep[]
  );
  // Merge both sources; dedupe by (step.id, step.type.id) so we only drop exact duplicates (API sometimes reuses step.id across different steps)
  const seenKeys = new Set<string>();
  const steps = [...topLevelSteps, ...milestoneSteps].filter((s) => {
    const id = s.id;
    const typeId = s.type?.id;
    const key = `${id ?? 'n'}\0${typeId ?? 'n'}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  const type = json.type ?? { id: 0, name: 'Checklist' };
  const normalized: CandidateChecklistResponse = {
    type: { id: type.id ?? 0, name: type.name ?? 'Checklist', is_inactive: type.is_inactive, is_archived: type.is_archived },
    steps,
  };

  log.debug({ candidateId, stepsCount: normalized.steps.length, fromMilestones: milestoneSteps.length }, 'Candidate checklist fetched');

  return normalized;
}

const CANDIDATES_PATH = '/afe-edems/v1/candidates';

/** Normalize school_year to "YYYY - YYYY" format (e.g. "2025" -> "2024 - 2025"). */
export function normalizeSchoolYear(value: string): string {
  const s = String(value).trim();
  if (!s) return s;
  if (s.includes(' - ')) return s;
  const n = parseInt(s, 10);
  if (!Number.isNaN(n) && n >= 1000 && n <= 9999) {
    return `${n - 1} - ${n}`;
  }
  return s;
}

/**
 * Fetch one page of candidates from AFE-EDEMS API.
 * GET https://api.sky.blackbaud.com/afe-edems/v1/candidates
 * school_year is normalized to "YYYY - YYYY" if you pass a single year (e.g. "2025" -> "2024 - 2025").
 */
export async function fetchCandidatesPage(
  config: BlackbaudAuthConfig | BlackbaudConfig,
  params: CandidatesQueryParams = {}
): Promise<CandidatesApiResponse> {
  const token = await getAccessToken(config);
  const baseUrl = config.apiBaseUrl.replace(/\/$/, '');
  const search = new URLSearchParams();
  if (params.school_year != null) search.set('school_year', normalizeSchoolYear(params.school_year));
  if (params.status != null) search.set('status', params.status);
  if (params.modified_date != null) search.set('modified_date', params.modified_date);
  if (params.size != null) search.set('size', String(params.size));
  if (params.page != null) search.set('page', String(params.page));
  if (params.school_level != null) search.set('school_level', String(params.school_level));
  const qs = search.toString();
  const url = qs ? `${baseUrl}${CANDIDATES_PATH}?${qs}` : `${baseUrl}${CANDIDATES_PATH}`;

  log.info({ method: 'GET', url }, 'GET candidates');

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Bb-Api-Subscription-Key': config.subscriptionKey,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Candidates API failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as CandidatesApiResponse;
  const count = json.value?.length ?? 0;
  log.info({ method: 'GET', url, responseCount: count }, 'GET candidates response');
  return json;
}
