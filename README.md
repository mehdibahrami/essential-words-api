# Essential Words — API Server

Node.js/Express backend for the **Essential Words** vocabulary app. The app is a
thin client: every action (load vocab, swipe left/right in practice, add a
set/language, generate a quiz, view stats) is a REST call, and this server owns
both the data (SQLite) and the logic (Leitner spaced-repetition scheduling and
quiz generation).

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full design.

## Quick start

```bash
npm install
cp .env.example .env    # set API_KEY (and GEMINI_API_KEY for quizzes)
npm start               # listens on PORT (default 3100)
npm test                # Jest + supertest
```

Generate an API key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Auth

Every `/api/*` request needs the `x-api-key` header. `/health` is open.

```bash
curl -s localhost:3100/health
curl -s localhost:3100/api/languages -H "x-api-key: $API_KEY"
```

## Configuration (`.env`)

| Variable | Description |
|----------|-------------|
| `API_KEY` | Required. 64-char hex shared secret. |
| `PORT` | Default `3100`. |
| `RATE_LIMIT_RPM` | Requests/minute/IP. Default `120`. |
| `APP_TIMEZONE` | IANA tz for Leitner "start of day". Default `Europe/Amsterdam`. |
| `GEMINI_API_KEY` | Google Gemini key for `POST /api/quiz/generate`. |
| `DB_PATH` | Optional SQLite path override. |

## Endpoints

All under `/api`, all require `x-api-key`.

**Data** — `GET/POST /languages`, `PUT/DELETE /languages/:id`;
`GET /sets?languageId=`, `POST /sets`, `PUT/DELETE /sets/:id`;
`GET /words?setId=&languageId=`, `GET /words/:id`, `POST /words`, `PUT/DELETE /words/:id`.

**Learning** — `GET /review/next?languageId=&setId=&limit=`, `POST /review/:wordId/learned`;
`GET /practice/next?languageId=&setId=`, `POST /practice/:wordId/correct`,
`POST /practice/:wordId/incorrect`; `GET /stats?languageId=&setId=`;
`POST /sets/:id/reset`, `POST /languages/:id/reset`.

**Quiz** — `POST /quiz/generate` `{languageId, setId?, level, numQuestions,
contentSource: "leitnerBoxes"|"customTopic"|"verbConjugation"|"articles",
leitnerBoxes?, tenses?, customText?, questionsInEnglish}`.

**Sync** — `GET /sync?since=<iso>` (delta + tombstones; full snapshot when
`since` omitted), `POST /sync/import` (bulk seed preserving IDs).

## Deploy to the Raspberry Pi

Runs as a systemd service behind the existing Cloudflare tunnel, published at
`https://words.jurchi.ir`.

```bash
# from this machine
rsync -av --exclude node_modules --exclude data --exclude .env \
  ./ medhibahrami@192.168.2.10:~/essential-words-api/

# on the Pi
cd ~/essential-words-api
npm ci --omit=dev
cp .env.example .env && nano .env         # set API_KEY, GEMINI_API_KEY
sudo cp deploy/essential-words-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now essential-words-api
systemctl status essential-words-api
curl -s localhost:3100/health
```

**Manual step (Cloudflare dashboard, one time):** in Zero Trust → Networks →
Tunnels → your tunnel → *Public Hostname*, add
`words.jurchi.ir` → `http://localhost:3100`. The tunnel is token-managed, so this
route can't be scripted from the Pi.

## One-time data migration

Export the app's current SQLite data and `POST` it to `/api/sync/import`
(preserves IDs) so your existing words/sets/languages move up to the server.
