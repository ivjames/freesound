# Freesound Boards

Build custom sound boards from [Freesound](https://freesound.org)'s Creative
Commons library, with the attribution every clip is owed.

Search Freesound, audition results, and drop the ones you want onto a board.
Each pad gets a keyboard key; the whole board plays from the number and letter
rows. The credit for every clip — title, author, source link, licence — is
recorded when the pad is created and exports as Markdown, plain text, HTML or
JSON.

**This is not a myinstants clone.** The clips here are Creative Commons works
whose authors chose to license them; the site's job is to make using them
properly the easy path, not to strip the credit off them.

## What it does

- **Search** Freesound's catalogue, filtered by length and — if you are
  building something commercial — by excluding NonCommercial clips at source.
- **Titles translated into English** for display, because Freesound is
  international and you cannot pick a clip off a list you cannot read. The
  credit always keeps the uploader's original title (see below).
- **Deduplication**, in the three senses the word actually has: the same clip
  twice on one board is refused, one pack's twenty near-identical takes fold
  into a single row, and a board can be scanned for clips that *sound* alike.
- **Boards** of up to 64 pads each. Pads carry a label, a colour, a gain, an
  optional loop flag, and a keyboard key.
- **Playback** through Web Audio, from an mp3 preview cached on this server.
  Pads retrigger instantly and layer over each other; `Esc` stops everything.
- **Credits** rendered on the board and downloadable in four formats, with a
  board-level warning when a NonCommercial clip makes the whole board unusable
  commercially.
- **Sharing**: a board lives at `/b/<id>` and needs no token to open and play.

## Licensing, honestly

Freesound issues three licences, and this app treats them differently because
they *are* different:

| Freesound licence | shown as | what it obliges you to do |
|---|---|---|
| Creative Commons 0 | `CC0` | nothing. Credited anyway, as a record of provenance. |
| Attribution | `CC BY` | credit the author, name the work, link the source, state the licence. |
| Attribution NonCommercial | `CC BY-NC` | all of the above, **and** no commercial use. |

Anything unrecognised is treated as the strictest case rather than the
loosest. Licence *versions* are deliberately not inferred: clips uploaded under
CC BY 3.0 and 4.0 both come back from the API as "Attribution", so the credit
links to the sound's own page, which is the authority.

**A translated title is a display label, never an attribution.** A pad stores
both the uploader's original title and its English translation; the board shows
the translation and every credit shows the original, because attribution means
identifying the work as its author named it. Turn the translation off entirely
by leaving `ANTHROPIC_API_KEY` unset, or per-viewer with the "Show original
titles" checkbox — the credits are identical either way.

The server stores a cached mp3 *preview* per sound (the same file Freesound
serves publicly to preview a clip) so that a saved board keeps working and a
pad fires without a round-trip. It never fetches or redistributes original
uploads — that needs OAuth2, which this app does not implement and does not
want.

## Deduplication, in three senses

"Duplicate" means three different things here, and only the first one blocks
anything:

| | what it catches | what happens |
|---|---|---|
| **Exact** | the same Freesound clip already on this board | refused, naming the pad it collided with — "show me" or "add anyway" |
| **Near** | one pack's `footstep_01`…`_20` flooding a results page | folded behind a disclosure; four *different* people's "rain" never merge |
| **Acoustic** | a clip that *sounds* like something already on the board | a warning on add, plus an explicit board scan — never a refusal |

The acoustic one uses Freesound's own similarity index, so it costs one request
per clip checked; the other two are free.

## Running it locally

Node 22+. One dependency (`@anthropic-ai/sdk`), no build step.

```bash
npm ci
cp .env.example .env      # add FREESOUND_API_KEY, optionally ANTHROPIC_API_KEY
npm start                 # http://127.0.0.1:8074
npm test
```

An API key comes from <https://freesound.org/apiv2/apply> — the "Client
secret/Api key" column. Token auth is all this app uses.

Without a key the site still runs: boards load and play, and `/api/search`
answers 503 saying so. That is the deliberate shape, because playing a board
spends nothing and searching spends your quota.

## The token

`FREESOUND_WRITE_TOKEN` in `.env` (generate with `freesound token`) gates the
routes that spend the API key or change a board. Reading and playing stay open.
Leave it empty and everything is open, including to anyone who finds the URL —
`/api/health` reports which mode the install is in, so it is never ambiguous.

## Deploying

This site runs on the lab980 droplet at **freesound.lab980.com**. Merging a PR
does not deploy it. See `DEPLOY.md`.
