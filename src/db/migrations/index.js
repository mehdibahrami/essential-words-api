const migration001 = require('./001_baseline_columns');

/** Ordered by version. Add new migrations here, never renumber or edit a shipped one. */
const migrations = [migration001];

/**
 * Apply every migration not yet recorded in `schema_migrations`, in order, each in
 * its own transaction. Replaces the old ad-hoc `PRAGMA table_info` + `ALTER TABLE`
 * chain in db/index.js, which had no version record and could only express additive
 * column changes -- not a table rebuild (see migration 002).
 */
function runMigrations(db) {
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const run = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
        .run(migration.version, migration.name);
    });
    run();
  }
}

module.exports = { runMigrations, migrations };
