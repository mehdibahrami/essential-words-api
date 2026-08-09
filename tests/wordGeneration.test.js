// Mocked before any other require so wordGeneration.js's own top-level
// `require('./gemini')` picks up the mock instead of the real network call.
jest.mock('../src/services/gemini', () => ({ generateWordDetails: jest.fn() }));

const { makeApp, client } = require('./helpers');
const { openDatabase } = require('../src/db');
const languages = require('../src/services/languages');
const sets = require('../src/services/sets');
const words = require('../src/services/words');
const { generateWordDetails: mockedGenerateWordDetails } = require('../src/services/gemini');
const { generateWordForSet, buildPrompt } = require('../src/services/wordGeneration');

function seedDutch() {
  const db = openDatabase(':memory:');
  const lang = languages.createLanguage(db, { name: 'Dutch', code: 'nl-NL' });
  const set = sets.createSet(db, { name: 'Basics', languageId: lang.id });
  return { db, lang, set };
}

test('prompt asks for Persian translations and an English definition, regardless of target language', () => {
  const dutch = { name: 'Dutch', code: 'nl-NL' };
  const french = { name: 'French', code: 'fr-FR' };
  for (const lang of [dutch, french]) {
    const prompt = buildPrompt(lang, 'huis');
    expect(prompt).toMatch(/wordTranslated.*Persian/i);
    expect(prompt).toMatch(/definitionTranslated.*Persian/i);
    expect(prompt).toMatch(/"definition".*ENGLISH/);
    expect(prompt).toMatch(/A2/);
  }
});

test('prompt asks for noun grammar only for Dutch', () => {
  const dutch = { name: 'Dutch', code: 'nl-NL' };
  const french = { name: 'French', code: 'fr-FR' };
  expect(buildPrompt(dutch, 'huis')).toContain('"grammar"');
  expect(buildPrompt(french, 'maison')).not.toContain('"grammar"');
});

test('generates a Dutch noun and stores article/plural grammar', async () => {
  const { db, set } = seedDutch();
  const generate = async (prompt) => {
    expect(prompt).toContain('huis');
    return {
      headword: 'het huis', partOfSpeech: 'noun', wordTranslated: 'the house',
      definition: 'een gebouw om in te wonen', definitionTranslated: 'a building to live in',
      example1: 'Het huis is groot.', example1Translated: 'The house is big.',
      example2: 'Zij kopen een huis.', example2Translated: 'They are buying a house.',
      grammar: { article: 'het', plural: 'huizen' },
    };
  };

  const word = await generateWordForSet(db, set.id, 'huis', { generateWordDetails: generate });
  expect(word.word).toBe('het huis');
  expect(word.partOfSpeech).toBe('noun');
  expect(word.grammar).toEqual({ kind: 'noun', article: 'het', plural: 'huizen', irregularPlural: false });
});

test('a regular Dutch verb stores the full AI-provided conjugation (not live-derived)', async () => {
  const { db, set } = seedDutch();
  const generate = async () => ({
    headword: 'lopen', partOfSpeech: 'verb', wordTranslated: 'راه رفتن',
    definition: 'to walk', definitionTranslated: 'راه رفتن، پیاده رفتن',
    example1: 'Ik loop naar school.', example1Translated: 'من به مدرسه می‌روم.',
    example2: 'Zij lopen in het park.', example2Translated: 'آن‌ها در پارک راه می‌روند.',
    grammar: {
      present: { ik: 'loop', jij: 'loopt', hij: 'loopt', wij: 'lopen' },
      irregular: false, separable: false,
      past: { singular: 'liep', plural: 'liepen' }, pastParticiple: 'gelopen',
    },
  });

  const word = await generateWordForSet(db, set.id, 'lopen', { generateWordDetails: generate });
  expect(word.grammar).toEqual({
    kind: 'verb',
    present: { ik: 'loop', jij: 'loopt', hij: 'loopt', wij: 'lopen' },
    irregular: false, separable: false,
    past: { singular: 'liep', plural: 'liepen' }, pastParticiple: 'gelopen',
  });
});

