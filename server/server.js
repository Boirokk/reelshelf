const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const ai = require('./ai');

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
    vibes: JSON.parse(row.vibes || '[]'),
    addedAt: row.addedAt,
  };
}

// Same as rowToItem, but also carries the parsed embedding vector — used
// internally by the AI routes, never sent to the browser (it's just a big
// array of floats with no use on the client, and no reason to ship it).
function rowToInternal(row) {
  const item = rowToItem(row);
  item.embedding = row.embedding ? JSON.parse(row.embedding) : null;
  return item;
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
    vibes: JSON.stringify(Array.isArray(data.vibes) ? data.vibes : (base.vibes || [])),
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
    INSERT INTO items (id, title, status, year, formats, genres, vibes, actors, location, quality, trailerKey, notes, posterPath, tmdbId, addedAt)
    VALUES (@id, @title, @status, @year, @formats, @genres, @vibes, @actors, @location, @quality, @trailerKey, @notes, @posterPath, @tmdbId, @addedAt)
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
    UPDATE items SET title=@title, status=@status, year=@year, formats=@formats, genres=@genres, vibes=@vibes,
      actors=@actors, location=@location, quality=@quality, trailerKey=@trailerKey, notes=@notes, posterPath=@posterPath, tmdbId=@tmdbId,
      embedding=''
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
    INSERT INTO items (id, title, status, year, formats, genres, vibes, actors, location, quality, trailerKey, notes, posterPath, tmdbId, addedAt)
    VALUES (@id, @title, @status, @year, @formats, @genres, @vibes, @actors, @location, @quality, @trailerKey, @notes, @posterPath, @tmdbId, @addedAt)
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

// ---------- settings (TMDB + OpenAI keys) ----------
app.get('/api/settings', (req, res) => {
  res.json({
    hasTmdbKey: !!getTmdbKey(),
    hasOpenAiKey: !!ai.getOpenAiKey(),
    chatModel: ai.getChatModel(),
    embedModel: ai.getEmbedModel(),
  });
});

app.post('/api/settings/tmdb', (req, res) => {
  const key = req.body && req.body.tmdbKey;
  if (typeof key === 'string' && key.trim()) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('tmdb_api_key', key.trim());
  }
  res.json({ hasTmdbKey: !!getTmdbKey() });
});

