'use strict';

/**
 * Dutch (nl-NL) grammar helpers.
 *
 * Present-tense verb conjugation is *computed* from the infinitive so every current
 * and future Dutch verb gets forms with no per-word data entry. Dutch present tense
 * is rule-derivable and strong verbs are regular in the present — only a small set of
 * verbs (zijn, hebben, the modals, and the monosyllabic -aan/-oen/-ien verbs) are
 * irregular, and those live in IRREGULAR_PRESENT with explicit forms.
 *
 * Noun gender (de/het) and plural are lexical, not computable, so they are NOT produced
 * here — they are stored per word in the `grammar` column and merely shaped by
 * buildNounGrammar() for the API DTO.
 */

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
// Long-vowel and other digraphs that are already "long" and must not be doubled again.
const DIGRAPHS = ['aa', 'ee', 'oo', 'uu', 'ie', 'ei', 'ij', 'ou', 'au', 'eu', 'oe', 'ui', 'ai', 'ay', 'oi'];

/**
 * Explicit present-tense forms for irregular verbs, keyed by infinitive.
 * Shape: { ik, jij, hij, wij }. `wij` doubles as jullie/zij (plural = infinitive).
 */
const IRREGULAR_PRESENT = {
  zijn:   { ik: 'ben',  jij: 'bent',  hij: 'is',   wij: 'zijn' },
  hebben: { ik: 'heb',  jij: 'hebt',  hij: 'heeft', wij: 'hebben' },
  kunnen: { ik: 'kan',  jij: 'kunt',  hij: 'kan',  wij: 'kunnen' },
  zullen: { ik: 'zal',  jij: 'zult',  hij: 'zal',  wij: 'zullen' },
  mogen:  { ik: 'mag',  jij: 'mag',   hij: 'mag',  wij: 'mogen' },
  willen: { ik: 'wil',  jij: 'wilt',  hij: 'wil',  wij: 'willen' },
  gaan:   { ik: 'ga',   jij: 'gaat',  hij: 'gaat', wij: 'gaan' },
  staan:  { ik: 'sta',  jij: 'staat', hij: 'staat', wij: 'staan' },
  slaan:  { ik: 'sla',  jij: 'slaat', hij: 'slaat', wij: 'slaan' },
  doen:   { ik: 'doe',  jij: 'doet',  hij: 'doet', wij: 'doen' },
  zien:   { ik: 'zie',  jij: 'ziet',  hij: 'ziet', wij: 'zien' },
  // Regular in pattern but the rule would wrongly double the short vowel, so pin them:
  komen:  { ik: 'kom',  jij: 'komt',  hij: 'komt', wij: 'komen' },
  // Conditional of zullen that appears as a headword in the data.
  zouden: { ik: 'zou',  jij: 'zou',   hij: 'zou',  wij: 'zouden' },
};

/**
 * Present-tense stems (the `ik` form) for otherwise-regular verbs where the spelling
 * rule guesses wrong. These are the unstressed-schwa endings (-eren, -enen, -elen,
 * -igen, -emen): the final vowel is a schwa and must NOT be doubled — but that is not
 * derivable from spelling (cf. `studeren → studeer`, stressed, which the rule gets
 * right). Verified against en.wiktionary conjugation templates. `jij`/`hij`/`wij` are
 * derived normally from these stems.
 */
const STEM_OVERRIDES = {
  luisteren: 'luister', veranderen: 'verander', leveren: 'lever',
  betekenen: 'beteken', openen: 'open', eindigen: 'eindig',
  // Common native schwa verbs (future-proofing beyond the current data set):
  herinneren: 'herinner', rekenen: 'reken', tekenen: 'teken', wandelen: 'wandel',
  ademen: 'adem', verbeteren: 'verbeter', aarzelen: 'aarzel', bewonderen: 'bewonder',
  fluisteren: 'fluister', herhalen: 'herhaal', regenen: 'regen', bedoelen: 'bedoel',
  antwoorden: 'antwoord', beloven: 'beloof',
};

function isConsonant(ch) {
  return /[a-z]/.test(ch) && !VOWELS.has(ch);
}

/** Does `base` end in one of the long digraphs? */
function endsWithDigraph(base) {
  const tail = base.slice(-2);
  return DIGRAPHS.includes(tail);
}

/**
 * Derive the present-tense stem (the `ik` form) from a regular `-en` infinitive,
 * applying Dutch spelling rules: consonant de-doubling, long-vowel doubling in the
 * newly closed syllable, and final v→f / z→s.
 */
