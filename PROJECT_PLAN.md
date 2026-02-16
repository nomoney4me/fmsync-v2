# Blackbaud ↔ HubSpot Deal Sync - Project Plan

## Overview

A Docker-based service that syncs checklist data from Blackbaud Sky API to HubSpot deals. The system polls both APIs, applies business logic to determine deal stage updates, queues changes, and updates HubSpot with retry support. A Next.js frontend provides visibility into the pipeline and errors.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              Docker Compose Stack                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────────────────┐   │
│  │  Poller 1    │    │  Poller 2    │    │  Worker / Processor               │   │
│  │  Blackbaud   │    │  HubSpot     │    │  - Match by blackbaud_id          │   │
│  │  Checklist   │    │  Deals       │    │  - dealstage_transformer logic    │   │
│  │  (cron/sched)│    │  (cron/sched)│    │  - Enqueue updates                │   │
│  └──────┬───────┘    └──────┬───────┘    └───────────────┬──────────────────┘   │
│         │                   │                            │                       │
│         └───────────────────┴────────────────────────────┘                       │
│                                     │                                            │
│                                     ▼                                            │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                         Database (PostgreSQL)                             │   │
│  │  - raw_checklist_items, raw_deals (polled data)                           │   │
│  │  - hubspot_update_queue (pending updates)                                 │   │
│  │  - sync_logs, error_logs (audit & retry)                                  │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                     │                                            │
│                                     ▼                                            │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                         HubSpot API Worker                                │   │
│  │  - Process queue (POST to HubSpot)                                        │   │
│  │  - Log failures, retry with backoff                                       │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                   │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                         Next.js Frontend                                  │   │
│  │  - Dashboard: pipeline steps, queue status, errors                        │   │
│  │  - Per-step views, retry triggers                                         │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow (6 Steps)

| Step | Component | Description |
|------|-----------|-------------|
| 1 | Blackbaud Poller | Poll checklist items from Blackbaud Sky API on a schedule |
| 2 | HubSpot Poller | Poll deals from HubSpot via `@hubspot/api-client` npm package |
| 3 | Processor | Apply `dealstage_transformer` logic to checklist data → next dealstage & subdealstage |
| 4 | Matcher | Match records by `blackbaud_id` (checklist) ↔ deal property (HubSpot) → get `dealId` |
| 5 | Enqueuer | Insert update payloads into DB queue (`hubspot_update_queue`) |
| 6 | HubSpot Worker | Consume queue, POST to HubSpot, log errors, retry on failure |

---

## Proposed Service Structure

### Option A: Monorepo (Recommended)

```
fm-sync-final/
├── docker-compose.yml
├── .env.example
├── packages/
│   ├── blackbaud-poller/     # Node.js service - polls Blackbaud Sky API
│   ├── hubspot-poller/       # Node.js service - polls HubSpot deals
│   ├── processor/            # Node.js - transform & match logic
│   ├── hubspot-worker/       # Node.js - consumes queue, updates HubSpot
│   └── shared/               # Shared types, config, dealstage_transformer
├── apps/
│   ├── frontend/             # Next.js dashboard
│   └── api/                  # Optional: API for frontend (or Next.js API routes)
└── infrastructure/
    └── db/                   # Migrations, seeds
```

### Option B: Single Worker Service

Combine pollers + processor + worker into one Node.js app with internal queues (simpler, fewer containers).

---

## Technology Choices

| Concern | Recommendation | Notes |
|---------|----------------|-------|
| Runtime | Node.js | Matches HubSpot npm client; easy to add Blackbaud SDK/HTTP |
| Queue | PostgreSQL + `pg-boss` or ` BullMQ` + Redis | PostgreSQL alone = fewer services; Redis = faster queue |
| Database | PostgreSQL | Reliable, good for JSON columns if needed |
| Scheduler | `node-cron` or separate `ofelia` (Cron in Docker) | Per-service cron vs. centralized |
| HubSpot Client | `@hubspot/api-client` (npm) | Official, supports deals API |
| Blackbaud | REST API via `axios` / fetch | Sky API is REST-based |

---

## Key Files to Implement

| File | Purpose |
|------|---------|
| `shared/dealstage_transformer.ts` | Logic: checklist data → `{ dealstage, subdealstage }` |
| `blackbaud-poller/poll.ts` | Fetch checklist items, upsert into `raw_checklist_items` |
| `hubspot-poller/poll.ts` | Fetch deals (incl. `blackbaud_id`), upsert into `raw_deals` |
| `processor/run.ts` | Match, transform, enqueue |
| `hubspot-worker/consumer.ts` | Process queue, PATCH deals, retry on failure |
| `docker-compose.yml` | All services + PostgreSQL (+ Redis if used) |

