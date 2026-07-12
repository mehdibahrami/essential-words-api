# Essential Words API — Design

Backend for the Essential Words vocabulary app. The app becomes a thin client:
every action (load vocab, swipe left/right in practice, add a set/language,
generate a quiz, view stats) is a REST call; the server owns the data **and** the
business logic (Leitner spaced-repetition scheduling, quiz generation).

## Goals

- Single source of truth on the server (SQLite), reachable from iPhone + Mac.
- Server owns spaced-repetition scheduling so "swipe right/left" is a single call.
- Server owns quiz generation (moves the Gemini API key off the device — it is
  currently hard-coded in `GeminiAPIService.swift`).
- Delta sync so the client can refresh cheaply.
- Deploy on the Raspberry Pi (`192.168.2.10`) via systemd + the existing
  Cloudflare tunnel, published at `https://words.jurchi.ir`.

## Non-goals (this phase)

- The Swift client rewrite (separate effort — the app must be repointed from local
  GRDB to these endpoints).
- Multi-user auth / accounts. Single user, one shared API key.
- On-device speech (TTS) — stays on the device.

## Stack

Mirrors `ev-route-planner`: Node + Express, `better-sqlite3`, `x-api-key` HMAC
auth, `express-rate-limit`, `/health`, `src/{config,middleware,services,routes,db,utils}`,
Jest + supertest. Runs on `PORT=3100` (3000 is taken by ev-route-planner).

## Data model (SQLite)

Mirrors the app schema; every row also carries `updatedAt` (ISO-8601 UTC) and
`deletedAt` (soft delete) so `/sync?since=` can return changes and tombstones.

- **languages**: id, name, code (unique), sourceFileName, createdAt, updatedAt, deletedAt
- **word_sets**: id, name, languageId → languages, createdAt, updatedAt, deletedAt
- **words**: id, languageId, wordSetId, word, wordTranslated, partOfSpeech,
  definition, definitionTranslated, example1-3 (+Translated),
  leitnerBox, nextPracticeDate, isLearned, lastReviewedDate,
  createdAt, updatedAt, deletedAt

IDs are server-assigned autoincrement integers (matches the app's `Int64` PKs).
`POST /sync/import` preserves incoming IDs for the one-time migration of the
user's current data.

## Leitner scheduling (ported verbatim from `DatabaseManager.swift`)

State:
- **New**: `isLearned=false`, `leitnerBox=0`. Due when `nextPracticeDate <= now`.
- **Learning/mastered**: `isLearned=true`, `leitnerBox>=1`.

Box → interval (days): `1:0, 2:2, 3:4, 4:8, 5:16, 6:32`. Beyond box 6 ("mastered"):
`60 days × 1.5^(stage-1)` where `stage = box - 6`.

Transitions:
- **markLearned** (finish initial review): isLearned=true, box=1,
  lastReviewedDate=now, nextPracticeDate=startOfDay(now).
- **practicedCorrectly** (swipe right): box+=1; nextPracticeDate =
  startOfDay(now + interval(box)); lastReviewedDate=now.
- **practicedIncorrectly** (swipe left): box=1; nextPracticeDate =
  startOfNextDay(now); lastReviewedDate=now.

Day boundaries are computed in a configurable IANA timezone (`APP_TIMEZONE`,
default `Europe/Amsterdam`) so "due today" matches the user's local day, not UTC.

## Endpoints (all under `/api`, require `x-api-key`)

Data CRUD:
- `GET/POST /languages`, `PUT/DELETE /languages/:id`
- `GET /sets?languageId=`, `POST /sets`, `PUT/DELETE /sets/:id`
- `GET /words?setId=&languageId=`, `GET /words/:id`, `POST /words`, `PUT/DELETE /words/:id`
- `POST /sets/:id/words/bulk` — bulk-insert words (CSV import / language seeding)
- `DELETE /sets/:id/words`, `DELETE /languages/:id/words` — bulk-delete words

Learning actions:
- `GET /review/next?languageId=&setId=&limit=` — new-word queue (box 0, due)
- `POST /review/:wordId/learned` — finish initial review
- `GET /practice/next?languageId=&setId=` — next due learned word
- `POST /practice/:wordId/correct` — swipe right
- `POST /practice/:wordId/incorrect` — swipe left
- `GET /stats?languageId=&setId=` — {newWords, dueForPractice, learned, total}
- `POST /sets/:id/reset`, `POST /languages/:id/reset` — reset progress

Quiz:
- `POST /quiz/generate` — body: {languageId, setId?, level, numQuestions,
  contentSource, leitnerBoxes?, tenses?, customText?, questionsInEnglish}.
  `articles` (Dutch de/het) is generated locally from the word list; `leitnerBoxes`,
  `customTopic`, `verbConjugation` build a prompt and call Gemini. Returns
  `[{questionDescription, questionItself, options, correctAnswer}]`.

Sync & ops:
- `GET /sync?since=<iso>` — {languages, sets, words, serverTime}; omitting `since`
  returns the full snapshot; deleted rows appear with `deletedAt` set (tombstones).
- `POST /sync/import` — bulk seed {languages, sets, words} preserving IDs.
- `GET /health` — unauthenticated liveness.

## Errors

JSON `{ error: CODE, message }`. 400 validation, 401 auth, 404 not found,
429 rate limit, 500 server. Codes mirror `ev-route-planner`.

## Deployment

- App at `/home/medhibahrami/essential-words-api`, DB at `data/essential-words.sqlite`.
- systemd unit `essential-words-api.service` (see `deploy/`), `EnvironmentFile=.env`.
- `.env`: `API_KEY`, `PORT=3100`, `RATE_LIMIT_RPM`, `APP_TIMEZONE`, `GEMINI_API_KEY`.
- **Manual step (Cloudflare dashboard):** add public hostname
  `words.jurchi.ir → http://localhost:3100` to the existing token-managed tunnel.
