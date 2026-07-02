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

app.post('/api/library', async (req, res) => {
  const data = normalizeIncoming(req.body || {});
  if (!data.title) return res.status(400).json({ error: 'Title is required' });

  // Auto-tag vibes on creation, but only if the caller didn't already supply
  // some (respects an explicit manual/Suggest-button selection) and a key
  // is configured. Failure here is non-fatal — the title still gets saved.
  if (data.vibes === '[]' && ai.getOpenAiKey()) {
    try {
      const vibes = await ai.suggestVibes({ title: data.title, overview: data.notes, genres: JSON.parse(data.genres) });
      if (vibes.length) data.vibes = JSON.stringify(vibes);
    } catch (err) {
      console.warn('Auto-tag on create failed (non-fatal):', err.message);
    }
  }

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
async function tmdbApiGet(urlPath, query) {
  const key = getTmdbKey();
  if (!key) throw new ai.AiError('No TMDB API key configured', 400);
  const url = new URL(`https://api.themoviedb.org/3${urlPath}`);
  url.searchParams.set('api_key', key);
  Object.entries(query || {}).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });
  let r;
  try {
    r = await fetch(url);
  } catch (err) {
    throw new ai.AiError('Could not reach TMDB', 502);
  }
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new ai.AiError((body && body.status_message) || `TMDB error (${r.status})`, r.status);
  return body;
}

