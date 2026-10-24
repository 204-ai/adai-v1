# Public CRDT sync — fork the commons

Anyone can fork A(DAI) by pulling cr-sqlite's change stream into a fresh
database (`npm run fork:pull`) and keep it current by pulling again. The
endpoint streams `crsql_changes` **unfiltered**. That is safe because of one
rule, decided with the owner:

> **The CRR (synced) tables only ever hold what the commons publishes.**
> Anything private lives in LOCAL (non-CRR) tables, like tokens and emails
> always did. A consent change (a revocation, a restriction) is an ordinary
> cell change that reaches every fork on its next pull.

No shadow or mirror database, no per-cell filtering of the stream.

Code: `src/utils/signal-private.ts` (the private side), `src/sync/changes.ts`
(read / encode / apply), `src/routes/sync.ts` (endpoints), `src/sync/pull.ts` +
`src/cli/fork-pull.ts` (the fork), `src/cli/privacy-migrate.ts` (existing data).
Tests: `tests/public-sync.test.ts`.

## What moved where

| What | CRR (public) | Local |
|---|---|---|
| words of a `structural_only` / `revoked` / pending-review / `rejected` signal, a note withdrawn in review, an objection | `title, summary, content, source_url, provenance_chain, processing_trace` = NULL | `signal_private` (originals, `reasons`) |
| an `anonymous` signal's author | `submitted_by='anonymous'`, `batch_id`, `provenance_chain` NULL; edges/nodes it writes labelled `anonymous`; counters on `contributor:anonymous` | `signal_private.submitted_by/batch_id/provenance_chain`, `signal_authors` |
| before-images (`recordPrior`) | `processing_trace.prior = [{op, node_id, at}]` | `signal_priors (signal_id, idx, op, node_id, at, updated_by, before)` |
| an admin record with before-images (retire_batch `patches_to_review`) | the record without `before` | `signal_private.content` (reason `before_images`) |
| the retirement record of a batch holding an anonymous signal | `Retire batch: correction-<hex>`, content without `batch_id` | `signal_private.title/content` (reason `private_batch`) |
| the typed name of a public-form contribution in review | `submitted_by` NULL, no contributors row | `signal_private.submitted_by` (reason `pending_name`); the row is written on approval |

`signals_full` (a view) lays the originals back over the CRR row for the back
office. Pending words go public on approval (`publishQueued` /
`publishSignal`), as an UPDATE the stream carries.

## Audit of the five CRRs

- **nodes** — `metadata` is served whole by the public `/:type/:slug/data`
  export, so it is published already; a structural_only signal may no longer
  write it (refused). Values a later-revoked contribution wrote stay (as on the
  site; `patches_to_review` lists them for a curator). `updated_by` holds writer
  labels (`api-<name>`) of public contributors; anonymous writes say `anonymous`.
- **edges** — `created_by` (and the id, which embeds it) is a public writer
  label; anonymous → `anonymous`. Derived edges are deleted and re-inserted by
  the nightly `embed:derive` (cr-sqlite delete tombstones are in the stream).
- **signals** — the rows above. Kept public on purpose: `confidence` (the trust
  tier: policy), consent fields, `status`, `batch_id` and `provenance_chain` of
  attributed published signals (`/history` shows `proposed_as`, `picked_from`;
  `provenance_chain.summary` is the reader's summary of the public site — not
  shown anywhere, kept), admin records' reasons (public by design).
- **contributors** — `trust_tier` and counts stay (decided: policy). From this
  release on, the public form writes its contributors row (and the name on the
  signal) only when the contribution is approved: pending names stay private.
  That applies to new contributions only — contributors rows the older code
  created for public-form names stay public (one exists on prod: "EV3") unless
  an operator decides otherwise (a delete would be a CRR change of its own).
- **claims** — the dedup key of a structural_only claim is derived from its
  withheld URL; it is internal: `GET /api/edge/attribution` serialises an
  opaque `source-<n>` id per source, never the key.
- **node_aliases** — handles (public by design), old slugs, evidence page URLs,
  platform ids; written only by published writes.

## Migration on prod (operator)

