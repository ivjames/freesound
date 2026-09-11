// Playback.
//
// Web Audio rather than <audio> elements, for one reason that matters on a
// sound board: retrigger latency. An <audio> element has to be rewound and
// re-played, which on most browsers means a gap you can hear and a clip that
// cannot overlap itself. A decoded AudioBuffer can be fired from a fresh
// source node every time, so hitting a pad twice in quick succession does what
// a sound board is supposed to do.
//
// Buffers are decoded once and kept. A board is a few dozen short clips, so
// the memory is small and the second press of a pad is instant.

const buffers = new Map(); // soundId -> AudioBuffer
const pending = new Map(); // soundId -> Promise<AudioBuffer>
const playing = new Map(); // padId -> Set<AudioBufferSourceNode>

let ctx = null;

/**
 * Browsers will not start an AudioContext until the user has interacted with
 * the page, so one is created lazily on the first pad press and resumed if it
 * was suspended (which also happens when a tab is backgrounded).
 */
export async function context() {
  if (!ctx) ctx = new (window.AudioContext ?? window.webkitAudioContext)();
  if (ctx.state === 'suspended') await ctx.resume();
  return ctx;
}

export async function load(soundId, url) {
  if (buffers.has(soundId)) return buffers.get(soundId);
  if (pending.has(soundId)) return pending.get(soundId);

  const job = (async () => {
    const ac = await context();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load audio (${res.status})`);
    const buf = await ac.decodeAudioData(await res.arrayBuffer());
    buffers.set(soundId, buf);
    return buf;
  })().finally(() => pending.delete(soundId));

  pending.set(soundId, job);
  return job;
}

/** Stop every voice currently sounding for one pad. */
export function stop(padId) {
  for (const node of playing.get(padId) ?? []) {
    try {
      node.stop();
    } catch {
      // Already ended: stop() on a finished node throws in some browsers and
      // means exactly what we wanted anyway.
    }
  }
  playing.delete(padId);
}

export function stopAll() {
  for (const padId of [...playing.keys()]) stop(padId);
}

/**
 * Fire a pad. `onEnded` runs when the last voice for this press finishes, so
 * the UI can drop its "playing" state.
 */
export async function play(pad, url, { onEnded } = {}) {
  const ac = await context();
  const buffer = await load(pad.sound.id, url);

  // A looping pad is a toggle: pressing it again stops it. A one-shot layers,
  // which is what makes rapid retriggering useful.
  if (pad.loop && (playing.get(pad.id)?.size ?? 0) > 0) {
    stop(pad.id);
    onEnded?.();
    return;
  }

  const source = ac.createBufferSource();
  source.buffer = buffer;
  source.loop = Boolean(pad.loop);

  const gain = ac.createGain();
  gain.gain.value = Number.isFinite(pad.gain) ? pad.gain : 1;
  source.connect(gain).connect(ac.destination);

  const voices = playing.get(pad.id) ?? new Set();
  voices.add(source);
  playing.set(pad.id, voices);

  source.onended = () => {
    voices.delete(source);
    if (voices.size > 0) return;
    // Only clear the map entry if it is still OUR set. stop() deletes the entry
    // outright, so a pad stopped and immediately retriggered (keyboard
    // auto-repeat does this) has a fresh Set here while the old voices' onended
    // callbacks are still queued. Deleting unconditionally would drop the NEW
    // set, leaving its voices unreachable by stop() and stopAll() — a looping
    // pad that plays until the tab is closed.
    if (playing.get(pad.id) === voices) playing.delete(pad.id);
    onEnded?.();
  };
  source.start();
}

/**
 * Audition a search result, straight from Freesound's CDN.
 *
 * This one deliberately does NOT go through Web Audio. A search result's
 * preview has not been cached here yet, so the URL is Freesound's own — and
 * decoding it would mean `fetch` + `decodeAudioData`, which needs a permissive
 * CORS header from a host that makes no promise to send one. An <audio>
 * element plays a cross-origin URL without asking, and auditioning does not
 * need retrigger latency. Once a clip is on a board it is served from here and
 * gets the Web Audio path above.
 */
let previewEl = null;

export function preview(url) {
  stopPreview();
  const el = new Audio(url);
  el.crossOrigin = null;
  previewEl = el;
  el.addEventListener('ended', () => {
    if (previewEl === el) previewEl = null;
  });
  return el.play();
}

export function stopPreview() {
  if (!previewEl) return;
  previewEl.pause();
  previewEl.src = '';
  previewEl = null;
}
