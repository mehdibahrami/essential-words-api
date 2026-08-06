const { makeApp, client } = require('./helpers');
const { openDatabase } = require('../src/db');
const quiz = require('../src/services/quiz');
const languages = require('../src/services/languages');
const sets = require('../src/services/sets');
const words = require('../src/services/words');

function seed() {
  const db = openDatabase(':memory:');
  const lang = languages.createLanguage(db, { name: 'Dutch', code: 'nl-NL' });
  const set = sets.createSet(db, { name: 'S', languageId: lang.id });
  words.createWord(db, { word: 'lopen', wordTranslated: 'to walk', partOfSpeech: 'verb', languageId: lang.id, wordSetId: set.id });
  words.createWord(db, { word: 'de kat', wordTranslated: 'the cat', partOfSpeech: 'noun', languageId: lang.id, wordSetId: set.id });
  return { db, lang, set };
}

test('vocab quiz calls the injected generator with a well-formed prompt', async () => {
  const { db, lang, set } = seed();
  let capturedPrompt = '';
  const fakeGen = async (prompt) => {
    capturedPrompt = prompt;
    return [{ questionDescription: 'Q', questionItself: 'lopen', options: ['a', 'b', 'c', 'd'], correctAnswer: 'a' }];
  };

  const result = await quiz.generateQuiz(
    db,
    { languageId: lang.id, setId: set.id, level: 'A2', numQuestions: 5, contentSource: 'leitnerBoxes', leitnerBoxes: [0], questionsInEnglish: true },
    { generate: fakeGen }
  );

  expect(capturedPrompt).toContain('Dutch');
  expect(capturedPrompt).toContain('A2');
  expect(capturedPrompt).toContain('JSON array');
  expect(result).toHaveLength(1);
});

test('verb conjugation prompt lists verbs from the word list', async () => {
  const { db, lang, set } = seed();
  let capturedPrompt = '';
  const fakeGen = async (prompt) => { capturedPrompt = prompt; return []; };
  await quiz.generateQuiz(
    db,
    { languageId: lang.id, setId: set.id, contentSource: 'verbConjugation', tenses: ['Present Simple'], questionsInEnglish: false },
    { generate: fakeGen }
  );
  expect(capturedPrompt).toContain('verb conjugation');
  expect(capturedPrompt).toContain('lopen'); // the verb, not the noun
  expect(capturedPrompt).not.toContain('de kat'); // the noun is excluded
  expect(capturedPrompt).toContain('Focus on these tenses: Present Simple');
  expect(capturedPrompt).toContain('MUST be in Dutch'); // questionsInEnglish:false
});

test('articles quiz rejects non-Dutch languages', async () => {
  const db = openDatabase(':memory:');
  const en = languages.createLanguage(db, { name: 'English', code: 'en-US' });
  await expect(
    quiz.generateQuiz(db, { languageId: en.id, contentSource: 'articles', numQuestions: 5 })
  ).rejects.toThrow(/Dutch/);
});

describe('question translations', () => {
  const quiz = require('../src/services/quiz');

  test('keeps a translation only for multi-word sentences', () => {
    expect(quiz.questionTranslationFor('Het boek ____ op de tafel.', 'The book lies on the table.', 'leitnerBoxes'))
      .toBe('The book lies on the table.');
    // A bare headword: the options already are its meaning.
    expect(quiz.questionTranslationFor('liggen', 'to lie', 'leitnerBoxes')).toBeNull();
  });

  test('"ik + hebben" is two word tokens, not three', () => {
    // Naive whitespace splitting counts 3 here and would leak a translation.
    expect(quiz.questionTranslationFor('ik + hebben', 'I have', 'leitnerBoxes')).toBeNull();
  });

  test('verbConjugation and articles never carry a translation', () => {
    for (const source of ['verbConjugation', 'articles']) {
      expect(quiz.questionTranslationFor('Het boek ligt op de tafel.', 'The book lies on the table.', source)).toBeNull();
    }
  });

  test('a missing or non-string translation becomes null', () => {
    for (const bad of [undefined, null, 99, '  ']) {
      expect(quiz.questionTranslationFor('Het boek ____ op de tafel.', bad, 'leitnerBoxes')).toBeNull();
    }
  });

  test('generateQuiz stamps the field on every question', async () => {
    const { openDatabase } = require('../src/db');
    const db = openDatabase(':memory:');
    const lang = db.prepare("INSERT INTO languages (name, code) VALUES ('Dutch','nl-NL')").run();
    const languageId = lang.lastInsertRowid;
    const set = db.prepare('INSERT INTO word_sets (name, languageId) VALUES (?, ?)').run('S', languageId);
    const wordSetId = set.lastInsertRowid;
    db.prepare('INSERT INTO words (languageId, wordSetId, word, wordTranslated, definition, leitnerBox) VALUES (?,?,?,?,?,1)')
      .run(languageId, wordSetId, 'liggen', 'دراز کشیدن', 'to lie');

    const generate = async () => ([
      { questionDescription: 'Fill in the blank:', questionItself: 'Het boek ____ op de tafel.', options: ['ligt', 'legt', 'lag', 'leggen'], correctAnswer: 'ligt', questionTranslation: 'The book lies on the table.' },
      { questionDescription: 'Choose the definition:', questionItself: 'liggen', options: ['to lie', 'to lay', 'to sit', 'to stand'], correctAnswer: 'to lie', questionTranslation: 'to lie' },
    ]);

    const out = await quiz.generateQuiz(db, { languageId, contentSource: 'leitnerBoxes', leitnerBoxes: [1], numQuestions: 2 }, { generate });
    expect(out[0].questionTranslation).toBe('The book lies on the table.');
    expect(out[1].questionTranslation).toBeNull();
  });
});

