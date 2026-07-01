const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'reelshelf.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'shelf',
    year TEXT DEFAULT '',
    formats TEXT NOT NULL DEFAULT '[]',
    genres TEXT NOT NULL DEFAULT '[]',
    actors TEXT NOT NULL DEFAULT '[]',
    location TEXT DEFAULT '',
    quality TEXT DEFAULT '',
    trailerKey TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    posterPath TEXT DEFAULT '',
    tmdbId TEXT DEFAULT '',
    addedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migration: older databases created before tmdbId existed won't have the column.
const existingCols = db.prepare('PRAGMA table_info(items)').all().map(c => c.name);
if (!existingCols.includes('tmdbId')) {
  db.exec("ALTER TABLE items ADD COLUMN tmdbId TEXT DEFAULT ''");
}

// One-time repair: an earlier version bound tmdbId as a raw number, which
// SQLite silently stored as e.g. "949.0" instead of "949". Strip any
// trailing ".0" left over from that bug so string-equality matching works.
db.exec("UPDATE items SET tmdbId = substr(tmdbId, 1, length(tmdbId) - 2) WHERE tmdbId LIKE '%.0'");

module.exports = db;
