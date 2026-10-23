# A(DAI) Embedding Pipeline

Multimodal vector space over the A(DAI) knowledge graph, built on **Google Gemini Embedding 2**.

This is the canonical reference for the pipeline — design rationale, architecture, operational details. For day-to-day operator notes (counts, commands, deploy gotchas) see [CLAUDE.md § Embedding pipeline](../CLAUDE.md).

> **⚠️ Genesis-bake parts are HISTORICAL (retired June 2026).** The offline
> batch embed (`seed/_build/embed_nodes.py`), `seed/nodes.json`, the committed
> `embeddings.{bin,json}` sidecars, and the `COPY seed/` + `seed:consolidated`
> build step are **gone** — the live `/data/adai.db` is the only source of truth.
> What's still live and accurate below: the **embed-on-write** path
> (`src/embed/server.ts`), the nightly **`embed:derive`** (STYLE_KIN /
> VISUALLY_AFFINE / Tier-2 concept-EMBODIES against the live DB), and the
> `node_embeddings` table design. Vectors are now produced only by embed-on-write
> + the nightly `embed-derive-daily` workflow, never by a build-time bake.

---

## 1. What and why

A(DAI)'s graph holds artwork, practitioner, concept, and scene nodes connected by curatorial edges (`CREATED_BY`, `PRACTICES`, `BELONGS_TO`, etc). Pre-embedding, the graph only knew the *textual* half of each node — two Casey Reas pieces looked unrelated even when their pixels said otherwise, and Art Blocks artworks without `CREATED_BY` edges sat orphaned even when they were stylistically next door to a known practitioner.

Gemini Embedding 2 (GA April 2026) is Google's first natively multimodal embedding model: text and image are projected into one unified vector space via a shared transformer, not via late-fusion as in CLIP. For an artwork, we send `[title text…, image bytes]` in a single call and get back one fused 768-d vector that captures both modalities. For a practitioner or concept, text alone. All vectors land in the **same space**, so a practitioner's text vector and an artwork's text-plus-image vector are directly cosine-comparable.

### What we use it for

Four derived signals, all marked `confidence='low'` and tagged `created_by='embedding-multimodal-v1'` for trivial roll-back:

| Output | Direction | Where it lands |
|---|---|---|
| **`STYLE_KIN`** edges | practitioner ↔ practitioner (bidirectional rows) | Live `edges` table |
| **`VISUALLY_AFFINE`** edges | artwork ↔ artwork (bidirectional rows) | Live `edges` table |
| **`EMBODIES`** edges (Tier-2 concept propagation) | artwork → tag-concept (inferred "generated labels") | Live `edges` table — see §5 |
| **`SUGGESTS_CREATED_BY`** proposals | artwork → practitioner attribution candidates | `intake_queue` with `kind='ai_suggestion'` for curator review at `/review?kind=ai_suggestion` |

The pipeline **refuses** to auto-emit `INFLUENCES` or `RESPONDS_TO` even when similarity is high. Both edge types require evidence of artist intent (statements, interviews, practitioner contribution) — semantic similarity is a *necessary-but-not-sufficient* condition for either. Diluting them with auto-derived rows would erode their meaning.

### Why this design (vs alternatives)

- **CLIP-style joint embedding**: late-fusion separates text and image streams and never quite reconciles them. Gemini's shared transformer does, in one model call.
- **OpenAI text-embedding + separate image embedding**: forces us to pick which modality to compare and contaminates similarity with modality bias.
- **A per-source classifier**: editorial, brittle, doesn't generalise to new artworks.
- **Manual attribution**: what we'd be doing anyway. The embedding pipeline accelerates the curator's review by 100×, doesn't replace it.

---

## 2. Architecture

A split between offline batch (heavy, occasional, API-bound) and online derive (light, frequent, in-process):

