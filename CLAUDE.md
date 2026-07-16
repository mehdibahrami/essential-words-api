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

## Grammar (Dutch verb conjugation + noun plurals)
- Every word DTO carries a `grammar` object (or null), assembled in `words.serializeWord`. Shape is a discriminated union: `{kind:'verb', present:{ik,jij,hij,wij}, irregular}` or `{kind:'noun', article, plural, irregularPlural}`.
- **Verbs are computed live** (`src/services/dutchGrammar.js`) from the infinitive — present tense is rule-derivable; only `zijn`/`hebben`/modals and a few schwa verbs (`luisteren`→`luister`) are pinned in `IRREGULAR_PRESENT`/`STEM_OVERRIDES`. Gated to `nl-NL` via a per-db language-code cache in `words.js`. New Dutch verbs conjugate automatically — no data entry.
- **Separable verbs** (`meenemen` → "ik neem mee") carry `separable:true`. Separability is lexical, so it's gated on the explicit `SEPARABLE_VERBS` set; when a verb is in it, the longest matching `SEPARABLE_PREFIXES` is split off and the root is conjugated normally. Add new separable verbs to that set.
- **Nouns are stored** in the nullable `words.grammar` TEXT column (gender/plural are lexical). Populated by `scripts/populate-dutch-nouns-db.js` from `scripts/data/dutch-nouns.json` (244 nouns, each plural verified against en.wiktionary; run direct-to-SQLite on the Pi — the HTTP path hits the rate limiter). `irregularPlural` is computed (not stored).
- Column added by an idempotent migration in `src/db/index.js` (`ALTER TABLE words ADD COLUMN grammar`).

## Gotchas
- **Leitner logic is ported verbatim from the app's `DatabaseManager.swift`** (`src/utils/leitner.js`, `time.js`). If the app's boxes/intervals change, update both.
- Dates are **ISO-8601 UTC strings**; "start of day" for scheduling uses `APP_TIMEZONE` (default `Europe/Amsterdam`), not UTC.
- `POST /sync/import` preserves incoming IDs (one-time migration from the app DB); other creates use server-assigned autoincrement IDs.
- **`serializeWord(row, db)` must never be passed bare to `.map(serializeWord)`** — the array index arrives as `db` and (previously) 500'd the review/practice queues. Always `.map((r) => serializeWord(r, db))`. `languageCode` is hardened to ignore a non-db arg; regression test: "review queue serialization".

## Deploy (Raspberry Pi)
- Host: `medhibahrami@192.168.2.10`, at `~/essential-words-api`, port **3100** (3000 = ev-route-planner). Node 18 on the Pi.
- Runs as **systemd** unit `essential-words-api` (`deploy/*.service`, `EnvironmentFile=.env`). Public via a **token-managed Cloudflare tunnel** at `https://words.jurchi.ir` (public-hostname route added in the dashboard — not scriptable).
- Redeploy: `rsync -az --delete --exclude node_modules --exclude .env --exclude data ./ medhibahrami@192.168.2.10:~/essential-words-api/` then `ssh … 'sudo systemctl restart essential-words-api'`. Note: `--exclude data` also skips `scripts/data/`, so sync that dir explicitly when needed.
- **Outside the LAN:** the Pi is reachable over **Tailscale** at `100.107.130.120:3100`, and `ssh medhibahrami@100.107.130.120` works via Tailscale SSH. `https://words.jurchi.ir` works from anywhere.
