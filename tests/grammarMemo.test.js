const { openDatabase } = require('../src/db');
const languages = require('../src/services/languages');
const sets = require('../src/services/sets');
const words = require('../src/services/words');
const dutchGrammar = require('../src/services/dutchGrammar');

describe('Dutch verb grammar is memoized by (word, languageCode)', () => {
  function seed() {
    const db = openDatabase(':memory:');
    const lang = languages.createLanguage(db, { name: 'Dutch', code: 'nl-NL' });
    const set = sets.createSet(db, { name: 'S', languageId: lang.id });
    return { db, lang, set };
  }

  test('re-reading the same live-conjugated verb only conjugates once', () => {
    const { db, lang, set } = seed();
    const w = words.createWord(db, { word: 'maken', partOfSpeech: 'verb', languageId: lang.id, wordSetId: set.id });
    const spy = jest.spyOn(dutchGrammar, 'buildVerbGrammar');
    spy.mockClear(); // createWord's own serialize call may have already primed the cache

    const first = words.getWord(db, w.id);
    const second = words.getWord(db, w.id);
    const third = words.listWords(db, { setId: set.id })[0];

    expect(first.grammar.present.ik).toBe('maak');
    expect(second.grammar).toEqual(first.grammar);
    expect(third.grammar).toEqual(first.grammar);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    spy.mockRestore();
  });

  test('a different word is a separate cache entry (not a stale hit)', () => {
    const { db, lang, set } = seed();
    words.createWord(db, { word: 'maken', partOfSpeech: 'verb', languageId: lang.id, wordSetId: set.id });
    const w2 = words.createWord(db, { word: 'lopen', partOfSpeech: 'verb', languageId: lang.id, wordSetId: set.id });
    const grammar = words.getWord(db, w2.id).grammar;
    expect(grammar.present.ik).toBe('loop');
  });
});
