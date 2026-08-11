require('./helpers'); // sets process.env before config-dependent modules load

const { generateQuizFromPrompt, generateWordDetails } = require('../src/services/gemini');

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