test('a separable verb not in the hardcoded SEPARABLE_VERBS list still gets the correct split', async () => {
  const { db, set } = seedDutch();
  // "afsluiten" is deliberately NOT in dutchGrammar.js's SEPARABLE_VERBS set — this is
  // exactly the gap AI-provided grammar exists to cover: the live rule-based conjugator
  // would otherwise treat it as one regular verb and never split off "af".
  const generate = async () => ({
    headword: 'afsluiten', partOfSpeech: 'verb (separable)', wordTranslated: 'قفل کردن، بستن',
    definition: 'to lock / close off', definitionTranslated: 'قفل کردن، بستن',
    example1: 'Ik sluit de deur af.', example1Translated: 'من در را قفل می‌کنم.',
    example2: 'Zij sluiten de weg af.', example2Translated: 'آن‌ها جاده را می‌بندند.',
    grammar: {
      present: { ik: 'sluit af', jij: 'sluit af', hij: 'sluit af', wij: 'sluiten af' },
      irregular: false, separable: true,
      past: { singular: 'sloot af', plural: 'sloten af' }, pastParticiple: 'afgesloten',
    },
  });

  const word = await generateWordForSet(db, set.id, 'afsluiten', { generateWordDetails: generate });
  expect(word.grammar.separable).toBe(true);
  expect(word.grammar.present.ik).toBe('sluit af');
  expect(word.partOfSpeech).toBe('verb (separable)');
});

test('a verb with no usable AI grammar falls back to null (live derivation takes over on read)', async () => {
  const { db, set } = seedDutch();
  const generate = async () => ({
    headword: 'lopen', partOfSpeech: 'verb', wordTranslated: 'راه رفتن',
    definition: 'to walk', definitionTranslated: 'راه رفتن',
    example1: 'Ik loop.', example1Translated: 'من راه می‌روم.',
    // no grammar object at all
  });

  const word = await generateWordForSet(db, set.id, 'lopen', { generateWordDetails: generate });
  // words.buildGrammar's live path still kicks in for a Dutch "verb" with no stored grammar.
  expect(word.grammar.kind).toBe('verb');
  expect(word.grammar.present.ik).toBe('loop');
});

test('a Dutch noun missing its article prefix gets auto-corrected from the grammar article', async () => {
  const { db, set } = seedDutch();
  const generate = async () => ({
    headword: 'tafel', partOfSpeech: 'noun', wordTranslated: 'میز', // forgot the "de " prefix
    definition: 'table', definitionTranslated: 'میز',
    example1: 'De tafel is groot.', example1Translated: 'میز بزرگ است.',
    grammar: { article: 'de', plural: 'tafels' },
  });

  const word = await generateWordForSet(db, set.id, 'tafel', { generateWordDetails: generate });
  expect(word.word).toBe('de tafel');
});

test('rejects a duplicate headword without inserting anything', async () => {
  const { db, set, lang } = seedDutch();
  words.createWord(db, { word: 'het huis', wordTranslated: 'the house', languageId: lang.id, wordSetId: set.id });
  const generate = async () => ({ headword: 'het huis', partOfSpeech: 'noun', wordTranslated: 'the house', definition: 'x' });

  await expect(generateWordForSet(db, set.id, 'huis', { generateWordDetails: generate })).rejects.toThrow(/already in this set/);
  expect(words.listWords(db, { setId: set.id })).toHaveLength(1);
});

test('rejects an incomplete AI response without inserting anything', async () => {
  const { db, set } = seedDutch();
  const generate = async () => ({ headword: 'huis' }); // missing wordTranslated/definition

  await expect(generateWordForSet(db, set.id, 'huis', { generateWordDetails: generate })).rejects.toThrow(/missing required fields/);
  expect(words.listWords(db, { setId: set.id })).toHaveLength(0);
});

test('404s for a set that does not exist', async () => {
  const db = openDatabase(':memory:');
  await expect(generateWordForSet(db, 999, 'huis', { generateWordDetails: async () => ({}) })).rejects.toThrow(/Set not found/);
});

test('POST /api/sets/:id/words/ai-generate end to end', async () => {
  const { app, db } = makeApp();
  const api = client(app);
  const lang = languages.createLanguage(db, { name: 'French', code: 'fr-FR' });
  const set = sets.createSet(db, { name: 'Basics', languageId: lang.id });

  mockedGenerateWordDetails.mockResolvedValueOnce({
    headword: 'maison', partOfSpeech: 'noun', wordTranslated: 'house',
    definition: 'un bâtiment pour vivre', definitionTranslated: 'a building to live in',
    example1: 'La maison est grande.', example1Translated: 'The house is big.',
  });

  const res = await api.post(`/api/sets/${set.id}/words/ai-generate`).send({ word: 'maison' });
  expect(res.status).toBe(201);
  expect(res.body.word).toBe('maison');
  expect(res.body.wordTranslated).toBe('house');
});
