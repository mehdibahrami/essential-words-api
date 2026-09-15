const { openDatabase } = require('../src/db');
const languages = require('../src/services/languages');
const sets = require('../src/services/sets');
const words = require('../src/services/words');
const learning = require('../src/services/learning');

function seed() {
  const db = openDatabase(':memory:');
  const lang = languages.createLanguage(db, { name: 'Dutch', code: 'nl-NL' });
  const set = sets.createSet(db, { name: 'Basics', languageId: lang.id });
  const ids = ['een', 'twee', 'drie'].map(
    (w) => words.createWord(db, { word: w, languageId: lang.id, wordSetId: set.id }).id
  );
  return { db, lang, set, ids };
}

function pin(db, id, at) {
  db.prepare('UPDATE words SET pinnedAt = ? WHERE id = ?').run(at, id);
}

test('an all-unpinned queue is still ordered by id ascending', () => {
  const { db, set, ids } = seed();
  const queue = learning.reviewNext(db, { setId: set.id });
  expect(queue.map((w) => w.id)).toEqual(ids);
});

test('a pinned word leads the queue', () => {
  const { db, set, ids } = seed();
  pin(db, ids[2], '2026-09-15T10:00:00.000Z');
  const queue = learning.reviewNext(db, { setId: set.id });
  expect(queue.map((w) => w.id)).toEqual([ids[2], ids[0], ids[1]]);
});

test('two pinned words sort most-recently-pinned first', () => {
  const { db, set, ids } = seed();
  pin(db, ids[0], '2026-09-15T10:00:00.000Z');
  pin(db, ids[1], '2026-09-15T11:00:00.000Z');
  const queue = learning.reviewNext(db, { setId: set.id });
  expect(queue.map((w) => w.id)).toEqual([ids[1], ids[0], ids[2]]);
});

test('pinning leads within a part-of-speech filtered queue too', () => {
  const db = openDatabase(':memory:');
  const lang = languages.createLanguage(db, { name: 'Dutch', code: 'nl-NL' });
  const set = sets.createSet(db, { name: 'Basics', languageId: lang.id });
  const a = words.createWord(db, { word: 'lopen', partOfSpeech: 'verb', languageId: lang.id, wordSetId: set.id });
  words.createWord(db, { word: 'het huis', partOfSpeech: 'noun', languageId: lang.id, wordSetId: set.id });
  const c = words.createWord(db, { word: 'maken', partOfSpeech: 'verb', languageId: lang.id, wordSetId: set.id });
  pin(db, c.id, '2026-09-15T10:00:00.000Z');
  const queue = learning.reviewNext(db, { setId: set.id, pos: 'verb' });
  expect(queue.map((w) => w.id)).toEqual([c.id, a.id]);
});

test('a pinned word\'s DTO never exposes pinnedAt', () => {
  const { db, ids } = seed();
  pin(db, ids[0], '2026-09-15T10:00:00.000Z');
  const dto = words.getWord(db, ids[0]);
  expect(dto).not.toHaveProperty('pinnedAt');
});