```
                ┌──────────────────────────────────────────┐
                │ OFFLINE  (Python, seed/_build/)          │
                │                                          │
                │  seed/nodes.json                         │
                │       │                                  │
                │       ▼                                  │
                │  embed_nodes.py ──► Gemini API           │
                │       │                                  │
                │       ▼                                  │
                │  seed/embeddings.bin   (f32 LE × 768)    │
                │  seed/embeddings.json  (offsets, hashes) │
                └────────────────┬─────────────────────────┘
                                 │  (committed to git)
                                 ▼
                ┌──────────────────────────────────────────┐
                │ BUILD  (Docker)                          │
                │                                          │
                │  seed-consolidated.ts                    │
                │   ├─ loads nodes/edges/signals           │
                │   ├─ loads embeddings → node_embeddings  │
                │   └─ chains derive(db) ───┐              │
                │                            │              │
                │                            ▼              │
                │  embed/derive.ts:                        │
                │   ├─ computeCentroids() — 119 rows       │
                │   ├─ STYLE_KIN pairs above τ_kin         │
                │   ├─ VISUALLY_AFFINE pairs above τ_visual│
                │   └─ SUGGESTS_CREATED_BY → intake_queue  │
                │                                          │
                │  seed.db (baked into Docker image)       │
                └────────────────┬─────────────────────────┘
                                 ▼
                ┌──────────────────────────────────────────┐
                │ RUNTIME  (Fly.io)                        │
                │                                          │
                │  • Profile pages → on-demand topK        │
                │  • /neighbours/:type/:slug → topK        │
                │  • /field — dashed derived edges,        │
                │             'e' toggles embed mode       │
                │  • /review?kind=ai_suggestion            │
                │  • Approval → real CREATED_BY edge       │
                │  • Rejection → rejected_ai_suggestions   │
                └──────────────────────────────────────────┘
```

### Why split Python vs TypeScript?

| Concern | Resolution |
|---|---|
| The batch embed is API-bound, costs money, runs rarely | Python — matches existing `seed/_build/` pipeline (`fetch_moma_csv.py`, `upload_to_r2.py`, etc) |
| Runtime container should stay lean | Python and the Gemini SDK never ship to runtime |
| Derive (cosine pairwise) is fast and self-contained | TypeScript — runs inside the Node server, no Python boundary |
| Re-derive after a curator approval should be cheap | `npm run embed:derive` in-process; sub-second pass over the current vector set (~16k post-rebuild) |

Sidecars (`embeddings.bin`, `embeddings.json`) are **committed to git** so the Docker build picks them up at build time. The `.gitignore` carries a warning against re-ignoring them — accidentally stripping them would silently produce an empty embedding space in production.

---

## 3. Schema

Three local-only tables. `node_embeddings` and `rejected_ai_suggestions` are pure local (recomputable; no CRDT sync needed), and `intake_queue` gets a `kind` discriminator.

```sql
-- src/db.sql
CREATE TABLE IF NOT EXISTS node_embeddings (
    node_id    TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'identity',     -- 'identity' | 'style_centroid'
    model      TEXT NOT NULL,                         -- 'gemini-embedding-2'
    dims       INTEGER NOT NULL,                      -- 768
    vector     BLOB NOT NULL,                         -- f32 LE, L2-normalised
    has_image  INTEGER DEFAULT 0,
    image_hash TEXT,
    text_hash  TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (node_id, kind),
    FOREIGN KEY (node_id) REFERENCES nodes(id)
);

CREATE TABLE IF NOT EXISTS rejected_ai_suggestions (
    pair_hash   TEXT PRIMARY KEY NOT NULL,    -- sha256(source||edge_type||target)
    source_id   TEXT NOT NULL,
    target_id   TEXT NOT NULL,
    edge_type   TEXT NOT NULL,
    reason      TEXT,
    rejected_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- src/db.ts (migration wrapped in try/catch, keyed to SQLite's "duplicate column" error)
ALTER TABLE intake_queue ADD COLUMN kind TEXT NOT NULL DEFAULT 'human_signal';
```

**Two vector kinds per node:**
- `identity` — the node's own embedding (every embedded node has one).
- `style_centroid` — for practitioners with ≥1 live `CREATED_BY` edge, the L2-normalised mean of their attributed artworks' identity vectors. **Bridge practitioners and net-new imports without attribution have no centroid row** — they silently fall out of STYLE_KIN and SUGGESTS_CREATED_BY. All lookup code handles the undefined case.

---

## 4. The Python batch pass

