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

const SNAPSHOT_0083133_PROMPT = `You are populating a vocabulary flashcard for a language-learning app used by a native Persian (Farsi) speaker learning Dutch (code: nl-NL). The student entered: "de boodschappen".

LANGUAGE RULES — apply to every field below:
- "headword", "example1" and "example2" are written in Dutch.
- "definition" is written in ENGLISH, ALWAYS — regardless of Dutch. It is a short dictionary-style gloss (e.g. "occupied / busy", "with", "in front of"), not a definition written in Dutch.
- "wordTranslated", "definitionTranslated", "example1Translated" and "example2Translated" are written in PERSIAN (Farsi) script, ALWAYS — never English.
- "example1" and "example2" must be CEFR A2 level: short sentences, common everyday vocabulary, simple grammar — no subordinate clauses or advanced tenses.

HEADWORD NORMALIZATION: "headword" is always the base DICTIONARY form — corrected for spelling/casing, and NEVER the inflected form the student typed if they typed one:
- a conjugated verb → its infinitive (student enters "ben" → headword "zijn")
- a plural noun → its singular (student enters "huizen" → headword "het huis")
- an inflected adjective → its base predicate form (student enters Dutch "lange" → headword "lang")

Return a single JSON object (not an array) with exactly these fields:
- "headword": string, per the normalization rule above.
- "partOfSpeech": the single most accurate grammatical label for the headword.
- "wordTranslated": string.
- "definition": string.
- "definitionTranslated": string.
- "example1": string.
- "example1Translated": string.
- "example2": string.
- "example2Translated": string.

DUTCH-SPECIFIC GRAMMAR RULES:
- "partOfSpeech" should use this app's existing Dutch grammar labels: "noun", "verb", "verb (separable)", "verb (auxiliary)", "verb (modal)", "adjective", "adverb", "preposition", "pronoun", "conjunction", "determiner", "numeral", "interjection", etc. Use "verb (separable)" specifically when the verb's prefix detaches in the present tense (e.g. "opstaan" → "ik sta op", "meenemen" → "ik neem mee").
- Noun: "headword" MUST start with its article, "de " or "het " — exactly like every Dutch noun already in this app's database (e.g. "de hand", "het leven", "de tafel", "het huis"), never a bare noun with no article. Also include a "grammar" object: {"article": "de" or "het", "plural": "<plural form, WITHOUT the article>"}.
- Verb (any "partOfSpeech" starting with "verb"): "headword" is the bare infinitive, no article. Also include a "grammar" object with the FULL conjugation, shaped exactly like this real example for the separable verb "opstaan": {"present": {"ik": "sta op", "jij": "staat op", "hij": "staat op", "wij": "staan op"}, "irregular": true, "separable": true, "past": {"singular": "stond op", "plural": "stonden op"}, "pastParticiple": "opgestaan"}. CRITICAL: each present-tense VALUE is ONLY the conjugated verb (plus its detached prefix for a separable verb) — it must NEVER repeat the subject pronoun that is already its own JSON key (wrong: "ik": "ik sta op"; correct: "ik": "sta op"). For a separable verb, the detached prefix goes at the END of the value (wrong: "opstaat"; correct: "staat op").

Respond with ONLY the JSON object — no markdown fences, no surrounding text.`;

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

  test('GEMINI_INCOMPLETE fires when the model returns a non-string wordTranslated and none was supplied', async () => {
    const { db, set } = seedDutch();
    const generate = async () => ({
      headword: 'de tafel', partOfSpeech: 'noun', wordTranslated: 12345, definition: 'a table',
    });
    await expect(
      generateWordForSet(db, set.id, 'de tafel', { generateWordDetails: generate })
    ).rejects.toMatchObject({ status: 502, code: 'GEMINI_INCOMPLETE' });
    expect(words.listWords(db, { setId: set.id })).toHaveLength(0);
  });

  test('GEMINI_INCOMPLETE fires when the model returns a non-string definition and none was supplied', async () => {
    const { db, set } = seedDutch();
    const generate = async () => ({
      headword: 'de tafel', partOfSpeech: 'noun', wordTranslated: 'table', definition: {},
    });
    await expect(
      generateWordForSet(db, set.id, 'de tafel', { generateWordDetails: generate })
    ).rejects.toMatchObject({ status: 502, code: 'GEMINI_INCOMPLETE' });
    expect(words.listWords(db, { setId: set.id })).toHaveLength(0);
  });

  test('a caller-supplied wordTranslated still wins even when the model returns a non-string for it', async () => {
    const { db, set } = seedDutch();
    const generate = async () => ({
      headword: 'de tafel', partOfSpeech: 'noun', wordTranslated: 12345,
      definitionTranslated: 'میز',
    });
    const created = await generateWordForSet(
      db, set.id,
      { word: 'de tafel', wordTranslated: 'میز', definition: 'table' },
      { generateWordDetails: generate }
    );
    expect(created.wordTranslated).toBe('میز');
  });
});

