// Board persistence: one JSON file per board under data/boards/.
//
// No SQLite, and therefore no native module. The platform convention is that a
// site's data lives in `data/` inside the app dir, not that it has to be a
// database — and a native dependency here would have to be rebuilt against the
// droplet's Node ABI (MODULE_VERSION 127) on every bump, which is a real cost
// to carry for what is a few dozen small documents.
//
// Writes are atomic (write a sibling temp file, then rename, which is atomic
// within a filesystem) and serialised per board id, so a rename that races a
// read can never expose a half-written board.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BOARD_ID = /^b[0-9a-f]{12}$/;
const PAD_ID = /^p[0-9a-f]{12}$/;
export const MAX_PADS = 64;
const MAX_BOARDS = 200;

// The pad keyboard: digits then the letter rows, so the first pads added land
// under the fingers in a predictable order.
export const PAD_KEYS = [...'1234567890qwertyuiopasdfghjklzxcvbnm'];

export class StoreError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
    // Structured detail the UI can act on — a duplicate rejection carries the
    // pad it collided with, so the page can offer "go to it" rather than only
    // saying no.
    Object.assign(this, extra);
  }
}

const id = (prefix) => prefix + randomBytes(6).toString('hex');
const nowIso = () => new Date().toISOString();

function clampStr(value, max, field) {
  // Strip C0/C1 control characters: these strings are rendered into HTML, a
  // Markdown credits file and an HTTP header-adjacent JSON body, and a stray
  // newline in a pad label is noise in all three.
  const s = String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();
  if (!s) throw new StoreError(`${field} is required`);
  if (s.length > max) throw new StoreError(`${field} must be ${max} characters or fewer`);
  return s;
}

