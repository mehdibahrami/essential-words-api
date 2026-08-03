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
