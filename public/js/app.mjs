// Freesound Boards — the page.

import { ApiError, api, getToken, setToken } from './api.mjs';
import * as audio from './audio.mjs';

const $ = (id) => document.getElementById(id);

const el = {
  picker: $('board-picker'),
  newBoard: $('new-board'),
  toggleSearch: $('toggle-search'),
  toggleCredits: $('toggle-credits'),
  banner: $('banner'),
  pads: $('pads'),
  boardEmpty: $('board-empty'),
  search: $('search'),
  searchForm: $('search-form'),
  q: $('q'),
  commercialOnly: $('commercial-only'),
  maxDuration: $('max-duration'),
  searchStatus: $('search-status'),
  results: $('results'),
  more: $('more'),
  showOriginals: $('show-originals'),
  originalsLabel: $('originals-label'),
  scanSimilar: $('scan-similar'),
  scanResult: $('scan-result'),
  credits: $('credits'),
  creditsSummary: $('credits-summary'),
  creditsList: $('credits-list'),
  health: $('health'),
  tokenDialog: $('token-dialog'),
  tokenInput: $('token-input'),
};

const state = {
  boards: [],
  board: null,
  writeProtected: false,
  hasKey: false,
  translation: { available: false, model: '' },
  search: { page: 1, query: '', results: [] },
  // Per-viewer display preference: show Freesound's original titles instead of
  // the English translations. Credits always use the originals regardless.
  showOriginals: false,
};

const ORIGINALS_KEY = 'freesound-boards.originals';
try {
  state.showOriginals = localStorage.getItem(ORIGINALS_KEY) === '1';
} catch {
  /* private window or blocked site data — the default stands */
}

/**
 * What to show for a clip.
 *
 * `nameEn` is a translated display label, set only when it differs from the
 * original. `name` is what the uploader typed, and is the only one a credit may
 * use — translating an attribution would misidentify the work.
 */
const displayName = (sound) => (state.showOriginals ? sound.name : sound.nameEn || sound.name);
const isTranslated = (sound) => Boolean(sound.nameEn) && sound.nameEn !== sound.name;

// --- chrome ----------------------------------------------------------------

let bannerTimer = null;

function banner(message, kind = '', { actions = [] } = {}) {
  clearTimeout(bannerTimer);
  el.banner.textContent = '';
  el.banner.className = `banner ${kind}`;
  el.banner.hidden = !message;
  if (!message) return;

  el.banner.append(document.createTextNode(message));
  for (const action of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'banner-action';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      el.banner.hidden = true;
      action.run();
    });
    el.banner.append(b);
  }
  // A failure stays up until it is dismissed or replaced; anything else clears
  // itself, because a transient success that lingers reads as a live warning.
  if (kind !== 'bad') bannerTimer = setTimeout(() => (el.banner.hidden = true), 7000);
}

/**
 * Run an action, converting the one failure that needs a different answer — a
 * missing or wrong token — into a prompt rather than a message telling the user
 * to go and read DEPLOY.md. Every other error is re-thrown for the caller to
 * handle, because some of them (an exact duplicate) have their own answer.
 */
async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      banner(err.message, 'bad');
      askForToken();
      return undefined;
    }
    throw err;
  }
}

/** guard(), for callers that want the banner rather than the exception. */
async function attempt(fn) {
  try {
    return await guard(fn);
  } catch (err) {
    banner(err?.message ?? String(err), 'bad');
    return undefined;
  }
}

function askForToken() {
  el.tokenInput.value = getToken();
  el.tokenDialog.showModal();
}

el.tokenDialog.addEventListener('close', () => {
  if (el.tokenDialog.returnValue !== 'save') return;
  setToken(el.tokenInput.value.trim());
  banner('Token saved for this browser.', 'good');
  refreshBoards();
});

function togglePanel(panel, button, other, otherButton) {
  const show = panel.hidden;
  panel.hidden = !show;
  button.setAttribute('aria-expanded', String(show));
  if (show && other && !other.hidden) {
    other.hidden = true;
    otherButton.setAttribute('aria-expanded', 'false');
  }
}

// --- boards ----------------------------------------------------------------

