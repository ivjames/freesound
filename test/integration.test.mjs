// The path that actually matters: Freesound's response shape -> a pad -> a
// cached mp3 -> a credit. Everything here is driven through the real modules
// with `fetch` stubbed, so a change to how the API response is read fails a
// test rather than failing on the droplet.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { AudioCache } from '../lib/cache.mjs';
import { BoardStore } from '../lib/store.mjs';
import { creditsFor, creditsMarkdown } from '../lib/credits.mjs';
import { FreesoundError, search, sound, toSound } from '../lib/freesound.mjs';

const MP3 = Buffer.from('ID3fake-mp3-bytes');

// A response in the shape Freesound documents for GET /apiv2/sounds/<id>/.
const soundBody = (id, over = {}) => ({
  id,
  name: `Sound ${id}`,
  url: `https://freesound.org/s/${id}/`,
  username: 'uploader',
  license: 'Attribution',
  duration: 2.5,
  previews: {
    'preview-hq-mp3': `https://cdn.freesound.org/previews/${id}/${id}_x-hq.mp3`,
    'preview-lq-mp3': `https://cdn.freesound.org/previews/${id}/${id}_x-lq.mp3`,
  },
  images: { waveform_m: `https://cdn.freesound.org/displays/${id}/${id}_x_wave_M.png` },
  tags: ['test'],
  ...over,
});

let realFetch;
let calls;
let dataDir;

function stubFetch(handler) {
  globalThis.fetch = async (input, init) => {
    // The real fetch takes a string, a URL or a Request, and this code passes a
    // URL — reading `.url` off one silently yields undefined, which the client
    // then reports as "Freesound unreachable".
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url: href, headers: init?.headers ?? {} });
    return handler(new URL(href), init);
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  realFetch = globalThis.fetch;
  calls = [];
  dataDir = mkdtempSync(join(tmpdir(), 'fsboards-int-'));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('adding a sound to a board', () => {
  it('looks the sound up, caches the mp3, and records the credit', async () => {
    stubFetch((url) => {
      if (url.pathname === '/apiv2/sounds/4242/') return json(soundBody(4242));
      if (url.hostname === 'cdn.freesound.org') return new Response(MP3, { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });

    const store = new BoardStore(dataDir);
    const cache = new AudioCache(dataDir);
    const board = await store.create({ name: 'Show' });

    const canonical = toSound(await sound('key-abc', 4242));
    await cache.ensure(canonical.id, canonical.previewUrl);
    const pad = await store.addPad(board.id, { sound: canonical });

    // The API key travels in a header, never in the URL — a URL is logged by
    // every hop it passes through.
    const lookup = calls.find((c) => c.url.includes('/apiv2/sounds/'));
    assert.equal(lookup.headers.Authorization, 'Token key-abc');
    assert.ok(!lookup.url.includes('key-abc'), 'the key must not appear in the query string');
    assert.match(lookup.url, /fields=/, 'fields is always requested explicitly');

    // The hq preview is the one cached, and it is on disk under the sound id.
    assert.match(calls.at(-1).url, /-hq\.mp3$/);
    assert.deepEqual(readFileSync(cache.path(4242)), MP3);

    // The pad carries everything a credit needs.
    assert.equal(pad.sound.username, 'uploader');
    assert.equal(pad.sound.license, 'Attribution');
    assert.equal(pad.sound.url, 'https://freesound.org/s/4242/');
    assert.equal(pad.key, '1');

    const md = creditsMarkdown(creditsFor(await store.read(board.id)));
    assert.match(md, /Sound 4242/);
    assert.match(md, /by uploader/);
    assert.match(md, /freesound\.org\/s\/4242/);
    assert.match(md, /CC BY/);
  });

  it('fetches a sound\'s audio once even when several pads want it', async () => {
    let downloads = 0;
    stubFetch((url) => {
      if (url.hostname === 'cdn.freesound.org') {
        downloads += 1;
        return new Response(MP3, { status: 200 });
      }
      return json(soundBody(7));
    });

    const cache = new AudioCache(dataDir);
    const canonical = toSound(await sound('k', 7));
    await Promise.all([
      cache.ensure(7, canonical.previewUrl),
      cache.ensure(7, canonical.previewUrl),
      cache.ensure(7, canonical.previewUrl),
    ]);
    await cache.ensure(7, canonical.previewUrl); // and again, now that it is on disk
    assert.equal(downloads, 1);
  });

  it('refuses to fetch audio from a host that is not Freesound', async () => {
    stubFetch(() => {
      throw new Error('must not be called');
    });
    const cache = new AudioCache(dataDir);
    await assert.rejects(() => cache.ensure(9, 'https://evil.example/payload.mp3'), /non-Freesound URL/);
  });

  it('turns Freesound failures into something a user can act on', async () => {
    for (const [status, pattern] of [
      [401, /rejected the API key/],
      [404, /No such sound/],
      [429, /rate limit/],
      [500, /returned 500/],
    ]) {
      stubFetch(() => new Response('nope', { status }));
      await assert.rejects(() => sound('k', 1), (err) => {
        assert.ok(err instanceof FreesoundError);
        assert.match(err.message, pattern);
        return true;
      });
    }
  });

  it('caps the cached file size rather than writing whatever arrives', async () => {
    stubFetch(() => new Response(Buffer.alloc(13 * 1024 * 1024), { status: 200 }));
    const cache = new AudioCache(dataDir);
    await assert.rejects(
      () => cache.ensure(5, 'https://cdn.freesound.org/previews/5/5_x-hq.mp3'),
      /larger than this cache allows/,
    );
    assert.equal(await cache.stat(5), null, 'nothing is left behind on disk');
  });
});

describe('search', () => {
  it('asks for explicit fields and a bounded page size', async () => {
    stubFetch(() => json({ count: 2, next: null, results: [soundBody(1), soundBody(2)] }));
    const page = await search('k', { query: 'horn', pageSize: 9999 });
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, '/apiv2/search/');
    assert.equal(url.searchParams.get('query'), 'horn');
    assert.equal(url.searchParams.get('page_size'), '150', 'clamped to Freesound’s maximum');
    assert.match(url.searchParams.get('fields'), /previews/);
    assert.equal(page.results.length, 2);
  });

  it('drops a result with no mp3 preview instead of offering a pad that cannot play', async () => {
    stubFetch(() => json({ count: 2, next: null, results: [soundBody(1, { previews: {} }), soundBody(2)] }));
    const raw = await search('k', { query: 'x' });
    const usable = raw.results.filter((r) => {
      try {
        toSound(r);
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(usable.length, 1);
    assert.equal(usable[0].id, 2);
  });
});

describe('cache sweep', () => {
  it('never evicts audio a board still references', async () => {
    stubFetch(() => new Response(MP3, { status: 200 }));
    const store = new BoardStore(dataDir);
    const cache = new AudioCache(dataDir, { maxMb: 16 });
    const board = await store.create({ name: 'b' });

    for (const id of [1, 2, 3]) {
      await cache.ensure(id, `https://cdn.freesound.org/previews/${id}/${id}_x-hq.mp3`);
    }
    await store.addPad(board.id, { sound: toSound(soundBody(2)) });

    // Well under the ceiling: a sweep that has nothing to do removes nothing.
    const quiet = await cache.sweep(await store.referencedSoundIds());
    assert.equal(quiet.removed, 0);
    assert.ok(await cache.stat(1), 'unreferenced audio survives while there is room');
    assert.ok(await cache.stat(2));
  });
});
