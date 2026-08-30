const { matchesPosFamily, POS_FILTERS } = require('../src/utils/partOfSpeech');
const { makeApp, client } = require('./helpers');

describe('part-of-speech families', () => {
  // The real labels are free text: ~30 distinct values on the live DB, including case
  // variants ("Verb"), qualified forms ("verb (separable)") and combined ones
  // ("Noun / Verb"). Families match on TOKENS, which is what keeps "adverb" out of the
  // verb family — the trap a plain LIKE '%verb%' falls into.
  const cases = [
    ['verb', 'verb', true],
    ['Verb', 'verb', true],
    ['verb (separable)', 'verb', true],
    ['verb (auxiliary)', 'verb', true],
    ['Noun / Verb', 'verb', true],
    ['Noun / Verb', 'noun', true],
    ['adverb', 'verb', false],
    ['adverb', 'adverb', true],
    ['adjective/adverb', 'adjective', true],
    ['adjective/adverb', 'adverb', true],
    ['adv/prep', 'adverb', true],
    ['noun', 'noun', true],
    ['Noun', 'noun', true],
    ['pronoun', 'noun', false],
    ['question word', 'other', true],
    ['preposition', 'other', true],
    ['noun', 'other', false],
    ['verb (separable)', 'other', false],
    ['', 'other', true],
  ];
  test.each(cases)('%s is %s: %s', (label, family, expected) => {
    expect(matchesPosFamily(label, family)).toBe(expected);
  });

  test('exposes the families the app offers', () => {
    expect(POS_FILTERS).toEqual(['verb', 'noun', 'adjective', 'adverb', 'other']);
  });
});

describe('GET /api/review/next?pos=', () => {
  const { app } = makeApp();
  const api = client(app);
  let setId;

  const labels = ['verb', 'Verb', 'verb (separable)', 'adverb', 'noun', 'Noun / Verb', 'preposition'];

  beforeAll(async () => {
    const lang = await api.post('/api/languages').send({ name: 'Dutch', code: 'nl-NL' });
    const set = await api.post('/api/sets').send({ name: 'A2', languageId: lang.body.id });
    setId = set.body.id;
    await api.post(`/api/sets/${setId}/words/bulk`).send({
      words: labels.map((pos, i) => ({
        word: `w${i}`,
        wordTranslated: 'ترجمه',
        partOfSpeech: pos,
        definition: 'd',
      })),
    });
  });

  const posOf = (res) => res.body.map((w) => w.partOfSpeech).sort();

  test('no pos returns every new word', async () => {
    const res = await api.get('/api/review/next');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(labels.length);
  });

  test('pos=verb includes case and qualifier variants, excludes adverb', async () => {
    const res = await api.get('/api/review/next?pos=verb');
    expect(res.status).toBe(200);
    expect(posOf(res)).toEqual(['Noun / Verb', 'Verb', 'verb', 'verb (separable)'].sort());
  });

  test('pos=adverb does not match verbs', async () => {
    const res = await api.get('/api/review/next?pos=adverb');
    expect(posOf(res)).toEqual(['adverb']);
  });

  test('pos=other is everything in no family', async () => {
    const res = await api.get('/api/review/next?pos=other');
    expect(posOf(res)).toEqual(['preposition']);
  });

  test('pos=all is the same as no filter', async () => {
    const res = await api.get('/api/review/next?pos=all');
    expect(res.body).toHaveLength(labels.length);
  });

  test('an unknown pos is a 400, never a silent fallback', async () => {
    const res = await api.get('/api/review/next?pos=gerund');
    expect(res.status).toBe(400);
  });
});
