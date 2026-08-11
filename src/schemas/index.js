const { z } = require('zod');

// Loose numeric-or-numeric-string: every id in this API arrives from either a JSON
// body (number) or has historically been tolerated as a string. Services themselves
// call Number(...) on these before use, so the schema's job is only to reject
// obviously-wrong shapes (objects, arrays, booleans), not to fully own coercion.
const idLike = z.union([z.number(), z.string()]);
const idArray = z.array(idLike);

const optionalString = z.string().optional();
const optionalNullableString = z.string().nullable().optional();

// ---- Languages ----

const languageCreateSchema = z
  .object({
    name: z.string().min(1),
    code: z.string().min(1),
    sourceFileName: optionalNullableString,
  })
  .strict();

const languageUpdateSchema = z
  .object({
    name: optionalString,
    code: optionalString,
    sourceFileName: optionalNullableString,
  })
  .strict();

// ---- Sets ----

const setCreateSchema = z
  .object({
    name: z.string().min(1),
    languageId: idLike,
  })
  .strict();

const setUpdateSchema = z
  .object({
    name: optionalString,
  })
  .strict();

// ---- Words ----
// Field list mirrors WORD_FIELDS in src/services/words.js — keep the two in sync.
const wordContentShape = {
  wordTranslated: optionalString,
  partOfSpeech: optionalString,
  definition: optionalString,
  definitionTranslated: optionalString,
  example1: optionalNullableString,
  example1Translated: optionalNullableString,
  example2: optionalNullableString,
  example2Translated: optionalNullableString,
  example3: optionalNullableString,
  example3Translated: optionalNullableString,
  // Either the client-shaped grammar object or an already-serialized JSON string
  // (see serializeGrammarField in words.js); validated structurally there, not here.
  grammar: z.union([z.record(z.string(), z.any()), z.string()]).nullable().optional(),
};

const wordCreateSchema = z
  .object({
    word: z.string().min(1),
    languageId: idLike,
    wordSetId: idLike,
    ...wordContentShape,
  })
  .strict();

// PUT /words/:id — content fields only. leitnerBox/isLearned/nextPracticeDate are
// deliberately NOT accepted: Leitner state has one authority, the /review and
// /practice endpoints, never a direct field edit (see updateWord() in words.js, H2
// in CLAUDE.md). A request carrying any of them is rejected by `.strict()` below
// rather than silently ignored, so the hole is closed at the boundary, not just
// inside the service. wordSetId stays editable — moving a word between sets is a
// content correction, not a scheduling one.
const wordUpdateSchema = z
  .object({
    word: optionalString,
    wordSetId: idLike.optional(),
    ...wordContentShape,
  })
  .strict();

// POST /sets/:id/words/bulk — CSV import/seeding. Deliberately permissive per-item
// (an item with no/blank `word` is silently skipped by bulkCreateWords, not rejected —
// see tests/api.test.js "bulk word ops"). The array itself is capped: this route sits
// under the 10mb body limit meant for CSV seeding (Resources/English.csv, ~500 rows),
// not an unbounded insert -- BULK_WORDS_MAX leaves a generous margin above any real
// seed file while still bounding worst-case work done per request.
const BULK_WORDS_MAX = 2000;
const bulkWordItemSchema = z.record(z.string(), z.any());
const bulkCreateWordsSchema = z.union([
  z.array(bulkWordItemSchema).max(BULK_WORDS_MAX),
  z.object({ words: z.array(bulkWordItemSchema).max(BULK_WORDS_MAX) }).strict(),
]);

const aiGenerateWordSchema = z
  .object({
    word: z.string().min(1),
  })
  .strict();

// ---- Learning / trouble words / quiz ----

const drillRequestSchema = z
  .object({
    languageId: idLike,
    setId: idLike.nullable().optional(),
    wordIds: idArray.optional(),
    level: optionalString,
    limit: idLike.optional(),
  })
  .strict();

const quizGenerateSchema = z
  .object({
    languageId: idLike,
    setId: idLike.nullable().optional(),
    level: optionalString,
    numQuestions: idLike.optional(),
    contentSource: optionalString,
    leitnerBoxes: idArray.optional(),
    tenses: z.array(z.string()).optional(),
    customText: optionalString,
    questionsInEnglish: z.boolean().optional(),
  })
  .strict();

// POST /quiz/lapses — deliberately tolerant of a malformed `wordIds` (a non-array,
// e.g. a stray number) rather than 400ing: openLapses() already treats that case as a
// no-op (tests/api.test.js "a malformed body (non-array wordIds) is a no-op, not a
// 500"), a documented, tested leniency this schema preserves rather than tightens.
const quizLapsesSchema = z
  .object({
    wordIds: z.any().optional(),
  })
  .strict();

module.exports = {
  languageCreateSchema,
  languageUpdateSchema,
  setCreateSchema,
  setUpdateSchema,
  wordCreateSchema,
  wordUpdateSchema,
  bulkCreateWordsSchema,
  aiGenerateWordSchema,
  drillRequestSchema,
  quizGenerateSchema,
  quizLapsesSchema,
  BULK_WORDS_MAX,
};
