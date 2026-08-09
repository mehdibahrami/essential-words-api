const { badRequest, notFound, conflict } = require('../middleware/errorHandler');
const { HttpError } = require('../middleware/errorHandler');
const { generateWordDetails } = require('./gemini');
const words = require('./words');

const VALID_POS = new Set(['noun', 'verb', 'adjective', 'adverb', 'phrase', 'other']);

/**
 * Build the AI prompt for a single word. Dutch verb *present*-tense grammar is never
 * requested here — `words.buildGrammar` already derives it live and reliably from the
 * infinitive (see dutchGrammar.js) — but article/plural for nouns is lexical and can
 * only come from the model (or a human), so that's the one grammar fact we ask for.
 */
function buildPrompt(language, word) {
  const isDutch = language.code === 'nl-NL';
  const dutchNote = isDutch
    ? ' For Dutch: if the word is a noun, prefix the headword with its article, "de" or "het" (e.g. "de tafel", "het huis"); if it is a verb, use the plain infinitive with no article (e.g. "lopen").'
    : '';
  const nounGrammarInstruction = isDutch
    ? '\n- If "partOfSpeech" is "noun", also include a "grammar" object: {"article": "de" or "het", "plural": "<plural form, without the article>"}. Omit "grammar" entirely for any other part of speech.'
    : '';

  return `You are populating a vocabulary flashcard for a language-learning app. The target language is ${language.name} (code: ${language.code}). The student entered the word or phrase: "${word}".

Return a single JSON object (not an array) with exactly these fields:
- "headword": the canonical dictionary form of the word/phrase in ${language.name}, corrected for spelling and casing.${dutchNote}
- "partOfSpeech": one of "noun", "verb", "adjective", "adverb", "phrase", "other" — the single best fit.
- "wordTranslated": a natural, concise English translation of the headword.
- "definition": a short definition of the headword, written in ${language.name}.
- "definitionTranslated": that definition translated into English.
- "example1": a natural example sentence in ${language.name} using the headword.
- "example1Translated": the English translation of example1.
- "example2": a second, different example sentence in ${language.name} using the headword.
- "example2Translated": the English translation of example2.${nounGrammarInstruction}

Respond with ONLY the JSON object — no markdown fences, no surrounding text.`;
}

function normalizePartOfSpeech(value) {
  const v = String(value || '').trim().toLowerCase();
  return VALID_POS.has(v) ? v : 'other';
}

/** Only Dutch nouns carry a stored grammar fact (article/plural) — everything else
 * either has none (non-Dutch) or is derived live on read (Dutch verbs). */
function extractGrammar(language, partOfSpeech, aiGrammar) {
  if (language.code !== 'nl-NL' || partOfSpeech !== 'noun') return null;
  if (!aiGrammar || typeof aiGrammar !== 'object') return null;
  const article = aiGrammar.article === 'het' ? 'het' : aiGrammar.article === 'de' ? 'de' : null;
  const plural = typeof aiGrammar.plural === 'string' ? aiGrammar.plural.trim() : '';
  if (!article || !plural) return null;
  return { article, plural };
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

  const headword = typeof details.headword === 'string' && details.headword.trim() ? details.headword.trim() : word;
  const existing = db
    .prepare('SELECT id FROM words WHERE wordSetId = ? AND deletedAt IS NULL AND lower(word) = lower(?)')
    .get(wordSetId, headword);
  if (existing) throw conflict(`"${headword}" is already in this set`);

  const partOfSpeech = normalizePartOfSpeech(details.partOfSpeech);
  const grammar = extractGrammar(language, partOfSpeech, details.grammar);

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

module.exports = { generateWordForSet, buildPrompt, normalizePartOfSpeech, extractGrammar };
