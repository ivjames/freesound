import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { parseEnv } from '../lib/env.mjs';
import { isFreesoundUrl, licenseInfo, previewUrl, toSound } from '../lib/freesound.mjs';
import { clientIp, parseRange, secretEquals } from '../lib/http.mjs';
import { BoardStore, StoreError, normaliseColor } from '../lib/store.mjs';
import { creditsFor, creditsMarkdown, creditsText } from '../lib/credits.mjs';

const dirs = [];
function tmpData() {
  const d = mkdtempSync(join(tmpdir(), 'fsboards-'));
  dirs.push(d);
  return d;
}
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const rawSound = (over = {}) => ({
  id: 1234,
  name: 'Airhorn',
  username: 'someone',
  license: 'Attribution',
  url: 'https://freesound.org/s/1234/',
  duration: 1.5,
  previews: { 'preview-hq-mp3': 'https://cdn.freesound.org/previews/1/1234_x-hq.mp3' },
  images: {},
  tags: ['horn'],
  ...over,
});

describe('env', () => {
  it('parses assignments and ignores noise', () => {
    const v = parseEnv('# comment\nA=1\nexport B="two"\n\nBAD KEY=x\n');
    assert.deepEqual({ ...v }, { A: '1', B: 'two' });
  });

  it('keeps a # inside an unquoted value, because a secret may contain one', () => {
    assert.equal(parseEnv('K=abc#def').K, 'abc#def');
  });
});

