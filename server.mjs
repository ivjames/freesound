#!/usr/bin/env node
// Freesound Boards — freesound.lab980.com
//
// nginx proxies to this process on 127.0.0.1:$PORT. pm2 keeps it alive in fork
// mode. It holds no framework and no dependencies; see lib/ for the parts.
//
// Two things about the trust model, because they decide the whole route table:
//
//   * The Freesound API key is a metered credential and this vhost is public.
//     So every route that *spends* it — search, and adding a pad, which looks
//     the sound up canonically — sits behind the write token and a rate limit.
//   * Playing an existing board spends nothing: the audio is already cached on
//     disk. So reading and playing a board stays open, and a board you share
//     works for whoever you send it to without handing them your token.
//
// Set FREESOUND_WRITE_TOKEN in .env (`freesound token` generates one) and the
// split above applies. Leave it empty and the site is fully open, which is a
// legitimate choice on a box nobody has found yet and a bad one afterwards;
// /api/health reports which mode it is in.

import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openEnv } from './lib/env.mjs';
import { AudioCache } from './lib/cache.mjs';
import { BoardStore, StoreError, MAX_PADS, PAD_KEYS } from './lib/store.mjs';
import { CREDIT_FORMATS, creditsFor } from './lib/credits.mjs';
import { FreesoundError, licenseInfo, search, sound, toSound } from './lib/freesound.mjs';
import {
  HttpError,
  RateLimiter,
  clientIp,
  parseRange,
  readJsonBody,
  secretEquals,
  sendJson,
  sendText,
  serveStatic,
} from './lib/http.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const DATA = join(ROOT, 'data');
mkdirSync(DATA, { recursive: true });

const env = openEnv(join(ROOT, '.env'));
const PORT = Number(env.get('PORT', '8074'));

const store = new BoardStore(DATA);
const cache = new AudioCache(DATA, { maxMb: Number(env.get('FREESOUND_CACHE_MB', '512')) });

// Two buckets. Search is the expensive one — it is a request to Freesound
// every time — so it is the tighter of the two; board edits only touch local
// disk, apart from the one lookup a new pad makes.
const searchLimit = new RateLimiter({ limit: 60, windowMs: 60_000 });
const writeLimit = new RateLimiter({ limit: 240, windowMs: 60_000 });

const apiKey = () => env.get('FREESOUND_API_KEY');
const writeToken = () => env.get('FREESOUND_WRITE_TOKEN');

/**
 * Authorise a token-gated route. With no token configured every caller passes,
 * which is the documented open mode rather than an accident — /api/health says
 * so out loud so it cannot be mistaken for protection that is working.
 */
function requireToken(req, url) {
  const expected = writeToken();
  if (!expected) return;
  const header = req.headers['x-board-token'];
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  const supplied = (typeof header === 'string' && header) || bearer || url.searchParams.get('token') || '';
  if (!secretEquals(supplied, expected)) {
    throw new HttpError(supplied ? 'That token is not valid' : 'This action needs the board token', 401);
  }
}

function limit(bucket, req, what) {
  const verdict = bucket.take(clientIp(req));
  if (!verdict.ok) {
    throw new HttpError(`Too many ${what} — try again in ${verdict.retryAfter}s`, 429, {
      retryAfter: verdict.retryAfter,
    });
  }
}

// --- routes -----------------------------------------------------------------

async function health() {
  const boards = await store.list();
  const { bytes, files } = await cache.size();
  return {
    ok: true,
    // Names only, never values — the platform rule about keys in argv applies
    // just as much to a health endpoint anyone can curl.
    hasKey: Boolean(apiKey()),
    writeProtected: Boolean(writeToken()),
    boards: boards.length,
    pads: boards.reduce((n, b) => n + b.pads, 0),
    cache: { files, bytes },
    limits: { maxPads: MAX_PADS, padKeys: PAD_KEYS.length },
    node: process.version,
    uptime: Math.round(process.uptime()),
  };
}

