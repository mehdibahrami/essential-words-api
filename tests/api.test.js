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

describe('grammar DTO', () => {
  const { app } = makeApp();
  const api = client(app);
  let langId; let setId;

  beforeAll(async () => {
    langId = (await api.post('/api/languages').send({ name: 'Dutch', code: 'nl-NL' })).body.id;
    setId = (await api.post('/api/sets').send({ name: 'Grammar', languageId: langId })).body.id;
  });

  test('Dutch verb gets computed present tense', async () => {
    const res = await api.post('/api/words').send({
      word: 'maken', wordTranslated: 'to make', partOfSpeech: 'verb', languageId: langId, wordSetId: setId,
    });
    expect(res.body.grammar).toEqual({
      kind: 'verb', irregular: false,
      present: { ik: 'maak', jij: 'maakt', hij: 'maakt', wij: 'maken' },
      past: { singular: 'maakte', plural: 'maakten' }, pastParticiple: 'gemaakt',
    });
  });

  test('irregular Dutch verb flagged', async () => {
    const res = await api.post('/api/words').send({
      word: 'zijn', wordTranslated: 'to be', partOfSpeech: 'verb', languageId: langId, wordSetId: setId,
    });
    expect(res.body.grammar.irregular).toBe(true);
    expect(res.body.grammar.present.hij).toBe('is');
  });

  test('noun grammar round-trips from stored data', async () => {
    const created = await api.post('/api/words').send({
      word: 'kind', wordTranslated: 'child', partOfSpeech: 'noun', languageId: langId, wordSetId: setId,
      grammar: { kind: 'noun', article: 'het', plural: 'kinderen' },
    });
    expect(created.body.grammar).toEqual({
      kind: 'noun', article: 'het', plural: 'kinderen', irregularPlural: true,
    });
    // survives a re-read
    const got = await api.get(`/api/words/${created.body.id}`);
    expect(got.body.grammar.article).toBe('het');
  });

  test('non-verb/non-noun Dutch word has null grammar', async () => {
    const res = await api.post('/api/words').send({
      word: 'snel', wordTranslated: 'fast', partOfSpeech: 'adjective', languageId: langId, wordSetId: setId,
    });
    expect(res.body.grammar).toBeNull();
  });

  test('non-Dutch verb is not conjugated', async () => {
    const enId = (await api.post('/api/languages').send({ name: 'English', code: 'en-US' })).body.id;
    const enSet = (await api.post('/api/sets').send({ name: 'EN', languageId: enId })).body.id;
    const res = await api.post('/api/words').send({
      word: 'make', partOfSpeech: 'Verb', languageId: enId, wordSetId: enSet,
    });
    expect(res.body.grammar).toBeNull();
  });
});

