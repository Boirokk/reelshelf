const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

// ---------- helpers ----------
function uid() {
  return 'm_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function rowToItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    year: row.year || '',
    formats: JSON.parse(row.formats || '[]'),
    genres: JSON.parse(row.genres || '[]'),
    actors: JSON.parse(row.actors || '[]'),
    location: row.location || '',
    quality: row.quality || '',
    trailerKey: row.trailerKey || '',
    notes: row.notes || '',
    posterPath: row.posterPath || null,
    tmdbId: row.tmdbId || null,
    addedAt: row.addedAt,
  };
}

function toIdString(v) {
  if (v === undefined || v === null || v === '') return '';
  return String(v).trim();
}

function normalizeIncoming(data, existing) {
  const base = existing || {};
  return {
    title: (data.title !== undefined ? data.title : base.title || '').toString().trim(),
    status: data.status === 'wishlist' ? 'wishlist' : 'shelf',
    year: (data.year !== undefined ? data.year : base.year || '').toString(),
    formats: JSON.stringify(Array.isArray(data.formats) ? data.formats : (base.formats || [])),
    genres: JSON.stringify(Array.isArray(data.genres) ? data.genres : (base.genres || [])),
    actors: JSON.stringify(Array.isArray(data.actors) ? data.actors : (base.actors || [])),
    location: (data.location !== undefined ? data.location : base.location || '').toString(),
    quality: (data.quality !== undefined ? data.quality : base.quality || '').toString(),
    trailerKey: (data.trailerKey !== undefined ? data.trailerKey : base.trailerKey || '') || '',
    notes: (data.notes !== undefined ? data.notes : base.notes || '').toString(),
    posterPath: (data.posterPath !== undefined ? data.posterPath : base.posterPath || '') || '',
    // Always coerce to a plain string — binding a raw JS number here gets
    // silently stored as e.g. "949.0" instead of "949" by the SQLite driver,
    // which then breaks every future string-equality duplicate check.
    tmdbId: data.tmdbId !== undefined ? toIdString(data.tmdbId) : (base.tmdbId || ''),
  };
}

function getTmdbKey() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('tmdb_api_key');
  return row ? row.value : '';
}

// ---------- library CRUD ----------
app.get('/api/library', (req, res) => {
  const rows = db.prepare('SELECT * FROM items ORDER BY addedAt ASC').all();
  res.json(rows.map(rowToItem));
});

app.post('/api/library', (req, res) => {
  const data = normalizeIncoming(req.body || {});
  if (!data.title) return res.status(400).json({ error: 'Title is required' });
  const id = uid();
  const addedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO items (id, title, status, year, formats, genres, actors, location, quality, trailerKey, notes, posterPath, tmdbId, addedAt)
    VALUES (@id, @title, @status, @year, @formats, @genres, @actors, @location, @quality, @trailerKey, @notes, @posterPath, @tmdbId, @addedAt)
  `).run({ id, addedAt, ...data });
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  res.status(201).json(rowToItem(row));
});

app.put('/api/library/:id', (req, res) => {
  const existingRow = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!existingRow) return res.status(404).json({ error: 'Not found' });
  const existing = rowToItem(existingRow);
  const data = normalizeIncoming(req.body || {}, existing);
  if (!data.title) return res.status(400).json({ error: 'Title is required' });
  db.prepare(`
    UPDATE items SET title=@title, status=@status, year=@year, formats=@formats, genres=@genres,
      actors=@actors, location=@location, quality=@quality, trailerKey=@trailerKey, notes=@notes, posterPath=@posterPath, tmdbId=@tmdbId
    WHERE id=@id
  `).run({ id: req.params.id, ...data });
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  res.json(rowToItem(row));
});

app.delete('/api/library/:id', (req, res) => {
  const result = db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

app.post('/api/library/import', (req, res) => {
  const incoming = Array.isArray(req.body && req.body.library) ? req.body.library : null;
  if (!incoming) return res.status(400).json({ error: 'Expected { library: [...] }' });
  const insert = db.prepare(`
    INSERT INTO items (id, title, status, year, formats, genres, actors, location, quality, trailerKey, notes, posterPath, tmdbId, addedAt)
    VALUES (@id, @title, @status, @year, @formats, @genres, @actors, @location, @quality, @trailerKey, @notes, @posterPath, @tmdbId, @addedAt)
  `);
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const item of incoming) {
      if (!item || !item.title) continue;
      const data = normalizeIncoming({
        ...item,
        formats: Array.isArray(item.formats) ? item.formats : (item.format ? [item.format] : []),
      });
      const id = uid();
      const addedAt = item.addedAt || new Date().toISOString();
      insert.run({ id, addedAt, ...data });
      added++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ added });
});

// ---------- settings (TMDB key) ----------
app.get('/api/settings', (req, res) => {
  res.json({ hasKey: !!getTmdbKey() });
});

app.post('/api/settings', (req, res) => {
  const key = ((req.body && req.body.tmdbKey) || '').toString().trim();
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('tmdb_api_key', key);
  res.json({ hasKey: !!key });
});

// ---------- TMDB proxy (key never leaves the server) ----------
async function tmdbFetch(res, urlPath, query) {
  const key = getTmdbKey();
  if (!key) return res.status(400).json({ error: 'No TMDB API key configured' });
  const url = new URL(`https://api.themoviedb.org/3${urlPath}`);
  url.searchParams.set('api_key', key);
  Object.entries(query || {}).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });
  try {
    const r = await fetch(url);
    const body = await r.json();
    if (!r.ok) return res.status(r.status).json(body);
    res.json(body);
  } catch (err) {
    console.error('TMDB proxy error:', err);
    res.status(502).json({ error: 'Could not reach TMDB' });
  }
}

app.get('/api/tmdb/search', (req, res) => {
  tmdbFetch(res, '/search/movie', { query: req.query.query, include_adult: 'false' });
});
app.get('/api/tmdb/movie/:id/credits', (req, res) => {
  tmdbFetch(res, `/movie/${encodeURIComponent(req.params.id)}/credits`);
});
app.get('/api/tmdb/movie/:id/videos', (req, res) => {
  tmdbFetch(res, `/movie/${encodeURIComponent(req.params.id)}/videos`);
});

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Reel Shelf server listening on port ${PORT}`);
});
