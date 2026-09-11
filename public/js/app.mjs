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
  search: { page: 1, query: '', results: [] },
};

// --- chrome ----------------------------------------------------------------

let bannerTimer = null;

function banner(message, kind = '') {
  clearTimeout(bannerTimer);
  el.banner.textContent = message;
  el.banner.className = `banner ${kind}`;
  el.banner.hidden = !message;
  if (message && kind !== 'bad') bannerTimer = setTimeout(() => (el.banner.hidden = true), 6000);
}

/**
 * Every action funnels its failures through here, because the one failure that
 * needs a different answer is the missing token: the fix is a prompt, not a
 * message telling the user to go and read DEPLOY.md.
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
  const { boards } = (await guard(() => api.listBoards())) ?? { boards: [] };
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
  const board = await guard(() => api.getBoard(id));
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
  const board = state.board;
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

  const trigger = document.createElement('button');
  trigger.className = 'pad-label';
  trigger.type = 'button';
  trigger.textContent = pad.label;
  trigger.addEventListener('click', () => firePad(pad));

  const meta = document.createElement('div');
  meta.className = 'pad-meta';
  const nc = pad.sound.license?.toLowerCase().includes('noncommercial');
  meta.innerHTML = `${escapeHtml(pad.sound.username)} · ${pad.sound.duration.toFixed(1)}s`;
  if (nc) {
    const flag = document.createElement('span');
    flag.className = 'pad-nc';
    flag.textContent = ' · NC';
    flag.title = 'NonCommercial licence';
    meta.append(flag);
  }

  if (pad.key) {
    const key = document.createElement('span');
    key.className = 'pad-key';
    key.textContent = pad.key.toUpperCase();
    node.append(key);
  }

  const edit = document.createElement('div');
  edit.className = 'pad-edit';
  edit.append(
    smallButton('rename', () => renamePad(pad)),
    smallButton(pad.loop ? 'loop ✓' : 'loop', () =>
      guard(async () => {
        await api.updatePad(state.board.id, pad.id, { loop: !pad.loop });
        await openBoard(state.board.id);
      }),
    ),
    smallButton('remove', () =>
      guard(async () => {
        if (!confirm(`Remove “${pad.label}” from this board?`)) return;
        audio.stop(pad.id);
        await api.deletePad(state.board.id, pad.id);
        await openBoard(state.board.id);
      }),
    ),
  );

  node.append(trigger, meta, edit);
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
  guard(async () => {
    await api.updatePad(state.board.id, pad.id, { label });
    await openBoard(state.board.id);
  });
}

// --- search ----------------------------------------------------------------

async function runSearch(page = 1) {
  const query = el.q.value.trim();
  if (!query) return;
  state.search.query = query;
  state.search.page = page;
  el.searchStatus.textContent = 'Searching Freesound…';

  const data = await guard(() =>
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
  el.searchStatus.textContent = `${data.count.toLocaleString()} match${data.count === 1 ? '' : 'es'} on Freesound — showing ${state.search.results.length}.`;
}

function resultElement(sound) {
  const li = document.createElement('li');
  li.className = 'result';

  const name = document.createElement('div');
  name.className = 'result-name';
  name.textContent = sound.name;

  const actions = document.createElement('div');
  actions.className = 'result-actions';
  const playBtn = smallButton('play', () =>
    audio.preview(sound.previewUrl).catch((err) => banner(`Preview failed: ${err.message}`, 'bad')),
  );
  const addBtn = smallButton('add', async () => {
    if (!state.board) return banner('Make or pick a board first.', 'bad');
    addBtn.disabled = true;
    addBtn.textContent = 'adding…';
    const pad = await guard(() => api.addPad(state.board.id, { soundId: sound.id }));
    addBtn.disabled = false;
    addBtn.textContent = pad ? 'added' : 'add';
    if (pad) {
      await openBoard(state.board.id);
      await refreshBoards(state.board.id);
    }
  });
  actions.append(playBtn, addBtn);

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
  return li;
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
    li.innerHTML = `<em>${escapeHtml(pad.sound.name)}</em> by ${escapeHtml(pad.sound.username)} — `;
    const a = document.createElement('a');
    a.href = pad.sound.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = `freesound.org/s/${pad.sound.id}`;
    li.append(a, document.createTextNode(` — ${pad.sound.license || 'licence unknown'}`));
    el.creditsList.append(li);
  }
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// --- wiring ----------------------------------------------------------------

el.picker.addEventListener('change', () => openBoard(el.picker.value));

el.newBoard.addEventListener('click', () => {
  const name = prompt('Board name', 'New board');
  if (!name) return;
  guard(async () => {
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
  const health = await guard(() => api.health());
  if (health) {
    state.writeProtected = health.writeProtected;
    state.hasKey = health.hasKey;
    el.health.textContent =
      `${health.boards} board(s), ${health.pads} pad(s), ${(health.cache.bytes / 1048576).toFixed(1)} MB cached · ` +
      `${health.writeProtected ? 'editing needs the board token' : 'editing is open'}`;
    if (!health.hasKey) {
      banner('No Freesound API key is configured on this install — search will not work. See DEPLOY.md.', 'bad');
    }
  }
  await refreshBoards();
}

boot();
