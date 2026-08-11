/**
 * Back-fills the four `words` columns that the old hand-rolled `migrate()` added
 * one at a time (grammar, lapseCount, openLapse, lastLapsedAt). A brand-new database
 * already has all four from SCHEMA's CREATE TABLE, so each ALTER is still guarded --
 * this migration exists to record, in schema_migrations, that an existing (pre-lapse
 * -tracking) database has been brought up to date, not to change fresh installs.
 */
function up(db) {
  const wordCols = db.prepare('PRAGMA table_info(words)').all().map((c) => c.name);
  if (!wordCols.includes('grammar')) {
    db.exec('ALTER TABLE words ADD COLUMN grammar TEXT');
  }
  if (!wordCols.includes('lapseCount')) {
    db.exec('ALTER TABLE words ADD COLUMN lapseCount INTEGER NOT NULL DEFAULT 0');
  }
  if (!wordCols.includes('openLapse')) {
    db.exec('ALTER TABLE words ADD COLUMN openLapse INTEGER NOT NULL DEFAULT 0');
  }
  if (!wordCols.includes('lastLapsedAt')) {
    db.exec('ALTER TABLE words ADD COLUMN lastLapsedAt TEXT');
  }
}

module.exports = { version: 1, name: 'baseline_columns', up };