async function refreshBoards(selectId) {
  const { boards } = (await attempt(() => api.listBoards())) ?? { boards: [] };
  state.boards = boards;
  el.picker.innerHTML = '';
  for (const b of boards) {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = `${b.name} · ${b.pads} pad${b.pads === 1 ? '' : 's'}`;
    el.picker.append(opt);
  }
  el.picker.hidden = boards.length === 0;

  const wanted = selectId ?? boardIdFromUrl() ?? boards[0]?.id;
  if (wanted && boards.some((b) => b.id === wanted)) {
    el.picker.value = wanted;
    await openBoard(wanted);
  } else {
    state.board = null;
    renderBoard();
  }
}

const boardIdFromUrl = () => /^\/b\/([a-z0-9]+)$/.exec(location.pathname)?.[1] ?? null;

async function openBoard(id) {
  const board = await attempt(() => api.getBoard(id));
  if (!board) return;
  state.board = board;
  audio.stopAll();
  // The board id lives in the URL so a board can be linked to. Playing one
  // needs no token, so that link works for whoever it is sent to.
  history.replaceState(null, '', `/b/${board.id}`);
  document.title = `${board.name} — Freesound Boards`;
  renderBoard();
  renderCredits();
}

function renderBoard() {
  el.pads.innerHTML = '';
  el.scanResult.innerHTML = '';
  const board = state.board;
  el.scanSimilar.hidden = !board || board.pads.length < 2;
  if (!board) {
    el.boardEmpty.hidden = false;
    el.boardEmpty.textContent = state.boards.length
      ? 'Pick a board above.'
      : 'No board yet. Make one, then add sounds to it.';
    return;
  }
  el.boardEmpty.hidden = board.pads.length > 0;
  el.boardEmpty.textContent = 'Empty board. Hit “Add sounds” and search Freesound.';

  for (const pad of board.pads) el.pads.append(padElement(pad));
}

function padElement(pad) {
  const node = document.createElement('div');
  node.className = 'pad';
  node.style.setProperty('--pad-color', pad.color);
  node.dataset.padId = pad.id;
  node.dataset.soundId = String(pad.sound.id);

  if (pad.key) {
    const key = document.createElement('span');
    key.className = 'pad-key';
    key.textContent = pad.key.toUpperCase();
    node.append(key);
  }

  const trigger = document.createElement('button');
  trigger.className = 'pad-label';
  trigger.type = 'button';
  trigger.textContent = pad.label;
  trigger.addEventListener('click', () => firePad(pad));
  node.append(trigger);

  // When the label came from a translation, show the uploader's original title
  // underneath. That is the name in the credits, and someone checking a credit
  // against the board should not have to guess which clip is which.
  if (isTranslated(pad.sound) && pad.label !== pad.sound.name) {
    const original = document.createElement('div');
    original.className = 'pad-original';
    original.textContent = pad.sound.name;
    original.title = `Original title on Freesound: ${pad.sound.name}`;
    node.append(original);
  }

  const meta = document.createElement('div');
  meta.className = 'pad-meta';
  meta.append(document.createTextNode(`${pad.sound.username} · ${pad.sound.duration.toFixed(1)}s`));
  if (pad.sound.license?.toLowerCase().includes('noncommercial')) {
    const flag = document.createElement('span');
    flag.className = 'pad-nc';
    flag.textContent = ' · NC';
    flag.title = 'NonCommercial licence';
    meta.append(flag);
  }
  node.append(meta);

  const edit = document.createElement('div');
  edit.className = 'pad-edit';
  edit.append(
    smallButton('rename', () => renamePad(pad)),
    smallButton(pad.loop ? 'loop ✓' : 'loop', () =>
      attempt(async () => {
        await api.updatePad(state.board.id, pad.id, { loop: !pad.loop });
        await openBoard(state.board.id);
      }),
    ),
    smallButton('remove', () =>
      attempt(async () => {
        if (!confirm(`Remove “${pad.label}” from this board?`)) return;
        audio.stop(pad.id);
        await api.deletePad(state.board.id, pad.id);
        await openBoard(state.board.id);
      }),
    ),
  );
  node.append(edit);
  return node;
}

