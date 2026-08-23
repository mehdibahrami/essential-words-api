const { makeApp, client } = require('./helpers');

/** Create a language, a set, and `words.length` words; return ids. */
async function seed(api, words) {
  const lang = await api.post('/api/languages').send({ name: 'Dutch', code: 'nl-NL' });
  const set = await api.post('/api/sets').send({ name: 'Basics', languageId: lang.body.id });
  const ids = [];
  for (const w of words) {
    const res = await api.post('/api/words').send({
      word: w.word,
      languageId: lang.body.id,
      wordSetId: set.body.id,
      wordTranslated: w.wordTranslated || 'ترجمه',
    });
    ids.push(res.body.id);
  }
  return { languageId: lang.body.id, setId: set.body.id, ids };
}

/** Put a word into the Recall pool (learned, in `box`) without going through Leitner. */
function makeLearned(db, wordId, box = 1) {
  db.prepare('UPDATE words SET isLearned = 1, leitnerBox = @box WHERE id = @id')
    .run({ id: wordId, box });
}

describe('recall: recording an answer', () => {
  const { app, db } = makeApp();
  const api = client(app);
  let ids;

  beforeAll(async () => {
    ({ ids } = await seed(api, [{ word: 'tafel' }]));
    makeLearned(db, ids[0], 2);
  });

  test('records a correct answer', async () => {
    const res = await api.post(`/api/recall/${ids[0]}/answer`).send({ correct: true });
    expect(res.status).toBe(201);
    expect(res.body.wordId).toBe(ids[0]);
    expect(res.body.correct).toBe(true);
    expect(typeof res.body.createdAt).toBe('string');
    const rows = db.prepare('SELECT * FROM recall_attempts WHERE wordId = ?').all(ids[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0].correct).toBe(1);
  });

  test('an answer changes NOTHING on the words row', async () => {
    const before = db.prepare('SELECT * FROM words WHERE id = ?').get(ids[0]);
    await api.post(`/api/recall/${ids[0]}/answer`).send({ correct: false });
    await api.post(`/api/recall/${ids[0]}/answer`).send({ correct: true });
    const after = db.prepare('SELECT * FROM words WHERE id = ?').get(ids[0]);
    expect(after).toEqual(before);
  });

  test('a non-boolean correct is a 400', async () => {
    const res = await api.post(`/api/recall/${ids[0]}/answer`).send({ correct: 'yes' });
    expect(res.status).toBe(400);
  });

  test('an unknown word is a 404', async () => {
    const res = await api.post('/api/recall/999999/answer').send({ correct: true });
    expect(res.status).toBe(404);
  });

  test('a soft-deleted word is a 404', async () => {
    const lang = await api.post('/api/languages').send({ name: 'German', code: 'de-DE' });
    const set = await api.post('/api/sets').send({ name: 'S', languageId: lang.body.id });
    const w = await api.post('/api/words').send({
      word: 'weg', languageId: lang.body.id, wordSetId: set.body.id, wordTranslated: 'x',
    });
    await api.del(`/api/words/${w.body.id}`);
    const res = await api.post(`/api/recall/${w.body.id}/answer`).send({ correct: true });
    expect(res.status).toBe(404);
  });
});
