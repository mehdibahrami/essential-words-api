#!/usr/bin/env node
'use strict';

/**
 * Classify a Dutch verb as regelmatig / sterk / onregelmatig **from its past participle**.
 *
 * The sheet leads on the voltooid deelwoord, so the class has to describe the participle —
 * not the OVT. That is a real reclassification, not a relabelling, and it moves verbs in both
 * directions:
 *
 *   - the mixed verbs (weak OVT, strong participle) become STERK: `lachen` -> lachte /
 *     gelachen, and likewise heten, wassen, bakken, hoeven. The form on show ends in -en.
 *   - verbs with an odd OVT but a textbook-regular participle become REGELMATIG:
 *     `zeggen` -> zei / gezegd, `vragen` -> vroeg / gevraagd. ge- + stem + -d is exactly
 *     the regular pattern, whatever the preterite does.
 *
 * The three classes, defined on the participle alone:
 *
 *   sterk        participle ends in -en (or -aan: gedaan, gegaan, gestaan)
 *   regelmatig   participle is ge- + the verb's own stem + -t/-d, stem unchanged
 *   onregelmatig participle ends in -t/-d but the stem changed (kopen -> gekocht,
 *                brengen -> gebracht, denken -> gedacht, zoeken -> gezocht)
 *
 * The stem is the verb's own `ik` form taken from `dutchGrammar.computeVerbPresent`, never a
 * second stemmer here. That routes through IRREGULAR_PRESENT, then STEM_OVERRIDES, then
 * `deriveStem` — the same ladder the server uses. Calling `deriveStem` directly is wrong and
 * was tried: it doubles the schwa in the -eren/-enen/-igen verbs (openen -> "opeen"), which
 * marked nine plainly regular verbs — openen, luisteren, veranderen, regelen, betekenen,
 * ondertekenen, uitnodigen, regenen, eindigen — as onregelmatig. It also returns a separable's
 * root already split off ("ik nodig uit"), so `uitgenodigd` compares against `nodig`.
 */

const path = require('path');
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const dutchGrammar = require(path.join(repoRoot, 'src', 'services', 'dutchGrammar.js'));

/**
 * Preterite-presents and modals are pinned. Their participles (geweest, gehad, geweten,
 * gekund, gemogen, gemoeten, gewild) would scatter across sterk and onregelmatig on the rule
 * alone, but every Dutch course lists them together as the irregular core.
 */
const PRETERITE_PRESENT = new Set([
  'zijn', 'hebben', 'zullen', 'zouden', 'kunnen', 'mogen', 'moeten', 'willen', 'weten',
]);

/**
 * Head word only, with diacritics folded away: separables split in the OVT and `houden van`
 * carries a fixed preposition, while the diaeresis Dutch writes to break a vowel pair
 * (ge-eindigd, ge-interesseerd) is spelling, not stem -- comparing it literally marked both
 * of those regular verbs onregelmatig.
 */
function head(form) {
  return String(form || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/\s+/)[0] || '';
}

/** The `ik` form IS the present stem; for a separable it comes back split ("nodig uit"). */
function stemOf(infinitive) {
  const present = dutchGrammar.computeVerbPresent(infinitive);
  return present && present.present ? head(present.present.ik) : dutchGrammar.deriveStem(infinitive);
}

/**
 * Does the participle end in this verb's own unchanged stem plus the weak ending?
 * `-t`/`-d` are appended, except after a stem already ending in t or d, where Dutch writes no
 * second one (praten -> praat -> gepraat, antwoorden -> antwoord -> geantwoord).
 */
function isUnchangedStem(participle, stem) {
  if (!stem) return false;
  if (participle.endsWith(stem + 't') || participle.endsWith(stem + 'd')) return true;
  return /[td]$/.test(stem) && participle.endsWith(stem);
}

/**
 * A separable's participle infixes -ge- after the prefix (`voorstellen` -> `voorgesteld`), so
 * the stem to compare is the root's, not the whole infinitive's. `computeVerbPresent` splits
 * the roots it knows, but SEPARABLE_VERBS is a closed list and misses verbs whose OVT is
 * nonetheless pinned as separable in IRREGULAR_PAST (`voorstellen` -> "stelde voor"). So try
 * every prefix/root split of the infinitive rather than trusting one list, and require the
 * prefix to open the participle too -- that guard is what keeps an accidental suffix match
 * (`kopen` ending in `open`) from reading as regular.
 */
function matchesWeakPattern(infinitive, participle) {
  for (let cut = 0; cut <= infinitive.length - 3; cut++) {
    const prefix = infinitive.slice(0, cut);
    if (!participle.startsWith(prefix)) continue;
    if (isUnchangedStem(participle, stemOf(infinitive.slice(cut)))) return true;
  }
  return false;
}

function classifyByParticiple(infinitiveRaw, pastParticipleRaw) {
  const infinitive = head(infinitiveRaw);
  const participle = head(pastParticipleRaw);
  if (PRETERITE_PRESENT.has(infinitive)) return 'irregular';
  if (!participle) return 'unknown';

  if (participle.endsWith('en') || participle.endsWith('aan')) return 'strong';
  if (!/[td]$/.test(participle)) return 'irregular';

  return matchesWeakPattern(infinitive, participle) ? 'weak' : 'irregular';
}

module.exports = { classifyByParticiple, PRETERITE_PRESENT };