describe('freesound', () => {
  it('accepts only https Freesound hosts', () => {
    assert.ok(isFreesoundUrl('https://freesound.org/s/1/'));
    assert.ok(isFreesoundUrl('https://cdn.freesound.org/previews/a.mp3'));
    assert.ok(!isFreesoundUrl('http://freesound.org/s/1/'), 'plain http is refused');
    assert.ok(!isFreesoundUrl('https://evil.example/x.mp3'));
    assert.ok(!isFreesoundUrl('https://freesound.org.evil.example/x.mp3'), 'suffix must be a label boundary');
    assert.ok(!isFreesoundUrl('not a url'));
  });

  it('prefers the hq mp3 preview and refuses a non-Freesound one', () => {
    assert.match(previewUrl({ 'preview-hq-mp3': 'https://cdn.freesound.org/a-hq.mp3' }), /a-hq\.mp3$/);
    assert.match(previewUrl({ 'preview-lq-mp3': 'https://cdn.freesound.org/a-lq.mp3' }), /a-lq\.mp3$/);
    assert.equal(previewUrl({ 'preview-hq-mp3': 'https://evil.example/a.mp3' }), '');
    assert.equal(previewUrl(undefined), '');
  });

  it('reduces a sound to the fields a pad and a credit need', () => {
    const s = toSound(rawSound());
    assert.equal(s.id, 1234);
    assert.equal(s.username, 'someone');
    assert.equal(s.license, 'Attribution');
    assert.match(s.url, /freesound\.org\/s\/1234/);
    assert.match(s.previewUrl, /^https:\/\/cdn\.freesound\.org\//);
  });

  it('refuses a sound with no playable preview', () => {
    assert.throws(() => toSound(rawSound({ previews: {} })), /no mp3 preview/);
  });

  it('classifies the three licences Freesound issues, and fails closed otherwise', () => {
    assert.deepEqual(licenseInfo('Creative Commons 0'), { key: 'cc0', label: 'CC0', attribution: false, commercial: true });
    assert.equal(licenseInfo('Attribution').key, 'by');
    assert.equal(licenseInfo('Attribution NonCommercial').commercial, false);
    // Some responses carry a deed URL rather than a name.
    assert.equal(licenseInfo('http://creativecommons.org/licenses/by-nc/3.0/').key, 'by-nc');
    assert.equal(licenseInfo('http://creativecommons.org/publicdomain/zero/1.0/').key, 'cc0');
    // Unknown is treated as the strictest case, not the loosest.
    const unknown = licenseInfo('Some Future Licence');
    assert.equal(unknown.attribution, true);
    assert.equal(unknown.commercial, false);
  });
});

describe('http helpers', () => {
  it('parses byte ranges, including a suffix range', () => {
    assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
    assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
    assert.equal(parseRange('bytes=1000-', 1000), null, 'start past the end is unsatisfiable');
    assert.equal(parseRange('bytes=50-10', 1000), null);
    assert.equal(parseRange('bytes=a-b', 1000), null);
    assert.equal(parseRange(undefined, 1000), null);
  });

  it('compares secrets without throwing on a length mismatch', () => {
    assert.ok(secretEquals('hunter2', 'hunter2'));
    assert.ok(!secretEquals('hunter2', 'hunter3'));
    assert.ok(!secretEquals('short', 'a-much-longer-token'));
    assert.ok(!secretEquals('', ''), 'an empty secret never matches');
  });
});

describe('store', () => {
  it('creates a board and assigns pad keys in order', async () => {
    const store = new BoardStore(tmpData());
    const board = await store.create({ name: 'Standup' });
    assert.match(board.id, /^b[0-9a-f]{12}$/);

    const first = await store.addPad(board.id, { sound: toSound(rawSound()) });
    const second = await store.addPad(board.id, { sound: toSound(rawSound({ id: 5678 })) });
    assert.equal(first.key, '1');
    assert.equal(second.key, '2');
    assert.equal(first.label, 'Airhorn');
    assert.equal(first.gain, 1);
  });

  it('refuses the same Freesound clip twice on one board, and names the collision', async () => {
    const store = new BoardStore(tmpData());
    const board = await store.create({ name: 'b' });
    const first = await store.addPad(board.id, { sound: toSound(rawSound()), label: 'Airhorn' });

    await assert.rejects(
      () => store.addPad(board.id, { sound: toSound(rawSound()) }),
      (err) => {
        assert.equal(err.status, 409);
        assert.match(err.message, /already on this board as "Airhorn"/);
        // The UI offers "show me" from this, so it has to be structured.
        assert.deepEqual(err.duplicateOf, { padId: first.id, label: 'Airhorn', soundId: 1234 });
        return true;
      },
    );
    assert.equal((await store.read(board.id)).pads.length, 1);
  });

  it('allows the repeat when the caller says it is deliberate', async () => {
    // The same clip on two keys at different gains is a real thing to want.
    const store = new BoardStore(tmpData());
    const board = await store.create({ name: 'b' });
    await store.addPad(board.id, { sound: toSound(rawSound()) });
    const second = await store.addPad(board.id, { sound: toSound(rawSound()), allowDuplicate: true, gain: 0.5 });

    const after = await store.read(board.id);
    assert.equal(after.pads.length, 2);
    assert.equal(after.pads[1].gain, 0.5);
    assert.notEqual(after.pads[0].key, after.pads[1].key, 'the repeat still gets its own key');
    assert.equal(second.allowDuplicate, undefined, 'the flag is a request, not pad state');
  });

  it('does not treat a different clip as a duplicate', async () => {
    const store = new BoardStore(tmpData());
    const board = await store.create({ name: 'b' });
    await store.addPad(board.id, { sound: toSound(rawSound({ id: 1 })) });
    await store.addPad(board.id, { sound: toSound(rawSound({ id: 2 })) });
    assert.equal((await store.read(board.id)).pads.length, 2);
  });

  it('refuses a duplicate pad key', async () => {
    const store = new BoardStore(tmpData());
    const board = await store.create({ name: 'b' });
    await store.addPad(board.id, { sound: toSound(rawSound()), key: 'q' });
    await assert.rejects(
      () => store.addPad(board.id, { sound: toSound(rawSound({ id: 2 })), key: 'q' }),
      /already used/,
    );
  });

  it('rejects a board id that is not a board id, rather than touching the path', async () => {
    const store = new BoardStore(tmpData());
    for (const bad of ['../../etc/passwd', 'b12', 'bZZZZZZZZZZZZ', '']) {
      await assert.rejects(() => store.read(bad), StoreError);
    }
  });

  it('validates a reorder against the pads that exist', async () => {
    const store = new BoardStore(tmpData());
    const board = await store.create({ name: 'b' });
    const a = await store.addPad(board.id, { sound: toSound(rawSound()) });
    const b = await store.addPad(board.id, { sound: toSound(rawSound({ id: 2 })) });

    const reordered = await store.update(board.id, { order: [b.id, a.id] });
    assert.deepEqual(reordered.pads.map((p) => p.id), [b.id, a.id]);

    await assert.rejects(() => store.update(board.id, { order: [a.id] }), /exactly once/);
    await assert.rejects(() => store.update(board.id, { order: [a.id, a.id] }), /exactly once/);
  });

  it('serialises concurrent pad adds so none is lost', async () => {
    const store = new BoardStore(tmpData());
    const board = await store.create({ name: 'b' });
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.addPad(board.id, { sound: toSound(rawSound({ id: 100 + i })) })),
    );
    const after = await store.read(board.id);
    assert.equal(after.pads.length, 8);
    assert.equal(new Set(after.pads.map((p) => p.key)).size, 8, 'every pad got a distinct key');
  });

  it('rejects gain outside the allowed range and strips control characters from labels', async () => {
    const store = new BoardStore(tmpData());
    const board = await store.create({ name: 'b' });
    await assert.rejects(() => store.addPad(board.id, { sound: toSound(rawSound()), gain: 9 }), /gain/);
    const pad = await store.addPad(board.id, { sound: toSound(rawSound()), label: 'a b\nc' });
    assert.equal(pad.label, 'abc');
  });

  it('falls back to a default colour rather than accepting anything', () => {
    assert.equal(normaliseColor('#AABBCC'), '#aabbcc');
    assert.equal(normaliseColor('red; background:url(x)'), '#3f7fbf');
  });

  it('reports the sound ids a cache must keep', async () => {
    const store = new BoardStore(tmpData());
    const one = await store.create({ name: 'one' });
    const two = await store.create({ name: 'two' });
    await store.addPad(one.id, { sound: toSound(rawSound({ id: 11 })) });
    await store.addPad(two.id, { sound: toSound(rawSound({ id: 22 })) });
    assert.deepEqual([...(await store.referencedSoundIds())].sort(), [11, 22]);
  });
});

