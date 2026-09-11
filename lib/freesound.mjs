// Freesound apiv2 client.
//
// Token auth only: this app reads search results and the mp3 *previews* that
// come back with them, and neither needs OAuth2 — that is required for
// downloading originals, rating and commenting, none of which happen here.
// Docs: https://freesound.org/docs/api/resources_apiv2.html
//
// The endpoint is `/apiv2/search/`. The older `/apiv1/search/text` was
// deprecated in November 2025 and currently redirects here; some pages of
// Freesound's own docs still show the old path.

const API = 'https://freesound.org/apiv2';

// Explicit `fields` on every call. Freesound's docs open with the warning that
// omitting it gives you id,name,tags,username,license and nothing else — so a
// board would need a second request per result just to find its preview URL.
export const SOUND_FIELDS =
  'id,name,url,username,license,duration,previews,images,tags,avg_rating,num_downloads';

const MAX_PAGE_SIZE = 150; // Freesound's own cap
const DEFAULT_TIMEOUT_MS = 15000;

export class FreesoundError extends Error {
  constructor(message, status, { retryAfter = null } = {}) {
    super(message);
    this.name = 'FreesoundError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/**
 * True for URLs this app is willing to fetch. Preview and waveform URLs come
 * back inside API responses, but a board pad can also be created from a
 * client-supplied body, so every outbound fetch is checked against the same
 * allowlist rather than trusted because of where it was read from.
 */
export function isFreesoundUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return u.hostname === 'freesound.org' || u.hostname.endsWith('.freesound.org');
}

async function call(apiKey, path, params, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!apiKey) throw new FreesoundError('No Freesound API key configured', 503);
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  // The key goes in a header, never in the query string: a URL is logged by
  // every proxy it passes through, and a header is not.
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Token ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const why = err?.name === 'TimeoutError' ? 'timed out' : 'unreachable';
    throw new FreesoundError(`Freesound ${why}`, 504);
  }
  if (res.ok) return res.json();

  const detail = await res.text().catch(() => '');
  const short = detail.slice(0, 200).replace(/\s+/g, ' ').trim();
  if (res.status === 401 || res.status === 403) {
    throw new FreesoundError('Freesound rejected the API key', 502);
  }
  if (res.status === 404) throw new FreesoundError('No such sound on Freesound', 404);
  if (res.status === 429) {
    throw new FreesoundError('Freesound rate limit reached — try again shortly', 429, {
      retryAfter: Number(res.headers.get('retry-after')) || 60,
    });
  }
  throw new FreesoundError(`Freesound returned ${res.status}${short ? `: ${short}` : ''}`, 502);
}

/** Text search. Returns { count, next, previous, results }. */
export function search(apiKey, { query = '', page = 1, pageSize = 30, filter = '', sort = 'score' } = {}) {
  return call(apiKey, '/search/', {
    query,
    page: Math.max(1, Math.min(200, Number(page) || 1)),
    page_size: Math.max(1, Math.min(MAX_PAGE_SIZE, Number(pageSize) || 30)),
    filter,
    sort,
    fields: SOUND_FIELDS,
  });
}

/** One sound's canonical metadata. */
export function sound(apiKey, id) {
  if (!Number.isInteger(id) || id <= 0) throw new FreesoundError('Bad sound id', 400);
  return call(apiKey, `/sounds/${id}/`, { fields: SOUND_FIELDS });
}

/**
 * Pick the mp3 preview to cache. hq is ~128kbps, lq ~64kbps; both are mp3, so
 * either plays everywhere. ogg is ignored — one format keeps the cache and the
 * Content-Type simple.
 */
export function previewUrl(previews) {
  const url = previews?.['preview-hq-mp3'] || previews?.['preview-lq-mp3'] || '';
  return isFreesoundUrl(url) ? url : '';
}

/**
 * Reduce an API sound object to what a board pad stores. Everything here is
 * either needed to play the sound or needed to credit it — Freesound's CC BY
 * clips require the author, the title, the licence and a link back, so those
 * four are not optional extras.
 */
export function toSound(raw) {
  const id = Number(raw?.id);
  if (!Number.isInteger(id) || id <= 0) throw new FreesoundError('Freesound returned a sound with no id', 502);
  const preview = previewUrl(raw?.previews);
  if (!preview) throw new FreesoundError(`Sound ${id} has no mp3 preview to play`, 422);
  return {
    id,
    name: String(raw?.name ?? `Sound ${id}`).slice(0, 200),
    username: String(raw?.username ?? 'unknown').slice(0, 100),
    license: String(raw?.license ?? '').slice(0, 200),
    url: isFreesoundUrl(raw?.url) ? raw.url : `https://freesound.org/s/${id}/`,
    duration: Number(raw?.duration) || 0,
    previewUrl: preview,
    waveform: isFreesoundUrl(raw?.images?.waveform_m) ? raw.images.waveform_m : '',
    tags: Array.isArray(raw?.tags) ? raw.tags.slice(0, 12).map((t) => String(t).slice(0, 40)) : [],
  };
}

/**
 * What a licence obliges a board to do. Freesound returns one of three names
 * — "Creative Commons 0", "Attribution", "Attribution NonCommercial" — but
 * some responses carry a deed URL instead, so both shapes are read. Version
 * numbers are deliberately not inferred: clips uploaded under CC BY 3.0 and
 * 4.0 both come back as "Attribution", and the sound's own page is the
 * authority. Anything unrecognised is treated as the strictest case.
 */
export function licenseInfo(license) {
  const s = String(license ?? '').toLowerCase();
  const has = (...needles) => needles.some((n) => s.includes(n));
  if (has('creative commons 0', 'publicdomain/zero', '/zero/', 'cc0')) {
    return { key: 'cc0', label: 'CC0', attribution: false, commercial: true };
  }
  if (has('noncommercial', '/by-nc')) {
    return { key: 'by-nc', label: 'CC BY-NC', attribution: true, commercial: false };
  }
  if (has('attribution', '/by/')) {
    return { key: 'by', label: 'CC BY', attribution: true, commercial: true };
  }
  return { key: 'unknown', label: license ? String(license) : 'unknown', attribution: true, commercial: false };
}
