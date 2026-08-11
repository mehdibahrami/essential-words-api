const { makeApp, client } = require('./helpers');

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
});