function deriveStem(infinitive) {
  let base;
  if (infinitive.endsWith('en')) base = infinitive.slice(0, -2);
  else if (infinitive.endsWith('n')) base = infinitive.slice(0, -1);
  else base = infinitive;

  if (base.length >= 2) {
    const last = base[base.length - 1];
    const prev = base[base.length - 2];
    // 1) Double consonant at the end (pakken -> pakk -> pak): drop one.
    if (isConsonant(last) && last === prev) {
      base = base.slice(0, -1);
    } else if (isConsonant(last)) {
      // 2) Single consonant preceded by a single (short-written, long-sounded) vowel
      //    in what was an open syllable: double the vowel (maken -> mak -> maak).
      const vowel = base[base.length - 2];
      const beforeVowel = base.length >= 3 ? base[base.length - 3] : '';
      const singleVowel = VOWELS.has(vowel) && !endsWithDigraph(base.slice(0, -1));
      // Guard: only when the vowel truly stands alone (not part of a digraph like ie/ou).
      if (singleVowel && !(VOWELS.has(beforeVowel))) {
        base = base.slice(0, -1) + vowel + last;
      }
    }
  }

  // 3) Final consonant softening.
  if (base.endsWith('v')) base = base.slice(0, -1) + 'f';
  else if (base.endsWith('z')) base = base.slice(0, -1) + 's';

  return base;
}

/**
 * Compute present-tense forms for a Dutch infinitive.
 * @returns {{present: {ik,jij,hij,wij}, irregular: boolean} | null}
 */
function computeVerbPresent(infinitiveRaw) {
  if (!infinitiveRaw || typeof infinitiveRaw !== 'string') return null;
  const infinitive = infinitiveRaw.trim().toLowerCase();
  if (!infinitive) return null;

  if (IRREGULAR_PRESENT[infinitive]) {
    return { present: { ...IRREGULAR_PRESENT[infinitive] }, irregular: true };
  }

  // Only genuine `-en` infinitives are safe to conjugate by rule.
  if (!infinitive.endsWith('en')) return null;

  // Verified stem for otherwise-regular verbs the spelling rule mis-derives (schwa).
  const stem = STEM_OVERRIDES[infinitive] || deriveStem(infinitive);
  if (!stem) return null;
  const jijHij = stem.endsWith('t') ? stem : stem + 't';
  return {
    present: { ik: stem, jij: jijHij, hij: jijHij, wij: infinitive },
    irregular: false,
  };
}

/** Build the verb `grammar` object (or null) for a Dutch word. */
function buildVerbGrammar(word) {
  const p = computeVerbPresent(word);
  if (!p) return null;
  return { kind: 'verb', present: p.present, irregular: p.irregular };
}

/**
 * Shape a stored noun grammar record into the API DTO, computing `irregularPlural`
 * when not explicitly provided. Expects at least { article, plural }.
 */
function buildNounGrammar(singular, stored) {
  if (!stored || !stored.article || !stored.plural) return null;
  const article = stored.article === 'het' ? 'het' : 'de';
  const plural = String(stored.plural);
  // The headword includes its article (e.g. "de tafel"); compare bare forms.
  const bareSingular = String(singular || '').replace(/^(de|het)\s+/i, '');
  const barePlural = plural.replace(/^(de|het)\s+/i, '');
  const irregularPlural =
    typeof stored.irregularPlural === 'boolean'
      ? stored.irregularPlural
      : isIrregularPlural(bareSingular, barePlural);
  return { kind: 'noun', article, plural, irregularPlural };
}

/** A plural is "regular" when it is exactly singular + en / + s / + 's (foreign). */
function isIrregularPlural(singular, plural) {
  if (!singular || !plural) return false;
  const s = singular.trim().toLowerCase();
  const p = plural.trim().toLowerCase();
  if (p === s + 's' || p === s + 'en' || p === s + "'s") return false;
  // Doubled-consonant regulars: bal -> ballen, kar -> karren.
  if (p === s + s.slice(-1) + 'en') return false;
  // Long-vowel shortening regulars: maan -> manen, boot -> boten (drop one vowel + en).
  const dedoubled = s.replace(/([aeiou])\1([bcdfghjklmnpqrstvwxz])$/, '$1$2');
  if (dedoubled !== s && (p === dedoubled + 'en')) return false;
  // Final f->v / s->z regulars: brief -> brieven, huis -> huizen.
  if (s.endsWith('f') && p === s.slice(0, -1) + 'ven') return false;
  if (s.endsWith('s') && p === s.slice(0, -1) + 'zen') return false;
  return true;
}

module.exports = {
  computeVerbPresent,
  deriveStem,
  buildVerbGrammar,
  buildNounGrammar,
  isIrregularPlural,
  IRREGULAR_PRESENT,
};