---

## Database Schema (Conceptual)

```sql
-- Raw polled data
raw_checklist_items (id, blackbaud_id, payload_json, polled_at, ...)
raw_deals          (id, deal_id, blackbaud_id, payload_json, polled_at, ...)

-- Update queue
hubspot_update_queue (
  id, deal_id, payload_json, status, attempts, last_error,
  created_at, updated_at, next_retry_at
)

-- Audit & errors
sync_logs    (id, step, records_count, status, message, created_at)
error_logs   (id, source, error_message, context_json, created_at)
```

---

## Docker Services

| Service | Image/Base | Role |
|---------|------------|------|
| `postgres` | postgres:16-alpine | Database |
| `blackbaud-poller` | node:20-alpine | Poll Blackbaud checklist |
| `hubspot-poller` | node:20-alpine | Poll HubSpot deals |
| `processor` | node:20-alpine | Transform + match + enqueue |
| `hubspot-worker` | node:20-alpine | Consume queue, update HubSpot |
| `frontend` | node:20-alpine | Next.js dashboard |

**Scheduling**: Use `node-cron` inside each poller (e.g., every 5–15 min) or a shared `ofelia` container for cron jobs.

---

## Next.js Frontend – Pages & Features

| Page/Feature | Purpose |
|--------------|---------|
| **Dashboard** | Overview: last poll times, queue depth, error count, pipeline status |
| **Step 1: Blackbaud** | Table of latest checklist items, poll history, errors |
| **Step 2: HubSpot** | Table of latest deals, poll history |
| **Step 3–4: Processor** | Matched pairs, unmatched checklist items, transformer output |
| **Step 5: Queue** | Pending/success/failed items, retry triggers |
| **Step 6: HubSpot Updates** | Update history, errors, retry status |
| **Errors** | Central error log with filters, retry actions |

---

## Error Handling & Retry

- **Queue item states**: `pending` → `processing` → `success` | `failed`
- **Retry**: On HTTP 5xx or rate limit, set `next_retry_at` with exponential backoff (e.g. 1m, 5m, 15m)
- **Max attempts**: e.g. 5; after that mark `dead` and log for manual review
- **Idempotency**: Use `deal_id` + payload hash if needed to avoid duplicates

---

## Environment Variables

```env
# Blackbaud Sky API
BLACKBAUD_API_BASE_URL=
BLACKBAUD_CLIENT_ID=
BLACKBAUD_CLIENT_SECRET=
BLACKBAUD_REFRESH_TOKEN=
# or Sky API auth flow of your choice

# HubSpot
HUBSPOT_ACCESS_TOKEN=           # Private app or OAuth
HUBSPOT_DEAL_PROPERTY_BLACKBAUD_ID=blackbaud_id

# Database
DATABASE_URL=postgresql://...

# Optional: Redis (if using BullMQ)
REDIS_URL=redis://redis:6379
```

---

## Implementation Phases

### Phase 1: Foundation
- [ ] Docker Compose with PostgreSQL
- [ ] Shared package: types, `dealstage_transformer` stub
- [ ] Basic DB migrations (raw tables, queue, logs)

### Phase 2: Pollers
- [ ] Blackbaud poller (checklist items)
- [ ] HubSpot poller (deals with blackbaud_id)
- [ ] Store raw data in DB

### Phase 3: Processor & Queue
- [ ] Implement `dealstage_transformer` logic
- [ ] Processor: match by blackbaud_id, transform, enqueue
- [ ] HubSpot worker: consume queue, update deals

### Phase 4: Retry & Observability
- [ ] Retry with backoff
- [ ] Structured error logging
- [ ] Next.js frontend: dashboard + step views

### Phase 5: Polish
- [ ] Manual retry from UI
- [ ] Alerts (optional: email/Slack on repeated failures)
- [ ] Rate limiting awareness for both APIs

---

## Open Questions

1. **Blackbaud Sky API specifics**: Which exact endpoint for "checklist item"? (e.g. Constituent checklist, Event checklist, etc.)
2. **Dealstage logic**: Do you have a `dealstage_transformer` spec or pseudocode to implement?
3. **Poll frequency**: Desired interval for each poller?
4. **Queue choice**: PostgreSQL-only (simpler) vs Redis + BullMQ (more scalable)?

---

## Next Steps

1. Confirm Blackbaud checklist endpoint and auth method
2. Provide or draft `dealstage_transformer` rules
3. Choose monorepo vs single-service structure
4. Create `docker-compose.yml` and initial DB migrations
5. Implement pollers → processor → worker → frontend in phases
