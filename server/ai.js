const db = require('./db');

// Defaults as of mid-2026. Both are overridable from Settings without a code
// change, in case OpenAI renames/retires these later.
const DEFAULT_CHAT_MODEL = 'gpt-5.4-mini';
const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row && row.value ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value);
}

function getOpenAiKey() {
  return getSetting('openai_api_key', '');
}
function getChatModel() {
  return getSetting('openai_chat_model', DEFAULT_CHAT_MODEL);
}
function getEmbedModel() {
  return getSetting('openai_embed_model', DEFAULT_EMBED_MODEL);
}

class AiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 502;
  }
}

/**
 * Calls OpenAI's chat completions endpoint and returns the parsed JSON body
 * of the assistant's reply. `responseSchema`, if given, requests strict
 * JSON-schema-constrained output so we get back parseable structured data
 * instead of freeform prose.
 */
async function chatComplete({ system, user, responseSchema, schemaName, temperature }) {
  const key = getOpenAiKey();
  if (!key) throw new AiError('No OpenAI API key configured', 400);

  const body = {
    model: getChatModel(),
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    temperature: temperature !== undefined ? temperature : 0.4,
  };

  if (responseSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: schemaName || 'response', strict: true, schema: responseSchema },
    };
  }

  let r;
  try {
    r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new AiError('Could not reach OpenAI', 502);
  }

  const json = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = (json && json.error && json.error.message) || `OpenAI error (${r.status})`;
    throw new AiError(msg, r.status);
  }

  const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) throw new AiError('OpenAI returned an empty response', 502);

  if (responseSchema) {
    try {
      return JSON.parse(content);
    } catch (err) {
      throw new AiError('OpenAI returned malformed JSON', 502);
    }
  }
  return content;
}

/**
 * Embeds a batch of strings in one request. Returns an array of vectors in
 * the same order as the input. Empty/blank strings get a null placeholder
 * rather than being sent to the API.
 */
async function embedBatch(texts) {
  const key = getOpenAiKey();
  if (!key) throw new AiError('No OpenAI API key configured', 400);

  const cleaned = texts.map(t => (t || '').toString().trim());
  const nonEmptyIdx = [];
  const nonEmptyTexts = [];
  cleaned.forEach((t, i) => {
    if (t) { nonEmptyIdx.push(i); nonEmptyTexts.push(t); }
  });
  if (nonEmptyTexts.length === 0) return cleaned.map(() => null);

  let r;
  try {
    r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: getEmbedModel(), input: nonEmptyTexts }),
    });
  } catch (err) {
    throw new AiError('Could not reach OpenAI', 502);
  }

  const json = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = (json && json.error && json.error.message) || `OpenAI error (${r.status})`;
    throw new AiError(msg, r.status);
  }

  const vectors = (json.data || []).sort((a, b) => a.index - b.index).map(d => d.embedding);
  const out = cleaned.map(() => null);
  nonEmptyIdx.forEach((origIdx, i) => { out[origIdx] = vectors[i] || null; });
  return out;
}

async function embedOne(text) {
  const [v] = await embedBatch([text]);
  return v;
}

/** Standard cosine similarity between two equal-length numeric vectors. */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Text used to embed a library item — what it "means" for semantic matching. */
function itemEmbeddingText(item) {
  return [
    item.title,
    item.year,
    (item.genres || []).join(', '),
    (item.vibes || []).join(', '),
    (item.actors || []).join(', '),
    item.notes,
  ].filter(Boolean).join(' — ');
}

module.exports = {
  AiError,
  getOpenAiKey,
  getChatModel,
  getEmbedModel,
  setSetting,
  chatComplete,
  embedBatch,
  embedOne,
  cosineSimilarity,
  itemEmbeddingText,
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBED_MODEL,
};
