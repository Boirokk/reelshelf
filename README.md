# Reel Shelf — Self-Hosted

Your Reel Shelf app, now backed by a small Node/Express server and a SQLite
file instead of browser localStorage — so every device that points at this
server sees the same shared library, and the TMDB API key is configured
once for everyone.

## Run it (Docker, recommended)

```bash
docker compose up -d --build
```

Then open **http://localhost:8080** (or your server's IP/hostname). The
SQLite database lives in a Docker volume (`reelshelf-data`), so it survives
container restarts and rebuilds.

To use a different port, edit the `ports:` line in `docker-compose.yml`
(left side is the host port, e.g. `"8080:3000"`).

## Run it without Docker

Requires **Node.js 22.13+** (uses the built-in `node:sqlite` module — no
native compilation, no extra system packages needed).

```bash
cd server
npm install
node server.js
```

The app listens on port 3000 by default. Override with `PORT=8000 node server.js`.
Data is stored in `server/data/reelshelf.db` by default; override the
location with `DATA_DIR=/some/path node server.js`.

## First-time setup

1. Open the app in your browser.
2. Click **Settings** (top right), paste a free TMDB API key from
   themoviedb.org → Settings → API, and save. This key is stored
   server-side and shared by everyone using this server — it's never sent
   to client browsers. (Optionally add an OpenAI key in the same panel to
   enable the AI features — see below.)
3. Start adding titles. Anyone who opens the same URL sees the same shelf.

## What changed from the original single-file version

- **Library storage**: moved from browser `localStorage` to a SQLite
  database on the server, via a small REST API (`/api/library`).
- **TMDB API key**: now stored server-side (`/api/settings`) instead of
  per-browser. All TMDB calls (search, cast, trailer) are proxied through
  the server (`/api/tmdb/...`) so the key never reaches the browser.
- **Export/Import**: Export still downloads a JSON backup from your current
  library. Import now uploads into the shared server database (so an
  import is visible to everyone, not just your browser).
- Everything else — the UI, filters, genres, trailer embeds — is unchanged.

## Duplicate detection

When you search TMDB while adding a title, any result you already own (or
have on your wishlist) is marked **"📚 Already in your library/wishlist —
click to open"** in the results list. Clicking it opens that existing
entry's edit card instead of creating a new one. Matching uses the TMDB
movie id when available, falling back to a punctuation/accent/whitespace-
insensitive title (+ year) match for entries added before this feature
existed (or added without a TMDB search).

**Heads up on older entries:** items added before this feature shipped
don't have a stored TMDB id yet, so they rely on the title-match fallback.
It's fairly forgiving (ignores case, accents, curly quotes, colons,
periods, extra spaces), but a title you typed noticeably differently by
hand may still not be recognized. The fix for any specific title: open
that entry, search TMDB, and re-save it — that links a TMDB id and makes
future duplicate detection for it exact.

**Bug fixes (if you're updating from an earlier version of this feature):**
An earlier build stored the TMDB id incorrectly (as `"949.0"` instead of
`"949"`), which silently broke duplicate detection for anything added
right after the feature first shipped. The server now repairs any
already-corrupted ids automatically on startup, and new saves are no
longer affected. Separately, items with no year on record used to match
*any* same-titled search result regardless of year (a false-positive
source, e.g. matching a totally different movie that happens to share a
title) — that's now fixed to require matching years whenever either side
has one on record.

## AI features (optional — needs an OpenAI API key)

Reel Shelf can optionally use OpenAI's API to power four features. None of
this is required — the app works exactly as before if you skip this
section. Add a key under **Settings → OpenAI API Key** to turn it on.

- **✨ What should I watch?** — describe a mood ("something funny but not
  dumb, under 2 hours") and it picks 1–3 titles from your shelf (or
  wishlist) with a short reason for each, based on your own collection —
  not the internet at large.
- **✨ Smart Add** — paste free text like *"add Heat on blu-ray, put Se7en
  and Zodiac on my wishlist"* and it parses out each title, format, and
  status. Nothing gets created automatically — each parsed title opens the
  normal Add flow (with TMDB search pre-run) so you still confirm before
  saving.
- **✨ Vibe tags** — a closed set of mood tags (Cozy, Tense, Date Night,
  Kid-Friendly, etc.) you can assign manually or auto-suggest per title via
  the "✨ Suggest" button in the Add/Edit modal. Filterable via the Vibes
  dropdown, same as Genre.
- **✨ Ask AI (semantic search)** — press Enter in the search bar (or hit
  the "✨ Ask AI" button) to search by meaning instead of exact text match,
  e.g. "tense heist movie" finds relevant titles even if those words never
  appear in your notes.

**How it works technically:** the OpenAI key lives only on the server
(same pattern as the TMDB key) and is used for two things — chat
completions (`gpt-5.4-mini` by default) for recommendations and parsing,
and embeddings (`text-embedding-3-small` by default) for semantic search.
Both model names are overridable under Settings → Advanced if OpenAI
renames or retires one later. Each title's embedding is computed lazily
the first time it's needed and cached in the database; editing a title
invalidates its cached embedding so it's recomputed automatically. A
"Rebuild AI search index" button in Settings lets you force a full
recompute (useful after changing the embedding model).

**Cost:** this is genuinely cheap for a personal library — embeddings cost
fractions of a cent per title, and a single recommendation or Smart Add
request is well under a cent with the default mini/small models. There's
no built-in spending cap, so keep an eye on usage if you have a very large
library or use it very heavily.

## Backing up

Easiest path: use the **Export** button in the app to download a JSON
snapshot any time. For a full database backup, copy the Docker volume's
`reelshelf.db` file (find it with `docker volume inspect reelshelf_reelshelf-data`).

## Notes / things to consider adding later

- There's no authentication — anyone who can reach the URL can view/edit
  the shelf. Fine on a trusted home network; if you expose it to the
  internet, put it behind a reverse proxy with basic auth or a VPN
  (Tailscale, etc.).
- No HTTPS is configured — terminate TLS at a reverse proxy (Caddy, Nginx,
  Traefik) if you're exposing this beyond localhost.
