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

test('strips a pronoun the model redundantly duplicated into its own present-tense value (live Gemini bug, "afsluiten")', async () => {
  const { db, set } = seedDutch();
  const generate = async () => ({
    headword: 'afsluiten', partOfSpeech: 'verb (separable)', wordTranslated: 'بستن',
    definition: 'to close', definitionTranslated: 'بستن',
    example1: 'Ik sluit de deur af.', example1Translated: 'من در را می‌بندم.',
    example2: 'Zij sluiten de weg af.', example2Translated: 'آن‌ها جاده را می‌بندند.',
    // Real response observed from Gemini: every present-tense value wrongly repeats the
    // subject pronoun that is already its own JSON key.
    grammar: {
      present: { ik: 'ik sluit af', jij: 'jij sluit af', hij: 'hij sluit af', wij: 'wij sluiten af' },
      irregular: false, separable: true,
      past: { singular: 'sloot af', plural: 'sloten af' }, pastParticiple: 'afgesloten',
    },
  });

  const word = await generateWordForSet(db, set.id, 'afsluiten', { generateWordDetails: generate });
  expect(word.grammar.present).toEqual({ ik: 'sluit af', jij: 'sluit af', hij: 'sluit af', wij: 'sluiten af' });
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

describe('caller-supplied fields', () => {
  const supplied = { wordTranslated: 'رسید خرید', definition: 'receipt', posHint: 'noun' };

  test('prompt states supplied values as fixed and stops asking for them', () => {
    const lang = { name: 'Dutch', code: 'nl-NL' };
    const prompt = buildPrompt(lang, 'de kassabon', supplied);
    expect(prompt).toContain('رسید خرید');
    expect(prompt).toContain('receipt');
    expect(prompt).toContain('ALREADY KNOWN');
    expect(prompt).not.toMatch(/- "wordTranslated": string\./);
    expect(prompt).not.toMatch(/- "definition": string\./);
    // still asks for everything the model is responsible for
    expect(prompt).toMatch(/- "definitionTranslated"/);
    expect(prompt).toMatch(/- "example1"/);
    expect(prompt).toMatch(/- "partOfSpeech"/);
  });

  test('supplied translation and definition are stored verbatim, model values ignored', async () => {
    const { db, set } = seedDutch();
    const generate = async () => ({
      headword: 'de kassabon', partOfSpeech: 'noun',
      wordTranslated: 'SHOULD BE IGNORED', definition: 'SHOULD BE IGNORED',
      definitionTranslated: 'رسیدی که در فروشگاه می‌گیرید',
      example1: 'Ik heb de kassabon bewaard.', example1Translated: 'من رسید را نگه داشتم.',
      example2: 'Mag ik de kassabon zien?', example2Translated: 'می‌توانم رسید را ببینم؟',
      grammar: { article: 'de', plural: 'kassabonnen' },
    });
    const created = await generateWordForSet(
      db, set.id,
      { word: 'de kassabon', ...supplied },
      { generateWordDetails: generate }
    );
    expect(created.wordTranslated).toBe('رسید خرید');
    expect(created.definition).toBe('receipt');
    expect(created.definitionTranslated).toBe('رسیدی که در فروشگاه می‌گیرید');
  });

  test('posHint does not override the model partOfSpeech', async () => {
    const { db, set } = seedDutch();
    const generate = async () => ({
      headword: 'opstaan', partOfSpeech: 'verb (separable)',
      definitionTranslated: 'بلند شدن',
      example1: 'Ik sta vroeg op.', example1Translated: 'من زود بلند می‌شوم.',
      example2: 'Wij staan om zeven uur op.', example2Translated: 'ما ساعت هفت بلند می‌شویم.',
      grammar: {
        present: { ik: 'sta op', jij: 'staat op', hij: 'staat op', wij: 'staan op' },
        irregular: true, separable: true,
        past: { singular: 'stond op', plural: 'stonden op' }, pastParticiple: 'opgestaan',
      },
    });
    const created = await generateWordForSet(
      db, set.id,
      { word: 'opstaan', wordTranslated: 'بلند شدن', definition: 'to get up', posHint: 'verb' },
      { generateWordDetails: generate }
    );
    expect(created.partOfSpeech).toBe('verb (separable)');
    expect(created.grammar).toMatchObject({ kind: 'verb', separable: true });
  });

  test('pinned:true stamps pinnedAt; omitting it leaves pinnedAt null', async () => {
    const { db, set } = seedDutch();
    const generate = async () => ({
      headword: 'de fiets', partOfSpeech: 'noun', definitionTranslated: 'دوچرخه',
      example1: 'Ik pak de fiets.', example1Translated: 'من دوچرخه را برمی‌دارم.',
      example2: 'De fiets is kapot.', example2Translated: 'دوچرخه خراب است.',
      grammar: { article: 'de', plural: 'fietsen' },
    });
    const deps = { generateWordDetails: generate };

    const pinned = await generateWordForSet(
      db, set.id, { word: 'de fiets', wordTranslated: 'دوچرخه', definition: 'bicycle', pinned: true }, deps
    );
    const plain = await generateWordForSet(
      db, set.id, { word: 'de auto', wordTranslated: 'ماشین', definition: 'car' },
      { generateWordDetails: async () => ({ headword: 'de auto', partOfSpeech: 'noun', definitionTranslated: 'ماشین' }) }
    );

    const at = (id) => db.prepare('SELECT pinnedAt FROM words WHERE id = ?').get(id).pinnedAt;
    expect(at(pinned.id)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(at(plain.id)).toBeNull();
  });

  test('the old string signature still works unchanged', async () => {
    const { db, set } = seedDutch();
    const generate = async (prompt) => {
      expect(prompt).not.toContain('ALREADY KNOWN');
      return {
        headword: 'het huis', partOfSpeech: 'noun',
        wordTranslated: 'خانه', definition: 'house', definitionTranslated: 'ساختمانی برای زندگی',
        grammar: { article: 'het', plural: 'huizen' },
      };
    };
    const created = await generateWordForSet(db, set.id, 'huis', { generateWordDetails: generate });
    expect(created.word).toBe('het huis');
    expect(created.wordTranslated).toBe('خانه');
  });

  test('GEMINI_INCOMPLETE still fires for a field the model still owns', async () => {
    const { db, set } = seedDutch();
    const generate = async () => ({ headword: 'de tafel', partOfSpeech: 'noun', definition: 'table' });
    await expect(
      generateWordForSet(db, set.id, 'de tafel', { generateWordDetails: generate })
    ).rejects.toMatchObject({ status: 502 });
  });
});
