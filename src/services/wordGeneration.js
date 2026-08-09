const { badRequest, notFound, conflict } = require('../middleware/errorHandler');
const { HttpError } = require('../middleware/errorHandler');
const { generateWordDetails } = require('./gemini');
const words = require('./words');

/**
 * Build the AI prompt for a single word.
 *
 * `partOfSpeech` is intentionally free text, not a fixed enum — the real DB has ~45
 * distinct labels (preposition, pronoun, conjunction, determiner, numeral, interjection,
 * combined forms like "adjective/adverb", and critically "verb (separable)"), and both
 * `words.buildGrammar` (`pos.startsWith('verb ')`) and the quiz prompt builders
 * (`partOfSpeech.includes('verb')`) already tolerate that variety by substring match
 * rather than requiring an exact "verb". Constraining the model to a 6-value enum would
 * have silently collapsed "verb (separable)" down to "verb", throwing away exactly the
 * fact that matters most for a separable verb.
 */
function buildPrompt(language, word) {
  const isDutch = language.code === 'nl-NL';
  const dutchGrammarBlock = isDutch ? `

DUTCH-SPECIFIC GRAMMAR RULES:
- "partOfSpeech" should use this app's existing Dutch grammar labels: "noun", "verb", "verb (separable)", "verb (auxiliary)", "verb (modal)", "adjective", "adverb", "preposition", "pronoun", "conjunction", "determiner", "numeral", "interjection", etc. Use "verb (separable)" specifically when the verb's prefix detaches in the present tense (e.g. "opstaan" → "ik sta op", "meenemen" → "ik neem mee").
- Noun: "headword" MUST start with its article, "de " or "het " — exactly like every Dutch noun already in this app's database (e.g. "de hand", "het leven", "de tafel", "het huis"), never a bare noun with no article. Also include a "grammar" object: {"article": "de" or "het", "plural": "<plural form, WITHOUT the article>"}.
- Verb (any "partOfSpeech" starting with "verb"): "headword" is the bare infinitive, no article. Also include a "grammar" object with the FULL conjugation, shaped exactly like this real example for the separable verb "opstaan": {"present": {"ik": "sta op", "jij": "staat op", "hij": "staat op", "wij": "staan op"}, "irregular": true, "separable": true, "past": {"singular": "stond op", "plural": "stonden op"}, "pastParticiple": "opgestaan"}. CRITICAL: each present-tense VALUE is ONLY the conjugated verb (plus its detached prefix for a separable verb) — it must NEVER repeat the subject pronoun that is already its own JSON key (wrong: "ik": "ik sta op"; correct: "ik": "sta op"). For a separable verb, the detached prefix goes at the END of the value (wrong: "opstaat"; correct: "staat op").` : '';

  return `You are populating a vocabulary flashcard for a language-learning app used by a native Persian (Farsi) speaker learning ${language.name} (code: ${language.code}). The student entered: "${word}".

LANGUAGE RULES — apply to every field below:
- "headword", "example1" and "example2" are written in ${language.name}.
- "definition" is written in ENGLISH, ALWAYS — regardless of ${language.name}. It is a short dictionary-style gloss (e.g. "occupied / busy", "with", "in front of"), not a definition written in ${language.name}.
- "wordTranslated", "definitionTranslated", "example1Translated" and "example2Translated" are written in PERSIAN (Farsi) script, ALWAYS — never English.
- "example1" and "example2" must be CEFR A2 level: short sentences, common everyday vocabulary, simple grammar — no subordinate clauses or advanced tenses.

HEADWORD NORMALIZATION: "headword" is always the base DICTIONARY form — corrected for spelling/casing, and NEVER the inflected form the student typed if they typed one:
- a conjugated verb → its infinitive (student enters "ben" → headword "zijn")
- a plural noun → its singular (student enters "huizen" → headword "het huis")
- an inflected adjective → its base predicate form (student enters Dutch "lange" → headword "lang")

Return a single JSON object (not an array) with exactly these fields:
- "headword": string, per the normalization rule above.
- "partOfSpeech": the single most accurate grammatical label for the headword.
- "wordTranslated": string.
- "definition": string.
- "definitionTranslated": string.
- "example1": string.
- "example1Translated": string.
- "example2": string.
- "example2Translated": string.${dutchGrammarBlock}

Respond with ONLY the JSON object — no markdown fences, no surrounding text.`;
}

/** Free text, but guarded against the model returning a sentence or empty junk. */
function normalizePartOfSpeech(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v || v.length > 40 || !/^[a-z][a-z /().]*$/.test(v)) return 'other';
  return v;
}

function isNounPos(pos) { return pos.includes('noun'); }
function isVerbPos(pos) { return pos === 'verb' || pos.startsWith('verb '); }

/**
 * Article + plural for a Dutch noun — lexical facts only the model (or a human) can
 * supply. `null` if the model didn't give a usable article/plural; the word is still
 * created, just without a grammar row (matches how a hand-entered noun with no grammar
 * behaves today).
 */
function extractNounGrammar(aiGrammar) {
  if (!aiGrammar || typeof aiGrammar !== 'object') return null;
  const article = aiGrammar.article === 'het' ? 'het' : aiGrammar.article === 'de' ? 'de' : null;
  const plural = typeof aiGrammar.plural === 'string' ? aiGrammar.plural.trim() : '';
  if (!article || !plural) return null;
  return { article, plural };
}