app.post('/api/settings/openai', (req, res) => {
  const key = req.body && req.body.openaiKey;
  if (typeof key === 'string' && key.trim()) {
    ai.setSetting('openai_api_key', key.trim());
  }
  if (typeof (req.body && req.body.chatModel) === 'string' && req.body.chatModel.trim()) {
    ai.setSetting('openai_chat_model', req.body.chatModel.trim());
  }
  if (typeof (req.body && req.body.embedModel) === 'string' && req.body.embedModel.trim()) {
    ai.setSetting('openai_embed_model', req.body.embedModel.trim());
  }
  res.json({ hasOpenAiKey: !!ai.getOpenAiKey(), chatModel: ai.getChatModel(), embedModel: ai.getEmbedModel() });
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

// ---------- AI features (OpenAI proxy — key never leaves the server) ----------

// Must stay in sync with FORMATS/GENRES-equivalent lists in public/index.html.
const ALLOWED_FORMATS = ["DVD", "Blu-ray", "Blu-ray Ultra 4K", "Apple TV Digital 4K", "Fandango at Home", "Prime Video", "Movies Anywhere"];
const VIBE_TAGS = ["Cozy", "Feel-Good", "Funny", "Heartwarming", "Tense", "Dark", "Mind-Bending", "Nostalgic", "Kid-Friendly", "Date Night", "Slow Burn", "Popcorn Flick", "Visually Stunning", "Award-Worthy", "Based on a True Story", "Based on a Book", "Rewatchable"];

function handleAiError(res, err) {
  console.error('AI error:', err);
  const status = err instanceof ai.AiError ? err.status : 500;
  res.status(status).json({ error: err.message || 'AI request failed' });
}

// Computes and persists embeddings for any of the given (internal) items
// that don't already have one. Mutates each item's `.embedding` in place so
// callers can use the fresh vectors immediately in the same request.
async function ensureEmbeddings(items) {
  const missing = items.filter(it => !it.embedding);
  if (missing.length === 0) return;
  const texts = missing.map(it => ai.itemEmbeddingText(it));
  const vectors = await ai.embedBatch(texts);
  const update = db.prepare('UPDATE items SET embedding=@embedding WHERE id=@id');
  missing.forEach((it, i) => {
    const vec = vectors[i];
    if (vec) {
      it.embedding = vec;
      update.run({ id: it.id, embedding: JSON.stringify(vec) });
    }
  });
}

app.post('/api/ai/parse-add', async (req, res) => {
  try {
    const text = ((req.body && req.body.text) || '').toString().trim();
    if (!text) return res.status(400).json({ error: 'text is required' });

    const schema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              year: { type: 'string' },
              format: { type: 'string', enum: [...ALLOWED_FORMATS, ''] },
              status: { type: 'string', enum: ['shelf', 'wishlist'] },
            },
            required: ['title', 'year', 'format', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    };

    const result = await ai.chatComplete({
      system: `Extract a list of movies from free text describing what someone wants to add to their movie collection app. For each movie extract: title; year (4-digit string, "" if not mentioned); format (best match from exactly these options: ${ALLOWED_FORMATS.join(', ')} — use "" if not mentioned or unclear); and status ("wishlist" if they want it / don't own it yet, otherwise "shelf"). Split multiple movies into separate items.`,
      user: text,
      responseSchema: schema,
      schemaName: 'parsed_titles',
    });

    res.json({ items: result.items || [] });
  } catch (err) {
    handleAiError(res, err);
  }
});

app.post('/api/ai/tag', async (req, res) => {
  try {
    const title = ((req.body && req.body.title) || '').toString().trim();
    if (!title) return res.status(400).json({ error: 'title is required' });
    const overview = ((req.body && req.body.overview) || '').toString();
    const genres = Array.isArray(req.body && req.body.genres) ? req.body.genres : [];

    const schema = {
      type: 'object',
      properties: {
        vibes: { type: 'array', items: { type: 'string', enum: VIBE_TAGS } },
      },
      required: ['vibes'],
      additionalProperties: false,
    };

    const result = await ai.chatComplete({
      system: `Pick 2-5 tags from this fixed list that best describe the mood/vibe of the movie: ${VIBE_TAGS.join(', ')}. Only use tags from that exact list.`,
      user: `Title: ${title}\nGenres: ${genres.join(', ') || 'unknown'}\nOverview: ${overview || 'not available'}`,
      responseSchema: schema,
      schemaName: 'vibe_tags',
      temperature: 0.2,
    });

    res.json({ vibes: (result.vibes || []).filter(v => VIBE_TAGS.includes(v)) });
  } catch (err) {
    handleAiError(res, err);
  }
});

app.post('/api/ai/search', async (req, res) => {
  try {
    const query = ((req.body && req.body.query) || '').toString().trim();
    if (!query) return res.status(400).json({ error: 'query is required' });

    const items = db.prepare('SELECT * FROM items').all().map(rowToInternal);
    await ensureEmbeddings(items);
    const queryVec = await ai.embedOne(query);
    if (!queryVec) return res.status(502).json({ error: 'Could not embed the search query' });

    const results = items
      .filter(it => it.embedding)
      .map(it => ({ id: it.id, score: ai.cosineSimilarity(queryVec, it.embedding) }))
      .sort((a, b) => b.score - a.score);

    res.json({ results });
  } catch (err) {
    handleAiError(res, err);
  }
});

app.post('/api/ai/recommend', async (req, res) => {
  try {
    const mood = ((req.body && req.body.mood) || '').toString().trim();
    if (!mood) return res.status(400).json({ error: 'mood is required' });
    const scope = (req.body && req.body.status === 'wishlist') ? 'wishlist' : 'shelf';

    const items = db.prepare('SELECT * FROM items WHERE status = ?').all(scope).map(rowToInternal);
    if (items.length === 0) {
      return res.status(400).json({ error: `Nothing in your ${scope === 'wishlist' ? 'wishlist' : 'shelf'} yet` });
    }

    await ensureEmbeddings(items);
    const moodVec = await ai.embedOne(mood);
    if (!moodVec) return res.status(502).json({ error: 'Could not embed your request' });

    const candidates = items
      .filter(it => it.embedding)
      .map(it => ({ item: it, score: ai.cosineSimilarity(moodVec, it.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    if (candidates.length === 0) return res.status(502).json({ error: 'Could not compute recommendations' });

    const candidateList = candidates.map(c => {
      const it = c.item;
      const bits = [`id: ${it.id}`, `"${it.title}"`, `(${it.year || 'unknown year'})`];
      if (it.genres && it.genres.length) bits.push(`genres: ${it.genres.join(', ')}`);
      if (it.vibes && it.vibes.length) bits.push(`vibes: ${it.vibes.join(', ')}`);
      if (it.notes) bits.push(`notes: ${it.notes.slice(0, 200)}`);
      return '- ' + bits.join(' | ');
    }).join('\n');

    const schema = {
      type: 'object',
      properties: {
        message: { type: 'string' },
        picks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['id', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['message', 'picks'],
      additionalProperties: false,
    };

    const result = await ai.chatComplete({
      system: `You help someone pick a movie to watch from their own collection. You'll get a shortlist of candidates (already pre-filtered for relevance) and what they're in the mood for. Pick 1-3 titles from the candidate list that best fit and write a short, warm, specific reason for each — reference what they actually asked for. Only use ids that appear in the candidate list. If genuinely nothing fits, return an empty picks array and explain why in the message.`,
      user: `Mood/criteria: "${mood}"\n\nCandidates:\n${candidateList}`,
      responseSchema: schema,
      schemaName: 'recommendation',
    });

    const candidateIds = new Set(candidates.map(c => c.item.id));
    const picks = (result.picks || []).filter(p => candidateIds.has(p.id));
    res.json({ message: result.message || '', picks });
  } catch (err) {
    handleAiError(res, err);
  }
});

app.post('/api/ai/reindex', async (req, res) => {
  try {
    db.exec("UPDATE items SET embedding = ''");
    const items = db.prepare('SELECT * FROM items').all().map(rowToInternal);
    await ensureEmbeddings(items);
    res.json({ reindexed: items.filter(it => it.embedding).length, total: items.length });
  } catch (err) {
    handleAiError(res, err);
  }
});

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Reel Shelf server listening on port ${PORT}`);
});