async function doSearch(req, url) {
  requireToken(req, url);
  limit(searchLimit, req, 'searches');
  if (!apiKey()) {
    throw new HttpError('No Freesound API key is configured on this install — see DEPLOY.md', 503);
  }
  const query = (url.searchParams.get('q') ?? '').slice(0, 200);
  // Filters are passed through to Freesound's own filter syntax, but only the
  // two this UI offers are constructed here; a caller-supplied filter string
  // is length-capped and otherwise Freesound's problem to parse.
  const filters = [];
  const maxDuration = Number(url.searchParams.get('maxDuration'));
  if (Number.isFinite(maxDuration) && maxDuration > 0) filters.push(`duration:[0 TO ${Math.min(300, maxDuration)}]`);
  if (url.searchParams.get('commercial') === '1') {
    // Exclude NonCommercial clips at the source, so a board built for
    // commercial work cannot accidentally pick one up.
    filters.push('-license:"Attribution NonCommercial"');
  }
  const extra = (url.searchParams.get('filter') ?? '').slice(0, 300);
  if (extra) filters.push(extra);

  const page = Number(url.searchParams.get('page')) || 1;
  const raw = await search(apiKey(), {
    query,
    page,
    pageSize: 30,
    filter: filters.join(' '),
    sort: url.searchParams.get('sort') === 'downloads' ? 'downloads_desc' : 'score',
  });

  const results = [];
  for (const item of raw.results ?? []) {
    try {
      const s = toSound(item);
      results.push({ ...s, licenseInfo: licenseInfo(s.license) });
    } catch {
      // A result with no mp3 preview cannot become a pad, so it is dropped
      // rather than shown as something that will fail on click.
    }
  }
  return { count: raw.count ?? 0, page, hasMore: Boolean(raw.next), results };
}

async function addPad(req, url, boardId) {
  requireToken(req, url);
  limit(writeLimit, req, 'edits');
  const body = await readJsonBody(req);
  const soundId = Number(body.soundId);
  if (!Number.isInteger(soundId) || soundId <= 0) throw new HttpError('soundId must be a Freesound sound id', 400);
  if (!apiKey()) throw new HttpError('No Freesound API key is configured on this install', 503);

  // The sound is looked up here rather than taken from the request body. The
  // client could otherwise hand us any metadata it liked — including a preview
  // URL pointing somewhere that is not Freesound, which is a request this
  // server would then make on its behalf. Attribution has to be what Freesound
  // says it is, for the same reason.
  const canonical = toSound(await sound(apiKey(), soundId));
  await cache.ensure(canonical.id, canonical.previewUrl);

  const pad = await store.addPad(boardId, {
    sound: canonical,
    label: body.label,
    color: body.color,
    key: body.key,
    gain: body.gain,
    loop: body.loop,
  });
  cache.sweep(await store.referencedSoundIds()).catch(() => {});
  return pad;
}

async function serveAudio(req, res, soundId) {
  const open = await cache.open(soundId);
  if (!open) {
    // Not cached means no board has ever used it here. Fetching on demand
    // would let an unauthenticated caller drive arbitrary requests to
    // Freesound, so the answer is a 404 and the fix is to add it to a board.
    throw new HttpError('That sound is not on any board here', 404);
  }
  if (req.headers['if-none-match'] === open.etag) {
    open.stream.destroy();
    res.writeHead(304, { ETag: open.etag });
    return res.end();
  }

  const range = parseRange(req.headers.range, open.size);
  const common = {
    'Content-Type': 'audio/mpeg',
    ETag: open.etag,
    'Accept-Ranges': 'bytes',
    // Immutable: the file is named for a Freesound sound id and its bytes
    // never change, so a board reload should never re-fetch it.
    'Cache-Control': 'public, max-age=31536000, immutable',
  };
  if (!range) {
    res.writeHead(200, { ...common, 'Content-Length': open.size });
    return open.stream.pipe(res);
  }

  open.stream.destroy();
  const partial = await cache.open(soundId, { start: range.start, end: range.end });
  res.writeHead(206, {
    ...common,
    'Content-Length': range.end - range.start + 1,
    'Content-Range': `bytes ${range.start}-${range.end}/${open.size}`,
  });
  return partial.stream.pipe(res);
}