### What gets embedded

| Node type | Modalities | Strategy |
|---|---|---|
| `artwork` | text + image | `task: sentence similarity \| query: {title} ({year}). {description}` interleaved with image bytes |
| `practitioner` / `collective` | text only | `… : {name}. {practice_summary} {methodology}` — **portraits intentionally excluded**, see below |
| `concept` | text only | `… : Concept: {name}. {description}` |
| `scene` | text only | `… : Scene: {name}. {description}` |
| `institution` / `publication` / `project` / `classification_regime` | skipped | Not useful at v1; reserve for future |

**Why no practitioner portraits?** Wikidata-sourced portraits are mostly faces. Folding them in would pull practitioners toward "people who look alike" rather than "people who make similar work". The visual signal for a practitioner instead comes from their `style_centroid` row, computed downstream from their attributed artworks — a much stronger signal than the practitioner's bio text alone, because the bio is mostly biography, not style.

### Files

```
seed/_build/
├── embed_nodes.py        — main entry; reads nodes.json, calls Gemini, writes sidecar
├── image_fetch.py        — HTTP fetch + Pillow downsample + local SQLite cache
├── calibration_pairs.json — hand-picked positives/negatives for threshold tuning
├── calibrate.py          — prints histograms, recommends τ values
└── .image_cache.sqlite   — gitignored fetch cache (~60 MB after first run)
```

### Idempotency

Re-running `embed_nodes.py` only calls the API for rows whose `(text_hash, image_hash)` doesn't match the existing sidecar. After the initial pass, re-embed cost approaches zero unless the underlying nodes change.

### Cost

Single full embed pass at ~1,350 nodes: ~$0.03 interactive / $0.014 batch.

### Image fetching

> **⚠️ ALWAYS RUN `upload_to_r2.py --mirror` BEFORE THIS PASS.** Artwork
> embeddings are multimodal — the image is part of the vector. The embedder
> prefers the R2 cdn (below); if an artwork's image isn't mirrored yet it
> **silently falls back to text-only** — a wrong vector that looks fine. Order
> is always: **(1) mirror → (2) embed → (3) project.**

- Prefers `metadata.cdn_image_url` (R2-mirrored, stable) over `metadata.image_url` (rotting source).
- 4 MB cap on download; Pillow downsamples > 1024px to JPEG quality 85.
- MIME whitelist: JPEG / PNG / WebP / BMP. SVG/GIF/HEIC fall back to text-only.
- Per-host concurrency limits (Wikimedia → 2 to avoid 429s).
- IPFS gateway fallback for dead `gateway.objkt.com` references.

### Running it

```bash
# One-shot full embed (idempotent — re-runs skip cached rows)
seed/_build/.venv/bin/python3 seed/_build/embed_nodes.py

# Cost preview without API calls
seed/_build/.venv/bin/python3 seed/_build/embed_nodes.py --dry-run

# Restrict to a subset
seed/_build/.venv/bin/python3 seed/_build/embed_nodes.py --types artwork --limit 50
```

`GEMINI_API_KEY` lives in `.env` (gitignored). The Python venv at `seed/_build/.venv` has `google-genai`, `pillow`, `python-dotenv`.

---

## 5. The TypeScript derive pass

Single command, two stages:

```bash
npm run embed:derive       # chains centroids → derive (canonical entry)
npm run embed:centroids    # diagnostics only; embed:derive already runs it
npm run embed:calibrate    # print histograms against calibration_pairs.json
```

Every `embed:derive` starts with:
```sql
DELETE FROM edges            WHERE created_by  = 'embedding-multimodal-v1';
DELETE FROM intake_queue     WHERE submitted_by = 'contributor:embedding-pipeline'
                               AND status = 'pending';
```
…so re-runs are clean. Rejected pairs persist in `rejected_ai_suggestions` and are honoured across runs.

### Files

```
src/embed/
├── vectors.ts     — decode/encode f32 BLOB, cosine, L2-normalise, loadAll(db)
├── centroids.ts   — compute style centroids, upsert as kind='style_centroid'
├── derive.ts      — the pairwise pass; emits STYLE_KIN, VISUALLY_AFFINE, AI suggestions
├── neighbours.ts  — shared topK module reused by profile pages / similarity browser
└── cli.ts         — npm run embed:* entry point
```

