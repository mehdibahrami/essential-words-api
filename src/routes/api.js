const express = require('express');
const { asyncHandler, badRequest } = require('../middleware/errorHandler');
const languages = require('../services/languages');
const sets = require('../services/sets');
const words = require('../services/words');
const learning = require('../services/learning');
const sync = require('../services/sync');
const quiz = require('../services/quiz');

const router = express.Router();
const db = (req) => req.app.locals.db;

const idParam = (req) => {
  const id = Number(req.params.id ?? req.params.wordId);
  if (!Number.isInteger(id)) throw badRequest('Invalid id');
  return id;
};

// ---- Languages ----
router.get('/languages', asyncHandler((req, res) => res.json(languages.listLanguages(db(req)))));
router.post('/languages', asyncHandler((req, res) => res.status(201).json(languages.createLanguage(db(req), req.body))));
router.put('/languages/:id', asyncHandler((req, res) => res.json(languages.updateLanguage(db(req), idParam(req), req.body))));
router.delete('/languages/:id', asyncHandler((req, res) => { languages.deleteLanguage(db(req), idParam(req)); res.status(204).end(); }));
router.post('/languages/:id/reset', asyncHandler((req, res) => res.json(learning.resetProgress(db(req), { languageId: idParam(req) }))));

// ---- Sets ----
router.get('/sets', asyncHandler((req, res) => res.json(sets.listSets(db(req), { languageId: req.query.languageId }))));
router.post('/sets', asyncHandler((req, res) => res.status(201).json(sets.createSet(db(req), req.body))));
router.put('/sets/:id', asyncHandler((req, res) => res.json(sets.updateSet(db(req), idParam(req), req.body))));
router.delete('/sets/:id', asyncHandler((req, res) => { sets.deleteSet(db(req), idParam(req)); res.status(204).end(); }));
router.post('/sets/:id/reset', asyncHandler((req, res) => res.json(learning.resetProgress(db(req), { setId: idParam(req) }))));

// ---- Words ----
router.get('/words', asyncHandler((req, res) => res.json(words.listWords(db(req), { setId: req.query.setId, languageId: req.query.languageId }))));
router.get('/words/:id', asyncHandler((req, res) => {
  const w = words.getWord(db(req), idParam(req));
  if (!w || w.deletedAt) throw badRequest('Word not found');
  res.json(w);
}));
router.post('/words', asyncHandler((req, res) => res.status(201).json(words.createWord(db(req), req.body))));
router.put('/words/:id', asyncHandler((req, res) => res.json(words.updateWord(db(req), idParam(req), req.body))));
router.delete('/words/:id', asyncHandler((req, res) => { words.deleteWord(db(req), idParam(req)); res.status(204).end(); }));

// Bulk word ops (CSV import / seeding, bulk delete)
router.post('/sets/:id/words/bulk', asyncHandler((req, res) => res.status(201).json(words.bulkCreateWords(db(req), idParam(req), req.body.words ?? req.body))));
router.delete('/sets/:id/words', asyncHandler((req, res) => res.json(words.deleteWordsInSet(db(req), idParam(req)))));
router.delete('/languages/:id/words', asyncHandler((req, res) => res.json(words.deleteWordsForLanguage(db(req), idParam(req)))));

// ---- Learning: review (new words) & practice (Leitner) ----
router.get('/review/next', asyncHandler((req, res) => res.json(learning.reviewNext(db(req), { languageId: req.query.languageId, setId: req.query.setId, limit: req.query.limit }))));
router.post('/review/:wordId/learned', asyncHandler((req, res) => res.json(learning.markLearned(db(req), idParam(req)))));

router.get('/practice/next', asyncHandler((req, res) => {
  const w = learning.practiceNext(db(req), { languageId: req.query.languageId, setId: req.query.setId });
  res.json(w || null);
}));
router.post('/practice/:wordId/correct', asyncHandler((req, res) => res.json(learning.practiceCorrect(db(req), idParam(req)))));
router.post('/practice/:wordId/incorrect', asyncHandler((req, res) => res.json(learning.practiceIncorrect(db(req), idParam(req)))));

// ---- Stats ----
router.get('/stats', asyncHandler((req, res) => res.json(learning.stats(db(req), { languageId: req.query.languageId, setId: req.query.setId }))));
router.get('/trouble-words', asyncHandler((req, res) => res.json(learning.troubleWords(db(req), {
  languageId: req.query.languageId, setId: req.query.setId, limit: req.query.limit,
}))));

// ---- Quiz ----
router.post('/quiz/generate', asyncHandler(async (req, res) => res.json(await quiz.generateQuiz(db(req), req.body))));

// ---- Sync ----
router.get('/sync', asyncHandler((req, res) => res.json(sync.snapshot(db(req), req.query.since))));
router.post('/sync/import', asyncHandler((req, res) => res.json(sync.importData(db(req), req.body))));

module.exports = router;
