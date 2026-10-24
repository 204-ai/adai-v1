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
- **contributors** — `trust_tier` and counts stay (decided: policy). ⚠️ The
  public form (`POST /api/contribute`) creates a contributors row under the
  name typed in, at submission, even while the contribution waits in review —
  a typed name is public at once (unless the contribution is anonymous).
- **node_aliases** — handles (public by design), old slugs, evidence page URLs,
  platform ids; written only by published writes.

## Migration on prod (operator)

```bash
just deploy                      # code only; boot logs "[db] ⚠️ CRR rows hold unpublishable values …"
flyctl ssh console --app adai-basel -C "node /app/dist/cli/privacy-migrate.js --dry-run"
flyctl ssh console --app adai-basel -C "node /app/dist/cli/privacy-migrate.js"
flyctl ssh console --app adai-basel -C "node /app/dist/cli/privacy-migrate.js --dry-run"   # all zeros
curl -s https://adai-basel.fly.dev/api/sync/info                                          # 200 (503 until migrated; the check is cached 60 s)
```

One transaction; copy → verify → blank; aborts and rolls back if anything is
left. The originals stay in `signal_private` / `signal_priors` on the volume
(Litestream-replicated like the rest). Litestream's older WAL generations in
the private backup bucket still hold the pre-migration values — they are the
operator's, never public.

## Limits

- A fork applies a transaction larger than the page limit across several
  pages (cursor `"<db_version>:<seq>"`): between those pages it is partly
  applied. It is whole when the pull finishes.
- A fork that pulled before a revocation keeps the words until it pulls again;
  cr-sqlite cannot reach a copy that does not ask. `/offline` says so.
- Embeddings are local (`node_embeddings`): a fork runs `embed:backfill`.
