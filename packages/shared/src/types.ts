/**
 * Shared types for FM Sync pipeline
 */

/** Raw checklist item from Blackbaud (shape depends on Sky API) */
export interface ChecklistItem {
  blackbaud_id: string;
  [key: string]: unknown;
}

/** Raw deal from HubSpot (shape depends on API response) */
export interface HubSpotDeal {
  id: string;
  properties?: Record<string, string>;
  [key: string]: unknown;
}

/** Result of dealstage transformation */
export interface DealStageResult {
  dealstage: string;
  subdealstage?: string;
}

/** Payload to send to HubSpot for deal update */
export interface HubSpotUpdatePayload {
  dealstage: string;
  subdealstage?: string;
  [key: string]: unknown;
}

/** Queue status for hubspot_update_queue */
export type QueueStatus = 'pending' | 'processing' | 'success' | 'failed' | 'dead';
