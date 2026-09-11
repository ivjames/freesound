// Translation, with the Anthropic SDK's HTTP layer stubbed.
//
// The property that matters most is not "does it translate" — it is that
// nothing here can damage a credit or break a search. So: the original name is
// never overwritten, a failure degrades to the original, and a cached
// translation is reused rather than re-bought.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Translator, applyTranslations, DEFAULT_MODEL } from '../lib/translate.mjs';
import { creditsFor, creditsMarkdown } from '../lib/credits.mjs';

let realFetch;
let calls;
let dataDir;

/** Stub the SDK's transport and answer with a structured-output response. */
function stubModel(handler) {
  globalThis.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ href, body, headers: init?.headers ?? {} });
    const outcome = handler(body, calls.length);
    if (outcome instanceof Response) return outcome;
    return new Response(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: JSON.stringify(outcome) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}

/** What the model was asked to translate on call `n` (1-based). */
const askedOn = (n) => JSON.parse(calls[n - 1].body.messages[0].content);

beforeEach(() => {
  realFetch = globalThis.fetch;
  calls = [];
  dataDir = mkdtempSync(join(tmpdir(), 'fsboards-tr-'));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Translator', () => {
  it('is unavailable without a key, and never calls out', async () => {
    stubModel(() => {
      throw new Error('must not be called');
    });
    const t = new Translator(dataDir, () => '');
    assert.equal(t.available, false);
    assert.equal((await t.translate([{ id: 1, name: 'ruido' }])).size, 0);
    assert.equal(calls.length, 0);
  });

  it('translates a batch and reports which titles actually changed', async () => {
    stubModel(() => ({
      results: [
        { id: 1, en: 'door creak', translated: true },
        { id: 2, en: 'Airhorn', translated: false },
      ],
    }));
    const t = new Translator(dataDir, () => 'key-abc');
    const out = await t.translate([
      { id: 1, name: 'crujido de puerta' },
      { id: 2, name: 'Airhorn' },
    ]);

    assert.equal(out.get(1).en, 'door creak');
    assert.equal(out.get(1).translated, true);
    assert.equal(out.get(2).translated, false);

    assert.equal(calls[0].body.model, DEFAULT_MODEL);
    assert.equal(calls[0].body.output_config.format.type, 'json_schema');
    assert.equal(calls[0].body.temperature, 0);
    // Haiku 4.5 takes budget_tokens rather than adaptive thinking, and rejects
    // `effort` — this task wants neither, so neither may be sent.
    assert.ok(!('thinking' in calls[0].body), 'no thinking block');
    assert.ok(!calls[0].body.output_config.effort, 'no effort setting');
  });

  it('honours an overridden model', async () => {
    stubModel(() => ({ results: [{ id: 1, en: 'x', translated: true }] }));
    const t = new Translator(dataDir, () => 'k', 'claude-sonnet-5');
    await t.translate([{ id: 1, name: 'y' }]);
    assert.equal(calls[0].body.model, 'claude-sonnet-5');
  });

  it('buys each translation once and reuses it afterwards', async () => {
    stubModel(() => ({ results: [{ id: 7, en: 'rain', translated: true }] }));
    const t = new Translator(dataDir, () => 'k');
    await t.translate([{ id: 7, name: 'lluvia' }]);
    await t.translate([{ id: 7, name: 'lluvia' }]);
    assert.equal(calls.length, 1, 'the second lookup is served from cache');
  });

  it('persists the cache, so a restart does not re-buy the catalogue', async () => {
    stubModel(() => ({ results: [{ id: 7, en: 'rain', translated: true }] }));
    const first = new Translator(dataDir, () => 'k');
    await first.translate([{ id: 7, name: 'lluvia' }]);
    // flush() is fire-and-forget in the hot path; wait for it to land.
    await new Promise((r) => setTimeout(r, 20));
    assert.match(readFileSync(join(dataDir, 'translations.json'), 'utf8'), /rain/);

    const second = new Translator(dataDir, () => 'k');
    const out = await second.translate([{ id: 7, name: 'lluvia' }]);
    assert.equal(out.get(7).en, 'rain');
    assert.equal(calls.length, 1);
  });

  it('asks only about the ids it has not already got', async () => {
    stubModel((body) => {
      const asked = JSON.parse(body.messages[0].content);
      return { results: asked.map((a) => ({ id: a.id, en: `en-${a.id}`, translated: true })) };
    });
    const t = new Translator(dataDir, () => 'k');
    await t.translate([{ id: 1, name: 'a' }]);
    await t.translate([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ]);
    assert.deepEqual(askedOn(2).map((a) => a.id), [2]);
  });

  it('ignores ids the model invented', async () => {
    // The id is echoed by the model, so it is not trustworthy enough to key a
    // cache on without checking it against what was asked.
    stubModel(() => ({
      results: [
        { id: 1, en: 'ok', translated: true },
        { id: 999, en: 'hallucinated', translated: true },
      ],
    }));
    const t = new Translator(dataDir, () => 'k');
    const out = await t.translate([{ id: 1, name: 'a' }]);
    assert.equal(out.size, 1);
    assert.equal(out.get(999), undefined);
    assert.equal(t.peek(999), undefined);
  });

  it('degrades to the original name on any API failure', async () => {
    for (const status of [401, 429, 500]) {
      calls = [];
      stubModel(() => new Response(JSON.stringify({ error: { message: 'nope' } }), { status }));
      const t = new Translator(dataDir, () => 'k');
      const out = await t.translate([{ id: 1, name: 'crujido' }]);
      assert.equal(out.size, 0, `status ${status} returns nothing rather than throwing`);
    }
  });

  it('degrades when the model returns something unparseable', async () => {
    stubModel(
      () =>
        new Response(
          JSON.stringify({
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: DEFAULT_MODEL,
            content: [{ type: 'text', text: 'not json at all' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const t = new Translator(dataDir, () => 'k');
    assert.equal((await t.translate([{ id: 1, name: 'x' }])).size, 0);
  });

  it('splits a large set into batches', async () => {
    stubModel((body) => {
      const asked = JSON.parse(body.messages[0].content);
      return { results: asked.map((a) => ({ id: a.id, en: `en-${a.id}`, translated: true })) };
    });
    const t = new Translator(dataDir, () => 'k');
    const items = Array.from({ length: 95 }, (_, i) => ({ id: i + 1, name: `n${i}` }));
    const out = await t.translate(items);
    assert.equal(out.size, 95);
    assert.equal(calls.length, 3, '95 items at 40 per batch');
  });
});

describe('applyTranslations', () => {
  it('adds nameEn and never touches name', () => {
    const sounds = [{ id: 1, name: 'crujido de puerta' }];
    applyTranslations(sounds, new Map([[1, { en: 'door creak', translated: true }]]));
    assert.equal(sounds[0].name, 'crujido de puerta', 'the original is untouched');
    assert.equal(sounds[0].nameEn, 'door creak');
  });

  it('sets nothing when the title was already English', () => {
    const sounds = [{ id: 1, name: 'Airhorn' }];
    applyTranslations(sounds, new Map([[1, { en: 'Airhorn', translated: false }]]));
    assert.equal(sounds[0].nameEn, undefined, 'no point rendering the same name twice');
  });

  it('sets nothing when the translation equals the original', () => {
    const sounds = [{ id: 1, name: 'Kick' }];
    applyTranslations(sounds, new Map([[1, { en: 'Kick', translated: true }]]));
    assert.equal(sounds[0].nameEn, undefined);
  });
});

describe('credits are never translated', () => {
  it('renders the uploader’s original title even when a translation exists', () => {
    // The whole point of the feature's design: CC BY attribution identifies the
    // work as its author named it. A translated credit is a wrong credit.
    const board = {
      id: 'b0123456789ab',
      name: 'Show',
      updated: '2026-09-11T00:00:00.000Z',
      pads: [
        {
          label: 'door creak',
          sound: {
            id: 5,
            name: 'crujido de puerta',
            nameEn: 'door creak',
            username: 'ana',
            license: 'Attribution',
            url: 'https://freesound.org/s/5/',
            duration: 1,
          },
        },
      ],
    };
    const credits = creditsFor(board);
    assert.equal(credits.sounds[0].title, 'crujido de puerta');
    const md = creditsMarkdown(credits);
    assert.match(md, /crujido de puerta/);
    assert.ok(!md.includes('door creak'), 'the translation must not reach the credit');
  });
});
