// Small HTTP helpers. No framework: this app has four kinds of response
// (JSON, a static file, an audio range, a credits download) and a dependency
// tree is a liability on a box where `npm ci` runs on every deploy.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = 64 * 1024;

/**
 * An error whose message is meant for the caller.
 *
 * The distinction the request handler makes is *provenance*, not status code:
 * a message is returned verbatim because this code wrote it for a user to
 * read, and masked because it came from an unexpected throw. That has to hold
 * for 5xx too — "no API key is configured on this install" is a 503 and is
 * exactly what someone setting the site up needs to see.
 */
export class HttpError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    Object.assign(this, extra);
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/** Read a JSON request body, refusing anything oversized or unparseable. */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError('Request body too large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new HttpError('Body must be a JSON object', 400));
        }
        resolve(parsed);
      } catch {
        reject(new HttpError('Body is not valid JSON', 400));
      }
    });
  });
}

/**
 * Serve a file from `root`. The path is normalised and then re-checked against
 * the root prefix — `..` segments and absolute paths both collapse to
 * something outside it, and rejecting after normalising catches encodings that
 * rejecting before it would miss.
 */
export async function serveStatic(root, urlPath, res, { cacheControl } = {}) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const full = normalize(join(root, rel));
  if (full !== root && !full.startsWith(root + sep)) return false;

  let st;
  try {
    st = await stat(full);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;

  const dot = full.lastIndexOf('.');
  const type = TYPES[full.slice(dot).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Cache-Control': cacheControl ?? 'no-cache',
    'Last-Modified': st.mtime.toUTCString(),
  });
  createReadStream(full).pipe(res);
  return true;
}

/** Parse a single-range `Range` header against a known size. */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m) return null;
  const [, startRaw, endRaw] = m;
  if (startRaw === '' && endRaw === '') return null;
  let start;
  let end;
  if (startRaw === '') {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? size - 1 : Number(endRaw);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/** Constant-time secret comparison that does not leak length through timing. */
export function secretEquals(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length === 0 || y.length === 0) return false;
  // timingSafeEqual throws on a length mismatch, which would itself be an
  // oracle — compare fixed-width digests of the two instead.
  if (x.length !== y.length) {
    const pad = Buffer.alloc(Math.max(x.length, y.length));
    const xa = Buffer.concat([x, pad]).subarray(0, pad.length);
    const ya = Buffer.concat([y, pad]).subarray(0, pad.length);
    timingSafeEqual(xa, ya);
    return false;
  }
  return timingSafeEqual(x, y);
}

/**
 * The client's address. nginx is in front, so the socket address is always the
 * loopback proxy; the first entry of X-Forwarded-For is the real client *only
 * because* our own vhost sets that header. If the vhost is ever changed to
 * stop sending it, this falls back to the socket address and the rate limit
 * becomes global rather than per-client — degraded, not bypassed.
 */
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Fixed-window rate limiter, in memory. Enough for one pm2 fork process, which
 * is what this site runs (cluster mode is forbidden by the platform
 * conventions, so there is no second process to share state with).
 */
export class RateLimiter {
  #hits = new Map();
  #limit;
  #windowMs;

  constructor({ limit, windowMs }) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    const timer = setInterval(() => this.#prune(), windowMs);
    timer.unref();
  }

  #prune() {
    const cutoff = Date.now() - this.#windowMs;
    for (const [key, entry] of this.#hits) if (entry.start < cutoff) this.#hits.delete(key);
  }

  /** @returns {{ok: true} | {ok: false, retryAfter: number}} */
  take(key) {
    const now = Date.now();
    const entry = this.#hits.get(key);
    if (!entry || now - entry.start >= this.#windowMs) {
      this.#hits.set(key, { start: now, count: 1 });
      return { ok: true };
    }
    if (entry.count >= this.#limit) {
      return { ok: false, retryAfter: Math.ceil((entry.start + this.#windowMs - now) / 1000) };
    }
    entry.count += 1;
    return { ok: true };
  }
}
