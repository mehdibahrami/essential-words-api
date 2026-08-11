const { makeApp, client } = require('./helpers');

describe('languages service', () => {
  const { app } = makeApp();
  const api = client(app);
  let langId;

  test('setup: one language', async () => {
    const res = await api.post('/api/languages').send({
      name: 'Dutch', code: 'nl-NL', sourceFileName: 'Dutch.csv',
    });
    expect(res.status).toBe(201);
    langId = res.body.id;
  });

  test('update language on an unknown id -> 404', async () => {
    const res = await api.put('/api/languages/999999').send({ name: 'Nope' });
    expect(res.status).toBe(404);
  });

  test('update language renames it, leaving code and sourceFileName untouched', async () => {
    const res = await api.put(`/api/languages/${langId}`).send({ name: 'Nederlands' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Nederlands');
    expect(res.body.code).toBe('nl-NL');
    expect(res.body.sourceFileName).toBe('Dutch.csv');
  });

  test('update language can change code and clear sourceFileName explicitly', async () => {
    const res = await api.put(`/api/languages/${langId}`).send({
      code: 'nl', sourceFileName: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Nederlands');
    expect(res.body.code).toBe('nl');
    expect(res.body.sourceFileName).toBeNull();
  });

  test('update language with no fields keeps everything as-is', async () => {
    const res = await api.put(`/api/languages/${langId}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Nederlands');
    expect(res.body.code).toBe('nl');
  });

  test('delete language on an unknown id -> 404', async () => {
    const res = await api.del('/api/languages/999999');
    expect(res.status).toBe(404);
  });

  test('delete language cascades to its sets and words', async () => {
    const set = await api.post('/api/sets').send({ name: 'Basics', languageId: langId });
    const word = await api.post('/api/words').send({
      word: 'de hond', wordTranslated: 'the dog', languageId: langId, wordSetId: set.body.id,
    });
    expect(word.status).toBe(201);

    const del = await api.del(`/api/languages/${langId}`);
    expect(del.status).toBe(204);

    expect((await api.get('/api/languages')).body).toHaveLength(0);
    expect((await api.get('/api/sets')).body).toHaveLength(0);
    expect((await api.get(`/api/words?setId=${set.body.id}`)).body).toHaveLength(0);
  });

  test('update language on an already-deleted language -> 404', async () => {
    const res = await api.put(`/api/languages/${langId}`).send({ name: 'Zombie' });
    expect(res.status).toBe(404);
  });

  test('delete language on an already-deleted language -> 404', async () => {
    const res = await api.del(`/api/languages/${langId}`);
    expect(res.status).toBe(404);
  });
});
