# Practice Pulse API

Practice Pulse is a full-stack tool that helps behavioral health practices keep a handle on therapists, sessions, programs, and finances. This repository contains the Express-based backend that powers the application. It exposes REST endpoints for the web front-end, orchestrates authentication/authorization, and persists data to PostgreSQL.

This document is intentionally thorough so another engineer can step in quickly if the primary maintainer is unavailable.

## Tech stack at a glance

- **Runtime:** Node.js + Express (ES modules)
- **Database:** PostgreSQL (`in_kind_tracker` schema; see the [`in-kind-tracker-db`](../in-kind-tracker-db) repo)
- **Auth:** Session cookies backed by `in_kind_tracker.user_session`
- **Tests:** Jest with lightweight mocks around the `pg` client
- **Deploy:** Custom script (`deploy-prod-api.sh`) that copies files to a staging directory on the server

`src/server.js` is the main entry point. Every resource (therapists, programs, expenses, etc.) lives in `src/routes/` and is protected by the permission middleware in `src/middleware/authorization.js`.

## Getting started

### 1. Prerequisites

- Node.js **20.x** (or newer) and npm 10+
- A PostgreSQL instance seeded with the Practice Pulse schema/data

### 2. Clone & install

```bash
git clone git@github.com:bpottle-ccdenver/in-kind-tracker-api.git
cd in-kind-tracker-api
npm install
```

### 3. Configure environment

The app reads configuration via `dotenv`. Create a `.env` file in the project root. Minimum settings:

```env
DATABASE_URL=postgres://user:password@localhost:5432/in_kind_tracker
PORT=3001                      # optional (defaults to 3001)
SESSION_COOKIE_NAME=pp_session  # optional; defaults the same
SESSION_MAX_AGE_DAYS=7          # optional
NODE_ENV=development            # optional
```

In production these values live in Azure Secret Valut secrets (see `deploy-prod-api.sh` for the commands we use).

### 4. Run the API locally

```bash
# auto-reloads on change
npm run dev

# single run (production style)
npm start
```

On startup the server verifies the database connection (`SELECT 1`). If `DATABASE_URL` is missing or invalid it will log an error and exit. Once it binds, hit `http://localhost:3001/health` for a quick “ok”.

### 5. Run tests

```bash
npm test
```

The Jest suite stubs the pg pool, so a live database is not required. If you add a new query be sure to extend the mocks in the relevant test file.

## Repository layout

```
src/
  server.js                 # Express bootstrap & route registration
  db.js                     # pg Pool setup + connection helpers
  middleware/               # auth/permission middleware
  routes/                   # One file per REST resource
  __tests__/                # Jest specs (mirror the routes/middleware)
deploy-prod-api.sh          # Helper script for production deploys
```

## Database expectations

- All tables live in the `in_kind_tracker` schema (maintained in the `in-kind-tracker-db` repo).
- Local development: run the SQL in `in-kind-tracker-db/full` to seed a working database quickly.
- The API assumes certain seed data exists (roles, permissions, demo users); keep DB migrations in sync when adding new features.

## Authentication & permissions

- Sessions are cookie based. The cookie name and max age are controlled via `SESSION_COOKIE_*` environment variables.
- `src/routes/auth.js` handles login/logout and user enumeration for the front-end.
- `requirePermissions` in `src/middleware/authorization.js` checks the caller’s permissions (fetched from the DB) before allowing access to most routes. When adding a new route, update the permission map in `src/server.js` accordingly.

## Deployment notes

- `deploy-prod-api.sh` is the hand-rolled helper we currently use. It assumes you have access to Azure and have the appropriate secrets configured (`DATABASE_URL`, cookie settings, etc.).

## Common tasks

- **Add a new resource:** create `src/routes/<resource>.js`, write tests in `src/__tests__/`, register the router inside `src/server.js`, and update the permission map.
- **Adjust permissions:** change `src/middleware/authorization.js` and update the SQL seed data in the DB repo so future environments stay in sync.
- **Modify session behaviour:** update `src/routes/auth.js` and reflect any new environment variables in this README.

## Related repositories

- [`in-kind-tracker-web`](../in-kind-tracker-web) – React/Vite UI that consumes this API.
- [`in-kind-tracker-db`](../in-kind-tracker-db) – PostgreSQL schema, migrations, and seed data.

If you notice anything missing or inaccurate, please update this README as part of your change. That keeps the bus factor healthy for the whole team.
