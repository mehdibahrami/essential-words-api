const { badRequest } = require('../middleware/errorHandler');
const { getLanguage } = require('./languages');
const { generateQuizFromPrompt } = require('./gemini');

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Content sources whose questions can be full sentences worth translating. */
const TRANSLATABLE_SOURCES = new Set(['leitnerBoxes', 'customTopic']);
/** Below this many word tokens, a question is a headword or a conjugation cue, not a sentence. */
const SENTENCE_MIN_WORDS = 3;

/**
 * The English translation to attach to a question, or null.
 *
 * Decided here rather than trusted from the model, behind two independent gates: the
 * content source must be one that produces sentences, and the question must actually
 * read as a sentence. Tokens are filtered to those containing a letter, because
 * "ik + hebben" is three whitespace-separated tokens but only two words — a naive
 * whitespace count would leak translations onto conjugation prompts.
 */
function questionTranslationFor(questionItself, supplied, contentSource) {
  if (!TRANSLATABLE_SOURCES.has(contentSource)) return null;
  const text = typeof questionItself === 'string' ? questionItself.trim() : '';
  const words = text.split(/\s+/).filter((t) => /\p{L}/u.test(t));
  if (words.length < SENTENCE_MIN_WORDS) return null;
  return typeof supplied === 'string' && supplied.trim() ? supplied.trim() : null;
}

/** Live (non-deleted) words for a language, optionally scoped to a set. */
function wordsFor(db, languageId, setId) {
  const clauses = ['deletedAt IS NULL', 'languageId = @languageId'];
  const params = { languageId: Number(languageId) };
  if (setId != null) { clauses.push('wordSetId = @setId'); params.setId = Number(setId); }
  return db.prepare(`SELECT * FROM words WHERE ${clauses.join(' AND ')}`).all(params);
}

// ---- Prompt builders (ported from WordsViewModel.prepareQuizPrompt / prepareVerbConjugationPrompt) ----

function vocabPrompt(language, cfg, words) {
  const { level, numQuestions, leitnerBoxes, customText, contentSource, questionsInEnglish } = cfg;
  let prompt = `Generate a multiple-choice quiz for the ${language.name} language (code: ${language.code}) at the ${level} level. The quiz should have ${numQuestions} questions. `;

  if (contentSource === 'leitnerBoxes' && leitnerBoxes && leitnerBoxes.length) {
    prompt += "The questions should be in a style similar to Quizlet, focusing on vocabulary, definitions, and usage. Examples: 'What is the definition of [word]?', '[Definition] is the definition of what word?', 'Fill in the blank: [Sentence with blank] using one of the options.', or 'Choose the word that best fits this description: [Description]'.\n";
    prompt += "Each question MUST have two distinct parts: 'questionDescription' in English (e.g., 'Choose the correct definition:', 'Which word means the following?', 'Fill in the blank:') and 'questionItself' (e.g., the word 'Abandon', or the definition 'To leave completely and finally.', or the sentence 'He had to ____ his car.'). The 'questionItself' can be in the target language if appropriate (e.g. a sentence to fill in).\n";
    const boxSet = new Set(leitnerBoxes.map(Number));
    const picked = shuffle(words.filter((w) => boxSet.has(w.leitnerBox)))
      .slice(0, 30)
      .map((w) => `${w.word} (${w.wordTranslated})`);
    if (picked.length) {
      prompt += `Focus the quiz questions PRIMARILY on these vocabulary words (original and translation provided for your context): ${picked.join(', ')}. You can ask for definitions, translations, or use them in fill-in-the-blank sentences.\n`;
    } else {
      prompt += 'No specific Leitner box words were selected or found. Generate general vocabulary questions appropriate for the level.\n';
    }
  } else if (contentSource === 'customTopic' && customText) {
    prompt += `The questions should be in a style similar to Quizlet. Base the quiz questions on this user request or topic: "${customText}".\n`;
  } else {
    prompt += `Generate general vocabulary questions appropriate for the ${level} level for the ${language.name} language.\n`;
  }

  const descLang = questionsInEnglish ? 'English' : language.name;
  prompt += `IMPORTANT: The 'questionDescription' (the instruction, e.g. 'Choose the correct definition:') MUST be in ${descLang}. The 'questionItself' (the actual word, phrase, or sentence being asked about) MUST ALWAYS remain in ${language.name} — never translate it. The answer options should be in ${language.name}.\n`;
  prompt += "Each question should have 4 options, and one correct answer. Please provide the output as a JSON array of objects, where each object has 'questionDescription' (String), 'questionItself' (String), 'options' (Array of Strings), 'correctAnswer' (String - the text of the correct option), and 'questionTranslation' (String or null - a natural English translation of the COMPLETE 'questionItself' sentence with any blank filled in, ONLY when 'questionItself' is a full sentence; use null when it is a single word or short phrase).";
  return prompt;
}

