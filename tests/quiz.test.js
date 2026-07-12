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