### Calibrated thresholds (May 2026)

| Threshold | Value | Override env var | Source |
|---|---|---|---|
| `τ_attribute` | **0.88** | `TAU_ATTRIBUTE` | Median of 29 positive pairs — precision-biased (4 negatives in the overlap zone) |
| `τ_kin` | **0.91** | `TAU_KIN` | Top 5% of practitioner-pair similarities |
| `τ_visual` | **0.84** | `TAU_VISUAL` | Top 1% of artwork-pair similarities |

These are calibrated against `seed/_build/calibration_pairs.json` (30 hand-picked positive `CREATED_BY` pairs + 30 cross-scene negatives). To re-tune after a data refresh:

```bash
npm run embed:calibrate     # reads from DB
# or (during the Python pass, against the sidecar directly):
seed/_build/.venv/bin/python3 seed/_build/calibrate.py
```

The calibration set ships as 30/30 (the working floor). Growing it to ~100/~100 would tighten the threshold gap; the curator's eye is the gatekeeper either way for `SUGGESTS_CREATED_BY`.

### Bidirectional storage

`STYLE_KIN` and `VISUALLY_AFFINE` are stored as **two rows per pair** (P1→P2 *and* P2→P1) so the existing edge readers (`/api/graph`, `/api/graph/:slug/component` BFS, profile-page connection lists) don't need to know which edge types are symmetric. ~hundreds of rows extra, negligible.

### Edge id convention

`{source_id}--{edge_type}--{target_id}--embedding-multimodal-v1`

Deterministic, so the DELETE-and-rewrite cycle is stable and grep-friendly.

### `VISUALLY_AFFINE` creator filter

