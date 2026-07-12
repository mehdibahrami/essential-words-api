const { nowIso } = require('../utils/time');
const { badRequest, notFound } = require('../middleware/errorHandler');

function listLanguages(db, { includeDeleted = false } = {}) {
  const where = includeDeleted ? '' : 'WHERE deletedAt IS NULL';
  return db.prepare(`SELECT * FROM languages ${where} ORDER BY name COLLATE NOCASE ASC`).all();
}

function getLanguage(db, id) {
  return db.prepare('SELECT * FROM languages WHERE id = ?').get(id);
}

function createLanguage(db, { name, code, sourceFileName = null }) {
  if (!name || !code) throw badRequest('name and code are required');
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO languages (name, code, sourceFileName, createdAt, updatedAt)
       VALUES (@name, @code, @sourceFileName, @now, @now)`
    )
    .run({ name, code, sourceFileName, now });
  return getLanguage(db, info.lastInsertRowid);
}

function updateLanguage(db, id, fields) {
  const existing = getLanguage(db, id);
  if (!existing || existing.deletedAt) throw notFound('Language not found');
  const name = fields.name ?? existing.name;
  const code = fields.code ?? existing.code;
  const sourceFileName =
    fields.sourceFileName !== undefined ? fields.sourceFileName : existing.sourceFileName;
  db.prepare(
    `UPDATE languages SET name=@name, code=@code, sourceFileName=@sourceFileName, updatedAt=@now WHERE id=@id`
  ).run({ id, name, code, sourceFileName, now: nowIso() });
  return getLanguage(db, id);
}

/** Soft-delete the language and cascade the tombstone to its sets and words. */
function deleteLanguage(db, id) {
  const existing = getLanguage(db, id);
  if (!existing || existing.deletedAt) throw notFound('Language not found');
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare('UPDATE words SET deletedAt=@now, updatedAt=@now WHERE languageId=@id AND deletedAt IS NULL').run({ id, now });
    db.prepare('UPDATE word_sets SET deletedAt=@now, updatedAt=@now WHERE languageId=@id AND deletedAt IS NULL').run({ id, now });
    db.prepare('UPDATE languages SET deletedAt=@now, updatedAt=@now WHERE id=@id').run({ id, now });
  });
  tx();
}

module.exports = { listLanguages, getLanguage, createLanguage, updateLanguage, deleteLanguage };
