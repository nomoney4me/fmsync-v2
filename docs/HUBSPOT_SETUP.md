# HubSpot setup for FM Sync

What you need from HubSpot to run the HubSpot poller and the full sync flow (fetch deals → compute stage/substage → queue → POST to HubSpot). The poller uses the Search API and only fetches deals that have a value for the Blackbaud user id property, sorted by last modified date (newest first). You can optionally limit to deals modified after a given time via `HUBSPOT_MODIFIED_AFTER`.

---

## 1. What you need from HubSpot

### 1.1 Access token (required)

- **Type:** Private app access token (recommended) or OAuth access token.
- **Where:** HubSpot → **Settings** → **Integrations** → **Private Apps** → create an app (or use an existing one).
- **Scopes** (enable these for the private app):
  - **Read deals:** `crm.objects.deals.read` (or "Read all deals" in the UI).
  - **Write deals:** `crm.objects.deals.write` (or "Write all deals") — needed for the worker that PATCHes dealstage/substage.
- **Add to `.env`:**
  ```env
  HUBSPOT_ACCESS_TOKEN=pat-na1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  ```

### 1.2 Deal property: Blackbaud user id (required)

Deals must be linkable to Blackbaud checklist data by **user_id**.

- **Property internal name:** `blackbaud_user_id` (or your choice).
- **Type:** Single-line text or number (number is fine; we store Blackbaud `user_id`).
- **Where:** HubSpot → **Settings** → **Properties** → **Deal properties** → create (or find) a property and set the internal name.
- **Add to `.env`** if you use a different name:
  ```env
  HUBSPOT_DEAL_PROPERTY_BLACKBAUD_ID=blackbaud_user_id
  ```
- Each deal that should receive stage/substage updates from checklist data must have this property set to the corresponding Blackbaud **user_id**.

### 1.3 Deal stage (dealstage)

- **Property:** `dealstage` — standard HubSpot deal stage.
- Your pipeline stages should align with the values we send (from `stages.md`), e.g.:
  - `Application`
  - `Decision`
  - `Contract Sent`
  - `Closed Won`
  - `Closed Lost`
- In HubSpot, **Settings** → **Pipelines** → **Deals** → your pipeline: ensure stage IDs or values match what the app will send (we can map to your pipeline’s stage IDs if needed).

### 1.4 Substage (optional but recommended)

- **Property internal name:** `deal_substage_new` (or your choice; e.g. a custom single-line text or number).
- Used for substages 13–28 (e.g. “Application received”, “Assessment completed”, “Enrolled”).
- If you use a different property name, the processor/worker config will need to use that name when building the PATCH payload.

---

## 2. How the three goals map to the app

| Goal | Component | Status |
|------|-----------|--------|
| **1. Fetch HubSpot deals every N minutes** | **HubSpot poller** (`packages/hubspot-poller`) | ✅ Implemented. Uses `HUBSPOT_POLL_CRON` or `HUBSPOT_POLL_CRON_DEV` / `HUBSPOT_POLL_CRON_PROD` (default: every 5 min for both). Fetches deals and upserts into `hubspot_deals`. |
| **2. When logic is processed, insert (user_id, deal_id, stage, substage) into queue** | **Processor** (`packages/processor`) + **DB queue** | 🔲 Processor is still a stub. Needs to: join `hubspot_deals` ↔ checklist data by `blackbaud_user_id` = `user_id`, run stage/substage logic (`checklist-stages.ts`), compare to current deal; if different → insert into `hubspot_update_queue` (deal_id + payload with new dealstage/substage). |
| **3. POST to HubSpot and remove from queue** | **HubSpot worker** (consumer) | 🔲 Not implemented. Should: read `hubspot_update_queue` (status = pending), PATCH deal in HubSpot with `payload_json`, then mark row success (or failed/retry) and remove or update status. |

### 2.1 Database queue (already exists)

Table **`hubspot_update_queue`** (in `01-bb-schema.sql`):

- `deal_id` — HubSpot deal ID
- `payload_json` — JSON body to send when PATCHing the deal (e.g. `{ "dealstage": "...", "deal_substage_new": "..." }`)
- `status` — pending | processing | success | failed | dead
- `attempts`, `max_attempts`, `last_error`, `next_retry_at` — for retries

So “insert into the queue” = insert a row with `deal_id`, `payload_json` (stage + substage), `status = 'pending'`. “Remove from queue” = set `status = 'success'` (and optionally delete or archive later).

---

## 3. Env summary

| Variable | Required | Description |
|----------|----------|-------------|
| `HUBSPOT_ACCESS_TOKEN` | Yes | Private app (or OAuth) access token. |
| `HUBSPOT_DEAL_PROPERTY_BLACKBAUD_ID` | No | Default `blackbaud_user_id`. Deal property that stores Blackbaud user_id. |
| `HUBSPOT_POLL_CRON` | No | Cron for fetching deals; overrides both dev and prod. |
| `HUBSPOT_POLL_CRON_DEV` | No | Cron in non-production (default: `*/5` = every 5 min). |
| `HUBSPOT_POLL_CRON_PROD` | No | Cron in production (default: `*/5` = every 5 min). |
| `HUBSPOT_MODIFIED_AFTER` | No | Only fetch deals modified on or after this time (Unix ms). Omit to fetch all. |
| `DATABASE_URL` | Yes | Postgres connection string (for `hubspot_deals` and `hubspot_update_queue`). |

---

## 4. Quick checklist

- [ ] Create a HubSpot private app (or use OAuth).
- [ ] Grant **read** and **write** access to deals.
- [ ] Copy the access token into `.env` as `HUBSPOT_ACCESS_TOKEN`.
- [ ] Create or identify the deal property for Blackbaud user id; set `HUBSPOT_DEAL_PROPERTY_BLACKBAUD_ID` if different from `blackbaud_user_id`.
- [ ] Ensure deals that should be updated have `blackbaud_user_id` (or your property) set to the correct Blackbaud user_id.
- [ ] Align pipeline deal stages (and optional substage property) with the values the app will send (we can map to your pipeline in code if needed).

Once the processor and worker are implemented, the flow will be: **poller fetches deals** → **processor computes stage/substage and enqueues** → **worker PATCHes HubSpot and marks queue rows success**.
