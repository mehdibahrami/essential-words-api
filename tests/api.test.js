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

describe('trouble word drills', () => {
  const { openDatabase } = require('../src/db');
  const troubleDrills = require('../src/services/troubleDrills');

  function seed() {
    const db = openDatabase(':memory:');
    const lang = db.prepare("INSERT INTO languages (name, code) VALUES ('Dutch','nl-NL')").run();
    const set = db.prepare('INSERT INTO word_sets (name, languageId) VALUES (?,?)').run('Basics', lang.lastInsertRowid);
    const insert = db.prepare(`INSERT INTO words (languageId, wordSetId, word, wordTranslated, definition, example1)
                               VALUES (?,?,?,?,?,?)`);
    const a = insert.run(lang.lastInsertRowid, set.lastInsertRowid, 'liggen', 'دراز کشیدن', 'to lie', 'Het boek ligt op de tafel.');
    const b = insert.run(lang.lastInsertRowid, set.lastInsertRowid, 'de tafel', 'میز', 'the table', null);
    // Filler so the local fallback has enough candidates to build distractors from.
    for (const filler of ['leggen', 'zitten', 'staan', 'lopen']) {
      insert.run(lang.lastInsertRowid, set.lastInsertRowid, filler, filler, filler, null);
    }
    return { db, languageId: lang.lastInsertRowid, ids: { liggen: a.lastInsertRowid, tafel: b.lastInsertRowid } };
  }

  test('uses the AI drill when it is well formed', async () => {
    const { db, languageId, ids } = seed();
    const generate = async () => ([{
      wordId: ids.liggen,
      cloze: { sentence: 'Het boek ____ op de tafel.', answer: 'ligt', distractors: ['legt', 'liggen', 'legde'] },
      hook: 'liGGen lies by itself; leGGen needs an object.',
      confusables: ['leggen'],
    }]);
    const out = await troubleDrills.generateDrills(db, { languageId, wordIds: [ids.liggen] }, { generate });
    expect(out).toHaveLength(1);
    expect(out[0].cloze.answer).toBe('ligt');
    expect(out[0].hook).toMatch(/liGGen/);
    expect(out[0].confusables).toEqual(['leggen']);
  });

  test('falls back to the word own example when AI fails', async () => {
    const { db, languageId, ids } = seed();
    const generate = async () => { throw new Error('gemini down'); };
    const out = await troubleDrills.generateDrills(db, { languageId, wordIds: [ids.liggen, ids.tafel] }, { generate });
    const byId = Object.fromEntries(out.map((d) => [d.wordId, d]));
    expect(byId[ids.liggen].cloze.sentence).toContain('____');
    expect(byId[ids.liggen].cloze.sentence).not.toMatch(/ligt/i);
    expect(byId[ids.liggen].cloze.distractors.length).toBeGreaterThanOrEqual(2);
    expect(byId[ids.liggen].hook).toBeNull();
    // No example sentence and no AI -> no cloze at all; the client skips rung 2.
    expect(byId[ids.tafel].cloze).toBeNull();
  });

  test('falls back to the word own example when AI returns a non-array', async () => {
    const { db, languageId, ids } = seed();
    for (const generate of [async () => null, async () => ({})]) {
      const out = await troubleDrills.generateDrills(db, { languageId, wordIds: [ids.liggen, ids.tafel] }, { generate });
      const byId = Object.fromEntries(out.map((d) => [d.wordId, d]));
      expect(byId[ids.liggen].cloze.sentence).toContain('____');
      expect(byId[ids.liggen].cloze.sentence).not.toMatch(/ligt/i);
      expect(byId[ids.liggen].cloze.distractors.length).toBeGreaterThanOrEqual(2);
      expect(byId[ids.liggen].hook).toBeNull();
      // No example sentence and no AI -> no cloze at all; the client skips rung 2.
      expect(byId[ids.tafel].cloze).toBeNull();
      expect(byId[ids.tafel].hook).toBeNull();
    }
  });

  test('rejects a malformed AI cloze and falls back', async () => {
    const { db, languageId, ids } = seed();
    // No blank marker, and the answer is visible in the sentence.
    const generate = async () => ([{
      wordId: ids.liggen,
      cloze: { sentence: 'Het boek ligt op de tafel.', answer: 'ligt', distractors: ['legt'] },
      hook: 'ignored',
    }]);
    const out = await troubleDrills.generateDrills(db, { languageId, wordIds: [ids.liggen] }, { generate });
    expect(out[0].cloze.sentence).toContain('____');
    expect(out[0].hook).toBeNull();
  });

  test('caps the request at 8 words and rejects an empty list', async () => {
    const { db, languageId, ids } = seed();
    await expect(troubleDrills.generateDrills(db, { languageId, wordIds: [] }, { generate: async () => [] }))
      .rejects.toThrow(/wordIds/);

    // 9 DISTINCT word ids so the MAX_DRILL_WORDS slice actually has something to cut —
    // 20 copies of the SAME id would collapse to length 1 via the dedupe Set before the
    // cap logic ever runs, and the assertion below would pass trivially.
    const setRow = db.prepare('SELECT wordSetId FROM words WHERE id = ?').get(ids.liggen);
    const insert = db.prepare(`INSERT INTO words (languageId, wordSetId, word, wordTranslated, definition, example1)
                               VALUES (?,?,?,?,?,?)`);
    const distinctIds = [ids.liggen, ids.tafel];
    for (let i = 0; i < 7; i++) {
      const r = insert.run(languageId, setRow.wordSetId, `extra${i}`, `extra${i}`, `extra${i}`, null);
      distinctIds.push(r.lastInsertRowid);
    }
    expect(new Set(distinctIds).size).toBe(9);

    const out = await troubleDrills.generateDrills(db, { languageId, wordIds: distinctIds }, { generate: async () => [] });
    expect(out.length).toBe(8);
  });

  // The client renders the options as `distractors + [answer]` and grades by string
  // equality, so a distractor equal to the answer makes two options simultaneously
  // correct — and duplicate strings also collide in the SwiftUI `ForEach(id: \.self)`.
  const optionsOf = (cloze) => [...cloze.distractors, cloze.answer].map((o) => o.trim().toLowerCase());

  test('drops an AI distractor that repeats the answer', async () => {
    const { db, languageId, ids } = seed();
    const generate = async () => ([{
      wordId: ids.liggen,
      cloze: { sentence: 'Het boek ____ op de tafel.', answer: 'ligt', distractors: ['legt', 'ligt', 'legde'] },
      hook: 'kept',
    }]);
    const out = await troubleDrills.generateDrills(db, { languageId, wordIds: [ids.liggen] }, { generate });
    // Still the AI cloze — two distinct distractors survive, so it stays valid.
    expect(out[0].hook).toBe('kept');
    expect(out[0].cloze.distractors).toEqual(['legt', 'legde']);
    expect(optionsOf(out[0].cloze).filter((o) => o === 'ligt')).toHaveLength(1);
  });

  test('de-duplicates AI distractors that differ only by case or whitespace', async () => {
    const { db, languageId, ids } = seed();
    const generate = async () => ([{
      wordId: ids.liggen,
      cloze: { sentence: 'Het boek ____ op de tafel.', answer: 'ligt', distractors: ['legt', 'Legt ', 'legde'] },
      hook: 'kept',
    }]);
    const out = await troubleDrills.generateDrills(db, { languageId, wordIds: [ids.liggen] }, { generate });
    expect(out[0].hook).toBe('kept');
    expect(out[0].cloze.distractors).toEqual(['legt', 'legde']);
    const options = optionsOf(out[0].cloze);
    expect(new Set(options).size).toBe(options.length);
  });

  test('rejects an AI cloze left with fewer than 2 distractors after de-duplication', async () => {
    const { db, languageId, ids } = seed();
    // Three distractors on paper, but one repeats the answer and one is a case variant
    // of the other -> a single usable distractor, so the pack must take the local path.
    const generate = async () => ([{
      wordId: ids.liggen,
      cloze: { sentence: 'Het boek ____ op de tafel.', answer: 'ligt', distractors: ['legt', 'LEGT', 'Ligt'] },
      hook: 'discarded with the cloze',
    }]);
    const out = await troubleDrills.generateDrills(db, { languageId, wordIds: [ids.liggen] }, { generate });
    expect(out[0].hook).toBeNull();
    expect(out[0].cloze.sentence).toContain('____');
    expect(out[0].cloze.distractors.length).toBeGreaterThanOrEqual(2);
    expect(out[0].cloze.distractors).not.toContain('legt');
  });

  test('the local fallback cloze emits no duplicate options either', async () => {
    const { db, languageId, ids } = seed();
    const generate = async () => { throw new Error('gemini down'); };
    const out = await troubleDrills.generateDrills(db, { languageId, wordIds: [ids.liggen] }, { generate });
    const options = optionsOf(out[0].cloze);
    expect(options.length).toBeGreaterThanOrEqual(3);
    expect(new Set(options).size).toBe(options.length);
  });

  test('the local fallback cloze carries the example translation', async () => {
    const { db, languageId, ids } = seed();
    db.prepare('UPDATE words SET example1Translated = ? WHERE id = ?')
      .run('The book is lying on the table.', ids.liggen);
    const generate = async () => { throw new Error('gemini down'); };
    const out = await troubleDrills.generateDrills(db, { languageId, wordIds: [ids.liggen] }, { generate });
    expect(out[0].cloze.sentenceTranslation).toBe('The book is lying on the table.');
  });

  test('a word with no example translation still yields a valid cloze', async () => {
    const { db, languageId, ids } = seed();
    const generate = async () => { throw new Error('gemini down'); };
    const out = await troubleDrills.generateDrills(db, { languageId, wordIds: [ids.liggen] }, { generate });
    expect(out[0].cloze.sentence).toContain('____');
    expect(out[0].cloze.sentenceTranslation).toBeNull();
  });

  test('an AI sentence translation passes through, a non-string one is nulled', async () => {
    const { db, languageId, ids } = seed();
    const packFor = (translation) => async () => ([{
      wordId: ids.liggen,
      cloze: {
        sentence: 'Het boek ____ op de tafel.',
        answer: 'ligt',
        distractors: ['legt', 'legde'],
        sentenceTranslation: translation,
      },
      hook: 'kept',
    }]);

    const good = await troubleDrills.generateDrills(db, { languageId, wordIds: [ids.liggen] }, { generate: packFor('  The book lies on the table. ') });
    expect(good[0].cloze.sentenceTranslation).toBe('The book lies on the table.');

    for (const bad of [42, null, '   ']) {
      const out = await troubleDrills.generateDrills(db, { languageId, wordIds: [ids.liggen] }, { generate: packFor(bad) });
      expect(out[0].cloze.sentenceTranslation).toBeNull();
      expect(out[0].hook).toBe('kept'); // the cloze itself is still valid
    }
  });

  test('the requested CEFR level reaches the drill prompt', () => {
    const language = { name: 'Dutch', code: 'nl-NL' };
    const rows = [{ id: 1, word: 'liggen', partOfSpeech: 'verb', definition: 'to lie' }];
    expect(troubleDrills.drillPrompt(language, rows, 'B2')).toContain('B2');
    // The default must still be a usable prompt when no level is given.
    expect(troubleDrills.drillPrompt(language, rows)).toContain('A1');
  });
});

