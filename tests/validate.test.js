const { makeApp, client } = require('./helpers');
const { openDatabase } = require('../src/db');
const languages = require('../src/services/languages');
const sets = require('../src/services/sets');
const words = require('../src/services/words');

describe('PUT /words/:id has no Leitner escape hatch (H2)', () => {
  const { app } = makeApp();
  const api = client(app);
  let langId;
  let setId;
  let wordId;

  beforeAll(async () => {
    langId = (await api.post('/api/languages').send({ name: 'Dutch', code: 'nl-NL' })).body.id;
    setId = (await api.post('/api/sets').send({ name: 'Basics', languageId: langId })).body.id;
    wordId = (await api.post('/api/words').send({
      word: 'de kat', wordTranslated: 'the cat', languageId: langId, wordSetId: setId,
    })).body.id;
  });

  test('leitnerBox/isLearned/nextPracticeDate in the body -> 400, not applied', async () => {
    for (const bad of [{ leitnerBox: 5 }, { isLearned: true }, { nextPracticeDate: '2020-01-01' }]) {
      const res = await api.put(`/api/words/${wordId}`).send(bad);
      expect(res.status).toBe(400);
    }
    const w = (await api.get(`/api/words/${wordId}`)).body;
    expect(w.leitnerBox).toBe(0);
    expect(w.isLearned).toBe(false);
  });

  test('the service layer ignores these fields even called directly, bypassing HTTP validation', () => {
    const db = openDatabase(':memory:');
    const lang = languages.createLanguage(db, { name: 'Dutch', code: 'nl-NL' });
    const set = sets.createSet(db, { name: 'S', languageId: lang.id });
    const w = words.createWord(db, { word: 'de hond', languageId: lang.id, wordSetId: set.id });
    const updated = words.updateWord(db, w.id, { leitnerBox: 5, isLearned: true, nextPracticeDate: '2020-01-01' });
    expect(updated.leitnerBox).toBe(0);
    expect(updated.isLearned).toBe(false);
  });
});

describe('request validation (zod)', () => {
  const { app } = makeApp();
  const api = client(app);
  let langId;
  let setId;

  beforeAll(async () => {
    langId = (await api.post('/api/languages').send({ name: 'Dutch', code: 'nl-NL' })).body.id;
    setId = (await api.post('/api/sets').send({ name: 'Basics', languageId: langId })).body.id;
  });

  test('an unknown field on a strict schema is rejected with 400, not silently dropped', async () => {
    const res = await api.post('/api/languages').send({ name: 'X', code: 'x-X', notAField: 'sneaky' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BAD_REQUEST');
  });

  test('a missing required field is rejected before the service runs', async () => {
    const res = await api.post('/api/words').send({ languageId: langId, wordSetId: setId });
    expect(res.status).toBe(400);
  });

  test('a well-formed body still passes through validation unchanged', async () => {
    const res = await api.post('/api/words').send({
      word: 'de kat', wordTranslated: 'the cat', languageId: langId, wordSetId: setId,
    });
    expect(res.status).toBe(201);
    expect(res.body.word).toBe('de kat');
  });

  test('an unknown field on POST /sets/:id/words/ai-generate is rejected', async () => {
    const res = await api.post(`/api/sets/${setId}/words/ai-generate`).send({ word: 'huis', extra: true });
    expect(res.status).toBe(400);
  });

  test('an unknown field on PUT /words/:id is rejected', async () => {
    const created = await api.post('/api/words').send({
      word: 'de hond', wordTranslated: 'the dog', languageId: langId, wordSetId: setId,
    });
    const res = await api.put(`/api/words/${created.body.id}`).send({ word: 'de hond', bogus: 1 });
    expect(res.status).toBe(400);
  });

  test('a bulk-words body as a bare array still validates', async () => {
    const res = await api.post(`/api/sets/${setId}/words/bulk`).send([{ word: 'a' }, { word: 'b' }]);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ inserted: 2 });
  });

  test('bulkCreateWords rejects an array over BULK_WORDS_MAX before touching the DB', async () => {
    const { BULK_WORDS_MAX } = require('../src/schemas');
    const freshSetId = (await api.post('/api/sets').send({ name: 'Bulk cap', languageId: langId })).body.id;
    const words = Array.from({ length: BULK_WORDS_MAX + 1 }, (_, i) => ({ word: `w${i}` }));
    const res = await api.post(`/api/sets/${freshSetId}/words/bulk`).send({ words });
    expect(res.status).toBe(400);
    expect((await api.get(`/api/words?setId=${freshSetId}`)).body).toHaveLength(0);
  });
});
