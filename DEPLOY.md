# Deploying Freesound Boards

Target: **https://freesound.lab980.com** — served from the lab980 droplet (conventions in
the `ivjames/lab980.com` repo's `CLAUDE.md`).

Shape: nginx proxies to a pm2-managed Node process on `127.0.0.1:8074`,
with the app dir at `/var/www/freesound`.

## One-time bring-up (on the droplet, as root)

```bash
# 0. Confirm the port is free FIRST. provision-site does not check an explicit
#    --port, so this is the only thing standing between you and a vhost that
#    serves somebody else's site. Both commands silent = free.
PORT=8074
ss -ltn | grep ":$PORT"
grep -rn "127.0.0.1:$PORT" /etc/nginx/sites-available
#    Either one printed something? Stop and read "If the port is taken" below —
#    the fix is a repo change, not an edit on the box.

provision-site freesound ivjames/freesound --port "$PORT"
cd /var/www/freesound
ln -sf /var/www/freesound/bin/freesound /usr/local/bin/freesound
$EDITOR .env                          # provision-site seeded PORT; add FREESOUND_API_KEY
freesound token                       # generates FREESOUND_WRITE_TOKEN into .env
freesound deploy                      # npm ci, first pm2 start, probe, save
freesound keys                        # confirm both keys are set (names only)
```

Type the API key into `.env` with an editor. Do not `echo` it on a command
line: argv is world-readable through `/proc/<pid>/cmdline` and the line lands
in your shell history either way. `freesound token` exists for the same reason
— it generates and writes the token in one process and never prints it, so you
read it back with `grep '^FREESOUND_WRITE_TOKEN=' .env` when you need it.

There is no build step (`npm run build` does not exist and `deploy` skips it),
and no dependencies at all, so `npm ci` is a no-op that only validates the
lockfile.

`provision-site` stops before build/run on purpose — each site is deployed its
own way afterward. Here that way is `freesound deploy`: it sees that nothing
named `freesound` is registered with pm2 and runs the `pm2 start` in
`START_CMD` at the top of `bin/freesound`. That argv is set in the repo, not on
the droplet (a tracked-file edit there is wiped by the next deploy), and
`deploy` refuses a first start while it is still the `<entrypoint>`
placeholder.

Every pm2 call the CLI makes runs from a scrubbed environment: `env -i` plus
`PATH`, `HOME`, `LANG`, `PM2_HOME` and `TERM` if set, and `PORT` (`8074`).
pm2 copies the environment of the `pm2 start` call into the process and into
`~/.pm2/dump.pm2`, so anything the calling shell holds would live on there.
So the process gets `PORT` from the CLI and everything else from `.env` itself
(dotenv, or an ecosystem file that loads it) — nothing arrives from the shell
that ran `deploy`, and there is no box-level key store to copy from: `.env`
in the app dir is the only copy of any key this app uses. `pm2 save` runs only after the probe
passes and only when every registered pm2 process is `online` (the box rule),
otherwise it warns and leaves the previous dump alone.

Two details in that first line matter more than they look:

- **`--port` is not optional, and it is not checked.** Without it
  `provision-site` picks the next free port from 8060 and writes *that* into
  the vhost, while this repo's CLI, `.env` and app config all use `8074`. nginx
  then proxies to a port nothing is listening on and every request is a 502
  that looks like the app is down while it runs perfectly on the wrong port.
  **But confirm the port first**: `provision-site` only scans for a free one
  (`ss -ltn` plus every `127.0.0.1:<port>` in `sites-available`) when `--port`
  is *omitted*. An explicit `--port 8074` goes into the vhost unchecked.

  The symptom then is usually not an error. If another HTTP app already holds
  8074, nginx connects to it perfectly well and **serves that site under
  `freesound.lab980.com`** — a 200 from the wrong application, while this app
  separately fails to bind. Everything looks up: DNS resolves, TLS is valid,
  the page loads, `health-check` calls it healthy. A 502 is the kinder outcome
  and only happens when whatever holds the port is not a usable HTTP upstream.

  8074 is this repo's default but has never been confirmed against the droplet;
  `.claude/sites.json` in `ivjames/lab980.com` records the port as `null`, in
  `unverified`, for exactly that reason. Check first:

  ```bash
  ss -ltn | grep ':8074' ; grep -rn '127.0.0.1:8074' /etc/nginx/sites-available
  ```

  Both silent means it is free.

