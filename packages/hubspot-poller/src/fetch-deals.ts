/**
 * Fetch HubSpot deals that have the Blackbaud user id property set (on the Deal object).
 * Uses Search API: filter by HAS_PROPERTY(blackbaud_user_id), paginate, optional modifiedAfter.
 */
import { createLogger } from '@fm-sync/shared';

const log = createLogger('hubspot-fetch-deals', 'hs');

const SEARCH_URL = 'https://api.hubapi.com/crm/v3/objects/0-3/search';
const DELAY_MS = 250;
const MAX_429_RETRIES = 2;

export interface FetchDealsOptions {
  /** HubSpot access token (used for raw fetch; client kept for API compatibility). */
  accessToken: string;
  /** Deal property that stores Blackbaud user id (e.g. blackbaud_user_id). Must exist on Deal. */
  blackbaudProperty: string;
  limit?: number;
  /** If set, only return deals with hs_lastmodifieddate >= modifiedAfter (ms). */
  modifiedAfter?: number;
}

export interface DealResult {
  id: string;
  properties?: Record<string, string>;
}

/** Deal properties we request from the API (including the Blackbaud id on the Deal). */
export function getDealProperties(blackbaudProperty: string): string[] {
  return [
    blackbaudProperty,
    'createdate',
    'deal_substage_new',
    'dealname',
    'dealstage',
    'hs_lastmodifieddate',
    'hs_object_id',
    'isp_entry_year',
    'pipeline',
  ];
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch deals that have the given property set (e.g. blackbaud_user_id on the Deal).
 * Sorts by last modified descending in memory (Search API sorts can cause 400).
 */
export async function fetchDealsSearch(
  _client: { accessToken?: string },
  options: FetchDealsOptions
): Promise<DealResult[]> {
  const { accessToken, blackbaudProperty, limit = 100, modifiedAfter } = options;
  const dealProperties = getDealProperties(blackbaudProperty);

  const all: DealResult[] = [];
  let after: string | undefined;

  const buildBody = (): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: blackbaudProperty,
              operator: 'HAS_PROPERTY',
            },
          ],
        },
      ],
      limit: Math.min(limit, 100),
      properties: dealProperties,
    };
    if (after) body.after = after;
    return body;
  };

  const token = accessToken || (_client as { accessToken?: string }).accessToken;
  if (!token) {
    throw new Error('fetchDealsSearch requires accessToken in options or on client');
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const body = buildBody();
    let res: Response;
    let lastErr: Error | null = null;
    for (let retry = 0; retry <= MAX_429_RETRIES; retry++) {
      res = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        const wait = retryAfter ? parseInt(retryAfter, 10) * 1000 : DELAY_MS;
        log.warn({ retry, waitMs: wait }, 'Rate limited (429), retrying');
        await sleep(wait);
        lastErr = new Error(`Rate limited after ${MAX_429_RETRIES + 1} attempts`);
        continue;
      }
      lastErr = null;
      break;
    }
    if (lastErr) throw lastErr;

    if (!res!.ok) {
      const text = await res!.text();
      log.error(
        { status: res!.status, body: text, requestBody: body },
        'HubSpot search request failed'
      );
      throw new Error(`HubSpot search failed: ${res!.status} ${text}`);
    }

    const data = (await res!.json()) as {
      results?: Array<{ id: string; properties?: Record<string, string> }>;
      total?: number;
      paging?: { next?: { after?: string } };
    };
    const results = data.results ?? [];
    const total = data.total ?? 0;

    for (const r of results) {
      if (modifiedAfter != null && modifiedAfter > 0) {
        const lastMod = r.properties?.hs_lastmodifieddate;
        const ts = lastMod ? parseInt(lastMod, 10) : 0;
        if (!Number.isFinite(ts) || ts < modifiedAfter) continue;
      }
      all.push({ id: r.id, properties: r.properties });
    }

    log.info(
      { pageResults: results.length, totalSoFar: all.length, after, responseTotal: total },
      'Fetched deals page'
    );

    const nextAfter = data.paging?.next?.after;
    if (!nextAfter || results.length === 0) break;
    after = nextAfter;
    await sleep(DELAY_MS);
  }

  // Sort by last modified descending (newest first)
  all.sort((a, b) => {
    const ta = parseInt(a.properties?.hs_lastmodifieddate ?? '0', 10) || 0;
    const tb = parseInt(b.properties?.hs_lastmodifieddate ?? '0', 10) || 0;
    return tb - ta;
  });

  log.info({ totalDeals: all.length }, 'Fetch complete');
  return all;
}