describe('keepHeadword', () => {
  // The exam page's word list is curated: "de boodschappen" is plural on purpose, and
  // "naar bed gaan" is an expression. Without this flag the model's own normalization
  // turns them into "de boodschap" / "gaan", creating a row the page never asked for and
  // can never mark as added.
  const plural = { wordTranslated: 'خریدها', definition: 'groceries', posHint: 'noun (plural)' };
  const modelSingularises = async () => ({
    headword: 'de boodschap', // the model normalized anyway
    partOfSpeech: 'noun', definitionTranslated: 'خریدهای روزانه',
    example1: 'Ik doe de boodschappen.', example1Translated: 'من خرید می‌کنم.',
    example2: 'De boodschappen zijn duur.', example2Translated: 'خریدها گران هستند.',
    grammar: { article: 'de', plural: 'boodschappen' },
  });

  test('the caller-supplied headword wins over the model\'s normalized one', async () => {
    const { db, set } = seedDutch();
    const created = await generateWordForSet(
      db, set.id,
      { word: 'de boodschappen', keepHeadword: true, ...plural },
      { generateWordDetails: modelSingularises }
    );
    expect(created.word).toBe('de boodschappen');
  });

  test('the duplicate check keys off the caller\'s headword, not the model\'s', async () => {
    const { db, set } = seedDutch();
    const body = { word: 'de boodschappen', keepHeadword: true, ...plural };

    await generateWordForSet(db, set.id, body, { generateWordDetails: modelSingularises });

    // The second attempt's model returns a headword that matches NOTHING in the set, so
    // the 409 can only come from the check testing the CALLER's "de boodschappen".
    const modelDrifts = async () => ({
      headword: 'de inkopen', partOfSpeech: 'noun', definitionTranslated: 'خریدها',
      example1: 'Ik doe de inkopen.', example1Translated: 'من خرید می‌کنم.',
    });
    await expect(generateWordForSet(db, set.id, body, { generateWordDetails: modelDrifts }))
      .rejects.toMatchObject({ status: 409 });
    expect(words.listWords(db, { setId: set.id })).toHaveLength(1);
  });

  test('without the flag the model\'s headword still wins (unchanged behaviour)', async () => {
    const { db, set } = seedDutch();
    const created = await generateWordForSet(
      db, set.id,
      { word: 'de boodschappen', ...plural },
      { generateWordDetails: modelSingularises }
    );
    expect(created.word).toBe('de boodschap');
  });

  test('the prompt stops asking for a headword and drops the singularisation rule', () => {
    const lang = { name: 'Dutch', code: 'nl-NL' };
    const kept = buildPrompt(lang, 'de boodschappen', { ...plural, keepHeadword: true });
    // the LANGUAGE RULES line still names "headword" (it is still Dutch); what must be
    // gone is the REQUEST for the field.
    expect(kept).not.toMatch(/- "headword":/);
    expect(kept).not.toContain('HEADWORD NORMALIZATION');
    expect(kept).not.toContain('a plural noun → its singular');
    expect(kept).toContain('de boodschappen');
    expect(kept).toContain('ALREADY KNOWN');
    // everything the model still owns is still asked for
    expect(kept).toMatch(/- "partOfSpeech"/);
    expect(kept).toMatch(/- "definitionTranslated"/);
    expect(kept).toMatch(/- "example1"/);

    // ...and the default prompt is untouched.
    const plain = buildPrompt(lang, 'boodschappen');
    expect(plain).toContain('HEADWORD NORMALIZATION');
    expect(plain).toMatch(/- "headword": string/);
  });

  test('under keepHeadword the prompt drops the headword-shaping clauses but keeps the grammar-object requirements', () => {
    const lang = { name: 'Dutch', code: 'nl-NL' };
    const kept = buildPrompt(lang, 'de boodschappen', { ...plural, keepHeadword: true });
    // no instruction survives about what FORM the headword must take
    expect(kept).not.toMatch(/headword.*MUST start with its article/);
    expect(kept).not.toMatch(/headword.*is the bare infinitive/);
    // the consequence is spelled out explicitly instead
    expect(kept).toMatch(/"grammar" object and both example sentences must describe/);
    // the grammar-object CONTENT requirements are still present and unchanged
    expect(kept).toContain('{"article": "de" or "het", "plural": "<plural form, WITHOUT the article>"}');
    expect(kept).toContain('FULL conjugation');
    expect(kept).toContain('CRITICAL: each present-tense VALUE is ONLY the conjugated verb');
  });

  test('without keepHeadword the prompt is byte-identical to commit 0083133', () => {
    const lang = { name: 'Dutch', code: 'nl-NL' };
    const prompt = buildPrompt(lang, 'de boodschappen');
    expect(prompt).toBe(SNAPSHOT_0083133_PROMPT);
  });
});
