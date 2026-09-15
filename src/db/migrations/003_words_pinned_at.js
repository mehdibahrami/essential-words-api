/**
 * `words.pinnedAt` — an ISO-8601 UTC stamp that lifts a word to the front of the New
 * queue (`learning.reviewNext`). Nullable, and null for every pre-existing row, so the
 * new ordering is a no-op on a database that has never pinned anything.
 */
function up(db) {
  const cols = db.prepare('PRAGMA table_info(words)').all().map((c) => c.name);
  if (!cols.includes('pinnedAt')) {
    db.exec('ALTER TABLE words ADD COLUMN pinnedAt TEXT');
  }
}

module.exports = { version: 3, name: 'words_pinned_at', up };
