# A(DAI) — Digital Arts Knowledge Commons

> **⚠️ THE LIVE DATABASE IS THE ONLY SOURCE OF TRUTH.**
>
> The genesis seed pipeline — `seed/*.json`, the offline `seed/_build`
> gatherers, and the build-time reseed bake — was **RETIRED in June 2026**
> (recoverable from git history). The service is live; there is **no
> reseed-from-JSON** and the Docker image ships **no `seed.db`**.
>
> - **Data lives in `/data/adai.db`** on the Fly volume, continuously
>   replicated to R2 by **Litestream**. A fresh host restores the live DB
>   from that replica (see `entrypoint.sh`) — never from a baked seed.
> - **Deploys are code-only.** `just deploy` never touches data; the volume
>   persists across deploys. There is no `nuke-volume` / `redeploy-fresh`
>   anymore. Disaster recovery = a Litestream restore.
> - **New data enters through the governed write path** (`/api/v1/*`,
>   curator `/review`) — never by editing a file and rebuilding.
> - The only files left under `seed/` are the **live R2 janitors**
>   (`cull_orphans.py`, `shrink_oversized.py`); they reconcile the image
>   bucket against the live DB and never read any genesis JSON.

## What this is

A TypeScript/Express HTTP server that serves the A(DAI) digital arts knowledge
graph. It stores practitioner/concept/artwork data in SQLite with CR-SQLite CRDT
extensions, serves HTML pages and a D3/canvas graph visualization, and exposes a
JSON API for graph queries plus a token-gated contributor API for AI assistants.

Live at: https://adai-basel.fly.dev/

## Architecture

```
src/
  index.ts                — entry point: init DB, start Express server
  db.ts                   — SQLite/CR-SQLite setup + migrations
  auth.ts                 — bearer-token auth, requireAdmin
  templates.ts            — HTML page templates (header, footer, CSS)
  routes/
    pages.ts              — HTML page route handlers
    api.ts                — public JSON API route handlers
    contributor-api.ts    — token-gated /api/v1/* write surface
  embed/                  — embedding derive + on-write + neighbours
  archivist/              — the in-app research/archivist surface (model:
                            ARCHIVIST_MODEL; limits: ARCHIVIST_DAILY_BUDGET_USD,
                            default $5/day, and ARCHIVIST_SESSION_QUOTA per hour,
                            default 30; budget-alert.ts emails
                            ARCHIVIST_ALERT_EMAILS — else ADMIN_NOTIFY_EMAILS —
                            at 80 % and at the cap, once a UTC day each)
  intake/                 — URL intake: magic-link auth, drafts (job queue +
                            candidates + confirm), read-tool allowlist, mail,
                            worker spawner, page shells
  routes/intake.ts        — /contribute, /draft/:id, /batch/:id, /auth/:token,
                            /api/intake/* (session cookie or bearer)
  routes/internal.ts      — /internal/intake/* for the worker (X-Worker-Key;
                            mounted only when WORKER_KEY is set)
  utils/                  — token-mint, review, admin-actions, visibility, db-path,
                            ssrf (the one fetch guard), images (image_url → R2),
                            mail (Resend / stdout transport), …
  sync/                   — public CRDT sync: change stream encode/read/apply, fork pull
  routes/sync.ts          — GET /api/sync/info, /api/sync/changes
  cli/                    — operator CLIs (token issue/revoke/restore, rename,
                            privacy-migrate, fork-pull,
                            notify-digest, apply-image-patch, invite, backfill-open-items,
                            merge-nodes, migrate-slugs)
worker/                   — the intake worker (own package + Playwright image,
                            Fly app adai-intake-worker; never opens the DB —
                            talks HTTP to /internal/intake/* only)
db.sql                    — CR-SQLite schema (CRR tables + local tables)
seed/_build/              — the LIVE R2 janitors only (genesis pipeline retired):
    cull_orphans.py       — delete R2 images no live node references
    shrink_oversized.py   — downsize oversized R2 images, repoint cdn in live DB
    .venv/                — boto3 + Pillow (host-only; never in the image)
Dockerfile                — Node 22, multi-stage: builds the server; ships NO seed.db
entrypoint.sh             — boot: use volume DB → else Litestream restore → else fail loud
litestream.yml            — continuous WAL replication of /data/adai.db → R2 (private bucket)
fly.toml                  — Fly.io config (fra region, persistent /data volume)
```

## Running locally

The genesis seed is gone, so a local run needs an existing `./adai.db`. Get one
by pulling the live DB off prod (or restoring from the Litestream replica):

```bash
npm install
echo "get //data/adai.db ./adai.db" | flyctl ssh sftp shell --app adai-basel
just dev          # = npm run dev against the existing ./adai.db (refuses if absent)
# or directly:
npm run dev
```

Server: http://localhost:8080

### Trying the URL intake locally (no Fly needed)

The intake runs entirely on your machine: the main app plus the worker in
poll mode; emails print to the terminal; the Fly spawner is a no-op.

```bash
# .env — add once (keys ≥16 chars; the rest of .env as usual)
SESSION_SECRET=<openssl rand -hex 24>
WORKER_KEY=<openssl rand -hex 24>
MAIL_TRANSPORT=stdout          # magic links land in the server log, not Resend
ADAI_BASE_URL=http://localhost:8080
# ANTHROPIC_API_KEY required (worker); GEMINI_API_KEY optional (embedding
# lookups in resolve_entity / image_neighbours); R2_* optional (image confirm)

just intake-dev                # first run installs worker deps + Chromium; Ctrl-C stops both
```

Then:
1. The intake is **invite-only**: invite yourself first or no link is sent
   (`just invite you@x.y "Name" auto [practitioner:slug]`; `probationary`
   confirms go to `/review`). `INTAKE_OPEN=1` in `.env` skips the check.
   On prod: `just invite-prod …` or the admin endpoints `/api/v1/invites`
   (SKILL.md §4.6b).
2. http://localhost:8080/contribute → your email → "Send me a link".
3. Copy the `http://localhost:8080/auth/…` line from the terminal into the
   browser (single use, 15 min). Set a display name when asked.
4. Paste a URL (a big site like reas.com takes ~5 min and ~$0.75 of Sonnet 5;
   a small portfolio is quicker) → `/draft/:id` polls every 3 s as cards
   appear → accept / reject / edit / answer / chat → Confirm → `/batch/:id`.