describe('review queue serialization (regression)', () => {
  const { app } = makeApp();
  const api = client(app);

  test('multiple queued words serialize without error and carry grammar', async () => {
    // serializeWord is reached via `.map(serializeWord)`; the 2nd+ item passed an array
    // index as the db arg and used to crash the language-code cache (500).
    const langId = (await api.post('/api/languages').send({ name: 'Dutch', code: 'nl-NL' })).body.id;
    const setId = (await api.post('/api/sets').send({ name: 'Q', languageId: langId })).body.id;
    for (const word of ['maken', 'werken', 'lopen']) {
      await api.post('/api/words').send({ word, partOfSpeech: 'verb', languageId: langId, wordSetId: setId });
    }
    const res = await api.get(`/api/review/next?setId=${setId}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(3);
    res.body.forEach((w) => expect(w.grammar).toMatchObject({ kind: 'verb' }));
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

describe('bulk word ops', () => {
  const { app } = makeApp();
  const api = client(app);
  let langId;
  let setId;

  beforeAll(async () => {
    langId = (await api.post('/api/languages').send({ name: 'Spanish', code: 'es-ES' })).body.id;
    setId = (await api.post('/api/sets').send({ name: 'Seed', languageId: langId })).body.id;
  });

  test('bulk import inserts words scoped to the set', async () => {
    const res = await api.post(`/api/sets/${setId}/words/bulk`).send({
      words: [
        { word: 'hola', wordTranslated: 'hi', partOfSpeech: 'interj', definition: 'greeting' },
        { word: 'casa', wordTranslated: 'house' },
        { word: '' }, // skipped (no word)
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ inserted: 2 });
    const list = await api.get(`/api/words?setId=${setId}`);
    expect(list.body).toHaveLength(2);
    expect(list.body[0].languageId).toBe(langId);
  });

  test('delete all words in a set', async () => {
    const del = await api.del(`/api/sets/${setId}/words`);
    expect(del.body.deleted).toBe(2);
    expect((await api.get(`/api/words?setId=${setId}`)).body).toHaveLength(0);
  });

  test('delete all words for a language', async () => {
    await api.post(`/api/sets/${setId}/words/bulk`).send({ words: [{ word: 'perro', wordTranslated: 'dog' }] });
    const del = await api.del(`/api/languages/${langId}/words`);
    expect(del.body.deleted).toBe(1);
    expect((await api.get(`/api/words?languageId=${langId}`)).body).toHaveLength(0);
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

describe('lapse tracking', () => {
  const { app } = makeApp();
  const api = client(app);
  let langId; let setId; let wordId;

  beforeAll(async () => {
    langId = (await api.post('/api/languages').send({ name: 'Dutch', code: 'nl-NL' })).body.id;
    setId = (await api.post('/api/sets').send({ name: 'Basics', languageId: langId })).body.id;
    wordId = (await api.post('/api/words').send({
      word: 'liggen', wordTranslated: 'دراز کشیدن', definition: 'to lie',
      languageId: langId, wordSetId: setId,
    })).body.id;
    await api.post(`/api/review/${wordId}/learned`);
  });

  test('marking learned is not a lapse', async () => {
    const res = await api.get('/api/stats').query({ languageId: langId });
    expect(res.body.troubleWords).toBe(0);
  });

  test('incorrect opens a lapse and counts it', async () => {
    await api.post(`/api/practice/${wordId}/incorrect`);
    const w = (await api.get(`/api/words/${wordId}`)).body;
    expect(w.lapseCount).toBe(1);
    expect(w.openLapse).toBe(1);
    expect(w.lastLapsedAt).toEqual(expect.any(String));
    const stats = (await api.get('/api/stats').query({ languageId: langId })).body;
    expect(stats.troubleWords).toBe(1);
  });

  test('correct closes the lapse but keeps the lifetime count', async () => {
    await api.post(`/api/practice/${wordId}/correct`);
    const w = (await api.get(`/api/words/${wordId}`)).body;
    expect(w.openLapse).toBe(0);
    expect(w.lapseCount).toBe(1);
    const stats = (await api.get('/api/stats').query({ languageId: langId })).body;
    expect(stats.troubleWords).toBe(0);
  });

  test('a second failure increments the lifetime count', async () => {
    await api.post(`/api/practice/${wordId}/incorrect`);
    const w = (await api.get(`/api/words/${wordId}`)).body;
    expect(w.lapseCount).toBe(2);
    expect(w.openLapse).toBe(1);
  });

  test('reset clears all lapse state', async () => {
    await api.post(`/api/languages/${langId}/reset`);
    const w = (await api.get(`/api/words/${wordId}`)).body;
    expect(w.lapseCount).toBe(0);
    expect(w.openLapse).toBe(0);
    expect(w.lastLapsedAt).toBeNull();
  });
});

describe('trouble words pool', () => {
  const { app } = makeApp();
  const api = client(app);
  let langId; let setId; const ids = {};

  const addWord = async (word) => (await api.post('/api/words').send({
    word, wordTranslated: word, definition: word,
    languageId: langId, wordSetId: setId,
  })).body.id;

  beforeAll(async () => {
    langId = (await api.post('/api/languages').send({ name: 'Dutch', code: 'nl-NL' })).body.id;
    setId = (await api.post('/api/sets').send({ name: 'Basics', languageId: langId })).body.id;
    for (const w of ['een', 'twee', 'drie']) {
      ids[w] = await addWord(w);
      await api.post(`/api/review/${ids[w]}/learned`);
    }
    // 'een' fails twice, 'twee' once, 'drie' never.
    await api.post(`/api/practice/${ids.een}/incorrect`);
    await api.post(`/api/practice/${ids.een}/correct`);
    await api.post(`/api/practice/${ids.een}/incorrect`);
    await api.post(`/api/practice/${ids.twee}/incorrect`);
  });

  test('pool holds only words with an open lapse, worst first', async () => {
    const res = await api.get('/api/trouble-words').query({ languageId: langId });
    expect(res.status).toBe(200);
    expect(res.body.map((w) => w.word)).toEqual(['een', 'twee']);
    expect(res.body[0].lapseCount).toBe(2);
  });

  test('limit is honoured', async () => {
    const res = await api.get('/api/trouble-words').query({ languageId: langId, limit: 1 });
    expect(res.body).toHaveLength(1);
    expect(res.body[0].word).toBe('een');
  });

  test('words are serialized like every other word DTO', async () => {
    const res = await api.get('/api/trouble-words').query({ languageId: langId });
    expect(res.body[0].isLearned).toBe(true);
    expect(res.body[0]).toHaveProperty('grammar');
  });

  test('passing a word in practice removes it from the pool', async () => {
    await api.post(`/api/practice/${ids.twee}/correct`);
    const res = await api.get('/api/trouble-words').query({ languageId: langId });
    expect(res.body.map((w) => w.word)).toEqual(['een']);
  });
});
