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

describe('recall: pool and box filter', () => {
  const { app, db } = makeApp();
  const api = client(app);
  let languageId;
  let setId;
  let ids;

  beforeAll(async () => {
    ({ languageId, setId, ids } = await seed(api, [
      { word: 'een' },   // 0: stays box 0 / unlearned
      { word: 'twee' },  // 1: box 1
      { word: 'drie' },  // 2: box 3
      { word: 'vier' },  // 3: box 6
      { word: 'vijf' },  // 4: box 8 (mastered)
    ]));
    makeLearned(db, ids[1], 1);
    makeLearned(db, ids[2], 3);
    makeLearned(db, ids[3], 6);
    makeLearned(db, ids[4], 8);
  });

  const wordsIn = async (query) => {
    const res = await api.get(`/api/recall/queue?${query}`);
    expect(res.status).toBe(200);
    return res.body.map((w) => w.word).sort();
  };

  test('unlearned / box-0 words are never in the pool', async () => {
    expect(await wordsIn(`setId=${setId}`)).toEqual(['drie', 'twee', 'vier', 'vijf']);
  });

  test('box filter selects exactly those boxes', async () => {
    expect(await wordsIn(`setId=${setId}&boxes=1,3`)).toEqual(['drie', 'twee']);
  });

  test('box 6 also matches mastered words above box 6', async () => {
    expect(await wordsIn(`setId=${setId}&boxes=6`)).toEqual(['vier', 'vijf']);
  });

  test('an empty boxes param means every box', async () => {
    expect(await wordsIn(`setId=${setId}&boxes=`)).toEqual(['drie', 'twee', 'vier', 'vijf']);
  });

  test('junk box values are ignored, not fatal', async () => {
    expect(await wordsIn(`setId=${setId}&boxes=abc,3`)).toEqual(['drie']);
  });

  test('scoping by languageId works', async () => {
    expect(await wordsIn(`languageId=${languageId}`)).toEqual(['drie', 'twee', 'vier', 'vijf']);
  });

  test('count matches the queue length for the same filters', async () => {
    const res = await api.get(`/api/recall/count?setId=${setId}&boxes=1,3`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });

  test('limit is honoured and capped at MAX_SESSION_WORDS', async () => {
    const res = await api.get(`/api/recall/queue?setId=${setId}&limit=2`);
    expect(res.body).toHaveLength(2);
    const capped = await api.get(`/api/recall/queue?setId=${setId}&limit=99999`);
    expect(capped.body).toHaveLength(4);
  });

  test('queue rows are fully serialized words, not raw rows', async () => {
    const res = await api.get(`/api/recall/queue?setId=${setId}&boxes=1`);
    expect(res.body[0]).toHaveProperty('wordTranslated');
    expect(res.body[0]).toHaveProperty('leitnerBox', 1);
    expect(res.body[0]).toHaveProperty('grammar');
  });
});
