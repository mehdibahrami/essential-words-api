const config = require('../config');
const { HttpError } = require('../middleware/errorHandler');

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// A hung upstream must not pin an Express handler on the Pi forever: every request
// carries its own abort timeout, independent of the client's 90s generationTimeout
// (that one releases the *client*, not the server).
const REQUEST_TIMEOUT_MS = 60_000;
// Gemini's own transient-overload statuses. Retried once with jitter rather than
// failing the request outright.
const RETRYABLE_STATUSES = new Set([429, 503]);
const MAX_RETRIES = 1;
const jitterDelayMs = () => 250 + Math.random() * 500;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Process-wide in-flight cap so a burst of AI word-adds queues instead of firing an
// unbounded number of concurrent outbound requests from a single Pi process.
const MAX_CONCURRENT_CALLS = 3;
let activeCalls = 0;
const waiters = [];

function acquireSlot() {
  if (activeCalls < MAX_CONCURRENT_CALLS) {
    activeCalls += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseSlot() {
  activeCalls -= 1;
  const next = waiters.shift();
  if (next) {
    activeCalls += 1;
    next();
  }
}

/** POST the request, retrying once with jitter on a 429/503 response. */
async function fetchWithRetry(fetchImpl, url, options, sleepImpl) {
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      throw new HttpError(502, 'GEMINI_REQUEST_FAILED', `Gemini request failed: ${err.message}`);
    }
    if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
      attempt += 1;
      await sleepImpl(jitterDelayMs());
      continue;
    }
    return res;
  }
}

/**
 * Call Gemini with `prompt` and return the raw text of the first candidate.
 * Shared by every JSON-shaped caller below; each decides how to slice/parse it.
 */
async function callGemini(prompt, {
  apiKey = config.geminiApiKey, model = config.geminiModel, fetchImpl = fetch, sleepImpl = sleep,
} = {}) {
  if (!apiKey) throw new HttpError(500, 'GEMINI_NOT_CONFIGURED', 'GEMINI_API_KEY is not set');

  const url = `${BASE}/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json' },
  };

  await acquireSlot();
  try {
    const res = await fetchWithRetry(fetchImpl, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, sleepImpl);

    const raw = await res.text();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new HttpError(502, 'GEMINI_BAD_RESPONSE', 'Gemini returned non-JSON response');
    }

    if (payload.error) {
      throw new HttpError(502, 'GEMINI_API_ERROR', `Code ${payload.error.code}: ${payload.error.message}`);
    }
    const blockReason = payload.promptFeedback && payload.promptFeedback.blockReason;
    if (blockReason) {
      throw new HttpError(422, 'CONTENT_BLOCKED', `Prompt blocked: ${blockReason}`);
    }

    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new HttpError(502, 'GEMINI_EMPTY', 'Gemini response had no content');
    }
    return text;
  } finally {
    releaseSlot();
  }
}

/**
 * Call Gemini with `prompt` and decode the returned JSON array of quiz questions.
 * Replicates GeminiAPIService.generateQuiz: responseMimeType=application/json,
 * then slice the text from the first '[' to the last ']' before parsing.
 */
async function generateQuizFromPrompt(prompt, opts = {}) {
  const text = await callGemini(prompt, opts);
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  const jsonSlice = start !== -1 && end !== -1 ? text.slice(start, end + 1) : text;
  let questions;
  try {
    questions = JSON.parse(jsonSlice);
  } catch {
    throw new HttpError(502, 'GEMINI_PARSE_FAILED', 'Could not parse quiz JSON from Gemini');
  }
  if (!Array.isArray(questions)) {
    throw new HttpError(502, 'GEMINI_PARSE_FAILED', 'Gemini did not return a JSON array');
  }
  return questions;
}

/**
 * Call Gemini with `prompt` and decode the returned JSON object — used for single-item
 * generation (e.g. AI word lookup) rather than the array shape `generateQuizFromPrompt`
 * expects. Slices the text from the first '{' to the last '}' before parsing.
 */
async function generateWordDetails(prompt, opts = {}) {
  const text = await callGemini(prompt, opts);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const jsonSlice = start !== -1 && end !== -1 ? text.slice(start, end + 1) : text;
  let details;
  try {
    details = JSON.parse(jsonSlice);
  } catch {
    throw new HttpError(502, 'GEMINI_PARSE_FAILED', 'Could not parse word JSON from Gemini');
  }
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw new HttpError(502, 'GEMINI_PARSE_FAILED', 'Gemini did not return a JSON object');
  }
  return details;
}

module.exports = {
  generateQuizFromPrompt, generateWordDetails, MAX_CONCURRENT_CALLS, REQUEST_TIMEOUT_MS,
};
