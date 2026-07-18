const g = require('../src/services/dutchGrammar');

describe('computeVerbPresent — regular spelling rules', () => {
  const cases = {
    maken:   { ik: 'maak', jij: 'maakt', hij: 'maakt', wij: 'maken' },   // long-vowel doubling
    werken:  { ik: 'werk', jij: 'werkt', hij: 'werkt', wij: 'werken' },  // consonant cluster, no doubling
    pakken:  { ik: 'pak',  jij: 'pakt',  hij: 'pakt',  wij: 'pakken' },  // consonant de-doubling
    leven:   { ik: 'leef', jij: 'leeft', hij: 'leeft', wij: 'leven' },   // v -> f (+ doubling)
    reizen:  { ik: 'reis', jij: 'reist', hij: 'reist', wij: 'reizen' },  // z -> s
    lopen:   { ik: 'loop', jij: 'loopt', hij: 'loopt', wij: 'lopen' },
    eten:    { ik: 'eet',  jij: 'eet',   hij: 'eet',   wij: 'eten' },    // stem ends in t -> no extra t
    antwoorden: { ik: 'antwoord', jij: 'antwoordt', hij: 'antwoordt', wij: 'antwoorden' },
  };
  for (const [inf, expected] of Object.entries(cases)) {
    test(inf, () => {
      const r = g.computeVerbPresent(inf);
      expect(r).not.toBeNull();
      expect(r.irregular).toBe(false);
      expect(r.present).toEqual(expected);
    });
  }
});

describe('computeVerbPresent — schwa overrides (must NOT double)', () => {
  test.each([
    ['luisteren', 'luister'],
    ['veranderen', 'verander'],
    ['betekenen', 'beteken'],
    ['openen', 'open'],
    ['eindigen', 'eindig'],
    ['leveren', 'lever'],
  ])('%s -> ik %s', (inf, ik) => {
    expect(g.computeVerbPresent(inf).present.ik).toBe(ik);
  });
});

describe('computeVerbPresent — irregular map', () => {
  test('zijn', () => {
    expect(g.computeVerbPresent('zijn')).toEqual({
      present: { ik: 'ben', jij: 'bent', hij: 'is', wij: 'zijn' }, irregular: true,
    });
  });
  test('hebben', () => {
    expect(g.computeVerbPresent('hebben').present).toEqual({
      ik: 'heb', jij: 'hebt', hij: 'heeft', wij: 'hebben',
    });
  });
  test('komen is pinned (no vowel doubling)', () => {
    expect(g.computeVerbPresent('komen').present.ik).toBe('kom');
  });
});

describe('computeVerbPresent — separable verbs', () => {
  test.each([
    ['meenemen', 'neem mee', 'nemen mee'],
    ['opstaan', 'sta op', 'staan op'],
    ['aanbieden', 'bied aan', 'bieden aan'],
    ['afrekenen', 'reken af', 'rekenen af'],   // schwa root
    ['neerzetten', 'zet neer', 'zetten neer'], // stem ends in t
    ['doorgeven', 'geef door', 'geven door'],
  ])('%s -> ik %s / wij %s', (inf, ik, wij) => {
    const r = g.computeVerbPresent(inf);
    expect(r.separable).toBe(true);
    expect(r.present.ik).toBe(ik);
    expect(r.present.wij).toBe(wij);
  });

  test('trailing particle kept (omgaan met)', () => {
    expect(g.computeVerbPresent('omgaan met').present.ik).toBe('ga om met');
  });

  test('buildVerbGrammar marks separable', () => {
    expect(g.buildVerbGrammar('uitleggen')).toEqual({
      kind: 'verb', irregular: false, separable: true,
      present: { ik: 'leg uit', jij: 'legt uit', hij: 'legt uit', wij: 'leggen uit' },
      past: { singular: 'legde uit', plural: 'legden uit' }, pastParticiple: 'uitgelegd',
    });
  });

  test('lookalike non-separable verbs are not split', () => {
    // openen/bijten start with a prefix but are not separable.
    expect(g.computeVerbPresent('openen').present.ik).toBe('open');
    expect(g.computeVerbPresent('bijten').present.ik).toBe('bijt');
  });
});

describe('computeVerbPresent — guards', () => {
  test('non-infinitive returns null', () => {
    expect(g.computeVerbPresent('geef')).toBeNull();
    expect(g.computeVerbPresent('')).toBeNull();
    expect(g.computeVerbPresent(null)).toBeNull();
  });
});

describe('buildNounGrammar', () => {
  test('regular plural', () => {
    expect(g.buildNounGrammar('tafel', { article: 'de', plural: 'tafels' })).toEqual({
      kind: 'noun', article: 'de', plural: 'tafels', irregularPlural: false,
    });
  });
  test('irregular plural flagged', () => {
    expect(g.buildNounGrammar('kind', { article: 'het', plural: 'kinderen' }).irregularPlural).toBe(true);
    expect(g.buildNounGrammar('stad', { article: 'de', plural: 'steden' }).irregularPlural).toBe(true);
  });
  test('long-vowel-shortening plural is regular', () => {
    expect(g.buildNounGrammar('maan', { article: 'de', plural: 'manen' }).irregularPlural).toBe(false);
  });
  test('f->v plural is regular', () => {
    expect(g.buildNounGrammar('brief', { article: 'de', plural: 'brieven' }).irregularPlural).toBe(false);
  });
  test('missing data returns null', () => {
    expect(g.buildNounGrammar('x', { article: 'de' })).toBeNull();
  });
  test('article-prefixed headword is stripped before regularity check', () => {
    // The stored word text includes its article ("de tafel"); tafels is still regular.
    expect(g.buildNounGrammar('de tafel', { article: 'de', plural: 'tafels' }).irregularPlural).toBe(false);
    expect(g.buildNounGrammar('het huis', { article: 'het', plural: 'huizen' }).irregularPlural).toBe(false);
    expect(g.buildNounGrammar('het kind', { article: 'het', plural: 'kinderen' }).irregularPlural).toBe(true);
  });
});
