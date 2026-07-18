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

/**
 * Separable verbs: the prefix detaches and moves to the end of the clause in the present
 * tense (meenemen -> "ik neem mee"). Separability is lexical (openen, bijten are NOT
 * separable despite matching a prefix), so we gate on an explicit SEPARABLE_VERBS set and
 * only then split by the longest matching prefix. Add new separable verbs here.
 */
const SEPARABLE_PREFIXES = [
  'tegemoet', 'achterna', 'samen', 'binnen', 'terug', 'verder', 'tegen', 'langs', 'schoon',
  'achter', 'tussen', 'boven', 'dicht', 'open', 'thuis', 'onder', 'klaar', 'vast',
  'voor', 'over', 'door', 'neer', 'mee', 'weg', 'uit', 'toe', 'aan', 'los',
  'op', 'af', 'in', 'om', 'na', 'bij', 'uiteen',
].sort((a, b) => b.length - a.length);

const SEPARABLE_VERBS = new Set([
  'meenemen', 'samenwerken', 'weggaan', 'uitleggen', 'doorgaan', 'opstaan', 'terugkomen',
  'ophalen', 'oplossen', 'binnenkomen', 'afspreken', 'aankomen', 'uitgaan', 'aanbieden',
  'ingaan', 'opbellen', 'schoonmaken', 'dichtdoen', 'opendoen', 'samenwonen', 'inleveren',
  'afwassen', 'weggooien', 'instappen', 'uitstappen', 'wegbrengen', 'oversteken', 'afgaan',
  'tegenkomen', 'verdergaan', 'afrekenen', 'afmaken', 'afstuderen', 'doorgeven', 'langskomen',
  'meebrengen', 'meedoen', 'meegeven', 'meekomen', 'meekijken', 'neerleggen', 'neerzetten',
  'omgaan', 'opschrijven', 'meelopen', 'opbellen', 'uitzoeken', 'aanraden', 'meenemen',
  'opslaan',
]);

/**
 * Conjugate a separable verb: split off the prefix, conjugate the root normally, then
 * place the prefix at the end (and any trailing particle, e.g. "omgaan met").
 * @returns {{present, irregular, separable:true} | null}
 */
