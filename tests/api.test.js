const { makeApp, client, request, API_KEY } = require('./helpers');

describe('auth & health', () => {
  const { app } = makeApp();

  test('health needs no key', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('api rejects missing key', async () => {
    const res = await request(app).get('/api/languages');
    expect(res.status).toBe(401);
  });

  test('api accepts valid key', async () => {
    const res = await request(app).get('/api/languages').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('CRUD: languages, sets, words', () => {
  const { app } = makeApp();
  const api = client(app);
  let langId;
  let setId;

  test('create language', async () => {
    const res = await api.post('/api/languages').send({ name: 'Dutch', code: 'nl-NL' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    langId = res.body.id;
  });

  test('duplicate code -> 409', async () => {
    const res = await api.post('/api/languages').send({ name: 'Dutch2', code: 'nl-NL' });
    expect(res.status).toBe(409);
  });

  test('create set requires valid language', async () => {
    const bad = await api.post('/api/sets').send({ name: 'X', languageId: 9999 });
    expect(bad.status).toBe(400);
    const res = await api.post('/api/sets').send({ name: 'Basics', languageId: langId });
    expect(res.status).toBe(201);
    setId = res.body.id;
  });

  test('create and list words', async () => {
    const res = await api.post('/api/words').send({
      word: 'de hond', wordTranslated: 'the dog', languageId: langId, wordSetId: setId,
    });
    expect(res.status).toBe(201);
    expect(res.body.isLearned).toBe(false);
    expect(res.body.leitnerBox).toBe(0);

    const list = await api.get(`/api/words?setId=${setId}`);
    expect(list.body).toHaveLength(1);
  });

  test('soft-delete language cascades tombstones and hides from lists', async () => {
    const del = await api.del(`/api/languages/${langId}`);
    expect(del.status).toBe(204);
    expect((await api.get('/api/languages')).body).toHaveLength(0);
    expect((await api.get(`/api/words?setId=${setId}`)).body).toHaveLength(0);
  });
});

describe('learning flow (review -> practice)', () => {
  const { app } = makeApp();
  const api = client(app);
  let langId;
  let setId;
  let wordId;

  beforeAll(async () => {
    langId = (await api.post('/api/languages').send({ name: 'English', code: 'en-US' })).body.id;
    setId = (await api.post('/api/sets').send({ name: 'Set', languageId: langId })).body.id;
    wordId = (await api.post('/api/words').send({ word: 'abandon', wordTranslated: 'verlaten', languageId: langId, wordSetId: setId })).body.id;
  });

  test('new word appears in review queue', async () => {
    const res = await api.get(`/api/review/next?setId=${setId}`);
    expect(res.body.map((w) => w.id)).toContain(wordId);
  });

  test('stats reflect a new, unlearned word', async () => {
    const res = await api.get(`/api/stats?setId=${setId}`);
    expect(res.body).toMatchObject({ total: 1, learned: 0, newWords: 1 });
  });

  test('mark learned moves it to practice', async () => {
    const learned = await api.post(`/api/review/${wordId}/learned`);
    expect(learned.body.isLearned).toBe(true);
    expect(learned.body.leitnerBox).toBe(1);

    const next = await api.get(`/api/practice/next?setId=${setId}`);
    expect(next.body.id).toBe(wordId);
  });

  test('correct answer advances box and removes from due queue', async () => {
    const res = await api.post(`/api/practice/${wordId}/correct`);
    expect(res.body.leitnerBox).toBe(2);
    const next = await api.get(`/api/practice/next?setId=${setId}`);
    expect(next.body).toBeNull(); // scheduled 2 days out
  });

  test('reset progress returns the word to box 0', async () => {
    await api.post(`/api/sets/${setId}/reset`);
    const w = await api.get(`/api/words/${wordId}`);
    expect(w.body.leitnerBox).toBe(0);
    expect(w.body.isLearned).toBe(false);
  });
});

describe('sync', () => {
  const { app } = makeApp();
  const api = client(app);

  test('import preserves ids and snapshot returns them', async () => {
    const imp = await api.post('/api/sync/import').send({
      languages: [{ id: 5, name: 'German', code: 'de-DE' }],
      sets: [{ id: 9, name: 'Imported', languageId: 5 }],
      words: [{ id: 20, word: 'Haus', wordTranslated: 'house', languageId: 5, wordSetId: 9, isLearned: true, leitnerBox: 3 }],
    });
    expect(imp.status).toBe(200);
    expect(imp.body).toEqual({ languages: 1, sets: 1, words: 1 });

    const snap = await api.get('/api/sync');
    expect(snap.body.languages[0].id).toBe(5);
    expect(snap.body.words[0]).toMatchObject({ id: 20, isLearned: true, leitnerBox: 3 });
  });

  test('delta since returns only newer rows', async () => {
    const t = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await api.post('/api/languages').send({ name: 'French', code: 'fr-FR' });
    const delta = await api.get(`/api/sync?since=${encodeURIComponent(t)}`);
    expect(delta.body.languages.every((l) => l.code === 'fr-FR')).toBe(true);
  });
});

describe('quiz', () => {
  const { app } = makeApp();
  const api = client(app);

  test('Dutch articles quiz generated locally without AI', async () => {
    const langId = (await api.post('/api/languages').send({ name: 'Dutch', code: 'nl-NL' })).body.id;
    const setId = (await api.post('/api/sets').send({ name: 'Nouns', languageId: langId })).body.id;
    await api.post('/api/words').send({ word: 'de hond', wordTranslated: 'the dog', languageId: langId, wordSetId: setId });
    await api.post('/api/words').send({ word: 'het huis', wordTranslated: 'the house', languageId: langId, wordSetId: setId });

    const res = await api.post('/api/quiz/generate').send({
      languageId: langId, setId, contentSource: 'articles', numQuestions: 10,
    });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    expect(res.body[0].options).toEqual(['de', 'het']);
    expect(['de', 'het']).toContain(res.body[0].correctAnswer);
  });
});
