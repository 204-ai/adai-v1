PRAGMA journal_mode = WAL;

-- === CR-SQLite CRR TABLES ===
-- NOTE: CRR tables cannot have UNIQUE indices (besides PK) or NOT NULL without DEFAULT

CREATE TABLE IF NOT EXISTS nodes (
    id          TEXT PRIMARY KEY NOT NULL,
    type        TEXT DEFAULT '',
    name        TEXT DEFAULT '',
    slug        TEXT,
    metadata    TEXT,
    created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_by  TEXT DEFAULT 'unknown'
);

CREATE INDEX IF NOT EXISTS idx_nodes_slug ON nodes(slug);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);

SELECT crsql_as_crr('nodes');

CREATE TABLE IF NOT EXISTS edges (
    id             TEXT PRIMARY KEY NOT NULL,
    source_id      TEXT DEFAULT '',
    target_id      TEXT DEFAULT '',
    edge_type      TEXT DEFAULT '',
    signal_id      TEXT,
    confidence     TEXT DEFAULT 'medium',
    charge         TEXT,
    created_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    created_by     TEXT DEFAULT 'unknown',
    event_time     TEXT,
    valid_from     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    valid_until    TEXT,
    invalidated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_composite ON edges(source_id, target_id, edge_type, signal_id);
CREATE INDEX IF NOT EXISTS idx_edges_valid ON edges(valid_until);

SELECT crsql_as_crr('edges');

CREATE TABLE IF NOT EXISTS signals (
    id                  TEXT PRIMARY KEY NOT NULL,
    title               TEXT,
    source_url          TEXT,
    source_type         TEXT,
    cla_layer           TEXT,
    summary             TEXT,
    content             TEXT,
    submitted_by        TEXT DEFAULT 'unknown',
    confidence          TEXT DEFAULT 'medium',
    lived_experience    INTEGER DEFAULT 0,
    created_at          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    consent_scope       TEXT DEFAULT 'full_commons',
    consent_attribution TEXT DEFAULT 'attributed',
    consent_revocable   INTEGER DEFAULT 1,
    processing_trace    TEXT,
    source_origin       TEXT DEFAULT 'unknown',
    batch_id            TEXT,
    status              TEXT DEFAULT 'active',
    provenance_chain    TEXT
);

CREATE INDEX IF NOT EXISTS idx_signals_origin ON signals(source_origin);
CREATE INDEX IF NOT EXISTS idx_signals_batch  ON signals(batch_id);
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);

SELECT crsql_as_crr('signals');

