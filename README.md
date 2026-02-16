# FM Sync – Blackbaud ↔ HubSpot Deal Sync

Sync checklist data from Blackbaud Sky API to HubSpot deals with a pipeline: poll → transform → match → queue → update (with retries).

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Start PostgreSQL

```bash
npm run db:up
```

The schema is applied automatically on first start via `infrastructure/db/init/`.

**Existing DBs:** Run the diff migration for upsert + change detection:
```bash
psql $DATABASE_URL -f infrastructure/db/init/02-checklist-diff.sql
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your Blackbaud and HubSpot credentials
```

### 4. Obtain Blackbaud refresh token (OAuth 2.0, one-time)

Run the OAuth flow once. The token is saved to `.blackbaud-tokens.json`; the poller uses it automatically:

```bash
# Add BLACKBAUD_CLIENT_ID and BLACKBAUD_CLIENT_SECRET to .env first
# Register your app at https://developer.blackbaud.com/skyapi/applications/createapp
# Add redirect URI: http://localhost:3001/bb-callback

npm run bb:auth
```

Open http://localhost:3001, click "Authorize with Blackbaud", sign in. The refresh token is stored automatically. You only need to repeat this if the token is revoked or expires from long inactivity.

### 5. Run services (as we build them)

```bash
# Build shared package first
npm run build -w @fm-sync/shared

# Run individual services (Phase 2+)
npm run dev:blackbaud
npm run dev:hubspot-poller
npm run dev:processor
npm run dev:worker

# Frontend dashboard (Phase 4)
npm run dev:frontend
```

## Pipeline Flow

1. **Poll checklist data** (blackbaud-poller) – Fetches current data, upserts into `checklist_items`
2. **Diff detection** – On each poll, new data is compared to current; if different, `(user_id, checklist_id, checklist_item_id)` is logged to `checklist_diff_queue`
3. **Dealstage transform** (processor) – For each row in `checklist_diff_queue`, runs `dealstage_transformer` for that `user_id` (blackbaud_id) to compute new dealstage/subdealstage
4. **HubSpot queue** – Calculated result is pushed to `hubspot_update_queue` (to be submitted to HubSpot)

## Project Structure

```
fm-sync-final/
├── packages/
│   ├── shared/           # Types, dealstage_transformer
│   ├── blackbaud-poller/ # Step 1: Poll Blackbaud checklist
│   ├── hubspot-poller/   # Step 2: Poll HubSpot deals
│   ├── processor/        # Steps 3–5: Transform, match, enqueue
│   └── hubspot-worker/   # Step 6: Update HubSpot, retry
├── apps/
│   └── frontend/         # Next.js dashboard
├── infrastructure/db/    # Schema, migrations
└── docker-compose.yml
```

## Implementation Phases

- **Phase 1** ✓ Foundation (Docker, DB, shared package, stubs)
- **Phase 2** Pollers (Blackbaud, HubSpot)
- **Phase 3** Processor & HubSpot worker
- **Phase 4** Retry logic, Next.js dashboard
- **Phase 5** Polish (manual retry, alerts)

See [PROJECT_PLAN.md](./PROJECT_PLAN.md) for full architecture.
