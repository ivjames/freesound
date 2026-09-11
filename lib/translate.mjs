// Translating clip names to English.
//
// Freesound is international: a third of a results page can be Spanish,
// German, Portuguese or Japanese, and you cannot pick a clip off a list you
// cannot read. So names are translated for *display*.
//
// The attribution constraint is not negotiable and shapes everything here:
// **the credit always uses Freesound's original title, verbatim.** CC BY means
// identifying the work as its author named it, and a board that credits "Door
// Creak" for a clip called "crujido de puerta" is not a correct attribution.
// So a pad stores both — `sound.name` (original, what the credits render) and
// `sound.nameEn` (translation, what the board renders) — and nothing in
// lib/credits.mjs ever reads the translation.
//
// Why an LLM rather than a machine-translation API: these are not sentences.
// They are "Kick_01_bright.wav", "ruido de puerta fuerte", "PORTA_A_02",
// "雨の音". General MT mangles fragments like that and cheerfully "translates"
// strings that are already English. A model can be told to leave English alone,
// strip filename noise, and say when it did nothing.
//
// Translation is an enhancement, never a dependency: every failure path here
// returns the original names. A search must not break because a second API is
// having a bad day.

import Anthropic from '@anthropic-ai/sdk';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Haiku 4.5: $1/MTok in, $5/MTok out. A page of 30 clip names is roughly 600
// input and 400 output tokens — about a quarter of a cent per search page, and
// nothing at all once the cache is warm. Override in .env if you want a
// different model; the task is small enough that this one is the right default.
export const DEFAULT_MODEL = 'claude-haiku-4-5';

const MAX_BATCH = 40;
const TIMEOUT_MS = 30000;
const MAX_NAME = 200;

const SYSTEM = `You translate sound-clip titles from freesound.org into English, for display in a sound board UI.

These are titles users typed when uploading audio. Many are not sentences: they are filenames ("Kick_01_bright.wav"), shorthand ("amb_rain_lp"), or short phrases in any language ("ruido de puerta", "Regen auf Fenster", "雨の音").

For each title, return a short English display name.

Rules:
- If the title is already English, return it unchanged and set translated=false. Do not "improve" it, re-case it, or expand abbreviations.
- If it is not English, translate the meaning into natural English and set translated=true.
- Keep it short — a display label, not a sentence. Match the original's length where you can.
- Strip filename noise that carries no meaning: extensions (.wav, .mp3), and separators used as spaces. KEEP take/variant numbers, because they are how a user tells two clips apart.
- Never invent detail the title does not contain. If a title is opaque ("A02", "sfx_7"), return it unchanged with translated=false rather than guessing what the sound is.
- Transliterate proper nouns and onomatopoeia rather than inventing an English equivalent.

Return one result per input id, with every id echoed back exactly.`;

const SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'the id given in the input' },
          en: { type: 'string', description: 'the English display name' },
          translated: { type: 'boolean', description: 'false if the title was already English and is returned unchanged' },
        },
        required: ['id', 'en', 'translated'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

/**
 * Persistent translation cache, keyed by Freesound sound id.
 *
 * A clip's title never changes, so a translation is good forever — which makes
 * this the difference between paying once per clip and paying every time
 * someone searches for "rain".
 */
class TranslationCache {
  #path;
  #map = new Map();
  #dirty = false;
  #writing = null;

  constructor(dataDir) {
    this.#path = join(dataDir, 'translations.json');
    try {
      const raw = JSON.parse(readFileSync(this.#path, 'utf8'));
      for (const [id, entry] of Object.entries(raw)) this.#map.set(Number(id), entry);
    } catch {
      // No cache yet, or an unreadable one. Either way: start empty and rebuild
      // as clips are looked up. This file is derived, never data.
    }
  }

  get(id) {
    return this.#map.get(id);
  }

  set(id, entry) {
    this.#map.set(id, entry);
    this.#dirty = true;
  }

  get size() {
    return this.#map.size;
  }

  /** Atomic, and serialised so two concurrent searches cannot interleave. */
  async flush() {
    if (!this.#dirty) return;
    if (this.#writing) return this.#writing;
    this.#dirty = false;
    const body = JSON.stringify(Object.fromEntries(this.#map));
    const tmp = `${this.#path}.tmp-${randomBytes(4).toString('hex')}`;
    this.#writing = (async () => {
      try {
        await writeFile(tmp, body);
        await rename(tmp, this.#path);
      } catch {
        await unlink(tmp).catch(() => {});
        this.#dirty = true; // try again on the next flush
      } finally {
        this.#writing = null;
      }
    })();
    return this.#writing;
  }
}

export class Translator {
  #cache;
  #getKey;
  #model;
  #client = null;
  #clientKey = null;

  /**
   * @param {string} dataDir    where the translation cache lives
   * @param {() => string} getKey  reads ANTHROPIC_API_KEY at call time, so a key
   *                               added to .env while the app runs is picked up
   * @param {string} model
   */
  constructor(dataDir, getKey, model = DEFAULT_MODEL) {
    this.#cache = new TranslationCache(dataDir);
    this.#getKey = getKey;
    this.#model = model || DEFAULT_MODEL;
  }

  get available() {
    return Boolean(this.#getKey());
  }

  get model() {
    return this.#model;
  }

  get cached() {
    return this.#cache.size;
  }

  #anthropic() {
    const key = this.#getKey();
    if (!key) return null;
    // Rebuild only when the key actually changes, so editing .env takes effect
    // without leaking a client per request.
    if (!this.#client || this.#clientKey !== key) {
      this.#client = new Anthropic({ apiKey: key, timeout: TIMEOUT_MS, maxRetries: 2 });
      this.#clientKey = key;
    }
    return this.#client;
  }

  /** A cached translation, or undefined. Never calls out. */
  peek(id) {
    return this.#cache.get(id);
  }

  /**
   * Translate a batch of `{id, name}`.
   *
   * Returns a Map of id -> {en, translated}. Ids already cached cost nothing.
   * On any failure the map is simply missing those ids, and the caller falls
   * back to the original name — this never throws.
   */
  async translate(items) {
    const out = new Map();
    const todo = [];
    for (const { id, name } of items) {
      const hit = this.#cache.get(id);
      if (hit) {
        out.set(id, hit);
        continue;
      }
      if (!name) continue;
      todo.push({ id, name: String(name).slice(0, MAX_NAME) });
    }
    if (todo.length === 0) return out;

    const client = this.#anthropic();
    if (!client) return out;

    for (let i = 0; i < todo.length; i += MAX_BATCH) {
      const batch = todo.slice(i, i + MAX_BATCH);
      let results;
      try {
        results = await this.#callModel(client, batch);
      } catch (err) {
        console.warn(`[translate] batch of ${batch.length} failed: ${describe(err)}`);
        continue; // the caller falls back to original names for this batch
      }
      for (const r of results) {
        const entry = { en: r.en, translated: Boolean(r.translated) };
        this.#cache.set(r.id, entry);
        out.set(r.id, entry);
      }
    }
    this.#cache.flush().catch(() => {});
    return out;
  }

  async #callModel(client, batch) {
    const response = await client.messages.parse({
      model: this.#model,
      max_tokens: 4096,
      // No `thinking` block: Haiku 4.5 takes budget_tokens rather than adaptive
      // thinking, and this task does not want reasoning tokens at all.
      // `effort` is not supported on Haiku 4.5 either — passing it errors.
      temperature: 0,
      system: SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(batch) }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    });

    const parsed = response.parsed_output;
    if (!parsed || !Array.isArray(parsed.results)) {
      throw new Error('model returned no parseable results');
    }
    // Only accept ids we actually asked about: the id is echoed by the model,
    // so it is not trustworthy enough to key a cache on without checking.
    const asked = new Set(batch.map((b) => b.id));
    return parsed.results
      .filter((r) => asked.has(Number(r.id)) && typeof r.en === 'string' && r.en.trim())
      .map((r) => ({ id: Number(r.id), en: r.en.trim().slice(0, MAX_NAME), translated: r.translated }));
  }
}

/**
 * Turn an SDK error into one line for the log. The classes are ordered
 * most-specific first; a single broad catch would throw away the distinction
 * between "your key is wrong" (never retry) and "slow down" (retry).
 */
function describe(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'ANTHROPIC_API_KEY rejected';
  if (err instanceof Anthropic.PermissionDeniedError) return 'ANTHROPIC_API_KEY lacks permission';
  if (err instanceof Anthropic.RateLimitError) return 'rate limited by the Anthropic API';
  if (err instanceof Anthropic.BadRequestError) return `bad request: ${err.message}`;
  if (err instanceof Anthropic.InternalServerError) return 'Anthropic API server error';
  if (err instanceof Anthropic.APIConnectionError) return 'could not reach the Anthropic API';
  if (err instanceof Anthropic.APIError) return `Anthropic API error: ${err.message}`;
  return err?.message ?? String(err);
}

/**
 * Attach translations to a list of sounds, in place of nothing — the original
 * `name` is never overwritten. Returns the same array.
 */
export function applyTranslations(sounds, translations) {
  for (const sound of sounds) {
    const hit = translations.get(sound.id);
    // Only set nameEn when it differs from the original: a pad whose title was
    // already English should render one name, not the same name twice.
    if (hit && hit.translated && hit.en && hit.en !== sound.name) sound.nameEn = hit.en;
  }
  return sounds;
}
