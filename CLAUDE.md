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
- Every word DTO carries a `grammar` object (or null), assembled in `words.serializeWord`. Shape is a discriminated union: `{kind:'verb', present:{ik,jij,hij,wij}, irregular, past:{singular,plural}?, pastParticiple?}` or `{kind:'noun', article, plural, irregularPlural}`.
- **Verbs are computed live** (`src/services/dutchGrammar.js`) from the infinitive — present tense is rule-derivable; only `zijn`/`hebben`/modals and a few schwa verbs (`luisteren`→`luister`) are pinned in `IRREGULAR_PRESENT`/`STEM_OVERRIDES`. Gated to `nl-NL` via a per-db language-code cache in `words.js`. New Dutch verbs conjugate automatically — no data entry.
- **Past tense (OVT) + participle**: the Dutch past is NOT reliably rule-derivable (strong-verb stem changes, irregular participles), so every verb currently in the DB is pinned in `IRREGULAR_PAST` (`{singular, plural, participle}`, keyed by infinitive; separables keep the prefix at the end of the OVT and re-insert `ge-` in the participle). `computeWeakPast()` is a best-effort 't-kofschip fallback for *future* verbs not in the table. Verified by `tests/dutchGrammar.past.test.js`. A verb + fixed preposition (`houden van`) conjugates the head and carries the preposition.
- **Separable verbs** (`meenemen` → "ik neem mee") carry `separable:true`. Separability is lexical, so it's gated on the explicit `SEPARABLE_VERBS` set; when a verb is in it, the longest matching `SEPARABLE_PREFIXES` is split off and the root is conjugated normally. Add new separable verbs to that set.
- **Nouns are stored** in the nullable `words.grammar` TEXT column (gender/plural are lexical). Populated by `scripts/populate-dutch-nouns-db.js` from `scripts/data/dutch-nouns.json` (244 nouns, each plural verified against en.wiktionary; run direct-to-SQLite on the Pi — the HTTP path hits the rate limiter). `irregularPlural` is computed (not stored).
- Column added by an idempotent migration in `src/db/index.js` (`ALTER TABLE words ADD COLUMN grammar`).

## AI sentence material (`word_material`)
- **Generated material is cached, keyed `(wordId, level)`** (`word_material`, `src/db/index.js`). `generateDrills` (`src/services/troubleDrills.js`) reads the cache, calls Gemini **only for the misses**, and writes results back inside one `db.transaction`. This is the fix for a measured **34.4 s** cold call for 20 words, which blew the client's then-hard 30 s timeout and silently deleted Fill-the-gap, Build-it and typed gaps from every session with no error shown. Measured after deploy: cold **33.8 s**, warm **0.13 s**, byte-identical payloads.
- **A null result is cached too.** A word that resolves to no usable cloze is written as a row anyway — re-asking Gemini for it on every session is exactly the latency the cache exists to remove. Don't "optimise" that away by skipping empty writes.
- **`drillPrompt` takes `knownWords(db, languageId)`** so generated sentences reuse vocabulary the learner has actually learned (`leitnerBox >= 1`), bounded by `MIN_KNOWN_WORDS`/`MAX_KNOWN_WORDS`. Note the consequence: because rows are keyed only `(wordId, level)`, a word generated during a language's *first* session keeps that sentence forever, even as the learner's vocabulary grows. Benign in direction (early sentences are simpler), but the constraint effectively applies once per word.
- **Cache invalidation is an allow-list, not a blanket drop.** `MATERIAL_FIELDS` in `src/services/words.js` drops cached rows only when a field the prompt actually consumes changes. A Leitner/review update must **never** discard expensive AI material — that was the whole point of the allow-list.
- Tests: `tests/material.test.js`. Gemini is always injected as `deps.generate`; **never** let a test call the real API.

## Gotchas
- **Leitner logic is ported verbatim from the app's `DatabaseManager.swift`** (`src/utils/leitner.js`, `time.js`). If the app's boxes/intervals change, update both.
- Dates are **ISO-8601 UTC strings**; "start of day" for scheduling uses `APP_TIMEZONE` (default `Europe/Amsterdam`), not UTC.
- `POST /sync/import` preserves incoming IDs (one-time migration from the app DB); other creates use server-assigned autoincrement IDs.
- **`serializeWord(row, db)` must never be passed bare to `.map(serializeWord)`** — the array index arrives as `db` and (previously) 500'd the review/practice queues. Always `.map((r) => serializeWord(r, db))`. `languageCode` is hardened to ignore a non-db arg; regression test: "review queue serialization".

## Deploy (Raspberry Pi)
- Host: `medhibahrami@192.168.2.10`, at `~/essential-words-api`, port **3100** (3000 = ev-route-planner). Node 18 on the Pi.
- Runs as **systemd** unit `essential-words-api` (`deploy/*.service`, `EnvironmentFile=.env`). Public via a **token-managed Cloudflare tunnel** at `https://words.jurchi.ir` (public-hostname route added in the dashboard — not scriptable).
- Redeploy: `rsync -az --delete --exclude node_modules --exclude .env --exclude data ./ medhibahrami@<host>:~/essential-words-api/` then `ssh … 'cd ~/essential-words-api && npm install --omit=dev && sudo systemctl restart essential-words-api'`. Note: `--exclude data` also skips `scripts/data/`, so sync that dir explicitly when needed.
- **Prefer the Tailscale host `100.107.130.120` for deploys, not the LAN IP.** The LAN address `192.168.2.10` frequently times out on port 22 even from the same network; Tailscale SSH has been reliable. (First Tailscale SSH of a session may print an auth-check URL and then proceed on its own — that is normal, not a failure.) `https://words.jurchi.ir` works from anywhere.
- **Verify a deploy, don't assume it:** `curl -s https://words.jurchi.ir/health` plus an authed probe of a route you touched — a `400` for a missing required param proves the route is live and validating, which a `404` would not. The API key must match `APIConfig.swift` in the app repo, **not** necessarily the local `.env` (they have drifted).
- The `.env` is excluded from rsync, so the Pi keeps its own. A `401` after deploying almost always means you tested with the local `.env` key rather than the Pi's.
