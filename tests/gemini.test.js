require('./helpers'); // sets process.env before config-dependent modules load

const {
  generateQuizFromPrompt, generateWordDetails, MAX_CONCURRENT_CALLS, REQUEST_TIMEOUT_MS,
} = require('../src/services/gemini');

function fetchReturning(bodyText, status = 200) {
  return async () => ({ text: async () => bodyText, status });
}

function fetchWithCandidateText(text) {
  return fetchReturning(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
}

const okOpts = (fetchImpl) => ({ apiKey: 'test-key', model: 'gemini-test', fetchImpl });

describe('gemini: callGemini error branches (via generateQuizFromPrompt)', () => {
  test('missing API key -> GEMINI_NOT_CONFIGURED', async () => {
    await expect(generateQuizFromPrompt('prompt', { apiKey: '', fetchImpl: fetchReturning('{}') }))
      .rejects.toMatchObject({ status: 500, code: 'GEMINI_NOT_CONFIGURED' });
  });

  test('network failure -> GEMINI_REQUEST_FAILED', async () => {
    const fetchImpl = async () => { throw new Error('boom'); };
    await expect(generateQuizFromPrompt('prompt', okOpts(fetchImpl)))
      .rejects.toMatchObject({ status: 502, code: 'GEMINI_REQUEST_FAILED' });
  });

  test('non-JSON HTTP body -> GEMINI_BAD_RESPONSE', async () => {
    await expect(generateQuizFromPrompt('prompt', okOpts(fetchReturning('not json'))))
      .rejects.toMatchObject({ status: 502, code: 'GEMINI_BAD_RESPONSE' });
  });

  test('Gemini API error payload -> GEMINI_API_ERROR', async () => {
    const body = JSON.stringify({ error: { code: 400, message: 'bad request' } });
    await expect(generateQuizFromPrompt('prompt', okOpts(fetchReturning(body))))
      .rejects.toMatchObject({ status: 502, code: 'GEMINI_API_ERROR' });
  });

  test('blocked prompt -> CONTENT_BLOCKED', async () => {
    const body = JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } });
    await expect(generateQuizFromPrompt('prompt', okOpts(fetchReturning(body))))
      .rejects.toMatchObject({ status: 422, code: 'CONTENT_BLOCKED' });
  });

  test('empty candidate list -> GEMINI_EMPTY', async () => {
    const body = JSON.stringify({ candidates: [] });
    await expect(generateQuizFromPrompt('prompt', okOpts(fetchReturning(body))))
      .rejects.toMatchObject({ status: 502, code: 'GEMINI_EMPTY' });
  });
});

describe('gemini: generateQuizFromPrompt parsing', () => {
  test('non-JSON candidate text -> GEMINI_PARSE_FAILED', async () => {
    await expect(generateQuizFromPrompt('prompt', okOpts(fetchWithCandidateText('not an array'))))
      .rejects.toMatchObject({ status: 502, code: 'GEMINI_PARSE_FAILED' });
  });

  test('JSON that is not an array -> GEMINI_PARSE_FAILED', async () => {
    const fetchImpl = fetchWithCandidateText('{"not": "an array"}');
    await expect(generateQuizFromPrompt('prompt', okOpts(fetchImpl)))
      .rejects.toMatchObject({ status: 502, code: 'GEMINI_PARSE_FAILED' });
  });

  test('happy path slices and parses the JSON array', async () => {
    const fetchImpl = fetchWithCandidateText('Here you go: [{"q": 1}, {"q": 2}] thanks');
    const result = await generateQuizFromPrompt('prompt', okOpts(fetchImpl));
    expect(result).toEqual([{ q: 1 }, { q: 2 }]);
  });
});