Everything writes to your local `./adai.db`, never prod. Two-terminal
alternative: `npm run dev` and `ADAI_URL=http://localhost:8080 npm run
intake:worker`. Tests: `npm test` (main) and `cd worker && npm test`
(mocked model + browser, no Chromium needed).

## Database

Single SQLite file (`/data/adai.db` on Fly, `./adai.db` locally) with CR-SQLite
CRDT extensions (`@shards-lang/crsqlite`). Litestream replicates it to a private
R2 backup bucket continuously.

**CRR tables** (CRDT-synced):
- `nodes` — id, type, name, slug, metadata (full JSON), updated_by
- `edges` — id, source_id, target_id, edge_type, signal_id, confidence, charge,
  created_by, and bi-temporal fields: `event_time` (when the relationship was
  true in the world), `valid_from` (when it entered the graph), `valid_until`
  (NULL = still current), `invalidated_by` (the signal/edge that superseded it)
- `signals` — contributed information; consent fields (`consent_scope`,
  `consent_attribution`, `consent_revocable`), audit fields (`processing_trace`,
  `provenance_chain`), `source_origin`, `batch_id`, `status` ∈ {active, revoked,
  superseded}
- `contributors` — who contributed, trust tier, counts
- `node_aliases` — cross-source entity resolution: `(source, external_id) → node_id`

**Local tables** (NOT CRRs — never synced): `intake_queue` (review pipeline),
`settings`, `contributor_tokens` (sha256-hashed bearer tokens), `node_embeddings`
(768-d multimodal vectors), `archivist_sessions`, `rejected_ai_suggestions`,
`node_claims` + `relation_notes` (claims, below), and
the URL-intake set: `magic_links`, `contributor_sessions`, `contributor_emails`
(email → contributor, `self_node_id`), `drafts` (doubles as the worker job
queue), `intake_open_items` (cards left open at Confirm), `intake_usage`. Email never lands in a CRR.
The private side of signals: `signal_private`, `signal_priors`, `signal_authors`
(below), read back through the `signals_full` view.

**⚠️ The CRR rule: a CRR cell only ever holds what the commons publishes.** The
five CRRs are published as they are — `GET /api/sync/changes` streams cr-sqlite's
own `crsql_changes`, unfiltered, to anyone who forks the commons (*Public sync*
below). Whatever must not be published lives in a LOCAL table, and its CRR cell is
blank (`src/utils/signal-private.ts`):
- **words withheld** — `structural_only`, `revoked`, in review (`pending`,
  published on approval by `publishQueued` / `publishSignal`), `rejected`, a note
  withdrawn while in review, an `objection`: `title`, `summary`, `content`,
  `source_url`, `provenance_chain`, `processing_trace` → NULL in the CRR, the
  originals in **`signal_private`** (one row per signal, `reasons` a comma set);
- **who** — `anonymous`: `submitted_by` → `'anonymous'`, `batch_id` and
  `provenance_chain` → NULL; the real author stays in `signal_private` and
  `signal_authors`; writes it anchors are labelled `anonymous` (`edges.created_by`,
  `nodes.updated_by`; the edge id is `…--anonymous--<signal id>`, one row per
  attesting signal) and its counters go to the sentinel contributor
  `contributor:anonymous` (`ensureContributorRow` / `bumpApprovedCount` take the
  signal id — required). A batch holding an anonymous signal has a private
  handle: its retirement record is public as `Retire batch: correction-<hex>`
  (the full record in `signal_private`, reason `private_batch`);
- **the public form's name** — a `POST /api/contribute` in review holds back
  `submitted_by` too (`pending_name`, CRR NULL) and writes no contributors row;
  approval publishes the name and writes / bumps the row (`approveIntakeItem`).
  From this release on: rows older code created for form names stay public;
- **before-images** — `recordPrior` writes the values to **`signal_priors`**
  (`signal_id, idx, op, node_id, at, updated_by, before`); the CRR trace keeps
  `{"prior":[{op, node_id, at}]}`. An admin record carrying them (retire_batch's
  `patches_to_review`) keeps the record without `before` (the full one in
  `signal_private`, reason `before_images`). Read them with `priorsOf()`.
- A structural_only signal may not write node metadata (`StructuralWriteError`
  in every `materialise*`): node metadata is words in a CRR.

