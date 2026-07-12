# Essential Words — API Server

Node/Express + SQLite backend for the **Essential Words** iOS/Catalyst app. The app is a thin client;
this server owns the data **and** the logic (Leitner spaced-repetition scheduling, quiz generation).
Full design in [`docs/DESIGN.md`](docs/DESIGN.md).

## Build & verify
- `npm test` — Jest + supertest, runs against **in-memory SQLite** (`openDatabase(':memory:')`). Always run after changes.
- `npm start` (needs `.env` with `API_KEY`) / `npm run dev` (watch).
- Smoke test: `curl -s localhost:3100/health`; authed calls need `-H "x-api-key: $API_KEY"`.

## Architecture
- `server.js` → `src/app.js` `createApp(db)` (db is **injected** for testability) → `src/routes/api.js`.
- Services (`src/services/*.js`) are plain functions taking `db` as the first arg — no hidden singletons. Routes read the handle via `req.app.locals.db`.
- SQLite via `better-sqlite3` (synchronous). Schema in `src/db/index.js`; every row has `updatedAt`/`deletedAt` (soft delete) for delta sync.
- Auth: single shared `x-api-key` (single-user app), HMAC timing-safe compare (`src/middleware/auth.js`).
- Errors: throw `HttpError`/`badRequest`/`notFound` from services; `errorHandler` renders `{error, message}` + maps `SQLITE_CONSTRAINT*` → 409.

## Gotchas
- **Leitner logic is ported verbatim from the app's `DatabaseManager.swift`** (`src/utils/leitner.js`, `time.js`). If the app's boxes/intervals change, update both.
- Dates are **ISO-8601 UTC strings**; "start of day" for scheduling uses `APP_TIMEZONE` (default `Europe/Amsterdam`), not UTC.
- `POST /sync/import` preserves incoming IDs (one-time migration from the app DB); other creates use server-assigned autoincrement IDs.

## Deploy (Raspberry Pi)
- Host: `medhibahrami@192.168.2.10`, at `~/essential-words-api`, port **3100** (3000 = ev-route-planner). Node 18 on the Pi.
- Runs as **systemd** unit `essential-words-api` (`deploy/*.service`, `EnvironmentFile=.env`). Public via a **token-managed Cloudflare tunnel** at `https://words.jurchi.ir` (public-hostname route added in the dashboard — not scriptable).
- Redeploy: `rsync -az --delete --exclude node_modules --exclude .env --exclude data ./ medhibahrami@192.168.2.10:~/essential-words-api/` then `ssh … 'sudo systemctl restart essential-words-api'`.