describe('gemini: request hardening (2.4)', () => {
  const okBody = JSON.stringify({ candidates: [{ content: { parts: [{ text: '[1,2]' }] } }] });
  const noSleep = async () => {};

  test('every request carries an AbortSignal, so a hung upstream cannot pin the handler forever', async () => {
    let receivedSignal;
    const fetchImpl = async (_url, opts) => {
      receivedSignal = opts.signal;
      return { text: async () => okBody, status: 200 };
    };
    await generateQuizFromPrompt('prompt', okOpts(fetchImpl));
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(REQUEST_TIMEOUT_MS).toBe(60_000);
  });

  test('retries once with jitter on a 429, then succeeds', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return { text: async () => '{}', status: 429 };
      return { text: async () => okBody, status: 200 };
    };
    const result = await generateQuizFromPrompt('prompt', { ...okOpts(fetchImpl), sleepImpl: noSleep });
    expect(calls).toBe(2);
    expect(result).toEqual([1, 2]);
  });

  test('retries once on a 503 too', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return { text: async () => '{}', status: 503 };
      return { text: async () => okBody, status: 200 };
    };
    const result = await generateQuizFromPrompt('prompt', { ...okOpts(fetchImpl), sleepImpl: noSleep });
    expect(calls).toBe(2);
    expect(result).toEqual([1, 2]);
  });

  test('gives up after a single retry -- a persistent 429 still fails', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { text: async () => '{}', status: 429 }; };
    await expect(generateQuizFromPrompt('prompt', { ...okOpts(fetchImpl), sleepImpl: noSleep }))
      .rejects.toMatchObject({ status: 502, code: 'GEMINI_EMPTY' });
    expect(calls).toBe(2); // initial attempt + exactly one retry
  });

  test('a non-retryable status (e.g. 400) is not retried', async () => {
    let calls = 0;
    const body = JSON.stringify({ error: { code: 400, message: 'bad request' } });
    const fetchImpl = async () => { calls += 1; return { text: async () => body, status: 400 }; };
    await expect(generateQuizFromPrompt('prompt', { ...okOpts(fetchImpl), sleepImpl: noSleep }))
      .rejects.toMatchObject({ status: 502, code: 'GEMINI_API_ERROR' });
    expect(calls).toBe(1);
  });

  test('caps concurrent calls, queuing a burst beyond the limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const fetchImpl = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => { setTimeout(resolve, 15); });
      concurrent -= 1;
      return { text: async () => okBody, status: 200 };
    };
    await Promise.all(
      Array.from({ length: MAX_CONCURRENT_CALLS * 3 }, () => generateQuizFromPrompt('prompt', okOpts(fetchImpl)))
    );
    expect(maxConcurrent).toBeLessThanOrEqual(MAX_CONCURRENT_CALLS);
  });
});

describe('gemini: generateWordDetails parsing', () => {
  test('non-JSON candidate text -> GEMINI_PARSE_FAILED', async () => {
    await expect(generateWordDetails('prompt', okOpts(fetchWithCandidateText('not an object'))))
      .rejects.toMatchObject({ status: 502, code: 'GEMINI_PARSE_FAILED' });
  });

  test('JSON array instead of an object -> GEMINI_PARSE_FAILED', async () => {
    const fetchImpl = fetchWithCandidateText('[1, 2, 3]');
    await expect(generateWordDetails('prompt', okOpts(fetchImpl)))
      .rejects.toMatchObject({ status: 502, code: 'GEMINI_PARSE_FAILED' });
  });

  test('JSON null instead of an object -> GEMINI_PARSE_FAILED', async () => {
    const fetchImpl = fetchWithCandidateText('null');
    await expect(generateWordDetails('prompt', okOpts(fetchImpl)))
      .rejects.toMatchObject({ status: 502, code: 'GEMINI_PARSE_FAILED' });
  });

  test('happy path slices and parses the JSON object', async () => {
    const fetchImpl = fetchWithCandidateText('Sure: {"wordTranslated": "hond"} enjoy');
    const result = await generateWordDetails('prompt', okOpts(fetchImpl));
    expect(result).toEqual({ wordTranslated: 'hond' });
  });
});