```bash
just deploy                      # code only; boot logs "[db] ⚠️ CRR rows hold unpublishable values …"
flyctl ssh console --app adai-basel -C "node /app/dist/cli/privacy-migrate.js --dry-run"
flyctl ssh console --app adai-basel -C "node /app/dist/cli/privacy-migrate.js"
flyctl ssh console --app adai-basel -C "node /app/dist/cli/privacy-migrate.js --dry-run"   # all zeros
flyctl ssh console --app adai-basel -C "node /app/dist/cli/privacy-audit-stream.js"         # 0 blocks (prod never had an anonymous signal)
curl -s https://adai-basel.fly.dev/api/sync/info                                          # 200 (503 until migrated; the check is cached 60 s)
```

One transaction; copy → verify → blank; aborts and rolls back if anything is
left. The originals stay in `signal_private` / `signal_priors` on the volume
(Litestream-replicated like the rest). Litestream's older WAL generations in
the private backup bucket still hold the pre-migration values — they are the
operator's, never public.

## Legacy anonymous contributions — a block only the stream audit clears

An anonymous signal written by this release is *born safe*: inserted blank
(`signal_private.born_safe = 1`), its edges `…--anonymous--<signal id>`,
`created_by` / `updated_by` `anonymous`. Any other anonymous signal — written by
older code, or found by the migration — is **legacy**: its author's name may be
in the change stream (an edge id, a reference to it, a writer label).

- It becomes a row in the local `privacy_blocks` table (`recordPrivacyBlocks`,
  at boot, in `privacy:migrate` and in the stream audit; the sync gate only
  reads — a legacy signal not recorded yet closes it too) with the author's
  labels and the author-bearing ids seen. The labels come from every record
  that ties the signal to a writer: the private original, the CRR submitter
  (unless already `anonymous`), the authenticated author (`signal_authors` →
  `contributors`), the review row's submitter, and the `created_by` of edges it
  still anchors — each name as `<name>`, `api-<name>`, `curator-from-<name>`. A block **does not disappear when rows are deleted**; while any is
  uncleared, `/api/sync/*` answers `503 legacy_anonymous_attribution`.
- **Deleting or re-keying an edge is NOT enough.** An edge id is a primary key:
  after a DELETE, cr-sqlite keeps a tombstone with that pk in `crsql_changes`,
  and every fork receives it. References to the old id (`invalidated_by`, an
  admin record) survive too.
- The only way to clear a block is the operator's stream audit:
  `npm run privacy:audit-stream` (report) / `-- --clear`. It scans every
  `crsql_changes` row, tombstones included (packed pks decoded), for the
  recorded ids anywhere (pk, text cell, JSON), tombstones and dangling
  `invalidated_by` references whose **writer component** is one of the labels,
  `created_by` / `updated_by` of the rows the signal wrote, and the signal's
  own name cells. Matching is structural — the writer component of
  `<source>--<TYPE>--<target>--<writer>[--<hex8>]` compared exactly — so a name
  that happens to occur in a node id, an edge type, `anonymous` or a signal id
  does not match. It clears only when nothing matches.
- **Insufficient evidence is not "clean".** When no label and no author-bearing
  id can be established (the CRR already said `anonymous`, nothing local names
  the writer, and its edge was deleted before the block was recorded), the
  audit reports `insufficient evidence` and **never** clears the block. Only an
  explicit operator decision does, with a reason, logged in
  `privacy_blocks.resolution` (`{at, by, reason, findings}`):
  `npm run privacy:audit-stream -- --resolve <signal id> --reason "…" [--by <operator>]`.
  It is refused while the audit finds anything concrete. Resolve only after
  checking the stream by hand (e.g. every edge tombstone's writer component).
- **A tombstone cannot be removed** without editing cr-sqlite's clock tables.
  If the audit finds one, the block stays, and **that database must not be
  published**: keep `PUBLIC_SYNC=off`.
- Prod has never had an anonymous signal, so prod has no block.

## Limits

- A fork applies a transaction larger than the page limit across several
  pages (cursor `"<db_version>:<seq>"`): between those pages it is partly
  applied. It is whole when the pull finishes.
- A fork that pulled before a revocation keeps the words until it pulls again;
  cr-sqlite cannot reach a copy that does not ask. `/offline` says so.
- Embeddings are local (`node_embeddings`): a fork runs `embed:backfill`.