function smallButton(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

async function firePad(pad) {
  const node = el.pads.querySelector(`[data-pad-id="${pad.id}"]`);
  node?.classList.add('playing');
  try {
    await audio.play(pad, api.audioUrl(pad.sound.id), {
      onEnded: () => node?.classList.remove('playing'),
    });
  } catch (err) {
    node?.classList.remove('playing');
    banner(`Could not play “${pad.label}”: ${err.message}`, 'bad');
  }
}

function renamePad(pad) {
  const label = prompt('Pad label', pad.label);
  if (label === null) return;
  attempt(async () => {
    await api.updatePad(state.board.id, pad.id, { label });
    await openBoard(state.board.id);
  });
}

/** Flash a pad, so a "you already have this" message can point at one. */
function highlightPad(padId) {
  const node = el.pads.querySelector(`[data-pad-id="${padId}"]`);
  if (!node) return;
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1600);
}

// --- similarity scan -------------------------------------------------------

async function runSimilarScan() {
  el.scanSimilar.disabled = true;
  el.scanSimilar.textContent = 'scanning…';
  const report = await attempt(() => api.similarScan(state.board.id));
  el.scanSimilar.disabled = false;
  el.scanSimilar.textContent = 'Find similar clips';
  if (!report) return;

  el.scanResult.innerHTML = '';
  const summary = document.createElement('p');
  summary.className = 'hint';
  if (!report.clusters.length) {
    summary.textContent = `Scanned ${report.scanned} pad${report.scanned === 1 ? '' : 's'} — nothing on this board sounds like anything else on it.`;
    el.scanResult.append(summary);
    return;
  }
  summary.textContent =
    `${report.clusters.length} group${report.clusters.length === 1 ? '' : 's'} of clips that sound alike, ` +
    `out of ${report.scanned} pad${report.scanned === 1 ? '' : 's'} scanned. Nothing has been changed — these are yours to keep or remove.`;
  el.scanResult.append(summary);

  for (const cluster of report.clusters) {
    const group = document.createElement('div');
    group.className = 'scan-group';
    for (const hit of cluster) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'scan-hit';
      b.textContent = hit.label;
      b.title = hit.name;
      b.addEventListener('click', () => highlightPad(hit.padId));
      group.append(b);
    }
    el.scanResult.append(group);
  }
  if (report.truncated) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = `Only the first ${report.scanned} pads were scanned — each one costs a Freesound request.`;
    el.scanResult.append(note);
  }
}

// --- search ----------------------------------------------------------------

async function runSearch(page = 1) {
  const query = el.q.value.trim();
  if (!query) return;
  state.search.query = query;
  state.search.page = page;
  el.searchStatus.textContent = state.translation.available
    ? 'Searching Freesound and translating titles…'
    : 'Searching Freesound…';

  const data = await attempt(() =>
    api.search({
      q: query,
      page,
      commercial: el.commercialOnly.checked,
      maxDuration: Number(el.maxDuration.value) || 0,
    }),
  );
  if (!data) {
    el.searchStatus.textContent = 'Search failed.';
    return;
  }

  if (page === 1) {
    state.search.results = data.results;
    el.results.innerHTML = '';
  } else {
    state.search.results.push(...data.results);
  }
  for (const sound of data.results) el.results.append(resultElement(sound));
  el.more.hidden = !data.hasMore;

  const parts = [`${data.count.toLocaleString()} match${data.count === 1 ? '' : 'es'} on Freesound`];
  parts.push(`showing ${state.search.results.length}`);
  if (data.meta?.collapsed) {
    parts.push(`${data.meta.collapsed} near-duplicate${data.meta.collapsed === 1 ? '' : 's'} folded in`);
  }
  if (data.meta?.translated) {
    parts.push(`${data.meta.translated} title${data.meta.translated === 1 ? '' : 's'} translated`);
  }
  el.searchStatus.textContent = `${parts.join(' · ')}.`;
}

