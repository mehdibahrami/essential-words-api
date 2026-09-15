const { openDatabase } = require('../src/db');
const languages = require('../src/services/languages');
const sets = require('../src/services/sets');
const words = require('../src/services/words');
const learning = require('../src/services/learning');

// Seeded through raw SQL rather than words.createWord, because createWord's autoincrement
// ids make id order, insertion order and SQLite's own scan order all the same thing --
// which would let the entire ORDER BY clause be deleted from reviewNext with every
// assertion below still passing. Two things break that tie:
//   * explicit, out-of-order ids (3, 1, 2), and
//   * a nextPracticeDate deliberately opposed to the id, so that the index reviewNext
//     actually scans (idx_words_due, keyed ...nextPracticeDate) hands rows back in 3, 1, 2
//     order and only `id ASC` can turn that into 1, 2, 3.
// Each test therefore scopes by languageId AND setId, which is what selects that index.
const SEED = [
  { id: 3, word: 'een', due: '2020-01-01T00:00:00.000Z' },
  { id: 1, word: 'twee', due: '2020-01-02T00:00:00.000Z' },
  { id: 2, word: 'drie', due: '2020-01-03T00:00:00.000Z' },
];

function seed() {
  const db = openDatabase(':memory:');
  const lang = languages.createLanguage(db, { name: 'Dutch', code: 'nl-NL' });
  const set = sets.createSet(db, { name: 'Basics', languageId: lang.id });
  const insert = db.prepare(
    `INSERT INTO words (id, languageId, wordSetId, word, nextPracticeDate, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const { id, word, due } of SEED) insert.run(id, lang.id, set.id, word, due, due, due);
  // Ascending, so an assertion written as `ids` / `[ids[2], ids[0], ...]` reads as the
  // queue position it is, independent of which word landed on which id.
  const ids = SEED.map((r) => r.id).sort((a, b) => a - b);
  return { db, lang, set, ids };
}

function pin(db, id, at) {
  db.prepare('UPDATE words SET pinnedAt = ? WHERE id = ?').run(at, id);
}

test('an all-unpinned queue is still ordered by id ascending', () => {
  const { db, lang, set, ids } = seed();
  const queue = learning.reviewNext(db, { languageId: lang.id, setId: set.id });
  expect(queue.map((w) => w.id)).toEqual(ids);
});

test('a pinned word leads the queue', () => {
  const { db, lang, set, ids } = seed();
  pin(db, ids[2], '2026-09-15T10:00:00.000Z');
  const queue = learning.reviewNext(db, { languageId: lang.id, setId: set.id });
  expect(queue.map((w) => w.id)).toEqual([ids[2], ids[0], ids[1]]);
});

test('two pinned words sort most-recently-pinned first', () => {
  const { db, lang, set, ids } = seed();
  pin(db, ids[0], '2026-09-15T10:00:00.000Z');
  pin(db, ids[1], '2026-09-15T11:00:00.000Z');
  const queue = learning.reviewNext(db, { languageId: lang.id, setId: set.id });
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
