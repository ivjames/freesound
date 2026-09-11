// On-disk cache of Freesound mp3 previews, under data/audio/<soundId>.mp3.
//
// Why cache at all, rather than letting the browser hit Freesound's CDN
// directly? Three reasons, in order of how much they matter:
//
//   1. A board is a performance instrument. A pad that has to round-trip to a
//      third-party CDN before it makes a noise is not one.
//   2. It decouples a saved board from Freesound's uptime, rate limits and
//      whether a clip is still published. A board that stops working because
//      someone deleted a sound six months ago is a bad board.
//   3. The docs do not promise that preview URLs are fetchable without the API
//      key, so serving them from here is the option that works either way.
//
// The cache is derived state, not data: deleting data/audio/ costs nothing but
// a re-fetch. Attribution lives in the board JSON, never here.

import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { rename, stat, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FreesoundError, isFreesoundUrl } from './freesound.mjs';

const MAX_BYTES_PER_SOUND = 12 * 1024 * 1024; // an hq mp3 preview is far under this
const FETCH_TIMEOUT_MS = 30000;

export class AudioCache {
  #dir;
  #maxBytes;
  #inflight = new Map(); // soundId -> promise, so N pads of one sound fetch once

  constructor(dataDir, { maxMb = 512 } = {}) {
    this.#dir = join(dataDir, 'audio');
    this.#maxBytes = Math.max(16, Number(maxMb) || 512) * 1024 * 1024;
    mkdirSync(this.#dir, { recursive: true });
  }

  path(soundId) {
    if (!Number.isInteger(soundId) || soundId <= 0) throw new FreesoundError('Bad sound id', 400);
    return join(this.#dir, `${soundId}.mp3`);
  }

  async stat(soundId) {
    try {
      return await stat(this.path(soundId));
    } catch {
      return null;
    }
  }

  /** A read stream plus the metadata a 200/206 response needs, or null. */
  async open(soundId, { start, end } = {}) {
    const st = await this.stat(soundId);
    if (!st) return null;
    const etag = `"${createHash('sha1').update(`${soundId}:${st.size}:${st.mtimeMs}`).digest('hex')}"`;
    const from = start ?? 0;
    const to = end ?? st.size - 1;
    return { size: st.size, etag, from, to, stream: createReadStream(this.path(soundId), { start: from, end: to }) };
  }

  /**
   * Ensure the preview for `soundId` is on disk. `url` must be a Freesound
   * URL — checked here as well as at the call site, because this is the only
   * place that turns a string into an outbound request and a second look costs
   * nothing.
   */
  async ensure(soundId, url) {
    const existing = await this.stat(soundId);
    if (existing && existing.size > 0) return existing.size;

    const running = this.#inflight.get(soundId);
    if (running) return running;

    const job = this.#download(soundId, url).finally(() => this.#inflight.delete(soundId));
    this.#inflight.set(soundId, job);
    return job;
  }

  async #download(soundId, url) {
    if (!isFreesoundUrl(url)) throw new FreesoundError('Refusing to fetch audio from a non-Freesound URL', 400);
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      const why = err?.name === 'TimeoutError' ? 'timed out' : 'unreachable';
      throw new FreesoundError(`Freesound preview ${why}`, 504);
    }
    if (!res.ok) throw new FreesoundError(`Freesound preview returned ${res.status}`, 502);

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES_PER_SOUND) {
      throw new FreesoundError('Freesound preview is larger than this cache allows', 502);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) throw new FreesoundError('Freesound preview was empty', 502);
    if (buf.byteLength > MAX_BYTES_PER_SOUND) {
      throw new FreesoundError('Freesound preview is larger than this cache allows', 502);
    }

    const target = this.path(soundId);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, buf);
    try {
      await rename(tmp, target);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    return buf.byteLength;
  }

  async size() {
    let bytes = 0;
    let files = 0;
    for (const name of await readdir(this.#dir).catch(() => [])) {
      if (!name.endsWith('.mp3')) continue;
      const st = await stat(join(this.#dir, name)).catch(() => null);
      if (st) {
        bytes += st.size;
        files += 1;
      }
    }
    return { bytes, files, maxBytes: this.#maxBytes };
  }

  /**
   * Drop cached audio no board references any more, oldest first, until the
   * cache is under its ceiling. Referenced sounds are never evicted — a pad
   * whose audio has been swept is a broken pad, and the whole point of the
   * cache is that a saved board keeps working.
   */
  async sweep(keepIds) {
    const entries = [];
    for (const name of await readdir(this.#dir).catch(() => [])) {
      const m = /^(\d+)\.mp3$/.exec(name);
      if (!m) continue;
      const st = await stat(join(this.#dir, name)).catch(() => null);
      if (st) entries.push({ id: Number(m[1]), name, size: st.size, atime: st.atimeMs });
    }
    let total = entries.reduce((n, e) => n + e.size, 0);
    if (total <= this.#maxBytes) return { removed: 0, bytes: total };

    let removed = 0;
    const evictable = entries.filter((e) => !keepIds.has(e.id)).sort((a, b) => a.atime - b.atime);
    for (const entry of evictable) {
      if (total <= this.#maxBytes) break;
      if (await unlink(join(this.#dir, entry.name)).then(() => true, () => false)) {
        total -= entry.size;
        removed += 1;
      }
    }
    return { removed, bytes: total };
  }
}