describe('credits', () => {
  const board = {
    id: 'b0123456789ab',
    name: 'Standup',
    updated: '2026-09-11T00:00:00.000Z',
    pads: [
      { label: 'Horn', sound: toSound(rawSound({ id: 1, name: 'Airhorn', license: 'Attribution' })) },
      { label: 'Horn again', sound: toSound(rawSound({ id: 1, name: 'Airhorn', license: 'Attribution' })) },
      { label: 'Rain', sound: toSound(rawSound({ id: 2, name: 'Rain', username: 'other', license: 'Creative Commons 0' })) },
    ],
  };

  it('credits each distinct sound once, however many pads fire it', () => {
    const credits = creditsFor(board);
    assert.equal(credits.summary.pads, 3);
    assert.equal(credits.summary.sounds, 2);
    assert.equal(credits.summary.attributionRequired, 1, 'CC0 owes no attribution');
  });

  it('flags a board that is not cleared for commercial use', () => {
    const clear = creditsFor(board);
    assert.equal(clear.summary.commercialUseAllowed, true);

    const nc = creditsFor({
      ...board,
      pads: [...board.pads, { label: 'Song', sound: toSound(rawSound({ id: 3, license: 'Attribution NonCommercial' })) }],
    });
    assert.equal(nc.summary.commercialUseAllowed, false);
    assert.equal(nc.summary.nonCommercial, 1);
    assert.match(creditsMarkdown(nc), /Not cleared for commercial use/);
    assert.match(creditsText(nc), /NOT CLEARED FOR COMMERCIAL USE/);
  });

  it('renders every credit with title, author, source and licence', () => {
    const md = creditsMarkdown(creditsFor(board));
    assert.match(md, /Airhorn/);
    assert.match(md, /by someone/);
    assert.match(md, /freesound\.org\/s\/1/);
    assert.match(md, /CC BY/);
    assert.match(md, /CC0/);
  });

  it('escapes markdown metacharacters in a sound name', () => {
    const md = creditsMarkdown(
      creditsFor({ ...board, pads: [{ label: 'x', sound: toSound(rawSound({ name: '[click] *bang*' })) }] }),
    );
    assert.match(md, /\\\[click\\\]/);
  });
});

