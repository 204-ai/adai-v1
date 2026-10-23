# A(DAI) — ops recipes.
#
# Mostly thin wrappers around `flyctl`, `npm`, and `curl`, plus the
# documented "wipe-and-reseed" dance that we run every time a new seed
# is baked into the image. The point is to keep the order of those
# steps (deploy → nuke volume → wait → restore tokens) honest, so we
# never deploy fresh seed data and then forget to put the admin tokens
# back. Token restore is idempotent — running it when it's not needed
# is a no-op.
#
# Run `just` (no args) to see the recipe list.
#
# Prereqs:  just (brew install just), flyctl, jq, curl. The token
# recipes also need `.tokens.json` (gitignored — see .tokens.json.example).

app         := "adai-basel"
hostname    := "https://" + app + ".fly.dev"
db_path     := "/data/adai.db"
tokens_file := ".tokens.json"

# Show available recipes.
default:
    @just --list

# --- local dev ---------------------------------------------------------

# Start the dev server against an EXISTING ./adai.db. The genesis seed was
# retired June 2026 — there is no reseed-from-JSON. To get a local DB, restore
# the live one from the Litestream replica, or pull a copy off prod:
#   echo "get //data/adai.db ./adai.db" | flyctl ssh sftp shell --app adai-basel
dev:
    @test -f adai.db || { echo "no ./adai.db — pull one from prod or restore from Litestream (see recipe comment)"; exit 1; }
    npm run dev

# --- Fly: low-level building blocks ------------------------------------

# Wake the idle machine (fly.toml auto_stop_machines='stop'; SSH alone won't).
warm:
    @curl -fs {{hostname}}/api/stats >/dev/null && echo "warm"

# Tail recent logs (last 20 lines, non-streaming).
logs:
    flyctl logs --app {{app}} --no-tail | tail -20

# Open an interactive SSH shell on the machine.
ssh: warm
    flyctl ssh console --app {{app}}

# Wait up to 30s for /api/stats to come back healthy after a restart.
wait-healthy:
    @echo "waiting for {{hostname}}/api/stats..."
    @for i in 1 2 3 4 5 6 7 8 9 10; do \
        if curl -fs {{hostname}}/api/stats >/dev/null; then echo "healthy"; exit 0; fi; \
        sleep 3; \
    done; \
    echo "not healthy after 30s" >&2; exit 1

# --- Fly: deploy -------------------------------------------------------

# Build + deploy via the IAD remote builder (Depot times out for us).
# --ha=false: flyctl's HA default silently creates a SECOND machine + volume
# (= two divergent DBs behind one hostname, observed June 2026). Never omit it.
#
# Deploy is CODE-ONLY and never touches data: the /data volume persists across
# deploys and the live DB is the only source of truth. The genesis seed +
# volume-wipe ("redeploy-fresh") dance was RETIRED June 2026 — there is no
# reseed. Disaster recovery is a Litestream restore (entrypoint does it
# automatically on a fresh host), not a wipe.
deploy:
    FLY_REMOTE_BUILDER_REGION=iad flyctl deploy --ha=false

# Internal: fail fast if .tokens.json is missing (used by restore-tokens).
_check-tokens-file:
    @test -f {{tokens_file}} || { echo "missing {{tokens_file}} — see {{tokens_file}}.example." >&2; exit 1; }

# --- Fly: tokens -------------------------------------------------------

# List active tokens on prod.
tokens-list: warm
    flyctl ssh console --app {{app}} -C "node /app/dist/cli/revoke-token.js --list"

# Restore operator bearer tokens from {{tokens_file}} (idempotent).
# SFTPs the file to /tmp on the VM, runs the CLI, deletes the file. The
# CLI is wrapped in a transaction so a partial failure rolls back cleanly.
[doc("Restore operator bearer tokens from .tokens.json into prod (idempotent).")]
restore-tokens: warm _check-tokens-file
    @echo "[restore-tokens] uploading {{tokens_file}} → /tmp/.adai-tokens.json"
    @echo "put {{tokens_file}} /tmp/.adai-tokens.json" | flyctl ssh sftp shell --app {{app}}
    flyctl ssh console --app {{app}} -C "sh -c 'node /app/dist/cli/restore-tokens.js --from /tmp/.adai-tokens.json; rc=$?; rm -f /tmp/.adai-tokens.json; exit $rc'"

# Dry-run the restore: validates {{tokens_file}} against prod, rolls back.
restore-tokens-dry: warm _check-tokens-file
    @echo "put {{tokens_file}} /tmp/.adai-tokens.json" | flyctl ssh sftp shell --app {{app}}
    flyctl ssh console --app {{app}} -C "sh -c 'node /app/dist/cli/restore-tokens.js --from /tmp/.adai-tokens.json --dry-run; rc=$?; rm -f /tmp/.adai-tokens.json; exit $rc'"