Same-creator pairs are skipped (so we don't surface Casey Reas piece N ↔ Casey Reas piece M as a "rhyme"). Pairs where both artworks lack a known creator **are** emitted — that's the attribution-candidate use case where this edge is most useful.

### `SUGGESTS_CREATED_BY` flow

For each unattributed artwork A (no live `CREATED_BY` edge), score against every practitioner's `style_centroid`. The single best practitioner above `τ_attribute` becomes an `intake_queue` row with:
- `kind = 'ai_suggestion'`
- `submitted_by = 'contributor:embedding-pipeline'`
- `trust_tier = 'probationary'` (never auto-approves)
- `proposed_edges = JSON.stringify([{source_id: A, target_id: practitioner, edge_type: 'CREATED_BY', similarity: 0.89}])`
- `id = 'intake-ai-{12-hex-hash-of-pair}'` — URL-safe so `/api/review/:id/{approve,reject}` works without encoding gymnastics

On approve, the existing review handler materialises a real `CREATED_BY` edge tagged `created_by='curator-from-ai-suggestion'`. On reject, the pair's sha256 hash lands in `rejected_ai_suggestions` and the next derive pass skips it.

### `EMBODIES` (Tier-2 concept propagation) — `src/embed/concept-edges.ts`

Enriches EMBODIES beyond the attested `derive_curation.py` tag-EMBODIES: propagates a **tag-concept** to visually-similar *untagged* artworks. Runs inside `embed:derive` after `VISUALLY_AFFINE`, emitting `EMBODIES` (artwork → concept) at `confidence='low'`, dashed in `/field`, wiped+recomputed each run (so it's not in the committed canon JSON).

Why it's not naive centroid-cosine: generative-art vectors are **anisotropic** — they all point roughly the same way, so raw cosine sits in a compressed high band and a handful of central artworks match *every* concept. The fix is **mean-centring** the artwork vectors first, then a **kNN-vote**: for each non-member artwork, what fraction of its `knnK` (30) nearest centred neighbours carry the concept? Emit only if ≥ `voteThreshold` (0.30).

Two gates keep junk concepts from propagating (env-tunable, `CONCEPT_*`):
- **coherence** `tauCoherence` (0.15) — mean centred member→centroid cosine; drops umbrella tags (`art`, `generative`, `p5js`) whose members aren't visually coherent.
- **creators** `minCreators` (8) — members must span ≥8 distinct creators; kills single-artist tag-series that look coherent but aren't a shared concept.
- plus `minMembers` (15) and `maxPerConcept` (200).

It is **platform-crossing**: the tag *vocabulary* is seeded from fxhash tags, but propagation runs over all artwork vectors, so Art Blocks works get labelled too where they're visually close. Tune `TAU_CONCEPT_COH` up (→ ~0.22) to drop semantically-broad concepts (`city`, `space`) before the vote; leave `CONCEPT_VOTE` alone (it's already precision-biased). Validated on real fxhash tags before merge: naive centroid matched everything; centred kNN-vote gives tight propagation (`pixel`→untagged pixel-art, `grid`/`glitch`→nothing).

---

## 6. Visualisation surfaces

| Surface | What it shows | Code |
|---|---|---|
| **Profile pages** (`/practitioner/:slug`, `/artwork/:slug`, `/concept/:slug`, `/scene/:slug`) | Resemblances to explore (the style-kin section) / Visually affine / Style proximity / pending AI proposals — computed on-demand from in-memory vectors (~1 ms per request). The public entity view and the `/field` strip show neighbours ranked, without cosine scores (they bunch within a few hundredths and read as more conclusive than they are); `/record` and `/neighbours` keep the scores for evaluation | `src/embed/sections.ts`; `src/routes/pages.ts::renderEmbeddingSections` (record view) |
| **`/neighbours/:type/:slug`** | Top-K cosine neighbours of any node; shareable URL with knobs for query/candidate kind, type prefix, k | `src/routes/pages.ts` (handler) + `src/embed/neighbours.ts` |
| **`/field`** | Derived edges render dashed by default. Press **`e`** (or click the chrome chip) to flip into "embeddings mode": curatorial edges fade to ~3 % alpha, STYLE_KIN + VISUALLY_AFFINE rise to ~60 % | `public/field/sketch-graph.js::edgeDimming` |
| **`/review?kind=ai_suggestion`** | Curatorial queue for AI attribution proposals with cosine scores visible | `src/routes/pages.ts::/review` + `src/routes/api.ts` approve/reject handlers |

### Edge colors

The two new edge types render in muted variants of their semantic neighbours:

- `STYLE_KIN` — muted lavender (`#8a7aa8`), adjacent to `BELONGS_TO`
- `VISUALLY_AFFINE` — muted ochre (`#a89a7a`), adjacent to `CREATED_BY`

Plus the dashed stroke (`setLineDash([5, 4])`) so they're trivially distinguishable from curatorial edges at a glance.

---

## 7. Deploy considerations

The pipeline ships with the Docker image — no runtime API calls, no GEMINI_API_KEY needed in production.

- **Builder stage**: `COPY seed/` brings in the sidecars; `npm run seed:consolidated` loads embeddings and chains `derive()` so the baked `seed.db` ships complete.
- **Runtime stage**: `seed.db` only — the `.bin` and `.json` sidecars are already baked into it, so no embedding sidecar ships separately at runtime.
- **`.dockerignore`** excludes `seed/_build/` (483 MB venv + research artifacts).
- **Volume migration**: on first deploy after a schema/data change, the persistent `/data/adai.db` keeps the old data. The documented fix is the volume nuke: `flyctl ssh console -C "sh -c 'rm -f /data/adai.db*'"` + `flyctl machine restart`. On restart the entrypoint copies the new baked seed.db.

The recurring failure mode: **sidecar drift**. If `seed/nodes.json` changes but `embeddings.{bin,json}` isn't regenerated, the baked DB drifts off the actual data. The seed script's idempotent hash check helps catch this — only changed nodes get re-embedded. Re-commit the diff afterwards.

---

## 8. Empirical results (first pass, May 2026)

Against the v1 canon's 1,338 multimodal embeddings (May 2026 first-pass results below). v2 rebuild numbers re-populate after the daily `embed-derive-daily` GitHub Actions workflow runs against the new canon (~16k nodes):

```
{
  "centroids": 119 written, 0 skipped, 7 CREATED_BY targets lacked an artwork vector
  "thresholds": { "tau_attribute": 0.88, "tau_kin": 0.91, "tau_visual": 0.84 },
  "style_kin":            { "pairs": 373, "rows_written": 746 },
  "visually_affine":      { "pairs": 211, "rows_written": 422 },
  "suggests_created_by":  { "proposals": 17, "rejected_skipped": 0 },
  "unattributed_artworks_scored": 61
}
```

Total derive pass: **0.3 s** over the full vector space.

### Spot checks that the embedding space is real

- **Fidenza's nearest neighbours** (Tyler Hobbs's signature work): Meridian, Subscapes, Ringers, Chromie Squiggle, Incomplete Control (Hobbs again), The Eternal Pump — exactly the top-tier Art Blocks generative neighbourhood
- **Fidenza's style-centroid match**: Tyler Hobbs at 0.93, then Casey Reas at 0.86 (Δ = 0.07 to the right creator)
- **Casey Reas's style kin**: Kim Asendorf 0.94, Tyler Hobbs 0.93, Harm van den Dorpel, Mario Klingemann, Simon Denny, Vera Molnár — the generative/algorithmic crowd
- **AI-attribution proposals that actually work**:
  - `haveibeentrained.com` → Mat Dryhurst ✓ (he co-founded it)
  - `holly+ dao` → Holly Herndon ✓
  - `a study of entanglement` → Libby Heaney ✓ (quantum-art practitioner)
  - `artificial natural history` → Anna Ridler ✓ (AI/dataset art)
  - `beneath the neural waves` → Mario Klingemann ✓