async function serveCredits(res, boardId, format) {
  const spec = CREDIT_FORMATS[format];
  if (!spec) throw new HttpError(`Unknown credits format: ${format}`, 400);
  const board = await store.read(boardId);
  const credits = creditsFor(board);
  const filename = `credits-${board.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40) || board.id}.${spec.ext}`;
  sendText(res, 200, spec.render(credits), spec.type, {
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
}

// --- dispatch ---------------------------------------------------------------

const BOARD_PATH = /^\/api\/boards\/([a-z0-9]+)$/;
const PADS_PATH = /^\/api\/boards\/([a-z0-9]+)\/pads$/;
const PAD_PATH = /^\/api\/boards\/([a-z0-9]+)\/pads\/([a-z0-9]+)$/;
const CREDITS_PATH = /^\/api\/boards\/([a-z0-9]+)\/credits$/;
const AUDIO_PATH = /^\/api\/audio\/(\d+)\.mp3$/;

async function route(req, res, url) {
  const { pathname } = url;
  const method = req.method ?? 'GET';

  if (pathname === '/api/health' && method === 'GET') return sendJson(res, 200, await health());
  if (pathname === '/api/search' && method === 'GET') return sendJson(res, 200, await doSearch(req, url));

  if (pathname === '/api/boards') {
    if (method === 'GET') return sendJson(res, 200, { boards: await store.list() });
    if (method === 'POST') {
      requireToken(req, url);
      limit(writeLimit, req, 'edits');
      const body = await readJsonBody(req);
      return sendJson(res, 201, await store.create({ name: body.name }));
    }
  }

  const audio = AUDIO_PATH.exec(pathname);
  if (audio && (method === 'GET' || method === 'HEAD')) return serveAudio(req, res, Number(audio[1]));

  const credits = CREDITS_PATH.exec(pathname);
  if (credits && method === 'GET') return serveCredits(res, credits[1], url.searchParams.get('format') ?? 'md');

  const board = BOARD_PATH.exec(pathname);
  if (board) {
    if (method === 'GET') return sendJson(res, 200, await store.read(board[1]));
    if (method === 'PATCH') {
      requireToken(req, url);
      limit(writeLimit, req, 'edits');
      return sendJson(res, 200, await store.update(board[1], await readJsonBody(req)));
    }
    if (method === 'DELETE') {
      requireToken(req, url);
      limit(writeLimit, req, 'edits');
      return sendJson(res, 200, await store.remove(board[1]));
    }
  }

  const pads = PADS_PATH.exec(pathname);
  if (pads && method === 'POST') return sendJson(res, 201, await addPad(req, url, pads[1]));

  const pad = PAD_PATH.exec(pathname);
  if (pad) {
    if (method === 'PATCH') {
      requireToken(req, url);
      limit(writeLimit, req, 'edits');
      return sendJson(res, 200, await store.updatePad(pad[1], pad[2], await readJsonBody(req)));
    }
    if (method === 'DELETE') {
      requireToken(req, url);
      limit(writeLimit, req, 'edits');
      return sendJson(res, 200, await store.removePad(pad[1], pad[2]));
    }
  }

  if (pathname.startsWith('/api/')) throw new HttpError('No such endpoint', 404);

  // Static. The SPA owns /b/<id> for sharing a board, so those fall through to
  // index.html rather than 404ing.
  if (method === 'GET' || method === 'HEAD') {
    if (await serveStatic(PUBLIC, pathname === '/' ? '/index.html' : pathname, res)) return undefined;
    if (!pathname.includes('.')) {
      if (await serveStatic(PUBLIC, '/index.html', res)) return undefined;
    }
  }
  throw new HttpError('Not found', 404);
}

const server = createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    return sendJson(res, 400, { error: 'Bad request URL' });
  }

  route(req, res, url).catch((err) => {
    // Whether a message is safe to return is about where it came from, not
    // about its status code. These three classes are ours and every message
    // they carry was written to be read by a user — including 5xx ones like
    // "no API key is configured", which is the most useful thing this server
    // can say on a fresh install. Anything else is an unexpected throw: log it
    // in full here, and answer with a sentence, because a stack trace in an
    // HTTP body is how implementation details leak.
    const ours = err instanceof HttpError || err instanceof StoreError || err instanceof FreesoundError;
    const status = ours ? err.status : (err?.status ?? 500);
    if (!ours) {
      console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname} -> ${status}`, err);
    } else if (status >= 500) {
      // Ours, but still a server-side condition somebody should see in the log.
      console.warn(`[${new Date().toISOString()}] ${req.method} ${url.pathname} -> ${status}: ${err.message}`);
    }
    if (res.headersSent) return res.destroy();
    const headers = err?.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {};
    sendJson(res, status, { error: ours ? err.message : 'Something went wrong on the server' }, headers);
  });
});

// Bind 127.0.0.1 explicitly rather than leaving the host unset. An unset host
// listens on every interface, and on a dual-stack box "localhost" in an nginx
// proxy_pass can resolve to ::1 while the app is on 0.0.0.0 — the loopback
// family mismatch that casino hit. The vhost proxies to 127.0.0.1:<port>, so
// that is what this binds, and nothing outside the box can reach it directly.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`freesound-boards listening on http://127.0.0.1:${PORT}`);
  console.log(`  api key:  ${apiKey() ? 'configured' : 'MISSING — /api/search will 503'}`);
  console.log(`  writes:   ${writeToken() ? 'token required' : 'OPEN — anyone can spend the API key'}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // pm2 sends SIGINT and then SIGKILL after its timeout; do not wait for a
    // slow client to finish a download before letting the restart proceed.
    setTimeout(() => process.exit(0), 4000).unref();
  });
}