# --- Fly: R2 image janitor (orphan cull) -------------------------------
#
# cull_orphans.py reconciles the R2 bucket against canon references and
# reports/removes images nothing points at. Under the canon freeze,
# contributor-API uploads reference cdn_image_url only in the LIVE DB
# (/data/adai.db), never in seed/*.json — so the bucket MUST be diffed
# against the live DB, not just the committed canon, or a --delete would
# destroy live-referenced images. These recipes pull the live DB (incl.
# its WAL, so recent writes count) to a tmp file, run the cull with --db,
# then delete the tmp copy. (For a torn-free snapshot you can substitute a
# `litestream restore`d copy as the --db source.)

# Internal: pull /data/adai.db (+ -wal) off the volume → /tmp/adai-cull.db.
# Shared by the cull-orphans and shrink-oversized recipes (both diff R2 against
# the LIVE references, which only exist on the volume under the canon freeze).
_pull-live-db: warm
    @echo "[pull-live-db] pulling {{db_path}} (+ WAL) → /tmp/adai-cull.db"
    @rm -f /tmp/adai-cull.db /tmp/adai-cull.db-wal /tmp/adai-cull.db-shm
    @echo "get {{db_path}} /tmp/adai-cull.db" | flyctl ssh sftp shell --app {{app}}
    @echo "get {{db_path}}-wal /tmp/adai-cull.db-wal" | flyctl ssh sftp shell --app {{app}} || echo "[cull] no -wal (checkpointed) — ok"

# Dry-run: report orphan R2 images against the LIVE prod DB (reads only).
# The running DB is the only source of truth — an object is orphan iff no live
# node references it (genesis seed retired June 2026; no JSON is consulted).
[doc("Report orphan R2 images, diffed against the live prod DB (read-only).")]
cull-orphans-prod: _pull-live-db
    seed/_build/.venv/bin/python3 seed/_build/cull_orphans.py --db /tmp/adai-cull.db
    @rm -f /tmp/adai-cull.db /tmp/adai-cull.db-wal /tmp/adai-cull.db-shm

# DESTRUCTIVE: delete orphan R2 images, diffed against the live prod DB.
[doc("Delete orphan R2 images (diffed against the live prod DB). Destructive.")]
cull-orphans-prod-delete: _pull-live-db
    seed/_build/.venv/bin/python3 seed/_build/cull_orphans.py --db /tmp/adai-cull.db --delete
    @rm -f /tmp/adai-cull.db /tmp/adai-cull.db-wal /tmp/adai-cull.db-shm

# --- Fly: R2 oversized-image shrinker ----------------------------------
#
# shrink_oversized.py finds R2 images over a size threshold (default 5 MiB)
# that are still referenced by a LIVE node, downsizes them (longest edge
# <= 2048px, ANIMATION PRESERVED, format kept) to a NEW content-addressed key,
# uploads them, and emits a patch repointing each node's cdn_image_url.
#
# Because seed/*.json is frozen, the repoint lands in the LIVE prod DB only,
# via dist/cli/apply-image-patch.js over SSH (the only thing that writes the
# DB; it never re-embeds — the image is visually identical). The old oversized
# objects become orphans the instant the DB is repointed — reclaim them with
# `just cull-orphans-prod-delete` afterwards. Same live-DB-pull discipline as
# the cull recipes (the references only exist on the volume).
#
# ⚠️ The apply path needs dist/cli/apply-image-patch.js ON THE MACHINE — run
#    `just deploy` first if you've just added or changed that CLI.

# Dry-run: report oversized referenced images (list + DB scan only, no downloads).
[doc("Report oversized R2 images referenced by the live prod DB (read-only).")]
shrink-oversized-prod: _pull-live-db
    seed/_build/.venv/bin/python3 seed/_build/shrink_oversized.py --db /tmp/adai-cull.db
    @rm -f /tmp/adai-cull.db /tmp/adai-cull.db-wal /tmp/adai-cull.db-shm

# Measure: download+resize a sample, report REAL savings (no upload, no DB write).
[doc("Measure real savings on a sample of oversized images (no writes).")]
shrink-oversized-prod-measure: _pull-live-db
    seed/_build/.venv/bin/python3 seed/_build/shrink_oversized.py --db /tmp/adai-cull.db --measure
    @rm -f /tmp/adai-cull.db /tmp/adai-cull.db-wal /tmp/adai-cull.db-shm

