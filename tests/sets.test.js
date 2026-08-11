const { makeApp, client } = require('./helpers');

describe('sets service', () => {
  const { app } = makeApp();
  const api = client(app);
  let langId;
  let otherLangId;
  let setId;

  test('setup: two languages', async () => {
    langId = (await api.post('/api/languages').send({ name: 'Dutch', code: 'nl-NL' })).body.id;
    otherLangId = (await api.post('/api/languages').send({ name: 'French', code: 'fr-FR' })).body.id;
  });

  test('create set rejects missing name', async () => {
    const res = await api.post('/api/sets').send({ languageId: langId });
    expect(res.status).toBe(400);
  });

  test('create set rejects missing languageId', async () => {
    const res = await api.post('/api/sets').send({ name: 'Basics' });
    expect(res.status).toBe(400);
  });

  test('create set succeeds with a valid language', async () => {
    const res = await api.post('/api/sets').send({ name: 'Basics', languageId: langId });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Basics');
    setId = res.body.id;
  });

  test('list sets with no filter returns every active set', async () => {
    await api.post('/api/sets').send({ name: 'French Basics', languageId: otherLangId });
    const res = await api.get('/api/sets');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });

  test('list sets filters by languageId', async () => {
    const res = await api.get(`/api/sets?languageId=${langId}`);
    expect(res.status).toBe(200);
    expect(res.body.every((s) => s.languageId === langId)).toBe(true);
    expect(res.body.some((s) => s.name === 'French Basics')).toBe(false);
  });

  test('update set on an unknown id -> 404', async () => {
    const res = await api.put('/api/sets/999999').send({ name: 'Nope' });
    expect(res.status).toBe(404);
  });

  test('update set renames it', async () => {
    const res = await api.put(`/api/sets/${setId}`).send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
  });

  test('update set with no fields keeps the existing name', async () => {
    const res = await api.put(`/api/sets/${setId}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
  });

  test('delete set on an unknown id -> 404', async () => {
    const res = await api.del('/api/sets/999999');
    expect(res.status).toBe(404);
  });

  test('delete set cascades to its words and hides it from listings', async () => {
    const word = await api.post('/api/words').send({
      word: 'de kat', wordTranslated: 'the cat', languageId: langId, wordSetId: setId,
    });
    expect(word.status).toBe(201);

    const del = await api.del(`/api/sets/${setId}`);
    expect(del.status).toBe(204);

    expect((await api.get('/api/sets')).body.some((s) => s.id === setId)).toBe(false);
    expect((await api.get(`/api/words?setId=${setId}`)).body).toHaveLength(0);
  });

  test('update set on an already-deleted set -> 404', async () => {
    const res = await api.put(`/api/sets/${setId}`).send({ name: 'Zombie' });
    expect(res.status).toBe(404);
  });

  test('delete set on an already-deleted set -> 404', async () => {
    const res = await api.del(`/api/sets/${setId}`);
    expect(res.status).toBe(404);
  });
});
