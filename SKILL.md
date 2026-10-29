---
name: adai-contribute
description: Contribute to the A(DAI) Digital Arts Knowledge Commons (https://digitalartsinstitute.io) on behalf of a practitioner, using their bearer token in ADAI_TOKEN. Use to add a text signal about an existing entry, create entries (practitioner, artwork, concept, project, institution, collective, platform, etc.), add or supersede relations, upload and attach an image, tag a session with a batch_id, review contribution history, claim the practitioner's own page and speak for it (contest, add context, invite), add a reading of a relation, or, with an admin token, mint/list/revoke/link tokens, invite people, work the review queue, revoke a signal, retire an entry, or retire a batch. Talks to /api/v1/* via curl. Respects trust tiers. Never infer INFLUENCES or RESPONDS_TO from style or visual similarity; both require attested artist intent.
version: 2026-10-29
---

# A(DAI) contributor skill — for Claude (and any other AI assistant) writing to the knowledge commons

You are a Claude instance running with the practitioner's local sandbox. The
practitioner has handed you a bearer token for the A(DAI) Digital Arts
Knowledge Commons. Everything you contribute will be **attributed to them**,
land in the public commons under their consent settings, and remain
**revocable**. Don't be reckless.

A(DAI) is live at https://digitalartsinstitute.io/. The graph behind it has
practitioners, artworks, concepts, scenes, institutions, collectives,
platforms — see `/api/stats` for current counts.

---

## 0 — Setup, 30 seconds

`ADAI_TOKEN` should already be set in your environment by the practitioner.
Confirm it's there and identify yourself before writing anything:

```bash
# The token the practitioner gave you. Treat it like an SSH key — do NOT echo it.
[ -n "$ADAI_TOKEN" ] || { echo "ADAI_TOKEN not set — ask the practitioner"; exit 1; }
export ADAI_BASE="${ADAI_BASE:-https://digitalartsinstitute.io}"  # override for dev

# Confirm who you are about to write as.
curl -s -H "Authorization: Bearer $ADAI_TOKEN" "$ADAI_BASE/api/v1/whoami" | jq
```

Expected:
```json
{
  "contributor": { "id": "...", "name": "Casey Reas", "trust_tier": "reviewed" },
  "token_label": "claude-laptop",
  "token_prefix": "adai_abc1",
  "scope": "write",
  "r2_configured": true,
  "skill_version": "2026-07-07"
}
```

**Check you're on the current skill first.** `skill_version` above is the
version live on the server; the copy you're running declares its own in the
`version:` field at the very top of this file. **If the two don't match,
you're on an outdated copy** — stop, and tell the practitioner to re-download
it as https://digitalartsinstitute.io/adai-contribute.zip (a zip holding
`adai-contribute/SKILL.md` — upload it to Claude as is, no unzipping; the
plain text stays at https://digitalartsinstitute.io/skill.md), re-add it, and
start a fresh task. Endpoints and
conventions change between versions; don't contribute on a stale skill.

If `trust_tier` is `auto` or `reviewed`, your writes go live immediately.
If it's `probationary`, every write lands in the curator queue at
`$ADAI_BASE/review` — that's normal for new contributors. **You should
still contribute** — just be especially careful with edges and node
creates, since each one is a curator's time.

If `r2_configured` is `false`, image uploads (§1.5) will hard-fail with
`503 r2_not_configured`. The other endpoints still work — tell the
practitioner to set the `R2_*` env vars if they need images.

---

## 0.5 — Opening move

Once `whoami` succeeds, tell the practitioner who they're writing as and
what you can do for them (say things about existing entries, create new
ones, connect them, attach images — §1). Then offer a few starting
points; these map to the most common sessions and keep first-time
contributors out of trouble:

- **"Does ___ already exist in the graph?"** — always the first check (§1.0).
- **"Show me what you'll add before you post it."** — draft → sign-off → POST.
- **"What's my source for this?"** — required for INFLUENCES / RESPONDS_TO (§1.4).
- **"Will this go live now, or be reviewed first?"** — trust tier (§3).
- **"What have I contributed so far?"** — contribution history (§1.6).
- **"Here are the works from my show — add them and attach these images."**
  — batch intake; confirm the count and set a `batch_id` first (§1.7, §6).

One more thing to surface unprompted: the graph is a **public commons** and
contributions are attributed. If something they're telling you sounds
private (an unannounced collab, a personal anecdote about someone else),
ask before writing it.

---

## 0.6 — Tone: plain English, always

Speak to the contributor like a sharp colleague who isn't an engineer. Most
people using this skill are artists, curators, and collectors, not developers.

- **Lead with what it means for their work or the graph, then — only if needed —
  how it works.** Decision first, mechanism second.
- **Don't use system jargon as the main vocabulary.** Avoid, or instantly
  translate into plain words: node, edge, triple, POST, endpoint, schema, enum,
  metadata. Never surface internal codes (e.g. P1E09, FLD04) or raw type names
  (e.g. STYLE_KIN) — name things the way a person would ("the link from
  algorithmic art to generative art"). If a technical term is genuinely
  unavoidable, gloss it once in plain words.
- **Give one clear recommendation, not a menu.** If a choice is genuinely needed,
  offer two, say which you'd pick and why, in one line.
- **Keep it short.** Prefer a concrete example or analogy over an abstraction.
- Before replying, check: *"Could a curator with no coding background follow
  this?"* If not, rewrite.

Example —
- **Don't:** "I'll POST a RELATED edge (the triple) to /api/v1/edges; the
  source_url can't ride in the edge, so it stays in the register."
- **Do:** "I'll link algorithmic art to generative art. The link can't store its
  own source yet, so I'll keep the citation in our notes until that's fixed."

---

## 1 — The verbs

You have two read verbs and four write verbs. Pick the smallest one that
does the job.

### 1.0 `GET /api/graph` — discover what already exists

Before creating a node or edge, **look**. Duplicates are real work for the
curator to clean up. These read endpoints are unauthenticated.

```bash
# Every node of a type (id + name + slug + optional images). The id is
# what you pass to the write endpoints; the slug is what you pass to the
# ego/component endpoints below.
curl -s "$ADAI_BASE/api/graph?type=practitioner" | jq '.nodes[:3]'
# [
#   { "id": "practitioner:casey-reas", "name": "Casey Reas",
#     "type": "practitioner", "slug": "casey-reas",
#     "cdn_image_url": "https://pub-….r2.dev/images/ab/abcd….jpg" },
#   ...
# ]

# Ego graph — one hop around a node. Pass the slug, not the id.
curl -s "$ADAI_BASE/api/graph/casey-reas" | jq

# Full connected component reachable from a node (BFS over live edges).
# Use this when you need the practitioner's full neighbourhood — concepts
# they practise, collectives they belong to, artworks they made, etc.
# Caps at 800 by default; pass ?max_nodes=N up to 5000.
curl -s "$ADAI_BASE/api/graph/casey-reas/component?max_nodes=200" | jq
```

Valid `type=` values: `practitioner`, `artwork`, `concept`, `scene`,
`institution`, `collective`, `platform`, `publication`, `project`,
`classification_regime`. Pass `type=_all` for everything.

**Always grep these results for an existing name before you `POST /nodes`.**
Match case-insensitively, allow for punctuation differences, and surface
near-matches to the practitioner ("I see an existing `practitioner:tyler-hobbs`
— is that the same person?") rather than guessing.

### 1.1 `POST /api/v1/signals` — a piece of text about an existing node

Use this when the practitioner wants to **say something** about an entity:
context, attribution, a correction, a memory. The text goes into the
`signals` table; the curator decides whether to fold it into the node's
narrative.

```bash
curl -s -X POST "$ADAI_BASE/api/v1/signals" \
  -H "Authorization: Bearer $ADAI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target_node": "practitioner:casey-reas",
    "title": "Pedagogy note",
    "content": "Casey emphasised that Form+Code was structured around the idea that...",
    "source_url": "https://artblog.example.com/interview-2024"
  }'
```

Response: `{ signal_id, intake_id, status: "approved" | "pending", target_node }`.

`source_url` is optional, but when present it must be an absolute
`http(s)://` URL with a real host — it is rendered as a link on the
node's public surfaces, so malformed values are rejected with a `400`.

**Consent** (`consent_scope`, `consent_attribution`, optional here, on
readings §1.10 and on the public form): the commons is public *and
forkable* — anyone can pull its tables (`/offline` → "Fork the commons").
So what consent withholds never enters them:

- `"consent_scope": "structural_only"` — the relation counts, the words
  don't: `title`, `content`, `source_url` are kept by the operator only
  and are never published or synced. A structural-only contribution can
  carry relations, **never node metadata** — a create / patch / image
  write anchored to one is refused (node metadata is words in the public
  tables). Node, patch and image writes are always `full_commons`.
- `"consent_attribution": "anonymous"` — the public record says
  `anonymous`; your name, your batch id and the provenance stay with the
  operator, and the contribution is counted on an anonymous sentinel, not
  on your contributor row.
- While a write waits in review (`status: "pending"`) its words are not
  published either; they are on approval, and never if it is rejected.

### 1.2 `POST /api/v1/nodes` — create a new entity

Use this when nothing in §1.0 matched what the practitioner is talking
about. The server computes `<type>:<slug>` from the name (slug =
lowercase, accents transliterated, parens/dots/apostrophes stripped, `&` →
`and`, any other punctuation or space → one `-`). Pass `slug` explicitly
only if you need to override that; it is normalised by the same rules
(a `warnings` entry says so when it changed).

```bash
curl -s -X POST "$ADAI_BASE/api/v1/nodes" \
  -H "Authorization: Bearer $ADAI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "scene",
    "name": "Bay Area Generative Art 1980s",
    "metadata": { "status": "draft", "summary": "Loose meet-ups around..." },
    "aliases": [{ "source": "wikidata", "external_id": "Q123456" }]
  }'
```

Returns `{ node_id, created, status, signal_id, intake_id, warnings }`.
`created: false` means the node already existed — your metadata is **not**
merged in that case; use PATCH (§1.3) on the returned `node_id` instead.

**The server dedupes on `(type, slug)`.** Before choosing an id it looks for
a live (non-retired) node of the same type whose `slug` equals the computed
one — including when you pass `slug` explicitly. Legacy nodes keep spaced ids
(`practitioner:patrick tresset`) while their slug is the hyphen form
(`patrick-tresset`), so a create of "Patrick Tresset" returns that node:
`node_id: "practitioner:patrick tresset"`, `created: false`, and a `warnings`
line naming it — never a second `practitioner:patrick-tresset`. Always use the
`node_id` the response gives you. The same rule holds when a queued create is
approved at `/review` and when a URL-intake draft is confirmed (the card links
to the existing node).

After a successful create, hand the practitioner the share links: the
profile page `$ADAI_BASE/<type>/<slug>` and the field view zoomed straight
to the node, `$ADAI_BASE/field/<type>/<slug>`. The second one is the
"look at what I added" link (the old `/field?node=<node_id>` form redirects
to it).

**Concepts are the field vocabulary — and "field" status is curated.** In
`/field`, a `concept` with no `tag_origin` reads as a real *field* (the
art-historical layer: generative art, computer art, …); the ~100 fxhash artist
tags carry `tag_origin` and read as muted folksonomy. If your token is
**write-scope**, a concept you create is auto-stamped `tag_origin:
"contributor"` (you'll see a `warnings` line saying so), so it lands as a
tagged term, **not** a field. That's intended — create the concept if you need
it as an `EMBODIES` target, but minting a genuine new field (a movement like
cyberfeminism or tactical media) is a **curator/admin** call. If something you
made deserves field status, flag it to a curator; an admin promotes it by
clearing `tag_origin` (§1.3). **Admin-scope** creates skip the stamp — an
unmarked concept is a field.

**Common metadata fields by type.** Metadata is free-form, but the UI
reads these specific keys and renders them everywhere (profile pages,
graph/field hover, listings). Put structured data
in the fields below when you have it — fall back to free text otherwise.

For `type: "artwork"` — **year** (single source of truth for any
artwork-year display surface):

| Field | Type | Meaning |
|-------|------|---------|
| `year_start` | int | First year. Required for any year display when you don't have `year_raw`. |
| `year_end` | int \| null | Last year. Null or equal to `year_start` ⇒ single-year ("2024"). Otherwise renders as "2019–2024". |
| `year_ongoing` | bool | When true and `year_end` is null, renders as "2019–". |
| `year_raw` | string | Verbatim human form for the cases ints can't capture: `"c. 1965"`, `"1985–present"`, `"late 1990s"`. **Wins over `year_start`/`year_end`** when present, so only set it if the structured pair is wrong. |

Example creating an artwork with a clean year range:

```bash
curl -s -X POST "$ADAI_BASE/api/v1/nodes" \
  -H "Authorization: Bearer $ADAI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "artwork",
    "name": "Fidenza",
    "metadata": {
      "status": "confirmed",
      "year_start": 2021,
      "year_end": 2021,
      "medium": "long-form generative art on Art Blocks"
    }
  }'
```

Legacy seed artworks often store year under `basic_info.active_years`
(a string like `"2024-2025"`). The display layer reads that as a
fallback, so you don't need to migrate older nodes — but when **adding
new artworks or patching existing ones**, prefer the structured fields
above so future tooling can sort, filter, and reason about them.

### 1.3 `PATCH /api/v1/nodes/:id` — merge into existing metadata

Use this to **add or correct fields** on a node you didn't create — bios,
status flags, biographical links, URLs. The body is a JSON merge-patch:
keys you provide are merged, nested objects deep-merge, `null` deletes a
key. **You can't change `id` / `type` / `slug` / `name`** — those live in
columns, not metadata. And on a `concept`, only an **admin** token may touch
`tag_origin` (the field-vs-tag switch from §1.2) — a write-scope PATCH that
includes `tag_origin` gets a `403`; every other concept key stays patchable.

The node id goes in the path, so URL-encode it. Spaces → `%20`, colons
stay literal (curl handles them fine in unquoted form, but be safe in
scripts):

```bash
curl -s -X PATCH "$ADAI_BASE/api/v1/nodes/practitioner:casey-reas" \
  -H "Authorization: Bearer $ADAI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "homepage": "https://reas.com", "status": "confirmed" }'

# Legacy node id with a space — encode the space in the path:
curl -s -X PATCH "$ADAI_BASE/api/v1/nodes/practitioner:casey%20reas" \
  -H "Authorization: Bearer $ADAI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "homepage": "https://reas.com" }'
```

**Path params get URL-encoded; JSON body values do not.** That's why
`target_node` / `source_id` / `target_id` in POST bodies above keep
spaces as-is.

### 1.4 `POST /api/v1/edges` — connect two existing nodes

> **Edges to nodes you are creating:** `POST /edges` needs both ends to be
> live. A probationary token's `POST /nodes` only *queues*, so an edge to that
> node returns 400. Send new nodes and their edges together as a **package**
> (§1.4b) instead.

The graph is mostly edges. Use the curated edge types:

| Edge | Direction | Meaning |
|------|-----------|---------|
| `CREATED_BY` | artwork → practitioner | who made it |
| `EMBODIES` | artwork → concept | what it expresses |
| `PRACTICES` | practitioner → concept / technique | what they work with |
| `USES_TECHNIQUE` | practitioner → technique | finer-grained than PRACTICES |
| `BELONGS_TO` | practitioner → collective / scene | membership |
| `EXHIBITED_AT` | artwork → institution / platform | where it showed |
| `HELD_BY` | artwork → institution | in its collection — a museum, private or corporate collection (where it showed is `EXHIBITED_AT`) |
| `PARTICIPATED_IN` | practitioner → project | artist took part in a show / fair |
| `PRESENTED_BY` | project → institution / platform | gallery / host that presented the show (a platform-hosted series can have both) |
| `CURATED_BY` | project → practitioner | the show's curator (where named) |
| `REPRESENTS` | institution → practitioner | a gallery's core roster |
| `CLASSIFIED_BY` | any node → classification_regime | who positioned it |
| `COLLABORATES_WITH` | practitioner ↔ practitioner | symmetric collab |
| `DOCUMENTS` | publication → project / artwork | a catalogue, book or journal issue documenting a show or a work (the work or show reads "documented in") |
| `INFLUENCES` | practitioner → practitioner | **needs attestation** |
| `RESPONDS_TO` | artwork → artwork | **needs attestation** |

**Modelling a show, fair, or exhibition.** A show is a `project` node (create
it with §1.2). Connect its artists with `PARTICIPATED_IN`, its presenting
gallery/host with `PRESENTED_BY`, and its curator — only where actually named —
with `CURATED_BY`. A gallery's standing roster of artists is `REPRESENTS`, from
the `institution` to each `practitioner`. Without these, a show and its gallery
have nothing to connect to and float as orphans, so add them in the same session
you create the show.

**What an organisation is.** Galleries, museums, art centres, fairs, dealers
and advisories are all `institution` nodes — in the graph they do the same
thing. What the organisation says it is goes in `metadata.kind`: a list, since
one organisation can be several things, from this fixed set — `museum`,
`art centre`, `gallery`, `dealership`, `advisory`, `fair`, `festival`,
`venue`, `auction house`, `archive`, `residency`, `lab`, `foundation`,
`biennial`, `prize`. Take it from how the organisation describes itself on
its own site and keep its words in `metadata.kind_source` `{page_url, quote}`:
`{"kind": ["gallery", "dealership", "advisory"], "kind_source": {"page_url": "https://www.interfacegallery.io/about", "quote": "a project-based gallery, private art dealership and advisory"}}`.
Values outside the set are refused with `400 invalid_kind`. Publications,
platforms and collectives are node types, not kinds.

**Hard rule — do not infer `INFLUENCES` or `RESPONDS_TO` from style /
visual / thematic similarity.** These require an attested statement
(interview, essay, self-report). If you don't have a URL anchoring the
claim, don't write the edge. The embedding pipeline refuses to auto-emit
these for the same reason.

```bash
curl -s -X POST "$ADAI_BASE/api/v1/edges" \
  -H "Authorization: Bearer $ADAI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source_id": "artwork:fidenza",
    "target_id": "practitioner:tyler-hobbs",
    "edge_type": "CREATED_BY",
    "confidence": "high",
    "event_time": "2021-06-11"
  }'
```

**Fields:**
- `confidence`: free-form string, conventionally `"low"` / `"medium"` /
  `"high"`. Defaults to `"medium"` when omitted.
- `event_time`: when the relationship was **true in the world** (not when
  you recorded it — that's `created_at`, server-set). Optional. ISO 8601
  date (`"2021-06-11"`) or full timestamp (`"2021-06-11T14:00:00Z"`); the
  server stores the string verbatim, no validation.

**Idempotent retries.** Edge ids are deterministic on
`<source>--<EDGE_TYPE>--<target>--api-<your_contributor_name>`. POSTing
the same triple twice (e.g. after a flaky network) is a no-op — the
server `INSERT OR IGNORE`s and returns the same `edge_id`, no error, no
duplicate row.

**Superseding an edge** — when a fact changes (a practitioner left a
collective, an attribution turned out wrong), don't delete the old edge.
Add a new one with `supersedes_edge_id` pointing at the previous edge's
id (as returned by the earlier POST, or read from `/api/graph` plus the
deterministic format above). The old edge's `valid_until` and
`invalidated_by` get set; queries that filter `valid_until IS NULL` see
only the current state, but the history is preserved. Supersession breaks
the determinism rule above — the new edge gets a random 4-byte suffix
appended to its id, so you can re-attest the same triple as many times
as the facts change.

```json
{
  "source_id": "practitioner:foo",
  "target_id": "collective:bar",
  "edge_type": "BELONGS_TO",
  "supersedes_edge_id": "practitioner:foo--BELONGS_TO--collective:bar--api-casey-reas"
}
```

### 1.4b `POST /api/v1/packages` — new nodes and their edges in one write

`POST /edges` needs both ends to be **live** nodes. For a `probationary`
contributor `POST /nodes` only *queues*, so an edge to a node you just created
cannot be sent until a curator approves it. Use a **package** instead: the new
nodes and the edges between them (or to existing nodes) travel together.

```bash
curl -s -X POST "$ADAI_BASE/api/v1/packages" \
  -H "Authorization: Bearer $ADAI_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "batch_id": "residency-2026-06-08",
    "nodes": [
      {"ref": "show", "type": "project", "name": "Residency Show"},
      {"ref": "w1", "type": "artwork", "name": "Work One", "metadata": {"year": 2026}}
    ],
    "edges": [
      {"source_id": "w1", "target_id": "practitioner:patrick-tresset", "edge_type": "CREATED_BY"},
      {"source_id": "practitioner:patrick-tresset", "target_id": "show", "edge_type": "PARTICIPATED_IN"}
    ]
  }'
```

- **Nodes** take the same fields as §1.2 (`type`, `name`, `slug?`, `metadata?`,
  `aliases?`) plus an optional `ref`, a local handle.
- **Edge ends** (`source_id`, `target_id`; `source` / `target` also work) are
  either a live node id or a reference to a node of the same package: its `ref`,
  its `type:slug` id, or its `name` when that is unique in the package. Edge
  fields are those of §1.4 (`confidence?`, `event_time?`, `supersedes_edge_id?`).
- A node whose (type, slug) already exists — a legacy spaced id included — is
  **not created again**: edges attach to the existing node and the response
  lists it in `existing_nodes`.
- Everything is checked first. Any problem → `400 invalid_package` with a
  `problems` list (`{item, index, error}` for every bad node/edge) and **nothing
  is written**. Limits: 100 nodes and 300 edges per package
  (`400 package_too_large`); split bigger uploads into several packages with the
  same `batch_id`. Retired nodes are refused, as an edge end and as a node to
  reuse.
- Resolution order for an edge end: a package `ref`, then a package node's
  id, then a unique package name, then a live node id. A `ref` spelled like a
  live id therefore points at the package node: pick refs that don't look like
  ids (`w1`, `show`).
- **probationary**: ONE review item holds the nodes and edges; approving creates
  the nodes then the edges, all or nothing (a failure writes none of it and the
  item stays pending), **rejecting drops all of it**. There is no partial
  approval: keep a package to what belongs together. Response:
  `status: "pending"`, `intake_id`, `signal_id`, `node_ids` (ref → the id the
  node has or will have). **auto / reviewed**: applied at once in one
  transaction, `status: "approved"`, `created_nodes`.
- Warnings (unknown types, direction, INFLUENCES/RESPONDS_TO attestation) come
  back in `warnings`, as for the single endpoints.
- **Images**: a node may carry `image_url` (https, a public image: JPEG, PNG,
  GIF, WebP or AVIF, up to 20 MiB; fetched and mirrored by the server exactly as
  in §1.5). `reviewed` / `auto`: fetched right after the nodes are created;
  the response lists `images_attached` and `images_failed`. `probationary`:
  the URL waits in the review item and is fetched when a curator approves it
  (nothing is fetched for a rejected package); the card shows it, and a failure
  at approval is recorded on the item. **An image never fails a package**: a bad
  URL (not https, credentials, not a URL) or a failed fetch is a `warning` and
  the node is created without an image (attach one later with §1.5). `image_url`
  on a node that already exists is ignored with a warning: a package does not
  change an existing page.

### 1.5 `POST /api/v1/images` — upload an image and attach it

The practitioner just dropped a file in your sandbox. Hash it, push it to
the R2 mirror, attach the URL to a node — all in one round-trip.

```bash
curl -s -X POST "$ADAI_BASE/api/v1/images" \
  -H "Authorization: Bearer $ADAI_TOKEN" \
  -F "image=@/tmp/casey-portrait.jpg" \
  -F "node_id=practitioner:casey-reas"
```

Returns `{ node_id, upload: { key, url, sha256, bytes, content_type,
already_existed }, status, signal_id, intake_id }`. Every transport reads
the file's own first bytes to decide what it is — the declared type
(multipart part type, `mime_type`) is ignored; bytes that aren't a
JPEG/PNG/GIF/WebP/AVIF are refused with `415 not_an_image`. The `upload` block
is the immutable R2 object; the `status` tells you whether the metadata
patch went live or is queued.

JSON fallback (when you don't have multipart at hand):

```bash
B64=$(base64 -w0 /tmp/casey-portrait.jpg)
curl -s -X POST "$ADAI_BASE/api/v1/images" \
  -H "Authorization: Bearer $ADAI_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"node_id\":\"practitioner:casey-reas\",\"mime_type\":\"image/jpeg\",\"image_base64\":\"$B64\"}"
```

URL transport (the image already lives on the web — the server fetches it,
through an SSRF guard, 20 MiB cap, and sniffs the bytes to make sure it is
a JPEG/PNG/GIF/WebP/AVIF; `image_url` is kept as provenance):

```bash
curl -s -X POST "$ADAI_BASE/api/v1/images" \
  -H "Authorization: Bearer $ADAI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"node_id":"artwork:process-4","image_url":"https://reas.com/images/process4.jpg"}'
```

Errors: `400 private_host|bad_scheme`, `413 too_large`, `415 not_an_image`,
`502 upstream_status|image_fetch_failed`.

**What gets attached.** On approval, three fields are merged into the
node's `metadata`:
- `cdn_image_url` — the R2 URL. **Always overwritten** by each upload.
- `image_url` — upstream provenance URL. Only written **if missing**, so
  the original source URL (MoMA, Wikimedia, fxhash) stays authoritative
  when one exists.
- `image_sha256` — content hash of the bytes you uploaded. Always rewritten.

**One image per node.** There is no gallery, no array, no
primary/secondary distinction. Uploading a second image to the same node
replaces `cdn_image_url`. If the practitioner wants multiple images,
confirm whether they want the *new* one to win or want you to leave the
node alone.

**Idempotent on bytes.** Images are content-addressed: uploading the
same bytes twice is free (server HEADs R2 first; `already_existed: true`
in the response). Max payload: 12 MB.

**If `whoami` showed `r2_configured: false`,** this endpoint returns
`503 r2_not_configured` immediately — don't bother attempting. The
upload is the *only* endpoint that needs R2; signals/nodes/edges all
work without it.

### 1.6 `GET /api/v1/contributions` — the practitioner's own history

Answers "what have I contributed, and did it go live?" — every write made
with this token's contributor identity, newest first, with review status.
Token-scoped: it only ever shows their own rows.

```bash
curl -s -H "Authorization: Bearer $ADAI_TOKEN" "$ADAI_BASE/api/v1/contributions" | jq

# only the ones still waiting on a curator
curl -s -H "Authorization: Bearer $ADAI_TOKEN" \
  "$ADAI_BASE/api/v1/contributions?status=pending&limit=20" | jq
```

Response: `{ contributor, totals: { approved: N, pending: N, rejected: N },
returned, items }` where each item carries `action` (`signal` /
`create_node` / `patch_node` / `add_edge` / `attach_image`), `target_node`,
`status`, `created_at`, the anchoring `signal_id` + `title`, and the
`batch_id` when the write carried one (§1.7). Filter to one session with
`?batch=<batch_id>`. A `rejected` item includes the curator's
`rejection_reason` — relay it honestly; it's feedback, not a scolding.

### 1.7 `batch_id` — tag a session of related writes

Every write endpoint accepts an **optional batch handle** so a whole
session can be inspected later — and, if it went wrong, rolled back by an
admin in ONE call (§4.7) instead of fifty. **Always set one when you're
doing more than a couple of related writes** (a show's worth of artworks,
a gallery archive, any §6 bulk intake). For one-off contributions it's
fine to omit.

- `POST /signals`, `POST /nodes`, `POST /edges`, `POST /packages`: pass `"batch_id": "..."`
  in the JSON body.
- `POST /images`: pass `batch_id` as a multipart field (or JSON key).
- `PATCH /nodes/:id`: the body IS the metadata merge-patch, so the handle
  rides as a **query param**: `PATCH /api/v1/nodes/:id?batch_id=...`.

Format: 1–120 chars, letters/digits plus `. _ : -` (no spaces). Convention:
`<contributor-slug>-<purpose>-<YYYY-MM-DD>`, e.g.
`nguyen-wahed-archive-2026-06-08`. Generate it once at the start of the
session, use it on every write in that session, and tell the practitioner
what it is — it's their receipt.

```bash
BATCH="casey-reas-show-intake-2026-06-08"
curl -s -X POST "$ADAI_BASE/api/v1/nodes" \
  -H "Authorization: Bearer $ADAI_TOKEN" -H "Content-Type: application/json" \
  -d "{\"type\":\"artwork\",\"name\":\"Process 18\",\"batch_id\":\"$BATCH\"}"

# later: everything this session did, in one view
curl -s -H "Authorization: Bearer $ADAI_TOKEN" \
  "$ADAI_BASE/api/v1/contributions?batch=$BATCH" | jq
```

---

### 1.8 Contributing from a website — the URL intake

When the practitioner says "here is my site / the show page / our roster",
you have two routes.

**Manual** (you read the site yourself): one `batch_id` for the session
(§1.7), `resolve before create` (§1.0), then `/api/v1/nodes|edges|images`
as above. Relation policy for anything sourced from a page, verbatim:

| edge_type | direction | condition |
|---|---|---|
| CREATED_BY | artwork -> practitioner/collective | page attributes the work |
| EXHIBITED_AT | artwork -> institution/project/platform | page lists the show, venue or platform |
| HELD_BY | artwork -> institution | page lists the work in the institution's collection (collection record, accession number, credit line) |
| PARTICIPATED_IN | practitioner -> project | page lists the artist in the show |
| PRESENTED_BY | project -> institution/platform | page names the venue, organiser or host platform |
| CURATED_BY | project -> practitioner | page names the curator |
| REPRESENTS | institution -> practitioner | roster page, or "represented by" |
| USES_TECHNIQUE | artwork/practitioner -> concept | page names the technique |
| EMBODIES | artwork -> concept | page's own description, low confidence |
| BELONGS_TO | practitioner -> collective | page states membership |
| COLLABORATES_WITH | practitioner <-> practitioner | only with a quote naming the other party |
| DOCUMENTS | publication -> project/artwork | page is (or names) a catalogue, book or journal issue that documents the show or work |

Never from a site: `INFLUENCES`, `RESPONDS_TO`, `CLASSIFIED_BY`. Put the
supporting sentence from the page in the signal `content` and the page in
`source_url`; that is the audit trail.

**Delegated** (A(DAI) reads the site, the practitioner confirms):

```bash
curl -s -X POST "$ADAI_BASE/api/intake/drafts" \
  -H "Authorization: Bearer $ADAI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source_url":"https://example-artist.com"}'
# → 202 { draft_id, draft_url: "/draft/drf_…" }
```

A worker crawls the site, resolves every entity against the graph, and
proposes cards — works, shows, venues, people, relations, images, plus
"already in A(DAI)" notes and yes/no questions for the relations only the
artist can attest. **Nothing is written until the practitioner opens
`/draft/:id` and presses Confirm.** Send them the link (they sign in with
an emailed magic link). You can poll `GET /api/intake/drafts/:id` with the
same bearer token to watch progress (`status`, `candidates`, `summary`),
`PATCH …/candidates/:cid` to pre-accept cards they told you about, and
`POST …/chat` to ask the worker for changes, and `POST …/continue`
(optional `{"focus":"…"}`) for another full reading pass — it builds on the
survey, the pages already read and the cards they rejected; the draft's
`survey.remaining` says what is not covered yet. The confirmed batch has
`batch_id = draft_id` and shows up in `GET /api/v1/batches` and on the
public receipt `/batch/:id` like any other batch.

### 1.9 Claimed pages — speaking for the practitioner

A practitioner (or a collective / institution) can **claim** their page: it
gets a `✓ claimed` badge and a short **@handle** link (`/@casey-reas`), and
they get a log of everything the commons holds about it. Claiming does not
let anyone edit the page directly — curators still approve every change.
What a claimant can do is **speak**: contest a relation that is wrong, add
context to one, object to a proposal still in review, and invite the person
at the other end of a relation. The same bearer token works:

```bash
# Claim (instant when their invitation named this page; otherwise a curator decides)
curl -s -X POST "$ADAI_BASE/api/claims" -H "Authorization: Bearer $ADAI_TOKEN" -H 'content-type: application/json' \
  -d '{"node_id":"practitioner:casey-reas","evidence":"https://reas.com/bio names me","handle":"casey-reas"}' | jq
# Their log for one claimed page: relations (+ sources and notes), items in review about them, history
curl -s "$ADAI_BASE/api/me/log?node=practitioner:casey-reas" -H "Authorization: Bearer $ADAI_TOKEN" | jq
# Contest a relation — public at once ("contested by the subject"); a curator ends it or dismisses
curl -s -X POST "$ADAI_BASE/api/me/contest" -H "Authorization: Bearer $ADAI_TOKEN" -H 'content-type: application/json' \
  -d '{"node_id":"practitioner:casey-reas","relation":{"source_id":"institution:x","edge_type":"REPRESENTS","target_id":"practitioner:casey-reas"},"note":"Never represented by them."}'
# Contest a metadata edit instead: "edit":{"key":"born","signal_id":"signal-…"} (from the log's history)
# Context on a relation (live for auto/reviewed tiers, else reviewed)
curl -s -X POST "$ADAI_BASE/api/me/context" … -d '{"node_id":"…","relation":{…},"note":"Two shows together, 2019–21."}'
# Object to a pending proposal about them (queue_id from the log's "pending")
curl -s -X POST "$ADAI_BASE/api/me/objection" … -d '{"node_id":"…","queue_id":"intake-…","note":"…"}'
# Invite the other end of one of their relations (unclaimed person/collective/institution; 10 a week)
curl -s -X POST "$ADAI_BASE/api/me/invite" … -d '{"node_id":"practitioner:other","email":"them@example.org","message":"optional"}'
# Handle: check, then set (once every 30 days; old handles keep resolving)
curl -s "$ADAI_BASE/api/claims/handle?h=casey&node=practitioner:casey-reas" -H "Authorization: Bearer $ADAI_TOKEN"
curl -s -X POST "$ADAI_BASE/api/claims/handle" … -d '{"node_id":"practitioner:casey-reas","handle":"casey"}'
```

A note is always in the practitioner's own words — draft it with them, never
for them. A contest needs a reason a curator can check. Never invite someone
the practitioner did not name, and never put an email address anywhere public.

### 1.10 `POST /api/v1/readings` — a reading of one relation

Anyone with a token — a critic, a facilitator, a curator, no claim needed —
can attach a **reading** to one specific live relation ("this work responds
to that one", "this show was presented by that space"). It shows on the
relation's row and in the accounts section of **both** ends' pages, labelled
**"a reading by <name>"**: one account beside the others, never the subject
speaking — even when the writer claims one end (a claimant who wants to
speak *as the subject* uses context, §1.9). It stands only while its relation
is live.

```bash
curl -s -X POST "$ADAI_BASE/api/v1/readings" -H "Authorization: Bearer $ADAI_TOKEN" -H 'content-type: application/json' \
  -d '{"relation":{"source_id":"artwork:a","edge_type":"EXHIBITED_AT","target_id":"project:glitch"},
       "note":"Shown here as a record of failure rather than a glitch aesthetic.",
       "source_url":"https://example.org/review",
       "consent_attribution":"attributed",
       "consent_scope":"full_commons",
       "batch_id":"glitch-readings-2026-10"}' | jq
# source_url (optional): where the reading is published
# consent_attribution: "attributed" (default) or "anonymous" → "a reading by someone"
# consent_scope: "full_commons" (default) or "structural_only" → the words stay off the page
# batch_id (optional, as everywhere, §1.7)
# → 201 {"status":"live"|"pending","signal_id":"signal-…","intake_id":"intake-…","reading":{…}}
# Take it back (only its author; JSON content type required):
curl -s -X POST "$ADAI_BASE/api/v1/readings/<signal_id>/withdraw" -H "Authorization: Bearer $ADAI_TOKEN" -H 'content-type: application/json' -d '{}'
# A withdrawn reading leaves the page; one that was never published leaves no trace in /history.
```

Trust tiers as for every write (§3): `auto` / `reviewed` publish at once;
`probationary` readings wait on `/review?kind=reading`. The relation must be
live and curated (not embedding-derived); the same words twice on the same
relation are refused (409 `already_read`). At most 2000 characters, 5 readings
a minute and 30 a day per contributor, however they sign in (429
`too_many_readings`). A relation row shows its latest 3 readings; the rest are
in the page's accounts section. A reading
is the writer's own interpretation — write it with them, in their words; a
claim that the relation itself is wrong is not a reading (that is a
contest, §1.9, or a curator's correction). Signed-in contributors can add one
from the "+ reading" link on any relation row of a page.

## 2 — ID conventions

- **Newly-created nodes** always get the hyphenated form:
  `<type>:<slug>` where slug is `lowercase`, accents transliterated to
  ASCII (`là` → `la`), parens / dots / apostrophes stripped, `&` → `and`,
  every other run of punctuation or spaces (`#`, `,`, `/`, `?`, `–`, `—`)
  → a single `-`, none at either end. Examples: `practitioner:casey-reas`,
  `artwork:fidenza`, `classification_regime:a-dai-seed-canon-v1-2026-04`.
  This is what the API produces and what you should use in every example.
- **Legacy seed nodes** keep spaces from their original names:
  `practitioner:casey reas`, `classification_regime:a(dai) seed canon v1 (april 2026)`.
  **Both forms resolve** for write endpoints — the server matches on the
  full id. When you find a node via `/api/graph` (§1.0), echo back
  whichever id form the API returned; don't translate. Their `slug` is the
  hyphen form, and a create whose slug matches one returns the legacy node
  (`created: false`, §1.2), so a spaced id never gets a hyphenated twin.
- **URL-encode for path params, leave alone in JSON bodies.** PATCH puts
  the id in the URL path, so spaces become `%20`. POST bodies (`source_id`,
  `target_id`, `target_node`) take the id verbatim — JSON handles it.
- **Edges**: the server computes the id (see §1.4). You don't write it.

To slugify yourself: `slugify("Casey Reas")` → `casey-reas`,
`slugify("Form & Code")` → `form-and-code`,
`slugify("Aaron at Tsukuba, #6 22/5/85")` → `aaron-at-tsukuba-6-22-5-85`,
`slugify("Toujours là")` → `toujours-la`. Nodes created before October
2026 keep the slug they were given (some carry accents or `#`); read the
slug from the API rather than recomputing it.

---

## 3 — Trust and the queue

The server returns `status: "approved"` or `status: "pending"` on every
write. `pending` means a human has to click Approve at `/review`. **Tell
the practitioner what happened** — copy the link `$ADAI_BASE/review` into
your reply.

If the practitioner's trust is `probationary`, expect every write to
queue. Don't try to escalate. Don't try to "merge" by writing multiple
times. One signal/node/edge/image per intent.

**Probationary and edges to new nodes.** `POST /api/v1/nodes` under
`probationary` only queues an intake row: the node does not exist yet, so
`POST /api/v1/edges` to or from it returns **400** until a curator approves
it. For new nodes plus their relations use **`POST /api/v1/packages`**
(§1.4b): nodes and edges go into one review item, approved or rejected
together. More than 100 nodes → several packages with the same `batch_id`.
Edges between nodes that already exist can be a package too (`nodes: []`),
one review item instead of many. Do not retry edges in a loop.

Note: for image uploads under `probationary`, the R2 upload happens
immediately (the bytes are content-addressed and immutable, so there's
nothing to undo), but the metadata patch that attaches the URL is queued.
The response includes a `note` field saying as much.

---

## 4 — If your token is admin-scope

`whoami` will show `"scope": "admin"`. Admin tokens can do everything a
write token can (signals / nodes / edges / images, attributed to the
admin contributor), **plus**:

- mint write-scope tokens for other practitioners and revoke any token
  (§4.1–4.3) — but never mint other admin tokens; that's intentionally
  limited to the operator running the local CLI on the host;
- work the curator review queue over JSON — list, approve, reject,
  bulk-sweep by batch or contributor (§4.4);
- run the **correction primitives** — revoke a signal, retire a node,
  retire a whole batch (§4.5–4.7).

One principle behind all of it: **nothing is ever deleted.** Signals flip
to `status='revoked'`, edges get bi-temporally superseded
(`valid_until` + `invalidated_by`), nodes get `metadata.retired` and
vanish from every listing while staying reachable by direct URL for
audit. Every correction is anchored by an admin signal recording who,
when, and why — corrections have provenance exactly like contributions.

### 4.1 Mint a contributor token for someone

```bash
curl -s -X POST "$ADAI_BASE/api/v1/tokens" \
  -H "Authorization: Bearer $ADAI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "contributor_name": "Casey Reas",
    "label": "claude-laptop",
    "create_if_missing": true,
    "tier": "reviewed",
    "node": "institution:the-outlier-collection"
  }'
```

`node` is optional: the node this token's contributor stands for, a byline
link only (§4.3b). Leave it out unless the admin has decided the link.

Response includes `raw_token` — show it to the practitioner ONCE, in a
channel they trust (their chat with their own Claude works). The server
keeps only `sha256(token)`. You can't recover it later; if they lose it,
revoke and mint a new one.

`tier` controls auto-merge for the new contributor. Defaults to
`probationary`. Use `reviewed` when you trust them to skip the curator
queue. `auto` is reserved for the founding team and the practitioner
themself.

### 4.2 List tokens

```bash
curl -s "$ADAI_BASE/api/v1/tokens" \
  -H "Authorization: Bearer $ADAI_TOKEN" | jq

# filter
curl -s "$ADAI_BASE/api/v1/tokens?contributor=Casey%20Reas&active=1" \
  -H "Authorization: Bearer $ADAI_TOKEN" | jq
```

### 4.3 Revoke a token (rotation, leak, change of heart)

```bash
curl -s -X POST "$ADAI_BASE/api/v1/tokens/adai_abc12345/revoke" \
  -H "Authorization: Bearer $ADAI_TOKEN"
```

Soft-delete: the row stays for audit, `revoked_at` gets set, the bearer
hits 401 from then on.

### 4.3b Link a token to the node it stands for

An institution, collection or collective that posts through a token is a
contributor *and* a node. Name the node, and every "contributed by" byline
of its contributions links to it, its page says "contributes to the commons
as …", and `/<type>/<slug>/contributions` lists what it contributed.

```bash
curl -s -X PATCH "$ADAI_BASE/api/v1/tokens/adai_abc12345" \
  -H "Authorization: Bearer $ADAI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"node": "institution:the-outlier-collection"}'      # null clears it
```

Or at mint: `"node": "<node id>"` in §4.1's body.

**Change a contributor's trust tier** with the same call:
`-d '{"tier": "reviewed"}'` (`auto` | `reviewed` | `probationary`; `node` and
`tier` may go together, both or neither apply). The tier is the contributor's,
so all their tokens follow, from their next request; the response gives
`previous_tier`. Promote deliberately, after a batch or two reviewed clean. The node must exist and
not be retired. A revoked token keeps its link (rotating a credential does
not change whose contributions they were); the newest token that names a
node wins. When two nodes are merged, links to the duplicate move to the
kept node.

**`node` is a display / byline link, not self-attestation.** It does not tie
the key to the page as its subject: it gives no claim, no `✓ claimed` badge,
no right to contest, and the token's edits about that node are ordinary
contributions (same trust tier, same review), not "the subject speaking".
Self-attestation is a **claim**: an invite naming the page (§4.6b `node`) or
`POST /api/claims` (§1.9), settled per §4.6c. Linking a token to a node is the
admin's decision — don't set it on your own initiative.

### 4.4 Work the review queue

The JSON twin of the `/review` web page — same materialisation logic on
the server, so approving here is identical to a curator clicking Approve.

```bash
# What's pending? (filters: ?status= ?contributor= ?batch= ?kind= ?limit= ?before=)
curl -s -H "Authorization: Bearer $ADAI_TOKEN" \
  "$ADAI_BASE/api/v1/review?status=pending" | jq

# Newest first, max 500 per page. When the response has "has_more": true, pass
# its "next_before" as ?before= to read the next, older page (large batches):
curl -s -H "Authorization: Bearer $ADAI_TOKEN" \
  "$ADAI_BASE/api/v1/review?batch=my-batch&limit=500&before=<next_before>" | jq

# Approve / reject one item
curl -s -X POST "$ADAI_BASE/api/v1/review/<intake_id>/approve" \
  -H "Authorization: Bearer $ADAI_TOKEN"
curl -s -X POST "$ADAI_BASE/api/v1/review/<intake_id>/reject" \
  -H "Authorization: Bearer $ADAI_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"duplicate of practitioner:casey-reas"}'

# Bulk sweep — a whole batch or contributor in one call. ALWAYS dry-run
# first; the response lists exactly which intake_ids would be touched.
curl -s -X POST "$ADAI_BASE/api/v1/review/bulk" \
  -H "Authorization: Bearer $ADAI_TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"approve","batch_id":"nguyen-wahed-archive-2026-06-08","dry_run":true}'
# then drop dry_run. For reject, "reason" is required.
```

Bulk requires at least one selector (`ids`, `batch_id`, `contributor`) —
there is deliberately no "approve everything" switch. Caps at 500 items
per call; the response's `remaining` tells you to loop.

### 4.5 Revoke a signal

Retract one contribution: flips the signal to `revoked` and (by default)
supersedes every live edge it anchored. Idempotent.

```bash
curl -s -X POST "$ADAI_BASE/api/v1/signals/<signal_id>/revoke" \
  -H "Authorization: Bearer $ADAI_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"practitioner asked to retract this"}'
# {"signal_id":"...","already_revoked":false,"edges_superseded":2,"admin_signal_id":"..."}
# pass {"cascade":false} to leave the anchored edges alive
```

A revoked signal keeps its row (status `revoked`) but loses its words
publicly — title, content, source, provenance — on the site and in every
fork on its next pull. Nothing is deleted: the operator keeps the
original (`signal_private`, shown on `/review`).

### 4.6 Retire a node

For a node that shouldn't exist (wrong entity, junk upload, duplicate the
curator missed). Supersedes every live edge touching it and sets
`metadata.retired` — the node disappears from `/api/graph`, `/field`,
`/explore`, search, embeddings surfaces and the stats, but its row and
full history stay (the profile URL still resolves, like the historical
husks the canon overlay leaves).

```bash
# look before you leap
curl -s -X POST "$ADAI_BASE/api/v1/nodes/artwork:wrong-thing/retire" \
  -H "Authorization: Bearer $ADAI_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"uploaded against the wrong artist","dry_run":true}'
# then for real (drop dry_run)
```

Un-retiring is deliberate manual work: `PATCH /api/v1/nodes/:id` with
`{"retired": null, "retired_at": null, "retired_by": null, "retired_reason": null}`
brings the node back into listings, but its superseded edges stay
superseded — re-attest the ones that should live again (§1.4).

### 4.6b Invite someone to the URL intake (who may read websites into A(DAI))

The URL intake (`/contribute` — paste a website, the agent proposes cards) is
**invite-only**: every read costs model money, so only invited addresses get a
sign-in link. Anyone else who asks is recorded as a pending request, and the
admins get an email about it. After asking, a newcomer can say how they would
like to appear and add a short note about themselves; a request carries these
as `display_name` and `about`, and an invite without `name` uses
`display_name` — names come from the person, not from us.

```bash
# Invite (name = their public attribution, defaults to the request's display_name; tier as in §4.1; node = the page they ARE — theirs at once, optional)
curl -s -X POST "$ADAI_BASE/api/v1/invites" -H "Authorization: Bearer $ADAI_TOKEN" -H 'content-type: application/json' \
  -d '{"email":"irina@example.org","name":"Irina","tier":"reviewed","send":true}' | jq
# Who is invited, and who asked without an invite
curl -s "$ADAI_BASE/api/v1/invites" -H "Authorization: Bearer $ADAI_TOKEN" | jq '{invites: [.invites[] | {email,name,trust_tier,revoked_at,drafts}], requests}'
# Revoke: their sessions end at once; their contributions and drafts stay
curl -s -X POST "$ADAI_BASE/api/v1/invites/revoke" -H "Authorization: Bearer $ADAI_TOKEN" -H 'content-type: application/json' \
  -d '{"email":"irina@example.org"}' | jq
```

`send: true` emails them a sign-in link now; without it they sign in at
`/contribute` whenever they like. Ask the operator before inviting at
`auto` tier — auto means their confirmed drafts go live without review.
Treat the email addresses in these responses as private: never paste them
into a signal, a node, or anywhere public.

### 4.6c Claims, contests, subject notes and readings

Four more `kind`s in the review queue (§4.4 — `?kind=claim|contest|context|reading`,
same approve / reject calls): **claim** (approve = the page is theirs; reject
with a reason they receive by email), **contest** (approve = *uphold*: every
live claim of that relation ends bi-temporally, or an edited value goes back
to its before-image; reject = *dismiss*: the public mark comes off), and
**context** (a probationary claimant's note; approve publishes it) and
**reading** (a probationary contributor's reading of a relation, §1.10;
approve publishes it, reject keeps it off the page). A published reading is
taken down like any contribution: revoke its signal (§4.5) — or retire a
node (§4.6) / a batch (§4.7), which ends the relations it reads. Look at
the evidence first: the claim card on `/review` shows the email domain against
the page's website and any drafts they ran on that site.

```bash
curl -s "$ADAI_BASE/api/v1/claims?status=approved" -H "Authorization: Bearer $ADAI_TOKEN" | jq   # ?status= ?node=
curl -s -X POST "$ADAI_BASE/api/v1/claims/<claim_id>/revoke" -H "Authorization: Bearer $ADAI_TOKEN" -H 'content-type: application/json' \
  -d '{"reason":"impersonation"}'
```

Inviting with `"node": "practitioner:…"` (§4.6b; `practitioner` still works)
makes that page theirs at once. An uninvited person who asks to claim a page
from its profile shows up on `/review?kind=claim` under "not yet invited";
approving there invites them and approves the claim in one step.

### 4.7 Retire a batch — "take it out and start again"

Not a rollback: it takes what the batch added out of the live graph (with
the record kept), but it does **not** put earlier values back on nodes the
batch changed. Those come back as `patches_to_review` for a person to restore.

The big one. When an upload session went wrong (wrong CSV, wrong artist
mapping, a gallery wants a clean restart), retire the **whole batch** in
one call — provided the writes carried a `batch_id` (§1.7; one more
reason to always set it on bulk work).

```bash
# 0. what batches exist?
curl -s -H "Authorization: Bearer $ADAI_TOKEN" \
  "$ADAI_BASE/api/v1/batches?contributor=Nguyen%20Wahed%20Gallery" | jq

# 1. ALWAYS dry-run first — the response is the full plan
curl -s -X POST "$ADAI_BASE/api/v1/batches/nguyen-wahed-archive-2026-06-08/retire" \
  -H "Authorization: Bearer $ADAI_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"wrong mapping, gallery restarting","dry_run":true}' | jq

# 2. read the plan WITH the practitioner/gallery, then execute (drop dry_run)
```

What it does, in order: revokes every active signal in the batch →
supersedes every live edge those signals anchored → retires every node
the batch **created** → rejects every still-pending intake row from the
batch. What it deliberately does NOT do:

- **never retires pre-existing nodes** the batch merely collided with or
  patched (guarded by creation time; they're listed under
  `nodes_skipped_preexisting`);
- **does not auto-revert metadata patches / image attachments on
  pre-existing nodes** (a later write may have built on them) — these come
  back in `patches_to_review`, each with its `signal_id` (whose `content`
  records the exact patch) and `before`: the values the write replaced
  (`null` for a key that was absent; `before` itself is `null` for writes
  older than before-image recording). Before-images are operator-side
  (never in the public tables): they are in this response and on
  `/history`, not in the anchoring admin signal. Restore by hand with PATCH (§1.3);
- R2 image bytes stay (content-addressed, immutable, harmless orphans).

After the retirement the gallery starts again with a **new** batch_id.
The retired batch stays queryable forever (`/api/v1/batches`,
`?batch=` on contributions) — that's the audit trail, not a mess to
clean up.

---

## 5 — Don'ts

- **Don't impersonate.** Your token is bound to one contributor on the
  server side; the `submitted_by` field comes from the token, never from
  anything you send.
- **Don't bulk-import** without the practitioner's explicit go-ahead. If
  they say "ingest all my old shows", confirm the count first and follow
  the §6 playbook (one batch_id, sign-off before POSTing).
- **Don't infer `INFLUENCES` or `RESPONDS_TO`** from similarity (see §1.4).
- **Don't write to `/api/contribute`.** That's the legacy public web form
  used by anonymous browsers on `$ADAI_BASE/contribute`. It doesn't read
  your bearer token, so your contribution won't be attributed to the
  practitioner and won't respect their trust tier. Always use `/api/v1/*`.
- **Don't try to issue or rotate your own token.** That happens out-of-
  band; the practitioner runs `npm run token:issue` locally.
- **Don't delete data.** There is no DELETE endpoint by design — for
  anyone. The correction primitives exist instead: supersede an edge
  (§1.4), and an **admin** can revoke a signal (§4.5), retire a node
  (§4.6), or retire a batch (§4.7) — all provenance-preserving. If
  you're write-scope and something needs retracting, ask the curator.

If your token is admin-scope (§4), additional rules apply:
- **Don't mint a token without the practitioner asking.** A token they
  didn't ask for is impersonation potential.
- **Don't escalate `tier`.** If they came in as `probationary`, leave them
  there until they've earned `reviewed` — the curator queue exists for
  good reasons.
- **Don't share the raw token in a transcript you'll commit.** Use
  ephemeral channels.
- **Revoke proactively.** If a contributor lost their laptop, leaked a
  token in a screenshot, or just stopped contributing, rotate.
- **Always dry-run before any retire/bulk action** (§4.4, §4.6, §4.7) and
  read the plan back to whoever asked for the correction. The plan is
  cheap; an unnecessary retirement is annoying to reverse.
- **Prefer queue rejection over retiring live writes.** If a bulk upload is
  coming from a new contributor, keep them `probationary` for the first
  batch — then "start again" is just a bulk reject of pending items and
  nothing ever touched the graph. Retiring *live* writes is the
  fallback, not the plan.
- **Don't "clean up" history.** A retired batch, a revoked signal, a
  superseded edge are records, not clutter. Never try to make them
  disappear harder than the primitives already do.

---

## 6 — Bulk archive intake (galleries, estates, collections)

The script for "we want to upload our archive" — designed so a botched
run is a non-event:

1. **Mint the gallery a token at `probationary`** (§4.1; or ask the
   operator). Tell them this is the safety net for the first batch, not
   a demotion: every write queues for curator review, so a wrong upload
   can be rejected wholesale and *nothing ever touches the graph*.
2. **Agree the manifest before any POST** (§7): how many artworks, which
   artists, what fields, which images. Count confirmed by a human.
3. **One `batch_id` for the whole session** (§1.7), e.g.
   `nguyen-wahed-archive-2026-06-08`. Every signal/node/edge/image write
   carries it. Tell the gallery the id — it's their receipt.
4. **Upload.** Check existence before every create (§1.0). Watch
   `GET /api/v1/contributions?batch=<id>` as you go.
5. **Review.** The curator (or an admin Claude, §4.4) sweeps the batch:
   spot-check, then `review/bulk` approve — or reject with a reason if
   the batch is wrong.
6. **If it went wrong after going live** (the contributor was
   `reviewed`/`auto`, or the queue was approved too fast): admin
   batch retirement, §4.7. Dry-run, read the plan together, execute,
   start again with a new batch_id.
7. **Graduate the tier** (operator decision) once a batch or two have
   landed clean — then future sessions go live immediately.

---

## 7 — When in doubt

Ask the practitioner. The graph is small and human; cleanup is cheap
compared to a confident hallucination. If they hand you a CSV of 400
artworks and a 30-second monologue, the right move is to summarise what
you'd write and ask for sign-off before any POST.
