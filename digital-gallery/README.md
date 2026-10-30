# A(DAI) Digital Gallery

The artworks of the [A(DAI) Digital Arts Commons](https://digitalartsinstitute.io) as one endless stream, braided
forward through time, after Time Coil (204's `mind.art`, itself a remake of mind.lol). Each work holds the stage for four
seconds. Four views, `m` to step through them.

A trimmed fork of A(DAI) Coil (30 Oct 2026): it keeps A(DAI)'s field and the gallery, vortex and city, and leaves out
the coil, the tunnel, the spiral, a second (non-commons) gallery and recording. It is its own package in this
repository, beside the server, like `worker/`.

- **field** (default): A(DAI)'s own view of the commons, its `/field` page (the Shape of Time field), shown as it is from
  the A(DAI) site and opened on the work that was on stage; from there A(DAI) drives. `?field=http://localhost:8080`
  points it at a local A(DAI) (a local origin only: nothing else is framed here). The run holds while it is open; `m`
  or `mode ›` moves on, even after clicking into the field: the field hands `m` back (A(DAI)'s
  `public/field/js-interface/embed.js`, a postMessage handshake, in this repository).
- **gallery**: the works suspended on cables in the dark on either side of a slow walk; real up to the work
  on stage, fine ASCII in the distance. The view follows the mouse, sprung; the wheel walks forward (up) and back
  (down); a far jump fades through black. Click a work to open it: the camera comes up to it and a panel beside it
  gives its words, facts and tags and its neighbourhood in the commons (makers, their other works, concepts, where it
  was shown, visually close works), from per-work files `npm run manifest` writes to `public/data/works/`.
- **vortex**: a sheet of spacetime, ruled with a faint dithered grid, curving down into a well; you look out across it.
  The works are tiled densely on its slope along one spiral that slides on toward the throat: the work on stage lifts
  off to float in front of you, then falls down the well. The view follows the mouse too.
  Press `j` (or the button) to jump into the wormhole: you dive down the throat and come back up somewhere far off in
  the run, another decade. Click a work to open it as a wormhole of its own and dive in: you come back up with it on
  stage.
- **city**: the commons as a town round a plaza. Districts are the places the works were shown (V&A, SuperRare, Art
  Blocks, fxhash, A(DAI)); each artist is a building whose facades are panelled with their works, oldest at the
  bottom; buildings stand oldest nearest the plaza, with the band where each decade begins marked; style-kin links
  (machine-derived) arch from roof to roof. Structure is drawn as faint dithered lines; the works carry it. The eye
  flies from panel to panel as the run moves on; the wheel draws back to an aerial view. Kin links come from
  `public/data/city.json`, written by `npm run manifest`.
Each artist's works keep their own order; artists braid together in chunks of 2–4, and every turn braids them differently.

## Run

Needs Node 22.18 or later (the scripts are TypeScript run by Node itself, with `node:sqlite`) and a local A(DAI)
database: at the repository root run `npm run fork:pull -- --from https://digitalartsinstitute.io --db ./adai.db`
(public data only).

```bash
npm install
npm run artblocks   # ask Art Blocks when each project launched → work/artblocks.json (committed)
npm run manifest    # read adai.db → public/data/manifest.json (gitignored)
npm run dev         # http://localhost:5250
```

`npm run manifest -- --db <path>` reads another database; `--site <url>` changes where the credit links (default the live site).

Keys: `space` pause · `←` `→` previous/next · `m` mode · `i` credit · `f` fullscreen · `j` wormhole (vortex) · `esc` close.
In the 3D views, tap the background to pause or resume and swipe left/right to step; tapping a work keeps its view's action (open, dive or select).
URL: `?work=<artwork slug>` `?artist=<slug>` `?seed=` `?fuzz=0..1` `?hold=<seconds>` `?paused=1` `?mode=field|gallery|vortex|city` `?field=<A(DAI) url>`.

Checks: `npm test` (vitest) and `npm run build` (types, then the bundle); `npm run lint` is the type check alone.

## Dates

A work goes on the coil only with a date it can show and a reason for it (`i` shows both): the year on its A(DAI)
record, an fxhash mint opening, a SuperRare token's creation, an Art Blocks project launch, or the V&A's date text
("c.1974" and "1970s" read as estimates). Works dated only to a year are spread inside it the same way every run.
Works without a readable date stay off (95 of 3,595 at the first build).

## Rights

Code and data follow A(DAI)'s layers: the graph is CC BY-SA 4.0; the artwork images are not licensed by it and stay
with the artists and other rights holders. Images load from A(DAI)'s own mirror; nothing is copied here.
