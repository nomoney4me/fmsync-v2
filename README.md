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

---

## Moving from dev to production

### 1. Environment

- Set **`NODE_ENV=production`** (the systemd units set this).
- Use a production **`.env`** in the app directory (or configure env vars for the service). The units use `WorkingDirectory` so the app loads `.env` from that directory.
- Ensure **Blackbaud** refresh token is available in production (e.g. copy `.blackbaud-tokens.json` or re-run OAuth once on the prod server with prod app credentials).
- See [docs/HUBSPOT_SETUP.md](./docs/HUBSPOT_SETUP.md) for HubSpot token and deal/contact property setup.

### 2. Database

- Production Postgres must be running and reachable.
- Run migrations if you have any beyond the init scripts:
  ```bash
  npm run db:migrate
  ```
- For an existing DB that didn’t get the diff migration:
  ```bash
  psql $DATABASE_URL -f infrastructure/db/init/02-checklist-diff.sql
  ```

### 3. Build

From the repo root, build in dependency order so `dist/` is up to date:

```bash
# Required first: shared (used by pollers)
npm run build -w @fm-sync/shared

# Then the pollers (required for systemd)
npm run build -w @fm-sync/hubspot-poller
npm run build -w @fm-sync/blackbaud-poller
```

### 4. Run with systemd

The project uses **systemd** (not PM2) so it runs well on resource-limited VMs. Unit files are in `infrastructure/systemd/`.

**Install the units** (edit paths if your app is not in `/opt/fm-sync`):

```bash
sudo cp infrastructure/systemd/fm-sync-hubspot-poller.service /etc/systemd/system/
sudo cp infrastructure/systemd/fm-sync-blackbaud-poller.service /etc/systemd/system/
```

Edit each unit if needed (e.g. `WorkingDirectory` and `ExecStart` path, or `User`/`Group`):

```bash
sudo systemctl edit --full fm-sync-hubspot-poller
sudo systemctl edit --full fm-sync-blackbaud-poller
```

**Enable and start:**

```bash
sudo systemctl daemon-reload
sudo systemctl enable fm-sync-hubspot-poller fm-sync-blackbaud-poller
sudo systemctl start fm-sync-hubspot-poller fm-sync-blackbaud-poller
```

**Useful commands:**

```bash
sudo systemctl status fm-sync-hubspot-poller
sudo systemctl status fm-sync-blackbaud-poller
journalctl -u fm-sync-hubspot-poller -f
journalctl -u fm-sync-blackbaud-poller -f
sudo systemctl restart fm-sync-hubspot-poller
sudo systemctl stop fm-sync-hubspot-poller fm-sync-blackbaud-poller
```

The units are enabled for boot, so both pollers start automatically after a reboot.

**Optional: stages test server (port 3002)**  
To run the stage/substage test UI (look up a user by Blackbaud ID, see checklist + calculation):

```bash
sudo cp infrastructure/systemd/fm-sync-stages-test.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fm-sync-stages-test
```

Requires `npm install` at repo root (so `npx tsx` works). Open `http://<your-server>:3002` in a browser. Port can be changed with `Environment=STAGES_TEST_PORT=3002` in the unit or in `.env` as `STAGES_TEST_PORT`.

### 5. Poll schedule

In production, pollers use the **prod** cron (default every 5 minutes). Override with env vars:

- **HubSpot:** `HUBSPOT_POLL_CRON`, or `HUBSPOT_POLL_CRON_PROD` / `HUBSPOT_POLL_CRON_DEV`
- **Blackbaud:** `BLACKBAUD_POLL_CRON`, or `BLACKBAUD_POLL_CRON_PROD` / `BLACKBAUD_POLL_CRON_DEV`

Example: `HUBSPOT_POLL_CRON_PROD='*/15 * * * *'` for every 15 minutes in production only.