Every signal INSERT goes through `insertSignalRow` (born blank: the words never
touch the CRR); withholding later is `withholdSignal` — copy, verify, then blank by
UPDATE, so cr-sqlite emits the change and every fork loses the value on its next
pull. Back office (`/review`, `/api/v1/review`, the curator audit, the admin
digest, an owner's receipt and `/me` log, batch tools) reads **`signals_full`**
(the CRR row with the originals laid over it); a public surface reads `signals`
and must never output a `signals_full` value. A new private column means a local
table, never a CRR column. Existing data: `npm run privacy:migrate -- --dry-run`,
then without (idempotent, one transaction; it verifies every kept original EQUALS
the CRR value before blanking and aborts on a conflict — `PrivacyConflictError`,
`signal_priors conflict`); `initDb` warns at boot while rows are left, and the
sync endpoint answers 503 until none are. One kind it never moves:
**legacy anonymous contributions** — any anonymous signal not inserted blank by
this code (`signal_private.born_safe = 0`) may have left its author's name in the
stream (an edge id, whose tombstone outlives a DELETE; a reference; a writer
label). Each is a LOCAL `privacy_blocks` row (`src/utils/privacy-blocks.ts`)
that deleting rows never clears: sync answers `503 legacy_anonymous_attribution`
until `npm run privacy:audit-stream -- --clear` scans `crsql_changes`
(tombstones included, writer components matched structurally) and finds nothing;
a tombstone carrying the name means the DB must not be published. A block with
no author label and no author-bearing id to check (insufficient evidence) is
never auto-cleared: only `privacy:audit-stream -- --resolve <signal id> --reason
"…"`, logged in `privacy_blocks.resolution`. Blocks are recorded at boot, by
`privacy:migrate` and by the audit; the gate only reads. Prod never had
an anonymous signal. `anonymousGraphAttribution()` is the current-rows diagnostic
(`503 anonymous_graph_attribution`).

**Node types**: `artwork`, `practitioner`, `concept`, `classification_regime`,
`collective`, `platform`, `institution` (schema reserves `scene`, `publication`,
`project`, `event`, `related`). Cross-source identity merges by node id. Live
counts: `GET /api/stats`.

**Edge types** — 15 curated + 2 auto-derived. Curated: **CLASSIFIED_BY**,
**CREATED_BY**, **EXHIBITED_AT**, **EMBODIES** (artwork → concept/tag-concept),
**PRACTICES**, **BELONGS_TO**, **COLLABORATES_WITH**, **USES_TECHNIQUE**,
**INFLUENCES**, plus the show/gallery cluster (a show is a `project` node):
**PARTICIPATED_IN** (practitioner → project), **PRESENTED_BY** (project →
institution), **CURATED_BY** (project → practitioner), **REPRESENTS**
(institution → practitioner), and **HELD_BY** (artwork → institution: in its
collection — EXHIBITED_AT is where it was shown), and **DOCUMENTS**
(publication → project / artwork: a catalogue, book or journal issue
documenting a show or a work; "documented in" from the other end). Auto-derived by `npm run embed:derive`: **STYLE_KIN**
(creator ↔ creator), **VISUALLY_AFFINE** (artwork ↔ artwork), plus Tier-2
inferred concept-EMBODIES (`created_by='embedding-multimodal-v1'`, dashed in
`/field`). **RESPONDS_TO** (artwork → artwork) is reserved and intentionally
empty — it requires evidence of artist intent, not thematic similarity.
`db.sql` has no CHECK constraint on `edge_type`; prefer the existing types.

### Querying rules

- **Bi-temporal**: always filter `WHERE valid_until IS NULL` on `edges` queries
  that represent current state (unfiltered queries return historical edges too).
  `db.sql` indexes `valid_until`. Profile pages, `/api/graph`, `/api/graph/:slug`,
  and the component endpoint all apply it.
- **Retired-node visibility** (`src/utils/visibility.ts`,
  `json_extract(metadata,'$.retired') IS NOT 1`): retired nodes drop out of every
  listing surface but stay reachable by direct URL. Applied at `/api/stats`,
  `/api/graph*` (⚠️ stamp-pinned — `total_nodes`/`curated_edges` must stay
  clause-identical to the stream queries or the `/field` IndexedDB cache never
  validates; `curated_edges` counts distinct (source, type, target) relations,
  because the stream collapses several claims of one relation into one edge), page listings, archivist search, `src/embed/vectors.ts loadAll`,
  and embed backfill.

## HTTP endpoints

### HTML pages
- `GET /` — home with stats + recent additions
- `GET /explore` — list practitioners
- `GET /graph` — D3 force-directed graph
- `GET /field` — the 30k canvas field view (press `e` for embeddings mode);
  `GET /field/<type>/:slug` opens it focused on a node (the legacy
  `/field?node=<id>` 301s there)
- `GET /<type>/:slug` (practitioner, artwork, concept, …) — the **entity view**,
  server-rendered by `src/entity/view.ts` (+ `page.ts`): hero work, the node's
  own words, works, graph-derived relations, embedding neighbours (filled
  client-side). Resolves (type, slug), then slug alone; a wrong type segment
  301s. The /field overlay is the SAME article via `GET /api/entity?id=`;
  styles in `public/field/css/entity-view.css`, client in
  `public/field/js-interface/entity-view.js`. Showcase data: `src/entity/showcase.ts`.
- `GET /record/<type>/:slug` — the record view (back office: every field,
  contributions as prose, raw relations, provenance); linked from the entity
  view for curators and from `/review`
- `GET /:type/:slug/history` (+ `history.json`) — every metadata edit (before →
  after) and every relation added/ended, newest first, each with its signal;
  consent-filtered like the profile (`src/utils/history.ts`)
- `GET /neighbours/:type/:slug` — similarity browser (top-20 cosine neighbours)
- `GET /contribute` — signal submission form
- `GET /review` — curator review queue (curators only: a session whose email
  is in `ADMIN_EMAILS` — falls back to `ADMIN_NOTIFY_EMAILS` — or whose
  contributor holds an admin token; `POST /api/review/:id/*` likewise)
- `GET /claim/:type/:slug` · `GET /me` · `GET /@:handle` — claims (below)
- `GET /skill.md` — the contributor contract (verbatim `SKILL.md`)
- `GET /adai-contribute.zip` (alias `/skill.zip`) — the same file as Claude's
  skill uploader takes it: a zip holding `adai-contribute/SKILL.md`, built per
  request from `SKILL.md` (`src/utils/zip.ts`, no dependency)
- `GET /whitepaper` — the current whitepaper; `/whitepaper/v1.7` pins a release
  (see *Whitepaper* below)
- `GET /offline` — the commons on your own machine (issue #82): download the
  public snapshot (`SNAPSHOT_URL`; unset → "not published yet"), open it, query it

### JSON API
- `GET /api/stats` — node/edge/signal counts (retired-filtered)
- `GET /api/staging` — staging only: the switch state (see *Staging*)
- `GET /api/activity` — the live activity feed (issue #83, `src/utils/activity.ts`):
  the past 24 h only, consent-filtered, never from the cached graph stream;
  off unless `ACTIVITY_FEED=on` (or `settings.activity_feed='on'`; on staging the
  `activity` switch). `/field` shows it as a small collapsible "live" chip
  (`public/field/js-interface/activity.js` + `css/activity.css`), polled each 60 s;
  lines also expire client-side at their 24 h mark, and an error clears the feed
- `GET /api/graph` — full graph as D3 `{nodes, edges}`, `?type=` filter; nodes
  carry `cdn_image_url`/`image_url` when present
- `GET /api/graph/:slug` — ego graph (1-hop)
- `GET /api/graph/:slug/component` — full connected component (BFS over live
  edges; `?max_nodes=800`, up to 5000; `truncated: true` when hit)
- `GET /:type/:slug/data` — full JSON export (metadata + edges + approved
  signals); slug-only resolution, the type segment is decorative
- `POST /api/contribute` — submit a signal. Anonymous by identity: always
  probationary (`/review`), never a trust tier by typed name; approval writes a
  separate contributors row (`contributor:form-<hex>`, type `form`, the typed name
  as display name), never counts on an existing one. Operator lookups by name
  (`token:issue`, `token:revoke`, `contributor:rename`) skip `form` rows. A
  byline's node link ("contributed by X" on `/history`, `/record`, the entity
  view, `/<type>/<slug>/contributions`) comes from the signal's actual author
  (`signalAuthorNode` in `src/utils/contributor-node.ts`: `signal_authors` →
  that contributor's token node), never from the typed name; a `form` row links
  nowhere. **Ownership is decided in one place, `src/utils/authorship.ts`**
  (`signalOwner` / `ownedBySql` / `isFormShaped`): the authenticated author
  (`signal_authors`), else the approved form signal's own row (local
  `form_signals`), else nothing for a form-shaped signal (plain contribution, no
  batch id), else a legacy write by an unambiguous non-form name. Bylines,
  `GET /api/v1/contributions`, the contributions page and counts, snapshot
  credit and `contributor:rename` all use it.
- `POST /api/review/:id/approve` · `/reject` — curator actions
- `GET /api/sync/info` · `GET /api/sync/changes?since=&limit=` — the public
  CRDT change stream (*Public sync* below)

### URL intake (`/contribute`, `/draft/:id`, `/batch/:id`, `/api/intake/*`)

Spec: `docs/URL-INTAKE-SPEC.md`. A contributor signs in by magic link
(`POST /api/intake/login` → email → `GET /auth/:token` → `adai_session`
cookie), pastes a URL (`POST /api/intake/drafts`), a **separate worker
process** (`worker/`, Playwright + `claude-sonnet-5`) reads the site and
proposes *candidates* (nodes, edges, images, patches, questions, "known")
onto the draft, the contributor reviews them on `/draft/:id` and presses
**Confirm** → `confirmDraft` turns accepted cards into ONE batch
(`batch_id = draft id`) through `insertSignal` + `materialise*` (auto /
reviewed) or one pending `intake_queue` row (probationary). Receipt at
`/batch/:id`.

A read is a **dated snapshot**: signals carry the page's read date and hash;
a later read of the same site is an update (unchanged pages skipped), and a
present-tense relation the site no longer shows (REPRESENTS) comes back as an
`ended` card that closes the edge bi-temporally (spec §6.2c). Institution
pages lead with an artists roster derived at read time (`src/utils/roster.ts`);
`metadata.kind` on an institution is a list from `src/utils/org-kinds.ts`
(the roster also reaches `/field`, the archivist's `get_node` and `/:type/:slug/data`).
Edge direction by node type is enforced for intake (`EDGE_DIRECTIONS` in
`src/intake/candidate.ts`; a warning on `/api/v1/edges`). One relation with
several claims is shown once, "claimed by N sources", counted by distinct
evidence origin — the evidence page's host, else the attesting person —
not by contributor (`src/utils/claims.ts`); `/field` threads get heavier with N.

What a contributor does not decide stays **open** at Confirm (`intake_open_items`,
`src/intake/open-items.ts`): any invited contributor picks a read's open items up
from `/contribute` (or the subject's page) into a draft of their own
(`drafts.picked_from`) and decides them under their own name; the first proposer
stays in provenance (`picked_from`) and `/history` (spec §10b).

Sign-in is **invite-only** (`contributor_emails.invited_at`; admin
`POST/GET /api/v1/invites`, `POST /api/v1/invites/revoke`); uninvited requests
land in `intake_access_requests` and email the admins.

Two promises enforced in code: (1) the worker has **no graph write path** —
`/internal/intake/tool` is an allowlist of read tools, the draft endpoints
touch only `drafts` (`tests/intake-imports.test.ts`); (2) nothing leaves a
draft until Confirm. Relation policy (§7 of the spec) lives in
`src/intake/candidate.ts` — INFLUENCES / RESPONDS_TO only through an
answered question. `/api/intake/*` also accepts a `/api/v1` bearer token, so
an external assistant can drive drafts. Secrets: `SESSION_SECRET`,
`WORKER_KEY` (main + worker app), `WORKER_IMAGE` + `FLY_API_TOKEN`
(spawner), `INTAKE_FROM` (optional). Locally: `just intake-dev`; invites:
`npm run invite` / `just invite-prod`. Worker image: `just deploy-worker`
(build-only + push; the main app spawns one ephemeral machine per job via
the Machines API; the worker calls back over the public HTTPS URL
(`WORKER_ADAI_URL`) — NOT Flycast, which `force_https` breaks; first-time Fly
setup is in `docs/URL-INTAKE-SPEC.md` §14).

### Claims, handles, the personal log (`docs/CLAIM-SPEC.md`)

A contributor **claims** a practitioner / collective / institution page
(`node_claims`, local). An invite naming the node (`contributor_emails.self_node_id`,
backfilled into claims at boot) or a claimed peer's invite is instant;
anything else is `/review?kind=claim` — and a second claim on a claimed
practitioner always is. The public face is `metadata.claimed = {at, handle,
by[]}` (written with its before-image) and a `claim` signal. **Handles** are
`node_aliases(source='handle')` — that CRR's PK makes them unique; old
handles keep resolving; `/@:handle` 302s to the node. Claimants never
approve anything: on `/me` (`GET /api/me/log`) they **contest** a relation
or an edit (public at once; `kind='contest'` — approve = uphold: the relation
ends bi-temporally / the key returns to its before-image; reject = dismiss),
add **context** (tier-gated, `kind='context'`), **object** to a pending item
(settled by that item's outcome), and **invite** the unclaimed other end of a
live relation (instant claim, 10/week). Notes are signals + `relation_notes`;
they show on the profile, in `/history` and, for open contests, dashed in
`/field` (`GET /api/contested`, deliberately off the cached stream). `/field`
opens on a signed-in claimant's node; `m` / the chip veils everything beyond
2 hops (1 past 500 nodes). Receipts (`/batch/:id`) ask "is one of these you?".
Code: `src/claim/*`, `src/routes/claim.ts`; SKILL.md §1.9 + §4.6c.

Claimants are **told** when someone else adds a relation (live or in review), an
edit or a note about their page (issue #81, `src/notify/claimants.ts`): a scan
over `nodeHistory` + the review queue records `claimant_events`, mail goes out
per the `/me` setting (`notify_prefs.email` = immediate | daily (default) | off;
`GET/POST /api/me/notifications`), consent-filtered ("Someone …"), never about
their own contributions. Immediate: the server, ~90 s after a contribution
(`src/notify/kick.ts`; `NOTIFY_CLAIMANTS=off` disables it). Daily:
`node dist/cli/notify-claimants.js` in `notify-digest.yml` (exits 1 if any
email failed). Events store references and are re-checked when the mail is
written (claim still approved, node not retired, nothing rejected / withdrawn
/ revoked; consent read then). Emails are reserved as leased batches before any
network I/O and sent with the batch id as Resend's `Idempotency-Key`, so
overlapping passes or a crash never send twice (lease-fenced writes; the whole
provider request frozen; preference, claims and every line re-checked before
each attempt; past Resend's 24 h key window an unresolved batch becomes
`state='reconcile'` for a person, never resent). Deliveries are per channel
(`claimant_deliveries`), so web push can join email later.

**Readings** (issue #80 part 3): ANY contributor — no claim needed — attaches a
labelled reading to one live relation (`relation_notes.kind='reading'`, written
by `fileReading` in `src/claim/notes.ts`; `node_id` = the relation's source, no
claim implied). `POST /api/v1/readings` (bearer) or `POST /api/readings`
(session: the "+ reading" button on an entity-view relation row) with
`{relation, note, source_url?, consent_scope?, consent_attribution?, batch_id?}`;
`…/:signal_id/withdraw` by its author (JSON only; never undoes an admin revoke).
5 a minute / 30 a day per contributor across both routes (429); both stay
under the tight 64 KB body cap (`src/utils/json-body.ts` skips them in the
app-wide 16 MB parser). A row shows its latest 3; `/history` lists a note
only once it was published. Tier-gated like context (probationary →
`/review?kind=reading`). Shown on the relation row and in the accounts section
of both ends as "a reading by X" — `publicNotesFor` never lets a reading be the
subject (no handle, `subject_now` false, even for a claimant), and only while
the relation is live. Taken down by the admin correction model (revoke the
signal; retiring a node or batch ends the relation).

### Contributor API (`/api/v1/*`) — bearer-token, AI-driven

The write surface for AI assistants. Every endpoint requires
`Authorization: Bearer <token>`; tokens are issued out-of-band
(`npm run token:issue`) and stored sha256-hashed in `contributor_tokens`. The
caller contract is `SKILL.md` (served at `GET /skill.md`).

- `GET /api/v1/whoami` — identity + trust tier + r2 status + token scope
- `POST /api/v1/signals` — text contribution about an existing node
- `POST /api/v1/nodes` — create practitioner / artwork / concept / …; dedupes
  on (type, slug) against live nodes (`existingNodeBySlug`, also in
  `materialiseCreateNode` and URL-intake Confirm): a legacy spaced id with the
  same slug is returned with `created: false` + a warning, never duplicated
- `PATCH /api/v1/nodes/:id` — JSON-merge-patch on `metadata` (null deletes a key)
- `POST /api/v1/edges` — add an edge; bi-temporal supersession via
  `supersedes_edge_id`
- `POST /api/v1/images` — `multipart/form-data`, JSON `image_base64`, or JSON
  `image_url` (server-side fetch through the SSRF guard, magic-byte sniffed);
  uploads to R2 (content-addressed `images/<sha[:2]>/<sha>.<ext>`), attaches
  `cdn_image_url`
- `POST /api/v1/packages` — new nodes AND their edges in one write (edge ends: a
  live id or a node of the package by `ref` / id / unique name; ≤100 nodes,
  ≤300 edges; any problem → 400 listing all, nothing written; retired nodes
  refused). Probationary: ONE review item (`source_type='api_package'`,
  `target_node` = its first new node), approved or rejected whole; else applied
  in one transaction. `approveIntakeItem` runs in a savepoint for every item:
  a failure part-way writes nothing and the item stays pending; embeds run
  after, one at a time (`embedNodesAsync`)
- `GET /api/v1/contributions` — the contributor's own history
- `POST /api/v1/readings` (+ `/:signal_id/withdraw`) — a labelled reading of
  one live relation (see *Readings* above; SKILL.md §1.10)

Every write accepts an optional **`batch_id`** (stamped onto the anchoring
signal) making a whole upload session inspectable (`GET /api/v1/batches`) and
retirable as a unit (retire, not rollback: earlier values on nodes it changed
are listed for review, not restored). Format `[A-Za-z0-9][A-Za-z0-9._:-]{0,119}`.

Admin endpoints (require `scope='admin'`, enforced by `requireAdmin`):
- `GET/POST /api/v1/tokens`, `POST /api/v1/tokens/:prefix/revoke` — token mgmt
  (HTTP can only mint **write**-scope; admin tokens are operator-CLI-only)
- `PATCH /api/v1/tokens/:prefix {"node": id|null}` — the node a token's
  contributor stands for (`contributor_tokens.node_id`, issue #70; also
  `token:issue --node`): "contributed by X" links to it, its page says
  "contributes to the commons as X", `/<type>/<slug>/contributions` lists them
  (`src/utils/contributor-node.ts`); `{"tier": "auto"|"reviewed"|"probationary"}`
  on the same call sets the token's contributor's trust tier (all their
  tokens, from the next request; no SSH needed)
- `GET /api/v1/review`, `POST /api/v1/review/:id/approve|reject`,
  `POST /api/v1/review/bulk` — JSON twin of the curator queue
- `POST /api/v1/signals/:id/revoke` — status→revoked + supersede anchored edges
- `POST /api/v1/nodes/:id/retire` — supersede live edges + set `metadata.retired`
- `GET /api/v1/batches`, `POST /api/v1/batches/:batch_id/retire` — batch retirement

**Admin correction model (`src/utils/admin-actions.ts`): nothing is ever
deleted.** Signals flip `status='revoked'`; edges supersede bi-temporally; nodes
get `metadata.retired` and drop out of listings while staying reachable by URL.
Every correction inserts an anchoring admin signal (`source_type='api_admin'`)
that superseded edges reference via `invalidated_by`. SKILL.md §4.4–4.7 + §6
document the workflow.

**Duplicates and old addresses** (operator CLIs). `npm run node:merge -- --from
<id> --into <id> --reason "…" [--dry-run]` (`mergeNodes`) re-makes the
duplicate's live relations on the kept node (same source, contributor, event
time; the old ones superseded), copies metadata the kept node lacks, moves its
`node_aliases`, repoints `contributor_tokens.node_id` and
`contributor_emails.self_node_id`, and retires it with `metadata.merged_into`; refuses a claimed
duplicate. `npm run slugs:migrate -- [--dry-run]` (`migrateSlugs`) rewrites
slugs that predate the current slugifier (source suffix kept, ids unchanged).
Either way the old address **301s** to the current one on every page that
takes a slug (`src/utils/moved.ts`; a rewritten slug is kept as
`node_aliases(source='slug', external_id='<type>/<old slug>')`).

**Every node write keeps its before-image.** Metadata is overwritten in place,
so each patch / image attach / retire records what it replaced for the causing
signal (`recordPrior` in `src/utils/contribution.ts`): the values in the LOCAL
`signal_priors` (`{op,node_id,at,updated_by,before}`), only `{op,node_id,at}` in
its CRR `processing_trace.prior` — read them with `priorsOf()`
(`src/utils/signal-private.ts`). The operator CLIs
(`apply-image-patch`, `contributor:rename`, both `--by <operator>`) write an
`api_admin` signal too. A URL-intake card the contributor changed carries the
reader's original in its signal's `provenance_chain.proposed_as`.

**Trust tiers**: `auto` (founding team + self-report — auto-merge), `reviewed`
(established — auto-merge + tagged), `probationary` (default for new contributors
— queued for `/review`). `scope` (write|admin) governs *which endpoints*;
`trust_tier` governs *whether writes auto-merge or queue* — the two are
decoupled (an admin can be probationary). Mint/revoke/list logic lives in
`src/utils/token-mint.ts`, shared between HTTP and CLI.

Token CLI (local issues raw token to stdout once; store keeps only the hash):
```bash
npm run token:issue   -- --contributor "Name" --label "laptop" [--create --tier probationary] [--admin]
npm run token:revoke  -- --prefix adai_abc12345        # or --list [--contributor X]
npm run token:restore -- --from .tokens.json [--dry-run]   # disaster recovery

# Production (against /data/adai.db on the volume, via SSH):
flyctl ssh console --app adai-basel -C \
  "node /app/dist/cli/issue-token.js --contributor 'Name' --label 'l' --create --tier reviewed"
```
CLIs resolve the DB path via `src/utils/db-path.ts` (`DB_PATH` → `/data/adai.db`
→ `./adai.db`). `.tokens.json` (gitignored, repo root) holds the raw operator
tokens for `just restore-tokens`. `contributor_tokens` is local-only — never a
CRR (token material must never sync).

## Public snapshot (issue #82)

`npm run snapshot:export -- --out file.sqlite [--jsonl dir]` (`src/cli/export-snapshot.ts`,
`src/snapshot/build.ts`) reads the source **read-only** (no `initDb`, one read
transaction) and writes, atomically and never over the source, a **plain SQLite
file** (no cr-sqlite needed) with only the five CRR tables plus a `meta` table.
The privacy boundary is the projection: public signals only, decided per batch and
operation (a probationary URL-intake batch stays out while its review is pending
or rejected); structural_only / revoked keep the row without words; anonymous
ones lose every correlation handle (batch id, provenance; edges' `created_by`
and ids re-minted, references followed); signal content is prose only — structured
(JSON) bodies (API payloads, admin records with before-images) become at most
`{op, node_id?, edge_id?}`; node metadata is a typed, recursive allowlist of what
the entity view shows (key works as `{title, year, description}`, no
`image_provenance`, the upstream `image_url` only without a mirror copy), minus
any value a restricted or non-public contribution wrote; URLs (aliases included)
lose signed-looking query parameters, and one with userinfo is left out; `updated_by` only when the latest writer is
public and attributed; contributors only when named publicly, counters recomputed,
no trust tiers; references to records not in the file are NULL. A central
sanitiser (emails, common key shapes) runs over every value, every serialised JSON
string and every `meta` value as defence in depth only. No local tables, no embeddings; images stay on the public R2 URLs. Publishing:
`.github/workflows/snapshot-publish.yml` (dispatch-only until the licence statement
is decided) uploads to the public bucket under `snapshots/` — outside the
`images/` prefix `cull_orphans.py` works on.

## Public sync — fork the commons

Anyone can fork the commons by pulling cr-sqlite changes into a fresh database and
keep it current by pulling again (`/offline` explains it to the public). Safe to
publish unfiltered because of the CRR rule (*Database* above): no shadow database,
no per-cell filtering.

- `GET /api/sync/info` → `{format: "adai-crsql-changes/1", site_id (hex),
  db_version, schema: {hash, tables}, tables}`; `schema.hash` is a sha256 of the
  five CRRs' `PRAGMA table_info` (a fork must match it).
- `GET /api/sync/changes?since=<cursor>&limit=<n>` (default 5000, max 20000) →
  `{format, site_id, since, next, more, db_version, count, changes}`; each change
  is `[table, pk(base64), cid, val, col_version, db_version, site_id(hex), cl,
  seq]`, `val` typed exactly (text = string, integer = number or `{"i":"…"}`
  beyond 2^53, real = `{"r":n}`, blob = `{"b":base64}`, null). Ordered by
  `(db_version, seq)` in one read transaction; pages end on whole db_versions,
  except one transaction bigger than the limit (the genesis load, a nightly
  re-derive), split by seq with a `"<db_version>:<seq>"` cursor. A page also keeps
  a byte budget (~4 MB of encoded JSON, `DEFAULT_MAX_BYTES`), cut by the same
  rule; a single cell bigger than that is a page of its own. `since=0` = all.
  gzip off the request thread (async zlib); `Cache-Control` 5–30 s; no auth;
  240 requests / 10 min per client (`clientIp`: on Fly — `FLY_APP_NAME` set —
  `Fly-Client-IP`, else the last `X-Forwarded-For` hop; `TRUST_PROXY=1` trusts the
  last hop elsewhere; otherwise the socket address); candidates are read one at a
  time and measured with `Buffer.byteLength`;
  `PUBLIC_SYNC=off` disables it; 503 while `privacyBacklog()` is not zero.
  Code: `src/sync/changes.ts`, `src/routes/sync.ts` — its own route, never the
  stamp-pinned `/api/graph/stream`.
- `npm run fork:pull -- --from <base url> [--db ./fork.db] [--limit N] [--force]`
  (`src/sync/pull.ts`): `initDb` on the target (real CRRs), applies each page
  with `INSERT INTO crsql_changes` in one transaction with its cursor, keeps
  `fork_source_url`, `fork_source_site_id`, `fork_cursor`, `fork_pulled_at` in
  `settings`; re-runs pull only what is new. Refuses a different source site id,
  a target that already holds CRR rows and is no fork (both `--force`), a
  different CRR schema, and itself. `secure_delete` on, so an overwritten value
  (a revocation) is zeroed on the fork's disk. Then `DB_PATH=./fork.db npm run dev`.
- Not in the stream: every local table (tokens, emails, sessions, drafts, the
  review queue, claims' private side, notification state, `signal_private`,
  `signal_priors`) and **embeddings** — a fork runs `embed:backfill` with its own
  key. A fork's `/api/stats` matches except `pending_reviews` (local); profile
  sections fed by `intake_queue` (community contributions, accounts) and
  before-images on `/history` are empty there.
- Volume: today's commons is ~480k changes (~25 pages at the max limit). The
  nightly `embed:derive` is a diff (below): a run on unchanged vectors emits zero
  changes, a changed vector only the edges it is part of — a fork pulling daily
  receives what actually changed, not the whole derived layer (the old
  delete-then-insert emitted ~125k changes a night).

## Whitepaper

`src/routes/whitepaper.ts` renders `public/whitepaper/v<version>/whitepaper.md`
(committed markdown, `marked`, raw `<figure>` HTML passes through) inside the
site chrome. Each version is a release with its own directory, figures and
permanent URL; `/whitepaper` is the first entry of `public/whitepaper/versions.json`.
The raw markdown and figures are served beside it (`/whitepaper/v1.7/whitepaper.md`).
The text is written in the team's Google Doc; a release comes in through
`just whitepaper-import <file.docx> <version>` (pandoc + cwebp, host-only) as a PR.
The .docx export holds every tab of the doc — only the paper itself ships.
The `/field` philosophy panel's "Read the whitepaper" button points at `/whitepaper`.

## Embeddings

Gemini Embedding (multimodal, 768-d, L2-normalised). Vectors live in the
local-only `node_embeddings` table (NOT a CRR).

- **Provider** (`src/embed/provider.ts`): `EMBED_PROVIDER=gemini` (default,
  `GEMINI_API_KEY`) or `openai` — any OpenAI-compatible `/embeddings` endpoint
  serving an open model (`EMBED_BASE_URL`, default DeepInfra; `EMBED_API_KEY`;
  `EMBED_MODEL`, default `google/embeddinggemma-2`). `node_embeddings.model` is
  the model's tag and every reader takes only the current tag, so a **model
  switch** = set the env, `embed:import --from=<db>` (reuse vectors already
  computed elsewhere: a row moves only when its model, text hash and image hash
  — read off the content-addressed R2 key, no download — match what the node
  would be embedded from now; seconds, no API calls), `embed:backfill` (embeds
  only what is left), `embed:derive` with re-carried τ. Compare two models first
  with `scripts/embed-compare.ts`. Images the provider can't take (AVIF, >14 MB)
  embed as text only. The staging `gemini` switch governs either provider.
  `initDb` sets a 15 s busy timeout, so the server and an operator CLI writing
  the same file wait for each other instead of failing "database is locked".

- **`npm run embed:derive`** chains `centroids → derive`: recomputes style
  centroids for practitioners + collectives from live `CREATED_BY` edges and
  emits **STYLE_KIN** + **VISUALLY_AFFINE** rows plus **SUGGESTS_CREATED_BY**
  proposals into `intake_queue` (`kind='ai_suggestion'`), then runs **Tier-2
  concept propagation** (`src/embed/concept-edges.ts`). Calibrated thresholds:
  τ_attribute=0.88, τ_kin=0.91, τ_visual=0.84 (env-overridable
  `TAU_ATTRIBUTE`/`TAU_KIN`/`TAU_VISUAL`). **Incremental**: the run computes the
  desired derived set — ids deterministic,
  `<source>--<TYPE>--<target>--embedding-multimodal-v1`, confidence the constant
  `'low'` (no score stored, so float noise can't rewrite a cell) — and diffs it
  against the current derived rows in one transaction (`applyDerivedEdges` in
  `src/embed/derive.ts`): INSERT only new edges, hard-DELETE only unwanted ones
  (a derived edge is a recomputed view, not a claim — `/history` leaves them out;
  ending them bi-temporally would pile up dead rows in the public tables), UPDATE
  only a cell that differs; unchanged rows keep their `created_at`/`valid_from`.
  Twice on unchanged vectors = zero `crsql_changes` (`tests/derive-incremental.test.ts`).
  Computed on ONE read snapshot (ended before any write), applied in one short
  `BEGIN IMMEDIATE` (centroids, pending suggestions, edge diff together) after an
  input fingerprint check; inputs changed meanwhile → recompute (≤ 3 attempts),
  never a stale-snapshot upgrade; a dry run writes nothing (centroids in memory);
  the stats carry `edges: {desired, inserted, deleted, updated_rows, updated_cells}`.
  Pending `ai_suggestion` rows (local) are still replaced each run. The pipeline
  **refuses to auto-emit INFLUENCES or RESPONDS_TO** by design.
- **Embed-on-write**: `/api/v1/nodes` (POST/PATCH) and `/api/v1/images` call
  `embedNodeAsync` after materialise; failures are logged, never block the
  response. Requires `GEMINI_API_KEY` (Fly secret; `.env` locally).
- **Daily re-derive** (`.github/workflows/embed-derive-daily.yml`, 04:00 UTC):
  `embed:backfill` (catches anything embed-on-write missed) → `embed:derive`
  (no API calls) → `embed:report-drift`, all against the live DB. Required
  secrets: `FLY_API_TOKEN` (org-scoped deploy token), `GEMINI_API_KEY`. Each
  SSH step `curl`-warms `/api/stats` first (auto-stop idle timer).
- **Drift surveillance**: `npm run embed:report-drift` shows where the hard-coded
  τ sit in the live distribution (target τ_kin≈p95, τ_visual≈p99,
  τ_attribute≈p99). Re-tune by hand with `npm run embed:calibrate`.
  Auto-recalibration is intentionally not wired.
- **Surfaces**: profile-page Style-kin/Visually-affine sections,
  `/neighbours/:type/:slug`, and `/field` (`e` to foreground derived edges).

## Image mirror — Cloudflare R2

All node images are mirrored to a public R2 bucket so the graph renders even when
upstream URLs rot. New images arrive at runtime via `POST /api/v1/images`.

- **Bucket** `adai`. Public base `https://pub-ebd869876a824a5e83dbb2fe42d03211.r2.dev`.
- **Key scheme**: content-addressed `images/{sha256[:2]}/{sha256}.{ext}` — same
  bytes dedup automatically. `Cache-Control: public, max-age=31536000, immutable`.
- **Per-node fields** (in `metadata`): `image_url` (upstream provenance) +
  `cdn_image_url` (R2). Profile pages prefer `cdn_image_url`; keep both.
- **R2 secrets** (Fly secrets / `.env`): `R2_ENDPOINT`, `R2_BUCKET`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_BASE`. Litestream uses a
  **separate private** backup bucket via `R2_BACKUP_*` (never the public image
  bucket). Without the image creds `POST /api/v1/images` returns
  `503 r2_not_configured`; other endpoints still work.

### The R2 janitors (`seed/_build/*.py`, host venv)

Both reconcile against the **live DB only** — they never read any genesis JSON.
Run via the justfile recipes, which pull `/data/adai.db` (+ WAL) off the volume.

- **`cull_orphans.py`** — deletes R2 objects under `images/` that **no live node
  references** (`metadata.cdn_image_url`, retired nodes included). Dry-run by
  default; `--delete` removes them (batched; refuses if the DB resolved <100
  references — bucket-wipe guard). `just cull-orphans-prod` / `-delete`.
- **`shrink_oversized.py`** + **`dist/cli/apply-image-patch.js`** — finds R2
  images over a size threshold (default >5 MiB) still referenced by a live node,
  downsizes them (longest edge ≤2048px, **format + animation preserved**, never
  upscaling) to a **new content-addressed key**, uploads it, and emits a patch.
  Because keys are content-addressed the resized bytes hash to a new key, so the
  repoint lands in the **live DB only** via `apply-image-patch.js` (guarded by an
  old-value match; idempotent; **never re-embeds** — the image is visually
  identical). The old object becomes an orphan → reclaimed by `cull_orphans.py`.
  **Separation of concerns: shrink swaps the reference, cull reaps the dead
  object.** `just shrink-oversized-prod` / `-measure` / `-apply`. ⚠️ the apply
  recipe needs `dist/cli/apply-image-patch.js` on the machine — `just deploy`
  first if you just changed it.

## Deploying

```bash
just deploy        # FLY_REMOTE_BUILDER_REGION=iad flyctl deploy --ha=false
just logs          # tail recent logs
just ssh           # interactive shell (warms the machine first)
just wait-healthy  # poll /api/stats until healthy
```

- **Deploy is code-only.** The `/data` volume persists across deploys; the
  entrypoint sees the existing DB and uses it as-is. There is **no reseed and no
  volume wipe** — the genesis bake + `nuke-volume`/`redeploy-fresh` were retired
  June 2026. Disaster recovery is a **Litestream restore** (automatic on a fresh
  host; manual via `litestream restore`).
- `--ha=false` is mandatory: flyctl's HA default silently creates a second
  machine + volume (two divergent DBs behind one hostname).
- **Schema migrations are not automatic.** `initDb` runs `db.sql` on every boot
  (fine for `CREATE … IF NOT EXISTS`), but adding a column to an existing table
  must go through the idempotent try/catch pattern in `src/db.ts` (keyed to
  SQLite's stable "duplicate column name" error). Don't strip those try/catch
  blocks; blowing away the volume is not an option.

### Staging (`adai-staging`, `fly.staging.toml`)

https://adai-staging.fly.dev runs **the `staging` branch on a copy of the prod DB** — the place
to land and break things before a deliberate `just deploy` to prod.

- **Code**: `.github/workflows/staging-deploy.yml` deploys the `staging` branch
  after CI passes on it — merges to main never move staging. `just
  staging-promote` fast-forwards `staging` to main; `just staging-deploy` (or
  the Action run by hand) puts any branch up until the next push to `staging`.
- **Data, one way**: `entrypoint.sh` with `ADAI_ENV=staging` restores from the
  prod Litestream replica on the first boot after 03:00 UTC
  (`staging-refresh.yml` restarts a running machine at 03:15) and **never
  replicates** — a staging writer in the backup bucket would corrupt the
  disaster-recovery copy. `just staging-refresh` restores now.
- **Switches** (`src/utils/staging.ts`, one secret `STAGING_SWITCHES`): every
  outward integration is off by default and flipped per debugging session —
  `mail=stdout|allowlist:<addr|@domain>,…|live`, `worker=on`, `r2=on`,
  `gemini=on`, `archivist=off`, `activity=on`, `data=keep` (skip the nightly restore).
  `just staging-set mail=allowlist:x@y.z worker=on` sets the WHOLE state,
  `just staging-reset` returns to defaults, `just staging-status` shows them;
  a red bar on every staging page shows them too. On prod (`ADAI_ENV` unset)
  every switch is on and nothing changes.
- Staging is `noindex` (header + robots.txt). It shares the
  `adai-intake-worker` app, so its `WORKER_KEY` equals prod's.
- First time: `just staging-bootstrap`, set the R2 / worker secrets it prints,
  `just staging-deploy`.

### Ops via `just`

`brew install just`; `just` lists recipes. Key ones beyond deploy:
- `just warm` — wake the idle machine (`fly.toml auto_stop_machines='stop'`).
- `just tokens-list` — list active tokens on prod over SSH.
- `just restore-tokens` / `-dry` — re-insert operator tokens from `.tokens.json`
  (SFTP → run CLI → delete; idempotent, transactional). `.tokens.json` is
  gitignored and never lands on the VM at rest.
- `just cull-orphans-prod[-delete]` · `just shrink-oversized-prod[-measure|-apply]`
  — the R2 janitors (above).

## ID convention

`<type>:<name>` with spaces preserved and lowercase (e.g. `practitioner:casey
reas`, `artwork:fidenza`). The `slug` field is the kebab-case URL-safe form.
Server-side writes compute `<type>:<slug>`; live contributions may use kebab ids
(`practitioner:mat-dryhurst`). Cross-source identity merges by node id.

### Intake worker build inputs

The worker uses the canonical `src/utils/ssrf.ts` guard and the master protocol
plus gatherer context from `claude/skills/`. `worker/scripts/prepare.mjs` generates
its local TypeScript inputs before build, test and start; do not edit the
ignored generated files. Build its Dockerfile with the repository root as
context (`just deploy-worker` does this). CI builds and tests both packages.
Contributor-touched cards are immutable to the worker. Confirm checks the
candidate snapshot after image uploads; edits require another confirmation.
Receipt JSON requires the owner or an admin; public HTML receipts exist only
after submission.