---

## 9. Extending the pipeline

### Add a new derived edge type

Edit `src/embed/derive.ts`. The pattern: iterate the candidate set, cosine-score against the appropriate vectors, gate on a threshold, INSERT into `edges` with `created_by='embedding-multimodal-v1'` so re-runs delete and rewrite cleanly.

Before shipping a new auto-derived edge type:

- Update [`seed/SOURCES.md`](../seed/SOURCES.md) — the canonical edge-type list.
- Update [`CLAUDE.md`](../CLAUDE.md) edge counts and the embedding pipeline section.
- Add it to `EDGE_COLORS` in [`public/field/sketch-graph.js`](../public/field/sketch-graph.js) so the field viz colors it.
- Re-think whether the new type should be bidirectional (recommended: yes, unless the edge is genuinely directional).
- **Do not** auto-emit `INFLUENCES` or `RESPONDS_TO` — see § 1.

### Re-tune thresholds

Grow `seed/_build/calibration_pairs.json` toward 100/100. Re-run `npm run embed:calibrate`. Either edit the defaults in `src/embed/derive.ts` or set the env override at runtime.

### Re-embed after seed changes

```bash
# After editing seed/nodes.json (especially adding new artworks or rich descriptions)
seed/_build/.venv/bin/python3 seed/_build/embed_nodes.py    # idempotent
git add seed/embeddings.{bin,json}
git commit -m "embed: re-embed after <reason>"
```

The Docker build will pick up the new sidecars on next deploy.

---

## 10. Open questions

- **Scaling**: derive pass is `O(N²)` for visual affine — 728² = 530k pairs, sub-second today. At 10× the artwork count we'd want a kd-tree or LSH index.
- **Multi-instance**: `DELETE FROM edges WHERE created_by='embedding-multimodal-v1'` on a CRR table syncs. Two instances running derive at once would race. A `settings` table mutex would be enough.
- **HEIC/HEIF/AVIF support**: not in the v1 MIME whitelist (Pillow plugin not installed). Add when an image source needs it.
- **Practitioner portraits**: currently excluded. Worth an A/B once we have a richer attribution ground truth — measure whether including them improves practitioner↔artwork retrieval for known CREATED_BY pairs.

---

## References

- [Gemini Embedding 2 announcement](https://developers.googleblog.com/en/building-with-gemini-embedding-2/)
- [Gemini API model card](https://ai.google.dev/gemini-api/docs/models/gemini-embedding-2-preview)
- [Vertex multimodal embeddings guide](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-multimodal-embeddings) (task prefixes, limits)
- A(DAI) implementation: this directory + `../src/embed/` + `../seed/_build/`