// --- regressions from the adversarial review -------------------------------

describe('a pad patch cannot rewrite its attribution', () => {
  it('ignores a `sound` block in a PATCH body', async () => {
    // This was a real hole: normalisePad read `input.sound ?? existing.sound`,
    // so any client could PATCH a pad and replace the author, title, licence
    // and source URL — i.e. author its own attribution — and slip a
    // `javascript:` URL into the credit link that both the exported Markdown
    // and the rendered page turn into an anchor.
    const store = new BoardStore(tmpData());
    const board = await store.create({ name: 'b' });
    const pad = await store.addPad(board.id, { sound: toSound(rawSound()) });

    const patched = await store.updatePad(board.id, pad.id, {
      label: 'renamed',
      sound: {
        id: 1234,
        name: 'TOTALLY MINE',
        username: 'attacker',
        license: 'Creative Commons 0',
        url: 'javascript:alert(1)',
        previewUrl: 'https://evil.example/x.mp3',
      },
    });

    assert.equal(patched.label, 'renamed', 'the fields a client may set still apply');
    assert.equal(patched.sound.username, 'someone');
    assert.equal(patched.sound.name, 'Airhorn');
    assert.equal(patched.sound.license, 'Attribution');
    assert.equal(patched.sound.url, 'https://freesound.org/s/1234/');
    assert.match(patched.sound.previewUrl, /^https:\/\/cdn\.freesound\.org\//);
  });

  it('keeps the credit honest after such a patch', async () => {
    const store = new BoardStore(tmpData());
    const board = await store.create({ name: 'b' });
    const pad = await store.addPad(board.id, { sound: toSound(rawSound()) });
    await store.updatePad(board.id, pad.id, {
      sound: { id: 1234, name: 'MINE', username: 'attacker', license: 'Creative Commons 0', url: 'javascript:alert(1)' },
    });
    const md = creditsMarkdown(creditsFor(await store.read(board.id)));
    assert.match(md, /by someone/);
    assert.ok(!md.includes('attacker'), 'no client-authored author reaches a credit');
    assert.ok(!md.includes('javascript:'), 'no script URL reaches a credit link');
  });
});

describe('the per-board lock map does not grow without bound', () => {
  it('drops its entry once a board has no work queued', async () => {
    // pm2 keeps this process alive for weeks, and in the documented open mode
    // these ids arrive from unauthenticated requests — including ids that are
    // not boards at all.
    const store = new BoardStore(tmpData());
    const board = await store.create({ name: 'b' });
    for (let i = 0; i < 50; i++) await store.read(board.id).catch(() => {});
    for (let i = 0; i < 50; i++) await store.read(`bffffffffff${i % 10}`).catch(() => {});
    await new Promise((r) => setImmediate(r));
    assert.equal(store.pendingLocks, 0, 'every settled lock is released');
  });
});

describe('clientIp cannot be spoofed through X-Forwarded-For', () => {
  const req = (headers) => ({ headers, socket: { remoteAddress: '127.0.0.1' } });

  it('prefers X-Real-IP, which nginx sets rather than appends', () => {
    assert.equal(clientIp(req({ 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4, 9.9.9.9' })), '9.9.9.9');
  });

  it('takes the LAST forwarded-for hop, which is the one nginx appended', () => {
    // provision-site writes $proxy_add_x_forwarded_for, which is
    // "$http_x_forwarded_for, $remote_addr" — it appends to whatever the client
    // sent. Reading the first entry read an attacker-chosen value, and a fresh
    // one per request defeated the rate limiter entirely.
    assert.equal(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' })), '9.9.9.9');
    assert.equal(clientIp(req({ 'x-forwarded-for': 'evil, 203.0.113.7' })), '203.0.113.7');
  });

  it('falls back to the socket when no proxy header is present', () => {
    assert.equal(clientIp(req({})), '127.0.0.1');
    assert.equal(clientIp(req({ 'x-forwarded-for': '  ,  ' })), '127.0.0.1');
  });
});
