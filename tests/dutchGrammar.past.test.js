'use strict';

const {
  buildVerbGrammar,
  computeVerbPast,
  IRREGULAR_PAST,
} = require('../src/services/dutchGrammar');

describe('Dutch past tense (OVT + participle)', () => {
  test('every IRREGULAR_PAST entry is returned verbatim by computeVerbPast', () => {
    for (const [inf, entry] of Object.entries(IRREGULAR_PAST)) {
      const got = computeVerbPast(inf);
      expect(got).not.toBeNull();
      expect(got.past.singular).toBe(entry.singular);
      expect(got.past.plural).toBe(entry.plural || entry.singular);
      expect(got.participle || '').toBe(entry.participle || '');
    }
  });

  // Representative verbs across categories: strong, weak, separable, multiword, modal.
  const cases = {
    zijn: { s: 'was', p: 'waren', pp: 'geweest' },
    lopen: { s: 'liep', p: 'liepen', pp: 'gelopen' },
    werken: { s: 'werkte', p: 'werkten', pp: 'gewerkt' },
    wassen: { s: 'waste', p: 'wasten', pp: 'gewassen' }, // weak past, strong participle
    opslaan: { s: 'sloeg op', p: 'sloegen op', pp: 'opgeslagen' },
    opbellen: { s: 'belde op', p: 'belden op', pp: 'opgebeld' },
    'houden van': { s: 'hield van', p: 'hielden van', pp: 'gehouden van' },
    organiseren: { s: 'organiseerde', p: 'organiseerden', pp: 'georganiseerd' },
    verkopen: { s: 'verkocht', p: 'verkochten', pp: 'verkocht' }, // inseparable, no ge-
  };
  for (const [inf, want] of Object.entries(cases)) {
    test(`buildVerbGrammar('${inf}') has correct past + participle`, () => {
      const g = buildVerbGrammar(inf);
      expect(g).not.toBeNull();
      expect(g.past).toEqual({ singular: want.s, plural: want.p });
      expect(g.pastParticiple).toBe(want.pp);
    });
  }

  test('opslaan present tense conjugates (separable fix)', () => {
    const g = buildVerbGrammar('opslaan');
    expect(g.separable).toBe(true);
    expect(g.present.ik).toBe('sla op');
    expect(g.present.hij).toBe('slaat op');
  });

  test('modal with no participle omits pastParticiple', () => {
    const g = buildVerbGrammar('zullen');
    expect(g.past).toEqual({ singular: 'zou', plural: 'zouden' });
    expect(g.pastParticiple).toBeUndefined();
  });

  // Weak-rule fallback for verbs NOT in the table (future additions).
  const fallback = {
    mailen: { s: 'mailde', p: 'mailden', pp: 'gemaild' },
    checken: { s: 'checkte', p: 'checkten', pp: 'gecheckt' },
    verbranden: { s: 'verbrandde', p: 'verbrandden', pp: 'verbrand' }, // ver- => no ge-
  };
  for (const [inf, want] of Object.entries(fallback)) {
    test(`weak fallback computeVerbPast('${inf}')`, () => {
      expect(IRREGULAR_PAST[inf]).toBeUndefined();
      const got = computeVerbPast(inf);
      expect(got.past).toEqual({ singular: want.s, plural: want.p });
      expect(got.participle).toBe(want.pp);
    });
  }
});
