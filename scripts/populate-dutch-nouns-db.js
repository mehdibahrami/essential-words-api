#!/usr/bin/env node
'use strict';

/**
 * Direct-to-SQLite variant of populate-dutch-nouns.js — writes noun grammar straight
 * into the words table, bypassing the API rate limiter. Intended to run on the server.
 *
 * Usage (on the Pi):  cd ~/essential-words-api && node scripts/populate-dutch-nouns-db.js
 *
 * Idempotent. Matches by id, falling back to exact word text if the id is absent.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../src/config');

const data = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'dutch-nouns.json'), 'utf8')
);

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

// Ensure the column exists (the running service normally adds it on boot).
const cols = db.prepare('PRAGMA table_info(words)').all().map((c) => c.name);
if (!cols.includes('grammar')) db.exec('ALTER TABLE words ADD COLUMN grammar TEXT');

const byId = db.prepare('UPDATE words SET grammar=@g, updatedAt=@now WHERE id=@id AND deletedAt IS NULL');
const byWord = db.prepare('UPDATE words SET grammar=@g, updatedAt=@now WHERE word=@word AND deletedAt IS NULL');

let updated = 0; const misses = [];
const now = new Date().toISOString();
const tx = db.transaction(() => {
  for (const rec of data) {
    const g = JSON.stringify({ kind: 'noun', article: rec.article, plural: rec.plural });
    let info = byId.run({ g, now, id: rec.id });
    if (info.changes === 0) info = byWord.run({ g, now, word: rec.word });
    if (info.changes === 0) misses.push(rec.word);
    else updated += info.changes;
  }
});
tx();

console.log(`Updated ${updated}/${data.length} noun grammar rows.`);
if (misses.length) console.log(`No match for ${misses.length}:`, misses.join(', '));
db.close();