function verbConjugationPrompt(language, cfg, words) {
  const { level, numQuestions, tenses, leitnerBoxes, questionsInEnglish } = cfg;
  const tenseList = (tenses || []).slice().sort().join(', ');
  let prompt = `Generate a multiple-choice verb conjugation quiz for the ${language.name} language (code: ${language.code}) at the ${level} level. The quiz should have ${numQuestions} questions.\n`;
  prompt += `Focus on these tenses: ${tenseList}.\n`;
  prompt += "Each question should present a verb infinitive, a subject pronoun, and a tense, and ask the student to choose the correct conjugated form. For example: 'Conjugate \"to speak\" for \"he/she\" in Present Simple.' The options should include the correct conjugated form and 3 plausible but incorrect alternatives.\n";

  const boxSet = leitnerBoxes && leitnerBoxes.length ? new Set(leitnerBoxes.map(Number)) : null;
  const inScope = boxSet ? words.filter((w) => boxSet.has(w.leitnerBox)) : words;
  const verbs = shuffle(inScope.filter((w) => (w.partOfSpeech || '').toLowerCase().includes('verb')))
    .slice(0, 20)
    .map((w) => w.word);
  if (verbs.length) {
    prompt += `Use these verbs from the student's word list when possible: ${verbs.join(', ')}.\n`;
  }

  const descLang = questionsInEnglish ? 'English' : language.name;
  prompt += `IMPORTANT: The 'questionDescription' (the instruction, e.g. 'Conjugate in Present Simple:') MUST be in ${descLang}. The 'questionItself' (the pronoun + verb, e.g. 'ik + hebben') MUST ALWAYS remain in ${language.name} using the target language pronoun and verb infinitive — never translate them. The answer options should be in ${language.name}.\n`;
  prompt += "Each question should have 4 options, and one correct answer. Please provide the output as a JSON array of objects, where each object has 'questionDescription' (String, e.g. 'Conjugate in Present Simple:'), 'questionItself' (String, e.g. 'ik + hebben'), 'options' (Array of Strings), and 'correctAnswer' (String - the text of the correct option).";
  return prompt;
}

/** Dutch de/het article quiz — generated locally, no AI. Ported from generateDutchArticleQuiz. */
function dutchArticleQuiz(language, cfg, words) {
  if (language.code !== 'nl-NL') throw badRequest("The 'articles' quiz is only available for Dutch (nl-NL).");
  const articleWords = words.filter((w) => {
    const lower = (w.word || '').toLowerCase();
    return lower.startsWith('de ') || lower.startsWith('het ');
  });
  if (!articleWords.length) throw badRequest("No words with articles ('de' or 'het') found to generate this quiz.");

  const questions = [];
  for (const w of shuffle(articleWords).slice(0, cfg.numQuestions)) {
    const parts = w.word.split(/\s+/);
    if (parts.length < 2) continue;
    const article = parts[0];
    const noun = parts.slice(1).join(' ');
    questions.push({
      wordId: w.id,
      questionDescription: 'Kies het juiste lidwoord:',
      questionItself: noun,
      options: ['de', 'het'],
      correctAnswer: article,
      questionTranslation: null,
    });
  }
  if (!questions.length) throw badRequest('Could not generate any valid article questions.');
  return questions;
}

/**
 * Generate a quiz. `articles` is produced locally; the others build a prompt and
 * call Gemini. Returns an array of {questionDescription, questionItself, options, correctAnswer}.
 */
async function generateQuiz(db, body, deps = {}) {
  const {
    languageId,
    setId = null,
    level = 'A1',
    numQuestions = 10,
    contentSource = 'leitnerBoxes',
    leitnerBoxes = [],
    tenses = [],
    customText = '',
    questionsInEnglish = true,
  } = body || {};

  if (languageId == null) throw badRequest('languageId is required');
  const language = getLanguage(db, languageId);
  if (!language || language.deletedAt) throw badRequest('languageId does not reference an existing language');

  const cfg = { level, numQuestions: Number(numQuestions) || 10, contentSource, leitnerBoxes, tenses, customText, questionsInEnglish };
  const words = wordsFor(db, languageId, setId);

  if (contentSource === 'articles') {
    return dutchArticleQuiz(language, cfg, words);
  }

  const prompt =
    contentSource === 'verbConjugation'
      ? verbConjugationPrompt(language, cfg, words)
      : vocabPrompt(language, cfg, words);

  const gen = deps.generate || generateQuizFromPrompt;
  const questions = await gen(prompt);
  return questions.slice(0, cfg.numQuestions).map((q) => ({
    ...q,
    questionTranslation: questionTranslationFor(q.questionItself, q.questionTranslation, contentSource),
  }));
}

module.exports = { generateQuiz, vocabPrompt, verbConjugationPrompt, dutchArticleQuiz, questionTranslationFor };