CREATE TABLE IF NOT EXISTS contributors (
    id              TEXT PRIMARY KEY NOT NULL,
    name            TEXT DEFAULT '',
    type            TEXT DEFAULT '',
    trust_tier      TEXT DEFAULT 'low',
    contributions   INTEGER DEFAULT 0,
    approved_count  INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

SELECT crsql_as_crr('contributors');

CREATE TABLE IF NOT EXISTS node_aliases (
    source      TEXT NOT NULL DEFAULT '',
    external_id TEXT NOT NULL DEFAULT '',
    node_id     TEXT NOT NULL DEFAULT '',
    created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_node_aliases_node ON node_aliases(node_id);

SELECT crsql_as_crr('node_aliases');

-- === LOCAL-ONLY TABLES ===

CREATE TABLE IF NOT EXISTS intake_queue (
    id              TEXT PRIMARY KEY NOT NULL,
    signal_id       TEXT,
    target_node     TEXT,
    submitted_by    TEXT NOT NULL,
    trust_tier      TEXT NOT NULL,
    status          TEXT DEFAULT 'pending',
    reviewed_by     TEXT,
    reviewed_at     TEXT,
    rejection_reason TEXT,
    proposed_nodes  TEXT,
    proposed_edges  TEXT,
    created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_intake_status ON intake_queue(status);

-- Embeddings (Gemini Embedding 2 multimodal pass). Local-only, recomputable.
-- Two rows per practitioner are possible: kind='identity' (their text vector)
-- and kind='style_centroid' (mean of artworks they CREATED_BY, L2-normalised).
-- Only practitioners with live CREATED_BY edges get a style_centroid row;
-- bridge practitioners and net-new imports without attribution silently
-- fall out of STYLE_KIN / SUGGESTS_CREATED_BY downstream.
CREATE TABLE IF NOT EXISTS node_embeddings (
    node_id    TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'identity',     -- 'identity' | 'style_centroid'
    model      TEXT NOT NULL,
    dims       INTEGER NOT NULL,
    vector     BLOB NOT NULL,                         -- f32 LE, L2-normalised
    has_image  INTEGER DEFAULT 0,
    image_hash TEXT,
    text_hash  TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (node_id, kind),
    FOREIGN KEY (node_id) REFERENCES nodes(id)
);

CREATE INDEX IF NOT EXISTS idx_node_embeddings_kind ON node_embeddings(kind);

-- Latent "islands": k-means cluster id per node over the identity vectors.
-- Local-only (NOT a CRR) — a derived view of the embedding space, recomputed
-- by `embed:derive` (k-means in src/embed/islands.ts). Drives the field-flow
-- macro-layout: each island becomes a contiguous region of the Shape of Time.
-- Wiped + rewritten each derive run; served read-only at GET /api/islands.
CREATE TABLE IF NOT EXISTS node_islands (
    node_id    TEXT PRIMARY KEY NOT NULL,
    island     INTEGER NOT NULL,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (node_id) REFERENCES nodes(id)
);

CREATE INDEX IF NOT EXISTS idx_node_islands_island ON node_islands(island);

-- Pairs the curator rejected from the AI suggestion queue. The derive pass
-- consults this to avoid re-proposing the same attribution every run.
CREATE TABLE IF NOT EXISTS rejected_ai_suggestions (
    pair_hash   TEXT PRIMARY KEY NOT NULL,    -- sha256(source_id||edge_type||target_id)
    source_id   TEXT NOT NULL,
    target_id   TEXT NOT NULL,
    edge_type   TEXT NOT NULL,
    reason      TEXT,
    rejected_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_rejected_ai_target ON rejected_ai_suggestions(target_id);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('db_version', '1');

-- Bearer tokens for the /api/v1/* contributor API. Local-only (NOT a CRR):
-- token material must never sync. The raw token is sha256-hashed before
-- storage; we keep token_prefix (first 8 chars of the raw token) so an
-- operator can identify a token in `npm run token:revoke` without ever
-- seeing the secret again. Issuance is out-of-band via `src/cli/issue-token.ts`
-- — there is no HTTP endpoint that mints tokens.
CREATE TABLE IF NOT EXISTS contributor_tokens (
    token_hash      TEXT PRIMARY KEY NOT NULL,
    token_prefix    TEXT NOT NULL,
    contributor_id  TEXT NOT NULL,
    label           TEXT,
    scope           TEXT DEFAULT 'write',
    created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_used_at    TEXT,
    revoked_at      TEXT,
    node_id         TEXT                            -- the node this token's contributor stands for (issue #70), e.g. an institution posting its collection
);

CREATE INDEX IF NOT EXISTS idx_contributor_tokens_contributor
  ON contributor_tokens(contributor_id);
CREATE INDEX IF NOT EXISTS idx_contributor_tokens_prefix
  ON contributor_tokens(token_prefix);

-- Beta-programme email signups from the /field "Connect" room ("Enter the
-- Beta"). Local-only (NOT a CRR): visitor contact details must never sync into
-- the public graph. Lives on the /data volume, backed up by Litestream with
-- the rest of the DB. Read via the admin endpoint GET /api/v1/beta-signups.
-- UNIQUE(email) makes repeat submits idempotent.
CREATE TABLE IF NOT EXISTS beta_signups (
    id          TEXT PRIMARY KEY NOT NULL,
    email       TEXT NOT NULL UNIQUE,
    role        TEXT,
    note        TEXT,
    source      TEXT,
    created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_beta_signups_created ON beta_signups(created_at);

-- Archivist chat sessions. Local-only — anonymous-visitor session cookies
-- live here so we can rate-limit and audit without sync. NOT a CRR.
-- Cookie format: <session_id>.<hex(hmac_sha256(session_id, secret))> set as
-- HttpOnly+SameSite=Lax. Verification only requires re-computing the HMAC,
-- but we keep a row so we can track message_count for the per-session quota
-- and last_message_at for the rolling window.
CREATE TABLE IF NOT EXISTS archivist_sessions (
    session_id        TEXT PRIMARY KEY NOT NULL,
    created_at        INTEGER NOT NULL,
    ip                TEXT,
    user_agent        TEXT,
    message_count     INTEGER DEFAULT 0,
    last_message_at   INTEGER
);

-- Per-day token + cost rollup for the global budget gate. Pricing
-- constants live in src/archivist/ratelimit.ts; this table just stores
-- aggregates so we can compare today's spend to ARCHIVIST_DAILY_BUDGET_USD.
CREATE TABLE IF NOT EXISTS archivist_usage (
    date                 TEXT PRIMARY KEY NOT NULL,   -- YYYY-MM-DD UTC
    input_tokens         INTEGER DEFAULT 0,
    output_tokens        INTEGER DEFAULT 0,
    cache_read_tokens    INTEGER DEFAULT 0,
    cache_write_tokens   INTEGER DEFAULT 0,
    est_cost_usd         REAL DEFAULT 0
);

-- === URL INTAKE (docs/URL-INTAKE-SPEC.md) ===
-- Everything below is local-only (NOT a CRR). Email addresses, session
-- material and in-flight drafts must never sync into the public graph.

-- Magic links: single-use, hashed at rest. purpose='login' expires in 15 min;
-- 'draft_ready' / 'receipt' (the links inside notification emails) in 7 days.
CREATE TABLE IF NOT EXISTS magic_links (
    token_hash      TEXT PRIMARY KEY NOT NULL,      -- sha256 of the raw token
    email           TEXT NOT NULL,
    purpose         TEXT NOT NULL DEFAULT 'login',  -- login | draft_ready | receipt
    redirect        TEXT,                           -- path to land on after login
    created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    expires_at      TEXT NOT NULL,
    used_at         TEXT,
    ip              TEXT
);
CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);

-- Contributor sessions. Cookie format mirrors archivist_sessions:
-- adai_session=<session_id>.<hex(hmac_sha256(session_id, SESSION_SECRET))>.
-- 30 days sliding; deleting the row revokes the session.
CREATE TABLE IF NOT EXISTS contributor_sessions (
    session_id      TEXT PRIMARY KEY NOT NULL,
    contributor_id  TEXT NOT NULL,
    created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    expires_at      TEXT NOT NULL,
    last_seen_at    TEXT,
    ip              TEXT,
    user_agent      TEXT
);
CREATE INDEX IF NOT EXISTS idx_contributor_sessions_contributor ON contributor_sessions(contributor_id);

-- email -> contributor. `contributors` itself is a CRR and stays untouched;
-- anything per-contributor the intake needs (the practitioner node they ARE,
-- the display name they asked for) lives here.
CREATE TABLE IF NOT EXISTS contributor_emails (
    email           TEXT PRIMARY KEY NOT NULL,      -- lowercased
    contributor_id  TEXT NOT NULL,
    self_node_id    TEXT,                           -- practitioner node the contributor is (from the invite)
    verified_at     TEXT,
    created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    invited_at      TEXT,                           -- the URL intake is invite-only: NULL = may not sign in
    revoked_at      TEXT                            -- set by an admin; sessions end at once
);
CREATE INDEX IF NOT EXISTS idx_contributor_emails_contributor ON contributor_emails(contributor_id);

-- Uninvited addresses that asked for a sign-in link: the admins' "pending"
-- list (GET /api/v1/invites). Local; never a CRR.
CREATE TABLE IF NOT EXISTS intake_access_requests (
    email           TEXT PRIMARY KEY NOT NULL,      -- lowercased
    first_at        TEXT NOT NULL,
    last_at         TEXT NOT NULL,
    count           INTEGER NOT NULL DEFAULT 1,
    notified_at     TEXT,                           -- last admin email about it (at most daily)
    node_id         TEXT,                           -- signed-out "claim this page": the node asked for
    evidence        TEXT,                           -- … and why it is theirs
    display_name    TEXT,                           -- how they'd like to appear (pre-fills the invite)
    about           TEXT                            -- optional: who they are, what they'd contribute
);

-- Drafts double as the job queue: a row with job IS NOT NULL is claimable by
-- the intake worker; a claim older than 20 min with no heartbeat is
-- reclaimable. id doubles as batch_id on confirm.
CREATE TABLE IF NOT EXISTS drafts (
    id              TEXT PRIMARY KEY NOT NULL,      -- 'drf_' + 16 hex
    contributor_id  TEXT NOT NULL,
    source_url      TEXT NOT NULL,
    source_domain   TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'queued', -- queued | running | ready | submitted | failed | abandoned
    job             TEXT,                           -- JSON {kind: 'initial'|'chat'|'continue', message?, queued_at}
    claimed_by      TEXT,
    claimed_at      TEXT,
    heartbeat_at    TEXT,
    machine_id      TEXT,
    subject_node_id TEXT,
    candidates      TEXT NOT NULL DEFAULT '[]',
    messages        TEXT NOT NULL DEFAULT '[]',
    pages           TEXT NOT NULL DEFAULT '[]',
    summary         TEXT,
    survey          TEXT,                           -- JSON: the agent's site survey + coverage (note_survey)
    usage           TEXT,
    intake_ids      TEXT,
    error           TEXT,
    passes          INTEGER NOT NULL DEFAULT 0,
    notified_ready_at TEXT,
    created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    submitted_at    TEXT,
    picked_from     TEXT                            -- a pick-up of another draft's left-open items: that draft's id
);
CREATE INDEX IF NOT EXISTS idx_drafts_contributor ON drafts(contributor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_drafts_queue ON drafts(status, claimed_at);

-- Cards a contributor left undecided at Confirm (issue #77), kept for another
-- contributor to pick up. The card itself stays in its draft (submitted
-- drafts never change); a pick-up copies it into a new draft of the picker's,
-- and that draft's Confirm records the decision here. Local; never a CRR.
CREATE TABLE IF NOT EXISTS intake_open_items (
    draft_id        TEXT NOT NULL,                  -- the read the card was left open in
    cid             TEXT NOT NULL,
    kind            TEXT NOT NULL,
    label           TEXT NOT NULL,                  -- one line, names not cids
    reason          TEXT NOT NULL DEFAULT 'undecided', -- undecided | link_failed (the reader could not open the item's page)
    subject_node_id TEXT,                           -- the read's subject, for its page
    created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    decided_at      TEXT,
    decided_by      TEXT,                           -- contributor id
    decided_in      TEXT,                           -- the pick-up draft
    outcome         TEXT,                           -- accepted | answered | rejected | context_only | skipped
    PRIMARY KEY (draft_id, cid)
);
CREATE INDEX IF NOT EXISTS idx_open_items_open ON intake_open_items(decided_at, subject_node_id);

-- Daily USD rollup for the intake worker, sibling of archivist_usage.
CREATE TABLE IF NOT EXISTS intake_usage (
    date                 TEXT PRIMARY KEY NOT NULL,
    input_tokens         INTEGER DEFAULT 0,
    output_tokens        INTEGER DEFAULT 0,
    cache_read_tokens    INTEGER DEFAULT 0,
    cache_write_tokens   INTEGER DEFAULT 0,
    est_cost_usd         REAL DEFAULT 0
);

-- === CLAIMS (docs/CLAIM-SPEC.md) ===
-- "This node is me / mine." Local; the public face of an approved claim is
-- the node's metadata.claimed + a 'claim' signal + its handle alias row
-- (node_aliases source='handle', whose PK makes handles unique).
-- Several approved claimants per node (members of a collective); one
-- contributor may claim several nodes.
CREATE TABLE IF NOT EXISTS node_claims (
    id              TEXT PRIMARY KEY NOT NULL,      -- 'clm_' + 16 hex
    node_id         TEXT NOT NULL,
    contributor_id  TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | withdrawn | revoked
    via             TEXT NOT NULL,                   -- invite | request | peer_invite | post_intake
    evidence        TEXT,
    public_name     INTEGER NOT NULL DEFAULT 1,      -- 0 = badge without the claimant's name
    invited_by      TEXT,                            -- contributor id (peer_invite)
    queue_id        TEXT,                            -- intake_queue row (kind='claim') while pending
    signal_id       TEXT,                            -- the signal that made it public
    reviewed_by     TEXT,
    reviewed_at     TEXT,
    reason          TEXT,
    created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_node_claims_node ON node_claims(node_id, status);
CREATE INDEX IF NOT EXISTS idx_node_claims_contributor ON node_claims(contributor_id, status);

-- A claimant's word on a relation (or a metadata edit, or a pending queue
-- item) about a node they claimed. The signal (CRR) is the public record;
-- this is the index the profile / field / personal log read.
--   kind='contest'   — public mark at once; a curator upholds or dismisses
--   kind='context'   — a note shown with the relation (tier-gated)
--   kind='objection' — on a pending queue item; the curator sees it there
CREATE TABLE IF NOT EXISTS relation_notes (
    signal_id       TEXT PRIMARY KEY NOT NULL,
    kind            TEXT NOT NULL,
    source_id       TEXT,                            -- relation triple (contest/context on a relation)
    edge_type       TEXT,
    target_id       TEXT,
    meta_key        TEXT,                            -- contest on a metadata edit: the key …
    edit_signal_id  TEXT,                            -- … and the signal that wrote it
    queue_ref       TEXT,                            -- objection: the intake_queue row objected to
    node_id         TEXT NOT NULL,                   -- the claimed node it was written from
    contributor_id  TEXT NOT NULL,
    note            TEXT NOT NULL,
    state           TEXT NOT NULL,                   -- contest/objection: open | upheld | dismissed ; context: live | pending | rejected | withdrawn
    queue_id        TEXT,                            -- its own review row (contest; pending context)
    resolved_by     TEXT,
    resolved_at     TEXT,
    resolution      TEXT,
    created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_relation_notes_triple ON relation_notes(source_id, edge_type, target_id);
CREATE INDEX IF NOT EXISTS idx_relation_notes_node ON relation_notes(node_id, created_at);
CREATE INDEX IF NOT EXISTS idx_relation_notes_queue_ref ON relation_notes(queue_ref);