/**
 * Full verb conjugation, sanitized to the exact `WordGrammar.VerbGrammar` shape the
 * client decodes. Every DB verb sampled — including ones the live rule-based conjugator
 * (`dutchGrammar.js`) *could* handle — already stores a complete grammar object rather
 * than relying on live derivation, so AI generation follows that same convention rather
 * than leaving verbs to the live path (which cannot know a NEW separable verb isn't in
 * its hardcoded `SEPARABLE_VERBS` list, and would conjugate it as a single non-separable
 * word). `null` if the model's present-tense forms aren't usable — the word is still
 * created; `words.buildGrammar` then falls back to live derivation on read, so a
 * malformed AI response degrades to today's behavior rather than losing grammar entirely.
 */
/**
 * Defensive strip for the exact failure mode seen live (Gemini, "afsluiten"): a
 * present-tense value came back as "ik sluit af" for the "ik" key — the pronoun
 * duplicated into the value it's already the key for. The prompt now gives a literal,
 * unambiguous JSON example, but this guards the stored data even if a future response
 * slips anyway, since a leading "ik "/"jij "/etc. would otherwise render doubled next to
 * `GrammarSectionView`'s own pronoun label.
 */
function stripLeadingPronoun(pronoun, value) {
  return value.replace(new RegExp(`^${pronoun}\\s+`, 'i'), '').trim();
}

function extractVerbGrammar(aiGrammar) {
  if (!aiGrammar || typeof aiGrammar !== 'object') return null;
  const present = aiGrammar.present;
  const forms = ['ik', 'jij', 'hij', 'wij'];
  if (!present || typeof present !== 'object' || !forms.every((k) => typeof present[k] === 'string' && present[k].trim())) {
    return null;
  }
  const stripped = Object.fromEntries(forms.map((k) => [k, stripLeadingPronoun(k, present[k].trim())]));
  if (!forms.every((k) => stripped[k])) return null; // e.g. a value that was ONLY the pronoun
  const grammar = {
    kind: 'verb',
    present: stripped,
    irregular: !!aiGrammar.irregular,
    separable: !!aiGrammar.separable,
  };
  const past = aiGrammar.past;
  if (past && typeof past === 'object' && typeof past.singular === 'string' && past.singular.trim() &&
      typeof past.plural === 'string' && past.plural.trim()) {
    grammar.past = { singular: past.singular.trim(), plural: past.plural.trim() };
  }
  if (typeof aiGrammar.pastParticiple === 'string' && aiGrammar.pastParticiple.trim()) {
    grammar.pastParticiple = aiGrammar.pastParticiple.trim();
  }
  return grammar;
}

function extractGrammar(language, partOfSpeech, aiGrammar) {
  if (language.code !== 'nl-NL') return null;
  if (isNounPos(partOfSpeech)) return extractNounGrammar(aiGrammar);
  if (isVerbPos(partOfSpeech)) return extractVerbGrammar(aiGrammar);
  return null;
}

/**
 * Belt-and-suspenders: if the model classified the word as a Dutch noun and gave a
 * usable article but forgot to prefix "headword" with it (the one formatting rule most
 * likely to slip), fix the headword up rather than inserting a noun that looks unlike
 * every other one in the database.
 */
function ensureNounArticle(headword, partOfSpeech, grammar) {
  if (!grammar || !grammar.article || !isNounPos(partOfSpeech)) return headword;
  const alreadyPrefixed = /^(de|het)\s+/i.test(headword);
  return alreadyPrefixed ? headword : `${grammar.article} ${headword}`;
}

/**
 * Generate a full word record from a single user-entered word via AI, and insert it
 * into `wordSetId`. Nothing is written to the DB unless generation, validation and the
 * duplicate check all succeed — a failure at any step leaves the set untouched.
 */
async function generateWordForSet(db, wordSetId, rawWord, deps = {}) {
  const word = String(rawWord || '').trim();
  if (!word) throw badRequest('word is required');

  const set = db.prepare('SELECT id, languageId FROM word_sets WHERE id = ? AND deletedAt IS NULL').get(wordSetId);
  if (!set) throw notFound('Set not found');
  const language = db.prepare('SELECT id, name, code FROM languages WHERE id = ? AND deletedAt IS NULL').get(set.languageId);
  if (!language) throw notFound('Language not found');

  const generate = deps.generateWordDetails || generateWordDetails;
  const prompt = buildPrompt(language, word);
  const details = await generate(prompt);

  if (!details || typeof details.wordTranslated !== 'string' || !details.wordTranslated.trim() ||
      typeof details.definition !== 'string' || !details.definition.trim()) {
    throw new HttpError(502, 'GEMINI_INCOMPLETE', 'AI response was missing required fields');
  }

  const partOfSpeech = normalizePartOfSpeech(details.partOfSpeech);
  const grammar = extractGrammar(language, partOfSpeech, details.grammar);

  const rawHeadword = typeof details.headword === 'string' && details.headword.trim() ? details.headword.trim() : word;
  const headword = ensureNounArticle(rawHeadword, partOfSpeech, grammar);

  const existing = db
    .prepare('SELECT id FROM words WHERE wordSetId = ? AND deletedAt IS NULL AND lower(word) = lower(?)')
    .get(wordSetId, headword);
  if (existing) throw conflict(`"${headword}" is already in this set`);

  return words.createWord(db, {
    word: headword,
    languageId: set.languageId,
    wordSetId: Number(wordSetId),
    wordTranslated: details.wordTranslated.trim(),
    partOfSpeech,
    definition: details.definition.trim(),
    definitionTranslated: (details.definitionTranslated || '').toString().trim(),
    example1: details.example1 || null,
    example1Translated: details.example1Translated || null,
    example2: details.example2 || null,
    example2Translated: details.example2Translated || null,
    grammar,
  });
}

module.exports = {
  generateWordForSet, buildPrompt, normalizePartOfSpeech, extractGrammar,
  extractNounGrammar, extractVerbGrammar, ensureNounArticle,
};