# DESTRUCTIVE: resize+upload new objects, then repoint cdn_image_url in the live prod DB.
[doc("Resize oversized images → new R2 keys + repoint cdn_image_url in the live prod DB.")]
shrink-oversized-prod-apply: _pull-live-db
    seed/_build/.venv/bin/python3 seed/_build/shrink_oversized.py --db /tmp/adai-cull.db --apply --out /tmp/adai-shrink-patch.json
    @test -s /tmp/adai-shrink-patch.json || { echo "[shrink] no patch produced — nothing to apply"; rm -f /tmp/adai-cull.db /tmp/adai-cull.db-wal /tmp/adai-cull.db-shm; exit 0; }
    @echo "[shrink] uploading patch → prod /tmp/.adai-shrink-patch.json"
    @echo "put /tmp/adai-shrink-patch.json /tmp/.adai-shrink-patch.json" | flyctl ssh sftp shell --app {{app}}
    flyctl ssh console --app {{app}} -C "sh -c 'node /app/dist/cli/apply-image-patch.js --from /tmp/.adai-shrink-patch.json; rm -f /tmp/.adai-shrink-patch.json'"
    @rm -f /tmp/adai-cull.db /tmp/adai-cull.db-wal /tmp/adai-cull.db-shm /tmp/adai-shrink-patch.json
    @echo "[shrink] done — reclaim the now-orphaned originals with: just cull-orphans-prod-delete"

# --- staging (adai-staging, fly.staging.toml) -------------------------
#
# The `staging` branch runs on a nightly copy of the prod DB; staging never replicates and
# every outward integration sits behind a switch (src/utils/staging.ts):
#   mail=stdout|allowlist:<addr|@domain>,…|live  worker=on  r2=on  gemini=on
#   archivist=off  activity=on  data=keep
# CI deploys the `staging` branch after it passes (merges to main never touch
# it); `just staging-promote` moves it to main, `just staging-deploy` puts
# any working tree up.

staging_app  := "adai-staging"
staging_host := "https://" + staging_app + ".fly.dev"

# Deploy the working tree to staging (any branch; the next push to `staging` replaces it).
[doc("Deploy the current working tree to staging.")]
staging-deploy:
    FLY_REMOTE_BUILDER_REGION=iad flyctl deploy --config fly.staging.toml --ha=false

# Fast-forward the `staging` branch to origin/main; CI then deploys it.
# Refuses (non-fast-forward) if staging has commits main doesn't.
[doc("Fast-forward the staging branch to main (CI deploys it).")]
staging-promote:
    git fetch origin main
    git push origin origin/main:refs/heads/staging

# Set the switches. The arguments are the WHOLE state: unnamed switches return
# to their defaults. Restarts the machine (the DB copy is kept).
[doc("Set staging switches (whole state): just staging-set mail=allowlist:a@x.y worker=on")]
staging-set +switches:
    flyctl secrets set STAGING_SWITCHES="{{switches}}" -a {{staging_app}}

# Every switch back to its default.
[doc("Reset every staging switch to its default.")]
staging-reset:
    flyctl secrets unset STAGING_SWITCHES -a {{staging_app}}

# Show the switches staging is running with.
[doc("Show the staging switches.")]
staging-status:
    @curl -fsS {{staging_host}}/api/staging | jq .

# Fresh copy of the prod DB now (also overrides data=keep for this restore).
[doc("Restore a fresh copy of the prod DB on staging now.")]
staging-refresh:
    @curl -fs {{staging_host}}/api/stats >/dev/null
    flyctl ssh console --app {{staging_app}} -C "touch /data/.refresh"
    flyctl machine list --app {{staging_app}} --json | jq -r '.[].id' | xargs -n1 flyctl machine restart --app {{staging_app}}

[doc("Tail recent staging logs.")]
staging-logs:
    flyctl logs --app {{staging_app}} --no-tail | tail -40

[doc("SSH into the staging machine.")]
staging-ssh:
    @curl -fs {{staging_host}}/api/stats >/dev/null
    flyctl ssh console --app {{staging_app}}

# One-time: app + volume + the secrets that can come from here. Generates
# staging's own session secrets and copies the API keys present in .env; the
# R2 and worker secrets it prints must be set by hand.
[doc("Create the staging app and volume, set its generated + .env secrets (run once).")]
staging-bootstrap:
    #!/usr/bin/env bash
    set -euo pipefail
    flyctl apps create {{staging_app}} || true
    flyctl volumes list -a {{staging_app}} --json | jq -e 'length > 0' >/dev/null \
      || flyctl volumes create data --size 1 --region fra -a {{staging_app}} --yes
    {
      echo "SESSION_SECRET=$(openssl rand -hex 24)"
      echo "ARCHIVIST_SESSION_SECRET=$(openssl rand -hex 24)"
      grep -E '^(GEMINI_API_KEY|ANTHROPIC_API_KEY|RESEND_API_KEY|RESEND_FROM|ADMIN_NOTIFY_EMAILS|ADMIN_EMAILS)=' .env || true
    } | flyctl secrets import -a {{staging_app}} --stage
    echo
    echo "now set, with: flyctl secrets set NAME=value … -a {{staging_app}} --stage"
    echo "  required  R2_ENDPOINT R2_BACKUP_BUCKET R2_BACKUP_ACCESS_KEY_ID R2_BACKUP_SECRET_ACCESS_KEY"
    echo "            (a read-only token on the backup bucket is enough — staging only restores)"
    echo "  r2=on     R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_PUBLIC_BASE"
    echo "  worker=on WORKER_KEY (the same as prod's: the worker app holds one key)"
    echo "            WORKER_IMAGE FLY_API_TOKEN (just deploy-worker sets WORKER_IMAGE on both apps)"
    echo "then: just staging-deploy"