describe('quiz lapses', () => {
  const { app } = makeApp();
  const api = client(app);
  let langId; let setId; let wordId;

  beforeAll(async () => {
    langId = (await api.post('/api/languages').send({ name: 'Dutch', code: 'nl-NL' })).body.id;
    setId = (await api.post('/api/sets').send({ name: 'Basics', languageId: langId })).body.id;
    wordId = (await api.post('/api/words').send({
      languageId: langId, wordSetId: setId,
      word: 'de tafel', wordTranslated: 'the table', partOfSpeech: 'noun',
      definition: 'the table', definitionTranslated: 'de tafel',
    })).body.id;
    await api.post(`/api/review/${wordId}/learned`);
    // markLearned itself sets leitnerBox to 1, which is also the value a broken
    // openLapses might hardcode (mirroring practiceIncorrect's box reset). Advance
    // past box 1 here so the "unchanged" assertion below can't pass vacuously.
    await api.post(`/api/practice/${wordId}/correct`);
  });

  test('opens a lapse without touching Leitner state', async () => {
    const before = (await api.get(`/api/words/${wordId}`)).body;
    expect(before.leitnerBox).not.toBe(1);
    const res = await api.post('/api/quiz/lapses').send({ wordIds: [wordId] });
    expect(res.status).toBe(200);

    const after = (await api.get(`/api/words/${wordId}`)).body;
    expect(after.openLapse).toBe(1);
    expect(after.lapseCount).toBe(1);
    expect(after.lastLapsedAt).toBeTruthy();
    expect(after.leitnerBox).toBe(before.leitnerBox);
    expect(after.nextPracticeDate).toBe(before.nextPracticeDate);
  });

  test('the word appears in the trouble list and in stats', async () => {
    const list = await api.get(`/api/trouble-words?languageId=${langId}`);
    expect(list.body.map((w) => w.id)).toContain(wordId);
    const stats = await api.get(`/api/stats?languageId=${langId}`);
    expect(stats.body.troubleWords).toBeGreaterThanOrEqual(1);
  });

  test('a second lapse increments the lifetime count', async () => {
    await api.post('/api/quiz/lapses').send({ wordIds: [wordId] });
    const after = (await api.get(`/api/words/${wordId}`)).body;
    expect(after.lapseCount).toBe(2);
  });

  test('practiceCorrect still closes the lapse', async () => {
    await api.post(`/api/practice/${wordId}/correct`);
    const after = (await api.get(`/api/words/${wordId}`)).body;
    expect(after.openLapse).toBe(0);
    expect(after.lapseCount).toBe(2);
  });

  test('unknown ids are ignored rather than erroring', async () => {
    const res = await api.post('/api/quiz/lapses').send({ wordIds: [999999] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
  });

  test('an empty list is a no-op, not a 400', async () => {
    const res = await api.post('/api/quiz/lapses').send({ wordIds: [] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
  });
});

describe('article questions carry a word id', () => {
  const { app } = makeApp();
  const api = client(app);

  test('dutchArticleQuiz attaches wordId', async () => {
    const langId = (await api.post('/api/languages').send({ name: 'Dutch', code: 'nl-NL' })).body.id;
    const setId = (await api.post('/api/sets').send({ name: 'B', languageId: langId })).body.id;
    const wordId = (await api.post('/api/words').send({
      languageId: langId, wordSetId: setId,
      word: 'de tafel', wordTranslated: 'the table', partOfSpeech: 'noun',
      definition: 'the table', definitionTranslated: 'de tafel',
    })).body.id;

    const res = await api.post('/api/quiz/generate').send({
      languageId: langId, setId, contentSource: 'articles', numQuestions: 5,
    });
    expect(res.status).toBe(200);
    expect(res.body[0].wordId).toBe(wordId);
  });
});