function resultElement(sound) {
  const li = document.createElement('li');
  li.className = 'result';

  const name = document.createElement('div');
  name.className = 'result-name';
  name.append(document.createTextNode(displayName(sound)));
  if (isTranslated(sound) && !state.showOriginals) {
    const original = document.createElement('span');
    original.className = 'result-original';
    original.textContent = sound.name;
    original.title = 'Original title on Freesound — this is what the credits will say';
    name.append(original);
  }

  const actions = document.createElement('div');
  actions.className = 'result-actions';
  actions.append(
    smallButton('play', () =>
      audio.preview(sound.previewUrl).catch((err) => banner(`Preview failed: ${err.message}`, 'bad')),
    ),
    addButton(sound),
  );

  const meta = document.createElement('div');
  meta.className = 'result-meta';
  const lic = document.createElement('span');
  lic.className = `lic lic-${sound.licenseInfo.key}`;
  lic.textContent = sound.licenseInfo.label;
  meta.append(lic, document.createTextNode(` ${sound.username} · ${sound.duration.toFixed(1)}s · `));
  const link = document.createElement('a');
  link.href = sound.url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = `freesound.org/s/${sound.id}`;
  meta.append(link);

  li.append(name, actions, meta);

  // Near-duplicates: one pack's twenty takes of the same footstep would
  // otherwise be the whole page. They are folded behind a disclosure rather
  // than dropped, because sometimes twenty takes IS what you came for.
  if (sound.variants?.length) li.append(variantsElement(sound));
  return li;
}

function variantsElement(sound) {
  const details = document.createElement('details');
  details.className = 'variants';
  const summary = document.createElement('summary');
  summary.textContent = `${sound.variants.length} more like this ${sound.pack ? 'in the same pack' : 'from the same uploader'}`;
  details.append(summary);

  const list = document.createElement('ul');
  for (const variant of sound.variants) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'variant-name';
    label.textContent = displayName(variant);
    label.title = variant.name;
    const acts = document.createElement('span');
    acts.className = 'result-actions';
    acts.append(
      smallButton('play', () =>
        audio.preview(variant.previewUrl).catch((err) => banner(`Preview failed: ${err.message}`, 'bad')),
      ),
      addButton(variant),
    );
    item.append(label, acts);
    list.append(item);
  }
  details.append(list);
  return details;
}

function addButton(sound) {
  const button = smallButton('add', async () => {
    if (!state.board) return banner('Make or pick a board first.', 'bad');
    button.disabled = true;
    button.textContent = 'adding…';
    await addSound(sound, button);
  });
  return button;
}

async function addSound(sound, button, { allowDuplicate = false } = {}) {
  try {
    const result = await guard(() => api.addPad(state.board.id, { soundId: sound.id, allowDuplicate }));
    if (!result) return; // token prompt raised; leave the button ready to retry
    button.textContent = 'added';
    await openBoard(state.board.id);
    await refreshBoards(state.board.id);

    // Acoustic similarity is a warning, not a refusal: two clips sounding alike
    // is a reason to look, and the person decides.
    for (const warning of result.warnings ?? []) {
      banner(`${warning.message}: ${warning.pads.map((p) => p.label).join(', ')}`, '', {
        actions: warning.pads
          .slice(0, 3)
          .map((p) => ({ label: `go to ${p.label}`, run: () => highlightPad(p.padId) })),
      });
    }
  } catch (err) {
    button.textContent = 'add';
    // The exact-duplicate refusal names the pad it collided with, so offer the
    // two things a person actually wants: see it, or add it anyway.
    if (err instanceof ApiError && err.status === 409 && err.duplicateOf) {
      banner(err.message, 'bad', {
        actions: [
          { label: 'show me', run: () => highlightPad(err.duplicateOf.padId) },
          {
            label: 'add anyway',
            run: () => {
              button.disabled = true;
              button.textContent = 'adding…';
              addSound(sound, button, { allowDuplicate: true });
            },
          },
        ],
      });
      return;
    }
    banner(err?.message ?? String(err), 'bad');
  } finally {
    button.disabled = false;
  }
}

// --- credits ---------------------------------------------------------------