function conjugateSeparable(infinitive) {
  const [firstWord, ...rest] = infinitive.split(/\s+/);
  const particle = rest.length ? ' ' + rest.join(' ') : '';
  const prefix = SEPARABLE_PREFIXES.find(
    (p) => firstWord.startsWith(p) && firstWord.length - p.length >= 3
  );
  if (!prefix) return null;
  const root = firstWord.slice(prefix.length);
  const rootForms = computeVerbPresent(root);
  if (!rootForms) return null;
  const tail = `${prefix}${particle}`;
  const p = rootForms.present;
  return {
    present: {
      ik: `${p.ik} ${tail}`,
      jij: `${p.jij} ${tail}`,
      hij: `${p.hij} ${tail}`,
      wij: `${p.wij} ${tail}`,
    },
    irregular: rootForms.irregular,
    separable: true,
  };
}

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

  // Separable verbs first (gated on the explicit set to avoid false splits).
  const firstWord = infinitive.split(/\s+/)[0];
  if (SEPARABLE_VERBS.has(firstWord)) {
    const sep = conjugateSeparable(infinitive);
    if (sep) return sep;
  }

  if (IRREGULAR_PRESENT[infinitive]) {
    return { present: { ...IRREGULAR_PRESENT[infinitive] }, irregular: true };
  }

  // Verb + fixed preposition (e.g. "houden van", "wachten op"): conjugate the verb head
  // and carry the preposition along. Separable heads are handled above; this is the
  // non-separable multiword case.
  const parts = infinitive.split(/\s+/);
  if (parts.length > 1) {
    const head = computeVerbPresent(parts[0]);
    if (head) {
      const tail = ' ' + parts.slice(1).join(' ');
      return {
        present: {
          ik: head.present.ik + tail,
          jij: head.present.jij + tail,
          hij: head.present.hij + tail,
          wij: head.present.wij + tail,
        },
        irregular: head.irregular,
      };
    }
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

/**
 * Explicit past tense (OVT) + past participle, keyed by infinitive.
 * Shape: { singular, plural, participle }. `singular` is the ik/jij/hij OVT form,
 * `plural` the wij/jullie/zij form, `participle` the voltooid deelwoord.
 *
 * Unlike the present tense, the Dutch past is NOT reliably rule-derivable: strong verbs
 * change their stem vowel (lopen→liep, nemen→nam) and even many "weak" verbs have an
 * irregular participle (wassen→gewassen), so these are lexical and pinned here — the same
 * approach as IRREGULAR_PRESENT, just larger. Every verb currently in the DB is listed;
 * regular future verbs fall back to computeWeakPast(). Separable verbs keep the prefix at
 * the end of the OVT (opstaan→"stond op") and re-insert ge- inside the participle
 * (opgestaan). Sourced from the A2 exam vocabulary (authoritative) + verified generation.
 */
const IRREGULAR_PAST = {
  'aanbieden': { singular: 'bood aan', plural: 'boden aan', participle: 'aangeboden' },
  'aankomen': { singular: 'kwam aan', plural: 'kwamen aan', participle: 'aangekomen' },
  'aanmelden': { singular: 'meldde aan', plural: 'meldden aan', participle: 'aangemeld' },
  'aanvragen': { singular: 'vroeg aan', plural: 'vroegen aan', participle: 'aangevraagd' },
  'accepteren': { singular: 'accepteerde', plural: 'accepteerden', participle: 'geaccepteerd' },
  'afgaan': { singular: 'ging af', plural: 'gingen af', participle: 'afgegaan' },
  'afmaken': { singular: 'maakte af', plural: 'maakten af', participle: 'afgemaakt' },
  'afmelden': { singular: 'meldde af', plural: 'meldden af', participle: 'afgemeld' },
  'afrekenen': { singular: 'rekende af', plural: 'rekenden af', participle: 'afgerekend' },
  'afspreken': { singular: 'sprak af', plural: 'spraken af', participle: 'afgesproken' },
  'afstuderen': { singular: 'studeerde af', plural: 'studeerden af', participle: 'afgestudeerd' },
  'afwassen': { singular: 'waste af', plural: 'wasten af', participle: 'afgewassen' },
  'afzeggen': { singular: 'zei af', plural: 'zeiden af', participle: 'afgezegd' },
  'annuleren': { singular: 'annuleerde', plural: 'annuleerden', participle: 'geannuleerd' },
  'antwoorden': { singular: 'antwoordde', plural: 'antwoordden', participle: 'geantwoord' },
  'bakken': { singular: 'bakte', plural: 'bakten', participle: 'gebakken' },
  'bedoelen': { singular: 'bedoelde', plural: 'bedoelden', participle: 'bedoeld' },
  'beginnen': { singular: 'begon', plural: 'begonnen', participle: 'begonnen' },
  'begrijpen': { singular: 'begreep', plural: 'begrepen', participle: 'begrepen' },
  'bellen': { singular: 'belde', plural: 'belden', participle: 'gebeld' },
  'beschrijven': { singular: 'beschreef', plural: 'beschreven', participle: 'beschreven' },
  'beslissen': { singular: 'besliste', plural: 'beslisten', participle: 'beslist' },
  'besluiten': { singular: 'besloot', plural: 'besloten', participle: 'besloten' },
  'bespreken': { singular: 'besprak', plural: 'bespraken', participle: 'besproken' },
  'bestellen': { singular: 'bestelde', plural: 'bestelden', participle: 'besteld' },
  'betalen': { singular: 'betaalde', plural: 'betaalden', participle: 'betaald' },
  'betekenen': { singular: 'betekende', plural: 'betekenden', participle: 'betekend' },
  'bewegen': { singular: 'bewoog', plural: 'bewogen', participle: 'bewogen' },
  'bezoeken': { singular: 'bezocht', plural: 'bezochten', participle: 'bezocht' },
  'bezorgen': { singular: 'bezorgde', plural: 'bezorgden', participle: 'bezorgd' },
  'beïnvloeden': { singular: 'beïnvloedde', plural: 'beïnvloedden', participle: 'beïnvloed' },
  'bijten': { singular: 'beet', plural: 'beten', participle: 'gebeten' },
  'binnenkomen': { singular: 'kwam binnen', plural: 'kwamen binnen', participle: 'binnengekomen' },
  'blijven': { singular: 'bleef', plural: 'bleven', participle: 'gebleven' },
  'breken': { singular: 'brak', plural: 'braken', participle: 'gebroken' },
  'brengen': { singular: 'bracht', plural: 'brachten', participle: 'gebracht' },
  'controleren': { singular: 'controleerde', plural: 'controleerden', participle: 'gecontroleerd' },
  'danken': { singular: 'dankte', plural: 'dankten', participle: 'gedankt' },
  'dansen': { singular: 'danste', plural: 'dansten', participle: 'gedanst' },
  'denken': { singular: 'dacht', plural: 'dachten', participle: 'gedacht' },
  'dichtdoen': { singular: 'deed dicht', plural: 'deden dicht', participle: 'dichtgedaan' },
  'doen': { singular: 'deed', plural: 'deden', participle: 'gedaan' },
  'doorgaan': { singular: 'ging door', plural: 'gingen door', participle: 'doorgegaan' },
  'doorgeven': { singular: 'gaf door', plural: 'gaven door', participle: 'doorgegeven' },
  'doorsturen': { singular: 'stuurde door', plural: 'stuurden door', participle: 'doorgestuurd' },
  'dragen': { singular: 'droeg', plural: 'droegen', participle: 'gedragen' },
  'drinken': { singular: 'dronk', plural: 'dronken', participle: 'gedronken' },
  'dromen': { singular: 'droomde', plural: 'droomden', participle: 'gedroomd' },
  'duren': { singular: 'duurde', plural: 'duurden', participle: 'geduurd' },
  'eindigen': { singular: 'eindigde', plural: 'eindigden', participle: 'geëindigd' },
  'eten': { singular: 'at', plural: 'aten', participle: 'gegeten' },
  'feliciteren': { singular: 'feliciteerde', plural: 'feliciteerden', participle: 'gefeliciteerd' },
  'fietsen': { singular: 'fietste', plural: 'fietsten', participle: 'gefietst' },
  'formuleren': { singular: 'formuleerde', plural: 'formuleerden', participle: 'geformuleerd' },
  'gaan': { singular: 'ging', plural: 'gingen', participle: 'gegaan' },
  'gebeuren': { singular: 'gebeurde', plural: 'gebeurden', participle: 'gebeurd' },
  'gebruiken': { singular: 'gebruikte', plural: 'gebruikten', participle: 'gebruikt' },
  'geef': { singular: 'gaf', plural: 'gaven', participle: 'gegeven' },
  'geven': { singular: 'gaf', plural: 'gaven', participle: 'gegeven' },
  'groeien': { singular: 'groeide', plural: 'groeiden', participle: 'gegroeid' },
  'halen': { singular: 'haalde', plural: 'haalden', participle: 'gehaald' },
  'hebben': { singular: 'had', plural: 'hadden', participle: 'gehad' },
  'helpen': { singular: 'hielp', plural: 'hielpen', participle: 'geholpen' },
  'herhalen': { singular: 'herhaalde', plural: 'herhaalden', participle: 'herhaald' },
  'heten': { singular: 'heette', plural: 'heetten', participle: 'geheten' },
  'hoesten': { singular: 'hoestte', plural: 'hoestten', participle: 'gehoest' },
  'hoeven': { singular: 'hoefde', plural: 'hoefden', participle: 'gehoeven' },
  'hopen': { singular: 'hoopte', plural: 'hoopten', participle: 'gehoopt' },
  'horen': { singular: 'hoorde', plural: 'hoorden', participle: 'gehoord' },
  'houden': { singular: 'hield', plural: 'hielden', participle: 'gehouden' },
  'houden van': { singular: 'hield van', plural: 'hielden van', participle: 'gehouden van' },
  'huren': { singular: 'huurde', plural: 'huurden', participle: 'gehuurd' },
  'inchecken': { singular: 'checkte in', plural: 'checkten in', participle: 'ingecheckt' },
  'ingaan': { singular: 'ging in', plural: 'gingen in', participle: 'ingegaan' },
  'inleveren': { singular: 'leverde in', plural: 'leverden in', participle: 'ingeleverd' },
  'instappen': { singular: 'stapte in', plural: 'stapten in', participle: 'ingestapt' },
  'interesseren': { singular: 'interesseerde', plural: 'interesseerden', participle: 'geïnteresseerd' },
  'invullen': { singular: 'vulde in', plural: 'vulden in', participle: 'ingevuld' },
  'kennen': { singular: 'kende', plural: 'kenden', participle: 'gekend' },
  'kiezen': { singular: 'koos', plural: 'kozen', participle: 'gekozen' },
  'kijken': { singular: 'keek', plural: 'keken', participle: 'gekeken' },
  'klagen': { singular: 'klaagde', plural: 'klaagden', participle: 'geklaagd' },
  'klimmen': { singular: 'klom', plural: 'klommen', participle: 'geklommen' },
  'koken': { singular: 'kookte', plural: 'kookten', participle: 'gekookt' },
  'komen': { singular: 'kwam', plural: 'kwamen', participle: 'gekomen' },
  'kopen': { singular: 'kocht', plural: 'kochten', participle: 'gekocht' },
  'kosten': { singular: 'kostte', plural: 'kostten', participle: 'gekost' },
  'krijgen': { singular: 'kreeg', plural: 'kregen', participle: 'gekregen' },
  'kunnen': { singular: 'kon', plural: 'konden', participle: 'gekund' },
  'lachen': { singular: 'lachte', plural: 'lachten', participle: 'gelachen' },
  'langskomen': { singular: 'kwam langs', plural: 'kwamen langs', participle: 'langsgekomen' },
  'laten': { singular: 'liet', plural: 'lieten', participle: 'gelaten' },
  'leggen': { singular: 'legde', plural: 'legden', participle: 'gelegd' },
  'leiden': { singular: 'leidde', plural: 'leidden', participle: 'geleid' },
  'lenen': { singular: 'leende', plural: 'leenden', participle: 'geleend' },
  'leren': { singular: 'leerde', plural: 'leerden', participle: 'geleerd' },
  'leven': { singular: 'leefde', plural: 'leefden', participle: 'geleefd' },
  'leveren': { singular: 'leverde', plural: 'leverden', participle: 'geleverd' },
  'lezen': { singular: 'las', plural: 'lazen', participle: 'gelezen' },
  'liggen': { singular: 'lag', plural: 'lagen', participle: 'gelegen' },
  'lijken': { singular: 'leek', plural: 'leken', participle: 'geleken' },
  'lopen': { singular: 'liep', plural: 'liepen', participle: 'gelopen' },
  'luisteren': { singular: 'luisterde', plural: 'luisterden', participle: 'geluisterd' },
  'lukken': { singular: 'lukte', plural: 'lukten', participle: 'gelukt' },
  'maken': { singular: 'maakte', plural: 'maakten', participle: 'gemaakt' },
  'meebrengen': { singular: 'bracht mee', plural: 'brachten mee', participle: 'meegebracht' },
  'meedoen': { singular: 'deed mee', plural: 'deden mee', participle: 'meegedaan' },
  'meegeven': { singular: 'gaf mee', plural: 'gaven mee', participle: 'meegegeven' },
  'meekijken': { singular: 'keek mee', plural: 'keken mee', participle: 'meegekeken' },
  'meekomen': { singular: 'kwam mee', plural: 'kwamen mee', participle: 'meegekomen' },
  'meenemen': { singular: 'nam mee', plural: 'namen mee', participle: 'meegenomen' },
  'menen': { singular: 'meende', plural: 'meenden', participle: 'gemeend' },
  'missen': { singular: 'miste', plural: 'misten', participle: 'gemist' },
  'moeten': { singular: 'moest', plural: 'moesten', participle: 'gemoeten' },
  'mogen': { singular: 'mocht', plural: 'mochten', participle: 'gemogen' },
  'neerleggen': { singular: 'legde neer', plural: 'legden neer', participle: 'neergelegd' },
  'neerzetten': { singular: 'zette neer', plural: 'zetten neer', participle: 'neergezet' },
  'nemen': { singular: 'nam', plural: 'namen', participle: 'genomen' },
  'omgaan met': { singular: 'ging om', plural: 'gingen om', participle: 'omgegaan' },
  'ondertekenen': { singular: 'ondertekende', plural: 'ondertekenden', participle: 'ondertekend' },
  'ontbreken': { singular: 'ontbrak', plural: 'ontbraken', participle: 'ontbroken' },
  'onthouden': { singular: 'onthield', plural: 'onthielden', participle: 'onthouden' },
  'ontmoeten': { singular: 'ontmoette', plural: 'ontmoetten', participle: 'ontmoet' },
  'ontvangen': { singular: 'ontving', plural: 'ontvingen', participle: 'ontvangen' },
  'opbellen': { singular: 'belde op', plural: 'belden op', participle: 'opgebeld' },
  'opendoen': { singular: 'deed open', plural: 'deden open', participle: 'opengedaan' },
  'openen': { singular: 'opende', plural: 'openden', participle: 'geopend' },
  'ophalen': { singular: 'haalde op', plural: 'haalden op', participle: 'opgehaald' },
  'oplossen': { singular: 'loste op', plural: 'losten op', participle: 'opgelost' },
  'opschrijven': { singular: 'schreef op', plural: 'schreven op', participle: 'opgeschreven' },
  'opslaan': { singular: 'sloeg op', plural: 'sloegen op', participle: 'opgeslagen' },
  'opstaan': { singular: 'stond op', plural: 'stonden op', participle: 'opgestaan' },
  'organiseren': { singular: 'organiseerde', plural: 'organiseerden', participle: 'georganiseerd' },
  'overmaken': { singular: 'maakte over', plural: 'maakten over', participle: 'overgemaakt' },
  'overstappen': { singular: 'stapte over', plural: 'stapten over', participle: 'overgestapt' },
  'oversteken': { singular: 'stak over', plural: 'staken over', participle: 'overgestoken' },
  'pakken': { singular: 'pakte', plural: 'pakten', participle: 'gepakt' },
  'parkeren': { singular: 'parkeerde', plural: 'parkeerden', participle: 'geparkeerd' },
  'passen': { singular: 'paste', plural: 'pasten', participle: 'gepast' },
  'passeren': { singular: 'passeerde', plural: 'passeerden', participle: 'gepasseerd' },
  'pinnen': { singular: 'pinde', plural: 'pinden', participle: 'gepind' },
  'plaatsen': { singular: 'plaatste', plural: 'plaatsten', participle: 'geplaatst' },
  'praten': { singular: 'praatte', plural: 'praatten', participle: 'gepraat' },
  'proberen': { singular: 'probeerde', plural: 'probeerden', participle: 'geprobeerd' },
  'produceren': { singular: 'produceerde', plural: 'produceerden', participle: 'geproduceerd' },
  'publiceren': { singular: 'publiceerde', plural: 'publiceerden', participle: 'gepubliceerd' },
  'reageren': { singular: 'reageerde', plural: 'reageerden', participle: 'gereageerd' },
  'realiseren': { singular: 'realiseerde', plural: 'realiseerden', participle: 'gerealiseerd' },
  'regelen': { singular: 'regelde', plural: 'regelden', participle: 'geregeld' },
  'regenen': { singular: 'regende', plural: 'regende', participle: 'geregend' },
  'reizen': { singular: 'reisde', plural: 'reisden', participle: 'gereisd' },
  'rennen': { singular: 'rende', plural: 'renden', participle: 'gerend' },
  'repareren': { singular: 'repareerde', plural: 'repareerden', participle: 'gerepareerd' },
  'reserveren': { singular: 'reserveerde', plural: 'reserveerden', participle: 'gereserveerd' },
  'rijden': { singular: 'reed', plural: 'reden', participle: 'gereden' },
  'ruiken': { singular: 'rook', plural: 'roken', participle: 'geroken' },
  'ruilen': { singular: 'ruilde', plural: 'ruilden', participle: 'geruild' },
  'rusten': { singular: 'rustte', plural: 'rustten', participle: 'gerust' },
  'samenwerken': { singular: 'werkte samen', plural: 'werkten samen', participle: 'samengewerkt' },
  'samenwonen': { singular: 'woonde samen', plural: 'woonden samen', participle: 'samengewoond' },
  'schoonmaken': { singular: 'maakte schoon', plural: 'maakten schoon', participle: 'schoongemaakt' },
  'schrijven': { singular: 'schreef', plural: 'schreven', participle: 'geschreven' },
  'slapen': { singular: 'sliep', plural: 'sliepen', participle: 'geslapen' },
  'sluiten': { singular: 'sloot', plural: 'sloten', participle: 'gesloten' },
  'snijden': { singular: 'sneed', plural: 'sneden', participle: 'gesneden' },
  'solliciteren': { singular: 'solliciteerde', plural: 'solliciteerden', participle: 'gesolliciteerd' },
  'sparen': { singular: 'spaarde', plural: 'spaarden', participle: 'gespaard' },
  'spelen': { singular: 'speelde', plural: 'speelden', participle: 'gespeeld' },
  'sporten': { singular: 'sportte', plural: 'sportten', participle: 'gesport' },
  'spreken': { singular: 'sprak', plural: 'spraken', participle: 'gesproken' },
  'staan': { singular: 'stond', plural: 'stonden', participle: 'gestaan' },
  'stappen': { singular: 'stapte', plural: 'stapten', participle: 'gestapt' },
  'stoppen': { singular: 'stopte', plural: 'stopten', participle: 'gestopt' },
  'studeren': { singular: 'studeerde', plural: 'studeerden', participle: 'gestudeerd' },
  'sturen': { singular: 'stuurde', plural: 'stuurden', participle: 'gestuurd' },
  'tegenkomen': { singular: 'kwam tegen', plural: 'kwamen tegen', participle: 'tegengekomen' },
  'terugbrengen': { singular: 'bracht terug', plural: 'brachten terug', participle: 'teruggebracht' },
  'terugkomen': { singular: 'kwam terug', plural: 'kwamen terug', participle: 'teruggekomen' },
  'trouwen': { singular: 'trouwde', plural: 'trouwden', participle: 'getrouwd' },
  'uitchecken': { singular: 'checkte uit', plural: 'checkten uit', participle: 'uitgecheckt' },
  'uitgaan': { singular: 'ging uit', plural: 'gingen uit', participle: 'uitgegaan' },
  'uitleggen': { singular: 'legde uit', plural: 'legden uit', participle: 'uitgelegd' },
  'uitnodigen': { singular: 'nodigde uit', plural: 'nodigden uit', participle: 'uitgenodigd' },
  'uitstappen': { singular: 'stapte uit', plural: 'stapten uit', participle: 'uitgestapt' },
  'vallen': { singular: 'viel', plural: 'vielen', participle: 'gevallen' },
  'vechten': { singular: 'vocht', plural: 'vochten', participle: 'gevochten' },
  'veranderen': { singular: 'veranderde', plural: 'veranderden', participle: 'veranderd' },
  'verbieden': { singular: 'verbood', plural: 'verboden', participle: 'verboden' },
  'verdergaan': { singular: 'ging verder', plural: 'gingen verder', participle: 'verdergegaan' },
  'verdienen': { singular: 'verdiende', plural: 'verdienden', participle: 'verdiend' },
  'verdwalen': { singular: 'verdwaalde', plural: 'verdwaalden', participle: 'verdwaald' },
  'vergeten': { singular: 'vergat', plural: 'vergaten', participle: 'vergeten' },
  'verhuizen': { singular: 'verhuisde', plural: 'verhuisden', participle: 'verhuisd' },
  'verkopen': { singular: 'verkocht', plural: 'verkochten', participle: 'verkocht' },
  'verlengen': { singular: 'verlengde', plural: 'verlengden', participle: 'verlengd' },
  'verliezen': { singular: 'verloor', plural: 'verloren', participle: 'verloren' },
  'verspreiden': { singular: 'verspreidde', plural: 'verspreidden', participle: 'verspreid' },
  'vertellen': { singular: 'vertelde', plural: 'vertelden', participle: 'verteld' },
  'vertrekken': { singular: 'vertrok', plural: 'vertrokken', participle: 'vertrokken' },
  'vervullen': { singular: 'vervulde', plural: 'vervulden', participle: 'vervuld' },
  'vieren': { singular: 'vierde', plural: 'vierden', participle: 'gevierd' },
  'vinden': { singular: 'vond', plural: 'vonden', participle: 'gevonden' },
  'vliegen': { singular: 'vloog', plural: 'vlogen', participle: 'gevlogen' },
  'vluchten': { singular: 'vluchtte', plural: 'vluchtten', participle: 'gevlucht' },
  'voelen': { singular: 'voelde', plural: 'voelden', participle: 'gevoeld' },
  'volgen': { singular: 'volgde', plural: 'volgden', participle: 'gevolgd' },
  'vragen': { singular: 'vroeg', plural: 'vroegen', participle: 'gevraagd' },
  'vullen': { singular: 'vulde', plural: 'vulden', participle: 'gevuld' },
  'wachten': { singular: 'wachtte', plural: 'wachtten', participle: 'gewacht' },
  'wassen': { singular: 'waste', plural: 'wasten', participle: 'gewassen' },
  'wegbrengen': { singular: 'bracht weg', plural: 'brachten weg', participle: 'weggebracht' },
  'weggaan': { singular: 'ging weg', plural: 'gingen weg', participle: 'weggegaan' },
  'weggooien': { singular: 'gooide weg', plural: 'gooiden weg', participle: 'weggegooid' },
  'wensen': { singular: 'wenste', plural: 'wensten', participle: 'gewenst' },
  'werken': { singular: 'werkte', plural: 'werkten', participle: 'gewerkt' },
  'weten': { singular: 'wist', plural: 'wisten', participle: 'geweten' },
  'willen': { singular: 'wilde/wou', plural: 'wilden/wouden', participle: 'gewild' },
  'winnen': { singular: 'won', plural: 'wonnen', participle: 'gewonnen' },
  'wonen': { singular: 'woonde', plural: 'woonden', participle: 'gewoond' },
  'worden': { singular: 'werd', plural: 'werden', participle: 'geworden' },
  'zeggen': { singular: 'zei', plural: 'zeiden', participle: 'gezegd' },
  'zenden': { singular: 'zond', plural: 'zonden', participle: 'gezonden' },
  'zetten': { singular: 'zette', plural: 'zetten', participle: 'gezet' },
  'zien': { singular: 'zag', plural: 'zagen', participle: 'gezien' },
  'zijn': { singular: 'was', plural: 'waren', participle: 'geweest' },
  'zingen': { singular: 'zong', plural: 'zongen', participle: 'gezongen' },
  'zitten': { singular: 'zat', plural: 'zaten', participle: 'gezeten' },
  'zoeken': { singular: 'zocht', plural: 'zochten', participle: 'gezocht' },
  'zorgen': { singular: 'zorgde', plural: 'zorgden', participle: 'gezorgd' },
  'zouden': { singular: 'zou', plural: 'zouden', participle: '' },
  'zullen': { singular: 'zou', plural: 'zouden', participle: '' },
};

/** Voiceless consonants for 't kofschip (decides -te/-t vs -de/-d in weak verbs). */
const KOFSCHIP = new Set(['t', 'k', 'f', 's', 'p', 'x', 'c']);

/**
 * Weak (regular) past tense, used ONLY as a fallback for verbs not in IRREGULAR_PAST so a
 * *new* Dutch verb still gets past forms with no data entry (mirrors computeVerbPresent).
 * Best-effort: single-word regular verbs only; separable/phrasal verbs need the table.
 * @returns {{singular, plural, participle} | null}
 */
function computeWeakPast(infinitive) {
  const inf = infinitive.trim().toLowerCase();
  if (!inf || inf.includes(' ')) return null;
  const pres = computeVerbPresent(inf);
  if (!pres || pres.separable) return null;
  const stem = pres.present.ik; // spelling-correct stem, with v→f / z→s already applied

  // 't kofschip voicing is decided on the infinitive's underlying final consonant
  // (before v→f / z→s devoicing), so leven→leefde, reizen→reisde take -de.
  let root = inf.endsWith('en') ? inf.slice(0, -2) : inf.endsWith('n') ? inf.slice(0, -1) : inf;
  if (root.length >= 2 && root[root.length - 1] === root[root.length - 2]) root = root.slice(0, -1);
  const voiceless = root.endsWith('ch') || KOFSCHIP.has(root.slice(-1));

  const suf = voiceless ? 't' : 'd';
  const singular = stem + (voiceless ? 'te' : 'de');
  const plural = stem + (voiceless ? 'ten' : 'den');

  // Participle: ge + stem + t/d (no doubling if the stem already ends in that letter);
  // inseparable prefixes (be/ge/ver/ont/her/er) take no ge-.
  const base = stem.endsWith(suf) ? stem : stem + suf;
  const inseparable = /^(be|ge|ver|ont|her|er)/.test(inf) && inf.length >= 5;
  const participle = inseparable ? base : 'ge' + base;

  return { singular, plural, participle };
}

/**
 * Past tense (OVT) + past participle for a Dutch infinitive.
 * @returns {{past: {singular, plural}, participle: string|null} | null}
 */
function computeVerbPast(infinitiveRaw) {
  if (!infinitiveRaw || typeof infinitiveRaw !== 'string') return null;
  const inf = infinitiveRaw.trim().toLowerCase();
  if (!inf) return null;
  const hit = IRREGULAR_PAST[inf] || computeWeakPast(inf);
  if (!hit || !hit.singular) return null;
  return {
    past: { singular: hit.singular, plural: hit.plural || hit.singular },
    participle: hit.participle ? hit.participle : null,
  };
}

/** Build the verb `grammar` object (or null) for a Dutch word. */
function buildVerbGrammar(word) {
  const p = computeVerbPresent(word);
  if (!p) return null;
  const g = { kind: 'verb', present: p.present, irregular: p.irregular };
  if (p.separable) g.separable = true;
  const past = computeVerbPast(word);
  if (past) {
    g.past = past.past;
    if (past.participle) g.pastParticiple = past.participle;
  }
  return g;
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
  computeVerbPast,
  deriveStem,
  buildVerbGrammar,
  buildNounGrammar,
  isIrregularPlural,
  IRREGULAR_PRESENT,
  IRREGULAR_PAST,
};