### If the port is taken

Do **not** fix this on the droplet. The port's home is `FREESOUND_PORT` at the
top of `bin/freesound`, which is a **tracked file**, and two mechanisms
conspire to undo a local edit:

- `freesound deploy` runs `git reset --hard origin/$BRANCH` before it starts
  anything, so an edited `bin/freesound` is destroyed in the same command that
  was supposed to use it.
- Editing `.env` instead does not help either. The CLI hands pm2
  `PORT="${FREESOUND_PORT:-8074}"` from the restored file, and `lib/env.mjs`
  gives `process.env` precedence over `.env` — so the CLI's 8074 wins over
  whatever `.env` says, and the app binds 8074 while the vhost points at your
  chosen port.

So the order is: **land the new default in the repo first**, then provision.

```bash
# in a clone, not on the droplet
sed -i 's/FREESOUND_PORT:-8074/FREESOUND_PORT:-<port>/' bin/freesound
#   ...also update DEPLOY.md and .env.example, then PR and merge it
```

If you genuinely must bring the site up before that lands, `FREESOUND_PORT` is
a documented override — but it is per-invocation, not persistent, and it has
to be on **every** call:

```bash
FREESOUND_PORT=<port> freesound deploy
FREESOUND_PORT=<port> freesound status     # and restart, and logs, every time
```

Forget it once and the CLI restarts the app on 8074 behind a vhost pointing
somewhere else. Landing it in the repo is the only version of this that stays
fixed.
- **`provision-site` seeds `.env` with `PORT=` itself** (only if there isn't one
  already, mode 600). Add the remaining keys to that file — don't `cp` over it,
  or the port goes back out of sync.

Reboot survival needs the pm2 boot hook installed **once per droplet**
(`pm2 startup systemd -u root --hp /root`, then run the line it prints; verify
`systemctl is-enabled pm2-root` → enabled). `pm2 save` alone only writes the
dump — nothing replays it at boot without the hook.

### `.env` keys

| key | what it is |
|---|---|
| `PORT` | `8074` — must match the vhost's `proxy_pass` |
| `FREESOUND_API_KEY` | Freesound apiv2 key, from <https://freesound.org/apiv2/apply> (the "Client secret/Api key" column). Token auth only — this app never needs OAuth2, because it reads search results and mp3 previews and never downloads originals. Missing: the site still serves and plays boards, and `/api/search` answers 503 saying so. |
| `FREESOUND_WRITE_TOKEN` | Shared secret for the routes that spend the API key or change a board. `freesound token` generates it. **Empty means the site is fully open**, including to anyone who finds the URL, and this vhost is public and unauthenticated. |
| `ANTHROPIC_API_KEY` | Optional. Used **only** to translate clip titles into English for display, so a foreign-language results page is readable. Missing: titles show exactly as uploaded and nothing else changes. Credits always use the uploader's original title whether or not this is set. |
| `FREESOUND_TRANSLATE_MODEL` | Optional, default `claude-haiku-4-5`. A page of 30 titles is roughly a quarter of a cent, and each clip is translated **once ever** — the result is cached in `data/translations.json`, keyed by sound id, because a clip's title never changes. |
| `FREESOUND_CACHE_MB` | Optional, default `512`. Ceiling for the on-disk preview cache under `data/audio/`. Audio a board still references is never swept, whatever the ceiling says. |

`freesound keys` lists which of these are set — names only, never values.

**The app re-reads `.env` by itself**, polling its mtime on a slow timer, so a
key added or changed on the droplet takes effect within a few seconds without a
restart. This is deliberately unlike `piezo`, which reads its `.env` once at
startup and therefore reports `hasKey:false` until someone restarts it. A
restart still works here; it is just not required.

### What the vhost has to send