export function normaliseColor(value, fallback = '#3f7fbf') {
  const s = String(value ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : fallback;
}

/**
 * Build a pad from caller input.
 *
 * `sound` is taken from `input` ONLY when there is no existing pad — i.e. on
 * create, where server.mjs has just fetched it from Freesound itself. On update
 * the existing sound is kept and any `sound` in the patch is ignored outright.
 *
 * That asymmetry is the whole point. A pad's sound block IS the attribution:
 * author, title, licence and source URL. If a PATCH body could replace it, any
 * client could credit a CC BY clip to themselves, relabel it CC0, and put a
 * `javascript:` URL into the credit link that both the exported Markdown and
 * the rendered page turn into an anchor. Freesound is the only authority on
 * these fields, so they are only ever written from a lookup.
 *
 * `allowDuplicate` is likewise a request-scoped instruction rather than pad
 * state: read in addPad, never copied into the stored document.
 */
function normalisePad(input, existing = null) {
  const sound = existing ? existing.sound : input.sound;
  if (!sound || !Number.isInteger(sound.id)) throw new StoreError('pad needs a Freesound sound');
  const key = input.key === undefined ? existing?.key ?? '' : String(input.key ?? '').toLowerCase();
  if (key && !PAD_KEYS.includes(key)) throw new StoreError(`"${key}" is not an assignable pad key`);
  const gainRaw = input.gain === undefined ? existing?.gain ?? 1 : Number(input.gain);
  if (!Number.isFinite(gainRaw) || gainRaw < 0 || gainRaw > 2) {
    throw new StoreError('gain must be between 0 and 2');
  }
  return {
    id: existing?.id ?? id('p'),
    label: clampStr(input.label ?? existing?.label ?? sound.name, 40, 'label'),
    color: normaliseColor(input.color ?? existing?.color),
    key,
    gain: Math.round(gainRaw * 100) / 100,
    loop: Boolean(input.loop ?? existing?.loop ?? false),
    added: existing?.added ?? nowIso(),
    sound,
  };
}

export class BoardStore {
  #dir;
  #chain = new Map(); // board id -> tail promise, serialising that board's writes

  constructor(dataDir) {
    this.#dir = join(dataDir, 'boards');
    mkdirSync(this.#dir, { recursive: true });
  }

  /** Locks currently held or queued. Exposed so a test can prove they drain. */
  get pendingLocks() {
    return this.#chain.size;
  }

  #path(boardId) {
    if (!BOARD_ID.test(boardId)) throw new StoreError('No such board', 404);
    return join(this.#dir, `${boardId}.json`);
  }

  /** Run `fn` with exclusive access to one board, so read-modify-write is safe. */
  #locked(boardId, fn) {
    const prev = this.#chain.get(boardId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Never let one caller's rejection poison the next caller's turn.
    const settled = next.then(() => {}, () => {});
    this.#chain.set(boardId, settled);
    // Drop the entry once this is the tail and nothing is queued behind it.
    // Without this the map grows for the lifetime of the process, one entry per
    // distinct id ever seen — and in the documented open mode (no write token)
    // those ids come from unauthenticated requests, including ids that are not
    // boards at all. pm2 keeps this process alive for weeks.
    settled.then(() => {
      if (this.#chain.get(boardId) === settled) this.#chain.delete(boardId);
    });
    return next;
  }

  async #write(board) {
    board.updated = nowIso();
    const target = this.#path(board.id);
    const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, JSON.stringify(board, null, 2), { mode: 0o600 });
    try {
      await rename(tmp, target);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    return board;
  }

  async read(boardId) {
    let text;
    try {
      text = await readFile(this.#path(boardId), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') throw new StoreError('No such board', 404);
      throw err;
    }
    return JSON.parse(text);
  }

  /** Summaries for the picker: no pad bodies, so the list stays small. */
  async list() {
    const files = readdirSync(this.#dir).filter((f) => BOARD_ID.test(f.replace(/\.json$/, '')));
    const boards = [];
    for (const file of files) {
      try {
        const b = JSON.parse(await readFile(join(this.#dir, file), 'utf8'));
        boards.push({
          id: b.id,
          name: b.name,
          pads: b.pads?.length ?? 0,
          created: b.created,
          updated: b.updated,
        });
      } catch {
        // A board that will not parse is skipped rather than failing the whole
        // list: one bad file should not take the site's front page down.
      }
    }
    return boards.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  }

  async create({ name }) {
    if (readdirSync(this.#dir).length >= MAX_BOARDS) {
      throw new StoreError(`This install holds at most ${MAX_BOARDS} boards`, 409);
    }
    const board = {
      id: id('b'),
      name: clampStr(name, 60, 'name'),
      created: nowIso(),
      updated: nowIso(),
      pads: [],
    };
    return this.#locked(board.id, () => this.#write(board));
  }

  update(boardId, patch) {
    return this.#locked(boardId, async () => {
      const board = await this.read(boardId);
      if (patch.name !== undefined) board.name = clampStr(patch.name, 60, 'name');
      if (patch.order !== undefined) {
        if (!Array.isArray(patch.order)) throw new StoreError('order must be an array of pad ids');
        const byId = new Map(board.pads.map((p) => [p.id, p]));
        const seen = new Set();
        const reordered = [];
        for (const padId of patch.order) {
          if (typeof padId !== 'string' || !byId.has(padId) || seen.has(padId)) {
            throw new StoreError('order must list each existing pad id exactly once');
          }
          seen.add(padId);
          reordered.push(byId.get(padId));
        }
        if (reordered.length !== board.pads.length) {
          throw new StoreError('order must list each existing pad id exactly once');
        }
        board.pads = reordered;
      }
      return this.#write(board);
    });
  }

  remove(boardId) {
    return this.#locked(boardId, async () => {
      try {
        await unlink(this.#path(boardId));
      } catch (err) {
        if (err.code === 'ENOENT') throw new StoreError('No such board', 404);
        throw err;
      }
      return { id: boardId, deleted: true };
    });
  }

  addPad(boardId, input) {
    return this.#locked(boardId, async () => {
      const board = await this.read(boardId);
      if (board.pads.length >= MAX_PADS) {
        throw new StoreError(`A board holds at most ${MAX_PADS} pads`, 409);
      }

      // Exact duplicate: this Freesound sound is already on this board. Easy to
      // do by accident — the same airhorn surfaces in two different searches —
      // and the result is two pads that are indistinguishable in use. Refused
      // by default, nameable by the caller when the repeat is deliberate (the
      // same clip on two keys at different gains is a real thing to want).
      const existing = board.pads.find((p) => p.sound?.id === input.sound?.id);
      if (existing && !input.allowDuplicate) {
        throw new StoreError(
          `That clip is already on this board as "${existing.label}"`,
          409,
          { duplicateOf: { padId: existing.id, label: existing.label, soundId: existing.sound.id } },
        );
      }

      const taken = new Set(board.pads.map((p) => p.key).filter(Boolean));
      const pad = normalisePad({
        ...input,
        key: input.key ?? PAD_KEYS.find((k) => !taken.has(k)) ?? '',
      });
      if (pad.key && taken.has(pad.key)) {
        throw new StoreError(`Key "${pad.key}" is already used on this board`, 409);
      }
      board.pads.push(pad);
      await this.#write(board);
      return pad;
    });
  }

  updatePad(boardId, padId, patch) {
    return this.#locked(boardId, async () => {
      if (!PAD_ID.test(padId)) throw new StoreError('No such pad', 404);
      const board = await this.read(boardId);
      const i = board.pads.findIndex((p) => p.id === padId);
      if (i === -1) throw new StoreError('No such pad', 404);
      const pad = normalisePad(patch, board.pads[i]);
      if (pad.key && board.pads.some((p, j) => j !== i && p.key === pad.key)) {
        throw new StoreError(`Key "${pad.key}" is already used on this board`, 409);
      }
      board.pads[i] = pad;
      await this.#write(board);
      return pad;
    });
  }

  removePad(boardId, padId) {
    return this.#locked(boardId, async () => {
      if (!PAD_ID.test(padId)) throw new StoreError('No such pad', 404);
      const board = await this.read(boardId);
      const before = board.pads.length;
      board.pads = board.pads.filter((p) => p.id !== padId);
      if (board.pads.length === before) throw new StoreError('No such pad', 404);
      await this.#write(board);
      return { id: padId, deleted: true };
    });
  }

  /** Sound ids still referenced by some board — what the cache must keep. */
  async referencedSoundIds() {
    const ids = new Set();
    for (const summary of await this.list()) {
      const board = await this.read(summary.id).catch(() => null);
      for (const pad of board?.pads ?? []) ids.add(pad.sound.id);
    }
    return ids;
  }
}