const { generateDrills } = require('../src/services/troubleDrills');

describe('quiz material', () => {
  const { app } = makeApp();
  const api = client(app);
  let langId;
  let setId;
  let wordId;

  beforeAll(async () => {
    langId = (await api.post('/api/languages').send({ name: 'Dutch', code: 'nl-NL' })).body.id;
    setId = (await api.post('/api/sets').send({ name: 'Basics', languageId: langId })).body.id;
    const created = await api.post('/api/words').send({
      languageId: langId, wordSetId: setId,
      word: 'liggen', wordTranslated: 'to lie', partOfSpeech: 'verb',
      definition: 'to lie, to be placed', definitionTranslated: 'liggen',
      example1: 'Het boek ligt op de tafel.', example1Translated: 'The book is on the table.',
    });
    wordId = created.body.id;
  });

  test('returns the un-blanked sentence alongside the cloze', async () => {
    const db = app.locals.db;
    const out = await generateDrills(db, { languageId: langId, setId, wordIds: [wordId] }, {
      generate: async () => ([{
        wordId,
        cloze: {
          sentence: 'Het boek ____ op de tafel.',
          answer: 'ligt',
          distractors: ['legt', 'lag', 'liggen'],
          sentenceTranslation: 'The book is lying on the table.',
        },
        hook: 'liGGen lies by itself.',
        confusables: ['leggen'],
      }]),
    });
    expect(out).toHaveLength(1);
    expect(out[0].sentence).toBe('Het boek ligt op de tafel.');
    expect(out[0].cloze.sentence).toContain('____');
  });

  test('the local fallback also carries a sentence', async () => {
    // Its own db and word: `wordId` above was already cached by the previous test
    // under the same default level ('A1'), so reusing it here would serve straight
    // from `word_material` and never touch the throwing `generate` this test exists
    // to exercise.
    const db = openDatabase(':memory:');
    const lang = languages.createLanguage(db, { name: 'Dutch', code: 'nl-NL' });
    const set = sets.createSet(db, { name: 'Basics', languageId: lang.id });
    const w = words.createWord(db, {
      word: 'liggen', wordTranslated: 'to lie', partOfSpeech: 'verb',
      definition: 'to lie, to be placed', definitionTranslated: 'liggen',
      languageId: lang.id, wordSetId: set.id,
      example1: 'Het boek ligt op de tafel.', example1Translated: 'The book is on the table.',
    });

    let calls = 0;
    const out = await generateDrills(db, { languageId: lang.id, setId: set.id, wordIds: [w.id] }, {
      generate: async () => { calls += 1; throw new Error('gemini down'); },
    });
    expect(calls).toBe(1); // proves the local fallback path was actually exercised
    expect(out[0].sentence).toBe('Het boek ligt op de tafel.');
  });

  test('limit caps how many words are processed', async () => {
    const db = app.locals.db;
    const down = { generate: async () => { throw new Error('down'); } };

    // Seed MORE words than either cap. Passing a single id here — as an earlier draft
    // of this test did — makes the assertion pass whether or not the clamp exists.
    const ids = [];
    for (let i = 0; i < 25; i++) {
      const res = await api.post('/api/words').send({
        languageId: langId, wordSetId: setId,
        word: `woord${i}`, wordTranslated: `word${i}`, partOfSpeech: 'noun',
        definition: `definition ${i}`, definitionTranslated: `definitie ${i}`,
        example1: `Dit is woord${i} hier.`, example1Translated: `This is word${i} here.`,
      });
      ids.push(res.body.id);
    }

    const material = await generateDrills(db, { languageId: langId, setId, wordIds: ids, limit: 20 }, down);
    expect(material).toHaveLength(20);

    // The trouble route's default is unchanged at 8.
    const drill = await generateDrills(db, { languageId: langId, setId, wordIds: ids }, down);
    expect(drill).toHaveLength(8);

    // A caller cannot exceed MAX_MATERIAL_WORDS by asking for more.
    const overshoot = await generateDrills(db, { languageId: langId, setId, wordIds: ids, limit: 999 }, down);
    expect(overshoot).toHaveLength(20);

    // Junk limits fall back to the default rather than truncating to nothing.
    for (const bad of [0, -5, 'abc', null]) {
      const out = await generateDrills(db, { languageId: langId, setId, wordIds: ids, limit: bad }, down);
      expect(out).toHaveLength(8);
    }
  });

  test('POST /api/quiz/material rejects an empty wordIds list', async () => {
    const res = await api.post('/api/quiz/material').send({ languageId: langId, wordIds: [] });
    expect(res.status).toBe(400);
  });

  test('the drill prompt constrains sentence length', () => {
    const { drillPrompt } = require('../src/services/troubleDrills');
    const prompt = drillPrompt({ name: 'Dutch', code: 'nl-NL' }, [
      { id: 1, word: 'liggen', partOfSpeech: 'verb', definition: 'to lie' },
    ], 'A1');
    expect(prompt).toMatch(/between 4 and 8 words/i);
  });
});