`provision-site` writes the proxy vhost and certbot owns it afterwards. Two
things in it this app depends on:

- **`proxy_pass http://127.0.0.1:8074`**, with the literal address rather than
  `localhost`. The app binds `127.0.0.1` explicitly, and on a dual-stack box
  nginx can resolve `localhost` to `::1` — the loopback-family mismatch that
  bit `casino`, where a perfectly healthy app 502s because nginx is knocking on
  the other address family. `freesound status` probes `127.0.0.1:8074` and the
  public URL separately so the two failures are distinguishable.
- **`X-Forwarded-For`**. The rate limits on search and edits are keyed on the
  client address, and behind nginx the socket address is always the loopback
  proxy. Without that header every visitor shares one bucket: degraded, not
  bypassed, but worth knowing before someone reports that search stopped
  working for everyone at once.

### Checking the API key without spending much

```bash
curl -s localhost:8074/api/health | python3 -m json.tool   # hasKey / writeProtected
curl -s -H "X-Board-Token: $(grep '^FREESOUND_WRITE_TOKEN=' /var/www/freesound/.env | cut -d= -f2-)" \
     'localhost:8074/api/search?q=airhorn&maxDuration=3' | head -c 300
```

A 502 with "Freesound rejected the API key" means the key is wrong. A 503 means
there is no key in `.env` at all.

## Deploying updates

Land changes on `main` (via a PR — see `CLAUDE.md`), then on the droplet:

```bash
freesound deploy        # sync, npm ci, build, pm2 restart, probe, save
```

`deploy` exits non-zero when nothing answers HTTP on `127.0.0.1:8074`
afterwards (any status code counts as answering — an API-only app 404s on `/`;
up to `FREESOUND_PROBE_TRIES`, default 10, tries a second apart) — a dead app
is a failed deploy, not a warning to read past, and nothing is saved. The
public probe is printed alongside but does not decide the result, because it
also depends on DNS and TLS.

**How `deploy` syncs, since the conventions file sends you here for it:**
`git fetch` then `git reset --hard origin/<branch>`. A tracked file edited on
the droplet is destroyed silently on the next deploy — fix it in the repo. The
gitignored state is the exception and survives: `.env` and `data/` are meant to
be edited on the box.

## Check it

```bash
freesound status              # HEAD, pm2 state, local + public probe, cert
freesound logs                # tail pm2 logs for this app
health-check --site freesound # the droplet-wide auditor
```

## Overrides

- `FREESOUND_FQDN` — default `freesound.lab980.com`
- `FREESOUND_BRANCH` — default `main`
- `FREESOUND_PORT` — default `8074`
- `FREESOUND_PROBE_TRIES` — default `10`

## State on the droplet

Both are gitignored and survive `deploy`'s hard reset:

- `.env` — the only copy of this app's keys. There is no box-level key store,
  and `deploy` copies nothing in from anywhere.
- `data/boards/<id>.json` — one file per board, written atomically. This is the
  real data: back this up.
- `data/translations.json` — English titles, keyed by Freesound sound id.
  Derived and cheap to rebuild, but worth keeping: losing it means re-buying
  every translation the next time those clips are searched.
- `data/audio/<soundId>.mp3` — cached Freesound previews. Derived, not data:
  deleting the directory costs nothing but a re-fetch of whatever is still on a
  board. Note that a board whose audio has been deleted cannot re-fetch it
  without the API key, so restore `.env` first if you are moving the site.

A board is a small JSON document, so a backup is just:

```bash
tar czf /root/freesound-boards-$(date +%F).tgz -C /var/www/freesound data/boards
```

## Cost, in the two places this site spends money

- **Freesound** is free but metered per key. Search and pad-adding spend it;
  playing a board does not, because the audio is cached here. The write token
  is what stops an anonymous visitor spending your quota.
- **Anthropic** is spent only on translating titles, only for clips never seen
  before, at roughly a quarter of a cent per page of 30 on the default model.
  `/api/health` reports `translation.cached`, which is how many clips have
  already been paid for. Unset `ANTHROPIC_API_KEY` to switch the feature off
  entirely; nothing else changes.