# --- whitepaper ---------------------------------------------------------

# Import a release from the Google Doc's .docx export into
# public/whitepaper/v<version>/ (markdown + WebP figures) for a PR. Host-only:
# brew install pandoc webp. See scripts/import-whitepaper.mjs for the steps after.
[doc("Import a whitepaper release from .docx: just whitepaper-import ~/Downloads/x.docx 1.8")]
whitepaper-import docx version:
    node scripts/import-whitepaper.mjs "{{docx}}" {{version}}

# --- URL intake (docs/URL-INTAKE-SPEC.md) ------------------------------

# Main app + intake worker (poll mode) side by side. Needs SESSION_SECRET,
# WORKER_KEY, ANTHROPIC_API_KEY in .env. Magic links print to the server log.
[doc("Run the dev server and the intake worker together (local, poll mode).")]
intake-dev:
    #!/usr/bin/env bash
    set -euo pipefail
    test -f adai.db || { echo "no ./adai.db — pull one from prod first"; exit 1; }
    grep -q '^SESSION_SECRET=' .env && grep -q '^WORKER_KEY=' .env || { echo "add SESSION_SECRET and WORKER_KEY (>=16 chars) to .env"; exit 1; }
    test -d worker/node_modules || (cd worker && npm install && npx playwright install chromium)
    trap 'kill 0' INT TERM EXIT
    npm run dev &
    sleep 3
    ADAI_URL=http://localhost:8080 npm run intake:worker &
    wait

# Invite a contributor: pre-creates the contributor with the right tier so the
# first magic-link login lands correctly. Add --send to email the link now.
[doc("Invite a contributor to the URL intake (local DB): just invite x@y.z 'Name' auto [practitioner:slug]")]
invite email name tier="probationary" practitioner="":
    npm run invite -- --email "{{email}}" --name "{{name}}" --tier {{tier}} {{ if practitioner != "" { "--practitioner " + practitioner } else { "" } }}

# Same, on prod.
[doc("Invite a contributor on prod: just invite-prod x@y.z 'Name' auto [practitioner:slug]")]
invite-prod email name tier="probationary" practitioner="": warm
    flyctl ssh console --app {{app}} -C "node /app/dist/cli/invite.js --email '{{email}}' --name '{{name}}' --tier {{tier}} {{ if practitioner != "" { "--practitioner '" + practitioner + "'" } else { "" } }} --send"

# Build + push the worker image (NO machines are created), then point the main
# app at the new tag. `flyctl apps create adai-intake-worker` once beforehand.
[doc("Build and push the intake worker image; set WORKER_IMAGE on the main app.")]
deploy-worker:
    #!/usr/bin/env bash
    # pipefail: without it `| tee` swallows a failed build and the recipe goes
    # on to point WORKER_IMAGE at a tag that was never pushed (Sept 2026).
    set -euo pipefail
    test -d worker || { echo "no worker/ dir"; exit 1; }
    tag_short="$(git rev-parse --short HEAD)"
    (FLY_REMOTE_BUILDER_REGION=iad flyctl deploy --config worker/fly.toml --dockerfile worker/Dockerfile --build-only --push --image-label "$tag_short" 2>&1 | tee /tmp/adai-worker-deploy.log)
    tag="registry.fly.io/adai-intake-worker:$tag_short"
    echo "[worker] image $tag"
    flyctl secrets set WORKER_IMAGE="$tag" -a {{app}}
    if flyctl status -a {{staging_app}} >/dev/null 2>&1; then flyctl secrets set WORKER_IMAGE="$tag" -a {{staging_app}}; fi

# One-time: worker app + its secrets (WORKER_KEY must equal the main app's).
[doc("Create the worker Fly app and set its secrets (run once).")]
worker-bootstrap key anthropic_key:
    flyctl apps create adai-intake-worker || true
    flyctl secrets set WORKER_KEY="{{key}}" ANTHROPIC_API_KEY="{{anthropic_key}}" -a adai-intake-worker

# List live worker machines (should be empty between jobs).
[doc("List intake worker machines (expect none between jobs).")]
worker-machines:
    flyctl machines list -a adai-intake-worker
