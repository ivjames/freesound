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

The server stores a cached mp3 *preview* per sound (the same file Freesound
serves publicly to preview a clip) so that a saved board keeps working and a
pad fires without a round-trip. It never fetches or redistributes original
uploads — that needs OAuth2, which this app does not implement and does not
want.

## Running it locally

Node 22+. No dependencies, no build step.

```bash
cp .env.example .env      # add FREESOUND_API_KEY
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
