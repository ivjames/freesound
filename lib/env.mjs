// .env loading.
//
// The trap this avoids is piezo's: that app reads .env once at startup, so a
// key added while it is running stays invisible until someone restarts it, and
// the only symptom is a health endpoint reporting no key straight after the
// file was edited. Here the file's mtime is polled on a slow unref'd timer and
// the values are re-read when it changes, so editing .env on the droplet takes
// effect on its own. A restart still works; it is just no longer required.

import { readFileSync, statSync } from 'node:fs';

const RELOAD_MS = 5000;

let values = Object.create(null);
let stamp = null; // `${mtimeMs}:${size}` of the file as last read, or null

/** Parse a .env body. Last assignment of a key wins, as with a shell. */
export function parseEnv(text) {
  const out = Object.create(null);
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes; an unquoted value keeps any inline
    // `#` because a secret is allowed to contain one.
    if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val.at(-1) === val[0]) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function stampOf(path) {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function load(path) {
  const next = stampOf(path);
  if (next === stamp) return;
  stamp = next;
  if (next === null) {
    values = Object.create(null);
    return;
  }
  try {
    values = parseEnv(readFileSync(path, 'utf8'));
  } catch {
    // A half-written file mid-edit: keep the previous values and try again on
    // the next tick rather than dropping the app's key on the floor.
    stamp = null;
  }
}

/**
 * Start watching `path`. Returns a getter: process.env wins over the file, so
 * a value passed in by the CLI (PORT) cannot be shadowed by a stale .env.
 */
export function openEnv(path) {
  load(path);
  const timer = setInterval(() => load(path), RELOAD_MS);
  timer.unref();
  return {
    get(key, fallback = '') {
      const fromProcess = process.env[key];
      if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
      const fromFile = values[key];
      return fromFile !== undefined && fromFile !== '' ? fromFile : fallback;
    },
    /** Key names present with a non-empty value — names only, never values. */
    keys() {
      return Object.keys(values).filter((k) => values[k] !== '').sort();
    },
    close() { clearInterval(timer); },
  };
}
