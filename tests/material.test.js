const { openDatabase } = require('../src/db');
const languages = require('../src/services/languages');
const sets = require('../src/services/sets');
const words = require('../src/services/words');
const drills = require('../src/services/troubleDrills');

function seed() {
  const db = openDatabase(':memory:');
  const lang = languages.createLanguage(db, { name: 'Dutch', code: 'nl-NL' });
  const set = sets.createSet(db, { name: 'S', languageId: lang.id });
  const w = words.createWord(db, {
    word: 'onthouden', wordTranslated: 'to remember', partOfSpeech: 'verb',
    definition: 'to remember', languageId: lang.id, wordSetId: set.id,
  });
  return { db, lang, set, w };
}

const aiFor = (id) => [{
  wordId: id,
  cloze: {
    sentence: 'Ik kan haar naam niet ____.',
    answer: 'onthouden',
    distractors: ['vergeten', 'onthoudt', 'houden'],
    sentenceTranslation: "I can't remember her name.",
  },
  hook: 'on + houden = to hold on to.',
  confusables: ['vergeten'],
}];

test('a cold call generates, and the result is written to word_material', async () => {
  const { db, lang, w } = seed();
  let calls = 0;
  const generate = async () => { calls += 1; return aiFor(w.id); };

  const out = await drills.generateDrills(
    db, { languageId: lang.id, wordIds: [w.id], level: 'A1' }, { generate });

  expect(calls).toBe(1);
  expect(out[0].cloze.answer).toBe('onthouden');

  const row = db.prepare('SELECT * FROM word_material WHERE wordId = ? AND level = ?')
    .get(w.id, 'A1');
  expect(row).toBeTruthy();
  expect(row.clozeAnswer).toBe('onthouden');
  expect(JSON.parse(row.clozeDistractors)).toContain('vergeten');
});

test('a warm call serves from cache and never calls the generator', async () => {
  const { db, lang, w } = seed();
  let calls = 0;
  const generate = async () => { calls += 1; return aiFor(w.id); };

  await drills.generateDrills(db, { languageId: lang.id, wordIds: [w.id], level: 'A1' }, { generate });
  expect(calls).toBe(1);

  const out = await drills.generateDrills(db, { languageId: lang.id, wordIds: [w.id], level: 'A1' }, { generate });
  expect(calls).toBe(1);
  expect(out[0].cloze.answer).toBe('onthouden');
  expect(out[0].sentence).toBe('Ik kan haar naam niet onthouden.');
  expect(out[0].hook).toBe('on + houden = to hold on to.');
  expect(out[0].confusables).toEqual(['vergeten']);
});

test('a different level is a different cache entry', async () => {
  const { db, lang, w } = seed();
  let calls = 0;
  const generate = async () => { calls += 1; return aiFor(w.id); };

  await drills.generateDrills(db, { languageId: lang.id, wordIds: [w.id], level: 'A1' }, { generate });
  await drills.generateDrills(db, { languageId: lang.id, wordIds: [w.id], level: 'B1' }, { generate });
  expect(calls).toBe(2);
});

test('only uncached words are sent to the generator', async () => {
  const { db, lang, set, w } = seed();
  const w2 = words.createWord(db, {
    word: 'dragen', wordTranslated: 'to wear', partOfSpeech: 'verb',
    definition: 'to wear', languageId: lang.id, wordSetId: set.id,
  });

  await drills.generateDrills(db, { languageId: lang.id, wordIds: [w.id], level: 'A1' },
    { generate: async () => aiFor(w.id) });

  let promptedIds = null;
  const generate = async (prompt) => {
    promptedIds = prompt;
    return [{
      wordId: w2.id,
      cloze: { sentence: 'Ik ____ een hoed.', answer: 'draag', distractors: ['draagt', 'dragen', 'droeg'], sentenceTranslation: 'I wear a hat.' },
      hook: null, confusables: [],
    }];
  };

  const out = await drills.generateDrills(
    db, { languageId: lang.id, wordIds: [w.id, w2.id], level: 'A1' }, { generate });

  expect(promptedIds).toContain('dragen');
  expect(promptedIds).not.toContain('onthouden');
  expect(out).toHaveLength(2);
  expect(out.map((d) => d.wordId).sort()).toEqual([w.id, w2.id].sort());
});

test('a fully cached request makes no generator call at all', async () => {
  const { db, lang, w } = seed();
  await drills.generateDrills(db, { languageId: lang.id, wordIds: [w.id], level: 'A1' },
    { generate: async () => aiFor(w.id) });

  const generate = async () => { throw new Error('must not be called'); };
  const out = await drills.generateDrills(
    db, { languageId: lang.id, wordIds: [w.id], level: 'A1' }, { generate });
  expect(out[0].cloze.answer).toBe('onthouden');
});

describe('known-vocabulary constraint', () => {
  function seedWithKnown(db, lang, set, count) {
    const made = [];
    for (let i = 0; i < count; i += 1) {
      const w = words.createWord(db, {
        word: `bekend${i}`, wordTranslated: `known${i}`, partOfSpeech: 'noun',
        definition: `known${i}`, languageId: lang.id, wordSetId: set.id,
      });
      db.prepare('UPDATE words SET leitnerBox = 2 WHERE id = ?').run(w.id);
      made.push(w);
    }
    return made;
  }

  test('the prompt lists known words once the learner has enough of them', async () => {
    const { db, lang, set, w } = seed();
    seedWithKnown(db, lang, set, 12);

    let captured = '';
    const generate = async (prompt) => { captured = prompt; return []; };
    await drills.generateDrills(
      db, { languageId: lang.id, wordIds: [w.id], level: 'A1' }, { generate });

    expect(captured).toContain('bekend0');
    expect(captured).toContain('already knows');
  });

  test('the constraint is omitted when the learner knows almost nothing', async () => {
    const { db, lang, set, w } = seed();
    seedWithKnown(db, lang, set, 3);

    let captured = '';
    const generate = async (prompt) => { captured = prompt; return []; };
    await drills.generateDrills(
      db, { languageId: lang.id, wordIds: [w.id], level: 'A1' }, { generate });

    expect(captured).not.toContain('already knows');
  });

  test('the known list is capped at 80 headwords', () => {
    const { db, lang, set } = seed();
    seedWithKnown(db, lang, set, 100);
    expect(drills.knownWords(db, lang.id).length).toBe(80);
  });

  test('unlearned words (box 0) are not treated as known', () => {
    const { db, lang, set } = seed();
    words.createWord(db, {
      word: 'onbekend', wordTranslated: 'unknown', partOfSpeech: 'noun',
      definition: 'unknown', languageId: lang.id, wordSetId: set.id,
    });
    expect(drills.knownWords(db, lang.id)).not.toContain('onbekend');
  });
});
