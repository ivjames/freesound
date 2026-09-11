# Freesound Boards — working notes

Build custom sound boards from Freesound's CC-licensed library, with per-clip attribution.

Served at **https://freesound.lab980.com** from the lab980 droplet.

How work lands here — branch, PR, and the fact that merging is not deploying —
is in `.claude/rules/lab980-conventions.md`, which Claude Code loads
automatically every session. That file is owned by the lab980 scaffold and is
overwritten by it; **this** file is the site's own, and everything below is
about this site rather than about the platform. For the box itself, read the
`ivjames/lab980.com` repo's `CLAUDE.md`.

## Shape

A **proxied app**: nginx fronts a pm2-managed Node process on
`127.0.0.1:8074`.

- Repo: `ivjames/freesound` · droplet dir: `/var/www/freesound`
- pm2 process: `freesound` — **fork mode** (`exec_mode: "fork"`, no
  `instances` key: setting it silently flips pm2 into cluster mode, whose
  startup crashes land in `~/.pm2/pm2.log` instead of the app's own log — a
  crash-looping app with empty logs is that trap)
- Config and data live in the app dir (`.env`, `data/`), not `/etc` or
  `/var/lib`. `.env` is **not** in git; changing it is a droplet-side edit
  followed by a restart.
- vhost: `/etc/nginx/sites-available/freesound.lab980.com`, written by `provision-site`

## Deploying

On the droplet, as root:

```bash
freesound deploy      # pull, npm ci, pm2 start/restart, probe, save
freesound status      # HEAD, pm2 state, local + public probe, cert days
freesound logs        # tail this app's pm2 logs
freesound token       # generate FREESOUND_WRITE_TOKEN into .env
freesound keys        # which .env keys are set (names only, never values)
```

Full runbook, including first-time bring-up and `.env` keys: `DEPLOY.md`.

## Things worth knowing

- `.env` and `data/` are gitignored, so they survive `deploy`'s hard reset
  where everything else does not — which also means a missing key is invisible
  in the repo. Keep `.env.example` current and list every key in `DEPLOY.md`.
- Verify a **clean** clone works, not just the working tree. There is no build
  script here, so the check is install-and-test rather than install-and-build:

  ```bash
  d=$(mktemp -d) \
    && git archive HEAD | tar -x -C "$d" \
    && ( cd "$d" && npm ci && npm test ) \
    && rm -rf "$d"
  ```

  `mktemp -d` is the point, not tidiness. The directory has to exist — `tar -x
  -C` into a missing one fails outright — and it has to be *empty*, or the
  extract merges over an earlier run's files and the check quietly stops
  testing a clean tree. A fixed `/tmp/x` gets both wrong, and on a shared
  `/tmp` it lets two runs race, each able to delete the other's tree
  mid-build. The subshell keeps you in the checkout, so `$d` and the `git
  ls-files` below still resolve; the trailing `rm -rf` fires only on success,
  leaving a failed build in `$d` to look at. A kitchen-sink `.gitignore`
  eating a source dir is the classic thing this catches; `git ls-files <dir>`
  confirms what is actually tracked.
- pm2 process name is `freesound`; `freesound logs` tails it.

## How it is put together

Zero dependencies, no build step, no framework, no database. `npm ci` installs
nothing; it exists so `deploy` validates the lockfile. That is a deliberate
choice rather than minimalism for its own sake: this box rebuilds
`node_modules` on every deploy, and a native module here would have to be
rebuilt against the droplet's Node ABI (MODULE_VERSION 127) at every bump.

```
server.mjs        HTTP, routing, the trust model
lib/env.mjs       .env, re-read on mtime change (no restart needed for a new key)
lib/freesound.mjs apiv2 client: search, sound lookup, licence classification
lib/store.mjs     boards as one JSON file each, atomic writes, per-board locking
lib/cache.mjs     on-disk mp3 preview cache
lib/credits.mjs   attribution rendering — md / txt / html / json
lib/http.mjs      response helpers, static serving, ranges, rate limiting
public/           the page: three ES modules, one stylesheet
```

### The trust model, because it decides the route table

The vhost is public and unauthenticated, and the Freesound API key is metered.
So the split is by *what a request costs*, not by what it changes:

- **Open**: listing boards, reading a board, playing its audio, downloading its
  credits. These touch local disk only. A board at `/b/<id>` therefore works for
  whoever you send the link to, with no token.
- **Token-gated** (`FREESOUND_WRITE_TOKEN`, `X-Board-Token` header): search, and
  every board or pad mutation. Search is a request to Freesound every time;
  adding a pad is one lookup plus one preview download.

With the token unset everything is open. That is a supported mode, not a
failure — but `/api/health` reports `writeProtected` so it can never be mistaken
for protection that is quietly not working.

### Things that will bite you if you change them

- **`addPad` looks the sound up server-side and ignores client metadata.** The
  client sends a `soundId` and nothing else that matters. If it were trusted to
  send a preview URL, this server would make an outbound request to whatever
  host it named — and the recorded attribution would be whatever the client
  felt like claiming. Both are why `toSound()` and `isFreesoundUrl()` exist, and
  why the cache re-checks the host it is handed.
- **Audio is served only for sounds already on a board.** `/api/audio/<id>.mp3`
  returns 404 for anything uncached rather than fetching it, or it would be an
  open proxy for driving requests at Freesound.
- **Error messages are returned by provenance, not by status code.** A message
  from `HttpError`, `StoreError` or `FreesoundError` was written for a user and
  is returned as-is, 5xx included — "No Freesound API key is configured on this
  install" is a 503 and is the single most useful thing a fresh install can say.
  Anything else is masked and logged. Get this backwards and setup failures
  become "Something went wrong on the server".
- **Licence versions are never inferred.** Freesound returns `"Attribution"` for
  both CC BY 3.0 and 4.0 clips, so `licenseInfo()` classifies the *obligation*
  (attribution required? commercial use allowed?) and leaves the version to the
  sound's own page. An unrecognised licence is treated as the strictest case.
- **Web Audio for pads, `<audio>` for search previews.** A pad's clip is cached
  here, so it can be fetched and decoded for instant retriggering. A search
  result's preview is still on Freesound's CDN, which makes no promise about
  CORS headers — `fetch` + `decodeAudioData` would be a gamble, an `<audio>`
  element is not.

## Tests

`npm test` — `node --test`, no runner to install. `test/lib.test.mjs` covers the
units; `test/integration.test.mjs` stubs `fetch` and drives the real modules
along the path that matters (API response shape → pad → cached mp3 → credit), so
a change to how the API response is read fails here rather than on the droplet.
