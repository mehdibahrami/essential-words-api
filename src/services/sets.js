const { nowIso } = require('../utils/time');
const { badRequest, notFound } = require('../middleware/errorHandler');

function listSets(db, { languageId, includeDeleted = false } = {}) {
  const clauses = [];
  const params = {};
  if (!includeDeleted) clauses.push('deletedAt IS NULL');
  if (languageId != null) {
    clauses.push('languageId = @languageId');
    params.languageId = Number(languageId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM word_sets ${where} ORDER BY createdAt ASC`).all(params);
}

function getSet(db, id) {
  return db.prepare('SELECT * FROM word_sets WHERE id = ?').get(id);
}

function createSet(db, { name, languageId }) {
  if (!name || languageId == null) throw badRequest('name and languageId are required');
  const lang = db.prepare('SELECT id FROM languages WHERE id = ? AND deletedAt IS NULL').get(languageId);
  if (!lang) throw badRequest('languageId does not reference an existing language');
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO word_sets (name, languageId, createdAt, updatedAt) VALUES (@name, @languageId, @now, @now)`
    )
    .run({ name, languageId: Number(languageId), now });
  return getSet(db, info.lastInsertRowid);
}

function updateSet(db, id, fields) {
  const existing = getSet(db, id);
  if (!existing || existing.deletedAt) throw notFound('Set not found');
  const name = fields.name ?? existing.name;
  db.prepare('UPDATE word_sets SET name=@name, updatedAt=@now WHERE id=@id').run({ id, name, now: nowIso() });
  return getSet(db, id);
}

/** Soft-delete the set and cascade the tombstone to its words. */
function deleteSet(db, id) {
  const existing = getSet(db, id);
  if (!existing || existing.deletedAt) throw notFound('Set not found');
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare('UPDATE words SET deletedAt=@now, updatedAt=@now WHERE wordSetId=@id AND deletedAt IS NULL').run({ id, now });
    db.prepare('UPDATE word_sets SET deletedAt=@now, updatedAt=@now WHERE id=@id').run({ id, now });
  });
  tx();
}

module.exports = { listSets, getSet, createSet, updateSet, deleteSet };