function renderCredits() {
  const board = state.board;
  el.creditsList.innerHTML = '';
  el.creditsSummary.innerHTML = '';
  if (!board) return;

  for (const fmt of ['md', 'txt', 'html', 'json']) {
    $(`dl-${fmt}`).href = api.creditsUrl(board.id, fmt);
  }

  const seen = new Set();
  const unique = board.pads.filter((p) => !seen.has(p.sound.id) && seen.add(p.sound.id));
  const nc = unique.filter((p) => p.sound.license?.toLowerCase().includes('noncommercial'));

  const summary = document.createElement('p');
  summary.textContent = `${unique.length} sound${unique.length === 1 ? '' : 's'} across ${board.pads.length} pad${board.pads.length === 1 ? '' : 's'}.`;
  el.creditsSummary.append(summary);
  if (nc.length) {
    const flag = document.createElement('p');
    flag.className = 'flag';
    flag.textContent = `Not cleared for commercial use — ${nc.length} NonCommercial clip${nc.length === 1 ? '' : 's'}.`;
    el.creditsSummary.append(flag);
  }

  for (const pad of unique) {
    const li = document.createElement('li');
    // Deliberately pad.sound.name and never the translation: a credit has to
    // identify the work as its author named it.
    const cite = document.createElement('em');
    cite.textContent = pad.sound.name;
    li.append(cite, document.createTextNode(` by ${pad.sound.username} — `));
    const a = document.createElement('a');
    a.href = pad.sound.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = `freesound.org/s/${pad.sound.id}`;
    li.append(a, document.createTextNode(` — ${pad.sound.license || 'licence unknown'}`));
    el.creditsList.append(li);
  }
}

// --- wiring ----------------------------------------------------------------

el.picker.addEventListener('change', () => openBoard(el.picker.value));

el.newBoard.addEventListener('click', () => {
  const name = prompt('Board name', 'New board');
  if (!name) return;
  attempt(async () => {
    const board = await api.createBoard(name);
    await refreshBoards(board.id);
    banner(`Board “${board.name}” created.`, 'good');
  });
});

el.toggleSearch.addEventListener('click', () => {
  togglePanel(el.search, el.toggleSearch, el.credits, el.toggleCredits);
  if (!el.search.hidden) el.q.focus();
});
el.toggleCredits.addEventListener('click', () => {
  togglePanel(el.credits, el.toggleCredits, el.search, el.toggleSearch);
  renderCredits();
});

el.searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch(1);
});
el.more.addEventListener('click', () => runSearch(state.search.page + 1));
el.scanSimilar.addEventListener('click', runSimilarScan);

el.showOriginals.addEventListener('change', () => {
  state.showOriginals = el.showOriginals.checked;
  try {
    localStorage.setItem(ORIGINALS_KEY, state.showOriginals ? '1' : '0');
  } catch {
    /* nothing to do — the setting just will not persist */
  }
  // Re-render from state rather than re-searching: the translations are already
  // here, and a re-search would spend another Freesound request to show the
  // same clips under a different label.
  el.results.innerHTML = '';
  for (const sound of state.search.results) el.results.append(resultElement(sound));
  renderBoard();
});

// Keyboard triggering. Ignored while typing, and while a modifier is held, so
// it never eats a browser shortcut or a character in the search box.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === 'Escape') {
    audio.stopAll();
    audio.stopPreview();
    return;
  }
  const pad = state.board?.pads.find((p) => p.key && p.key === e.key.toLowerCase());
  if (!pad) return;
  e.preventDefault();
  firePad(pad);
});

async function boot() {
  el.showOriginals.checked = state.showOriginals;
  const health = await attempt(() => api.health());
  if (health) {
    state.writeProtected = health.writeProtected;
    state.hasKey = health.hasKey;
    state.translation = health.translation ?? { available: false, model: '' };
    el.health.textContent =
      `${health.boards} board(s), ${health.pads} pad(s), ${(health.cache.bytes / 1048576).toFixed(1)} MB cached · ` +
      `${health.writeProtected ? 'editing needs the board token' : 'editing is open'} · ` +
      `titles ${state.translation.available ? `translated by ${state.translation.model}` : 'shown as uploaded'}`;
    el.originalsLabel.hidden = !state.translation.available;
    if (!health.hasKey) {
      banner('No Freesound API key is configured on this install — search will not work. See DEPLOY.md.', 'bad');
    }
  }
  await refreshBoards();
}

boot();
