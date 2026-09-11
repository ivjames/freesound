// Talking to this site's own API.
//
// The board token, when the install has one, is held in localStorage and sent
// as a header. It is a shared secret for editing, not a login — there are no
// accounts here — so it is stored per browser and nothing else is kept.

const TOKEN_KEY = 'freesound-boards.token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    // A private window, or site data blocked. The app still works; the token
    // just has to be re-entered each session.
    return '';
  }
}

export function setToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to do — see getToken */
  }
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  const headers = {};
  const token = getToken();
  if (token) headers['X-Board-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;

  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new ApiError(`Server returned ${res.status}`, res.status);
  }
  if (!res.ok) throw new ApiError(payload?.error ?? `Server returned ${res.status}`, res.status);
  return payload;
}

export const api = {
  health: () => request('GET', '/api/health'),

  listBoards: () => request('GET', '/api/boards'),
  getBoard: (id) => request('GET', `/api/boards/${id}`),
  createBoard: (name) => request('POST', '/api/boards', { name }),
  renameBoard: (id, name) => request('PATCH', `/api/boards/${id}`, { name }),
  reorderBoard: (id, order) => request('PATCH', `/api/boards/${id}`, { order }),
  deleteBoard: (id) => request('DELETE', `/api/boards/${id}`),

  // Resolves to {pad, warnings} — warnings carry the acoustic-similarity hits,
  // which inform rather than block.
  addPad: (boardId, pad) => request('POST', `/api/boards/${boardId}/pads`, pad),
  similarScan: (boardId) => request('GET', `/api/boards/${boardId}/similar-scan`),
  updatePad: (boardId, padId, patch) => request('PATCH', `/api/boards/${boardId}/pads/${padId}`, patch),
  deletePad: (boardId, padId) => request('DELETE', `/api/boards/${boardId}/pads/${padId}`),

  search({ q, page = 1, commercial = false, maxDuration = 0, sort = 'score', translate = true, group = true }) {
    const params = new URLSearchParams({ q, page: String(page), sort });
    if (commercial) params.set('commercial', '1');
    if (maxDuration > 0) params.set('maxDuration', String(maxDuration));
    if (!translate) params.set('translate', '0');
    if (!group) params.set('group', '0');
    return request('GET', `/api/search?${params}`);
  },

  creditsUrl: (boardId, format) => `/api/boards/${boardId}/credits?format=${format}`,
  audioUrl: (soundId) => `/api/audio/${soundId}.mp3`,
};