async function tmdbFetch(res, urlPath, query) {
  try {
    const body = await tmdbApiGet(urlPath, query);
    res.json(body);
  } catch (err) {
    const status = err instanceof ai.AiError ? err.status : 502;
    res.status(status).json({ error: err.message || 'Could not reach TMDB' });
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

// Must stay in sync with the FORMATS list in public/index.html.
const ALLOWED_FORMATS = ["DVD", "Blu-ray", "Blu-ray Ultra 4K", "Apple TV Digital 4K", "Fandango at Home", "Prime Video", "Movies Anywhere"];

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

    const vibes = await ai.suggestVibes({ title, overview, genres });
    res.json({ vibes });
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

// Backfills vibe tags for every title that doesn't have any yet. Runs with
// limited concurrency (a handful of in-flight OpenAI requests at a time)
// rather than one giant batch — chat completions aren't batchable the way
// embeddings are, so this is a pool of individual calls instead.
app.post('/api/ai/tag-missing', async (req, res) => {
  try {
    if (!ai.getOpenAiKey()) return res.status(400).json({ error: 'No OpenAI API key configured' });

    const items = db.prepare("SELECT * FROM items WHERE vibes = '[]' OR vibes IS NULL").all().map(rowToItem);
    if (items.length === 0) return res.json({ tagged: 0, failed: 0, total: 0 });

    const update = db.prepare('UPDATE items SET vibes=@vibes WHERE id=@id');
    let tagged = 0;
    let failed = 0;
    let nextIndex = 0;
    const CONCURRENCY = 4;

    async function worker() {
      while (nextIndex < items.length) {
        const item = items[nextIndex++];
        try {
          const vibes = await ai.suggestVibes({ title: item.title, overview: item.notes, genres: item.genres });
          if (vibes.length) {
            update.run({ id: item.id, vibes: JSON.stringify(vibes) });
            tagged++;
          }
        } catch (err) {
          failed++;
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    res.json({ tagged, failed, total: items.length });
  } catch (err) {
    handleAiError(res, err);
  }
});

// Loosely-normalized title match, used to keep TMDB-verified suggestions
// from colliding with existing library entries that have odd punctuation,
// accents, or curly quotes. Mirrors the client-side duplicate-detection logic.
function normalizeTitleForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[:\-\u2013\u2014,.'"!?()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Suggests brand-new titles (not already in the library) for the wishlist,
// based on the person's existing taste (genres/vibes/actors they gravitate
// toward). Unlike /api/ai/recommend, which only picks among titles already
// in the database, this asks the model to draw on its general knowledge —
// so every suggestion gets verified against TMDB before being returned,
// to guard against hallucinated titles and to get real poster/id data.
app.post('/api/ai/discover', async (req, res) => {
  try {
    if (!ai.getOpenAiKey()) return res.status(400).json({ error: 'No OpenAI API key configured' });
    if (!getTmdbKey()) return res.status(400).json({ error: 'No TMDB API key configured — needed to verify suggestions are real movies' });

    const guidance = ((req.body && req.body.guidance) || '').toString().trim();
    const items = db.prepare('SELECT * FROM items').all().map(rowToItem);
    if (items.length === 0) {
      return res.status(400).json({ error: 'Add a few titles first so there is some taste to learn from' });
    }

    const rankByFrequency = (arr) => {
      const counts = {};
      arr.forEach(x => { counts[x] = (counts[x] || 0) + 1; });
      return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    };
    const topGenres = rankByFrequency(items.flatMap(it => it.genres || [])).slice(0, 6);
    const topVibes = rankByFrequency(items.flatMap(it => it.vibes || [])).slice(0, 6);
    const topActors = rankByFrequency(items.flatMap(it => it.actors || [])).slice(0, 8);
    const ownedList = items.map(it => `${it.title}${it.year ? ` (${it.year})` : ''}`).join(', ');

    const schema = {
      type: 'object',
      properties: {
        suggestions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              year: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['title', 'year', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['suggestions'],
      additionalProperties: false,
    };

    const result = await ai.chatComplete({
      system: `You recommend real, existing movies for someone to add to their wishlist, based on their taste. Suggest up to 8 real films they don't already own — never invent a title. Do not suggest anything from their "already owned" list (match loosely — different formatting of the same film still counts as already owned). For each suggestion give a specific, short reason tied to their actual taste (favorite genres/vibes/actors), not generic praise.`,
      user: `Favorite genres: ${topGenres.join(', ') || 'not enough data yet'}\nFavorite vibes: ${topVibes.join(', ') || 'not enough data yet'}\nFrequently appearing actors: ${topActors.join(', ') || 'not enough data yet'}\n${guidance ? `Extra guidance from the person: "${guidance}"\n` : ''}\nAlready owned / on wishlist (do not suggest these):\n${ownedList}`,
      responseSchema: schema,
      schemaName: 'wishlist_suggestions',
    });

    const raw = result.suggestions || [];
    const ownedTmdbIds = new Set(items.map(it => it.tmdbId).filter(Boolean).map(String));
    const ownedNormalizedTitles = new Set(items.map(it => `${normalizeTitleForMatch(it.title)}|${it.year || ''}`));

    // Verify each suggestion against TMDB (catches hallucinated titles) and
    // enrich with real poster/id data, with a small worker pool since chat
    // suggestions arrive one at a time rather than as a single batch call.
    const enriched = [];
    let nextIndex = 0;
    const CONCURRENCY = 4;
    async function worker() {
      while (nextIndex < raw.length) {
        const s = raw[nextIndex++];
        if (!s || !s.title) continue;
        try {
          const searchBody = await tmdbApiGet('/search/movie', { query: s.title, include_adult: 'false' });
          const candidates = searchBody.results || [];
          if (candidates.length === 0) continue;
          let match = candidates[0];
          if (s.year) {
            const withMatchingYear = candidates.find(c => (c.release_date || '').slice(0, 4) === s.year);
            if (withMatchingYear) match = withMatchingYear;
          }
          const matchYear = (match.release_date || '').slice(0, 4);
          if (ownedTmdbIds.has(String(match.id))) continue;
          if (ownedNormalizedTitles.has(`${normalizeTitleForMatch(match.title)}|${matchYear}`)) continue;
          enriched.push({
            tmdbId: String(match.id),
            title: match.title,
            year: matchYear,
            posterPath: match.poster_path || null,
            reason: s.reason || '',
          });
        } catch (err) {
          // Skip anything TMDB couldn't verify — better to under-suggest than to hallucinate a title.
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, raw.length) }, worker));

    // De-dupe in case the model suggested near-identical titles that both resolved to the same film.
    const seen = new Set();
    const deduped = enriched.filter(s => {
      if (seen.has(s.tmdbId)) return false;
      seen.add(s.tmdbId);
      return true;
    });

    res.json({ suggestions: deduped.slice(0, 8) });
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
