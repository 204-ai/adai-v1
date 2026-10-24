import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionPath } from "@shards-lang/crsqlite";
import { backlogTotal, privacyBacklog } from "./utils/signal-private.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

let db: DatabaseSync;

export function initDb(dbPath: string): DatabaseSync {
  // timeout = SQLite busy_timeout: wait up to 15 s for another connection's
  // write lock instead of failing at once with "database is locked". The
  // server and the operator CLIs (embed backfill / derive / import over SSH)
  // write the same file; without it either side fails the moment they meet.
  db = new DatabaseSync(dbPath, { allowExtension: true, timeout: 15_000 });
  db.loadExtension(extensionPath);

  preSchemaMigrations(db);
  const schema = readFileSync(join(PROJECT_ROOT, "db.sql"), "utf-8");
  db.exec(schema);

  runMigrations(db);
  warnPrivacyBacklog(db);

  return db;
}

// The CRR tables are published as they are (GET /api/sync/changes): a row
// that still holds what must not be published is a leak. Moving it is an
// operator step with a dry run (`npm run privacy:migrate`), never automatic
// at boot — this only says so, loudly.
function warnPrivacyBacklog(db: DatabaseSync) {
  try {
    const b = privacyBacklog(db);
    if (backlogTotal(b)) {
      console.warn(`[db] ⚠️ CRR rows hold unpublishable values ${JSON.stringify(b)} — run \`npm run privacy:migrate -- --dry-run\`, then without --dry-run`);
    }
  } catch (e) {
    console.warn(`[db] privacy backlog check failed: ${(e as Error).message}`);
  }
}

// Before db.sql runs: shapes db.sql's own statements would trip over.
//
// The claimant-notification tables (issue #81) changed shape during review,
// before anything was deployed: an earlier claimant_events had `line` (no
// `ref`), an earlier claimant_deliveries had no `batch_id` (db.sql indexes
// it), an earlier claimant_batches had no lease owner. They hold only
// dedup / delivery state, so an old shape is dropped and recreated by
// db.sql, and the notification baseline restarts from now.
function preSchemaMigrations(db: DatabaseSync) {
  const cols = (t: string) => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name as string));
  const ev = cols("claimant_events");
  const del = cols("claimant_deliveries");
  const bat = cols("claimant_batches");
  const stale =
    (ev.size && !ev.has("ref")) ||
    (del.size && !del.has("batch_id")) ||
    (bat.size && (!bat.has("lease_owner") || !bat.has("first_attempt_at")));
  if (!stale) return;
  db.exec(`DROP TABLE IF EXISTS claimant_deliveries;
           DROP TABLE IF EXISTS claimant_batches;
           DROP TABLE IF EXISTS claimant_events;
           DELETE FROM settings WHERE key = 'claimant_notify_since';`);
  console.warn("[db] claimant notification tables were an earlier shape: recreated, baseline restarts");
}

// Migrations that cannot live in db.sql because they would fail (and abort the
// whole script) on re-runs once already applied. Each one is wrapped in its
// own try/catch keyed to a SPECIFIC, STABLE SQLite error message — do not
// "clean these up" by removing the try/catch or by swallowing the error
// generically. The comments are load-bearing.
function runMigrations(db: DatabaseSync) {
  // Add `kind` discriminator to intake_queue so AI suggestions (from the
  // Gemini embedding derive pass) can be filtered out of the human /review
  // tab. SQLite raises "duplicate column name: kind" on re-runs; that error
  // string is stable across versions and is the documented migration path
  // (see CLAUDE.md § Deploy gotchas — adding a column to an existing CRR or
  // local table can't be done declaratively in db.sql).
  try {
    db.exec("ALTER TABLE intake_queue ADD COLUMN kind TEXT NOT NULL DEFAULT 'human_signal'");
  } catch (e: any) {
    if (!String(e?.message ?? e).includes("duplicate column name")) throw e;
  }
  // drafts.survey (Sept 2026): the intake agent's site survey + coverage
  // statement. Same idempotent pattern; a fresh DB already has the column
  // from db.sql, an existing volume gets it here.
  try {
    db.exec("ALTER TABLE drafts ADD COLUMN survey TEXT");
  } catch (e: any) {
    if (!String(e?.message ?? e).includes("duplicate column name")) throw e;
  }
  // contributor_emails.invited_at / revoked_at (Sept 2026): the URL intake
  // became invite-only. Same idempotent pattern.
  for (const col of ["invited_at", "revoked_at"]) {
    try {
      db.exec(`ALTER TABLE contributor_emails ADD COLUMN ${col} TEXT`);
    } catch (e: any) {
      if (!String(e?.message ?? e).includes("duplicate column name")) throw e;
    }
  }
  // intake_access_requests.node_id / evidence (Oct 2026): a signed-out
  // "claim this page" request names the node (docs/CLAIM-SPEC.md §2.3);
  // display_name / about: how the requester would like to appear (issue #72).
  for (const col of ["node_id", "evidence", "display_name", "about"]) {
    try {
      db.exec(`ALTER TABLE intake_access_requests ADD COLUMN ${col} TEXT`);
    } catch (e: any) {
      if (!String(e?.message ?? e).includes("duplicate column name")) throw e;
    }
  }
  // drafts.picked_from (Oct 2026): a pick-up of left-open items (issue #77).
  try {
    db.exec("ALTER TABLE drafts ADD COLUMN picked_from TEXT");
  } catch (e: any) {
    if (!String(e?.message ?? e).includes("duplicate column name")) throw e;
  }
  // contributor_tokens.node_id (Oct 2026): the node a token's contributor
  // stands for (issue #70).
  try {
    db.exec("ALTER TABLE contributor_tokens ADD COLUMN node_id TEXT");
  } catch (e: any) {
    if (!String(e?.message ?? e).includes("duplicate column name")) throw e;
  }
  // signal_authors (issue #80): the authenticated author of signals written
  // before insertSignal recorded it, where the record proves it — once (a
  // settings flag; every write since records its author itself):
  //   - a URL-intake signal whose provenance names its draft (a /api/v1
  //     caller can set batch_id but never provenance_chain), whose batch is
  //     that draft, and whose submitter is the draft owner's current name;
  //   - a claim note (relation_notes is written only by the signed-in claimant).
  // Ambiguous history stays unverified rather than guessed: a draft owner
  // renamed since (submitted_by no longer matches), a signal whose submitter
  // is not the draft's owner (whoever confirmed it, it is not proven to be
  // the owner's), and every /api/v1 or form write from before.
  const done = db.prepare("SELECT value FROM settings WHERE key = 'signal_authors_backfill'").get() as any;
  if (!done) {
    db.exec(`INSERT OR IGNORE INTO signal_authors (signal_id, contributor_id, via)
      SELECT s.id, d.contributor_id, 'draft' FROM signals s
        JOIN drafts d ON d.id = s.batch_id AND d.id = CASE WHEN json_valid(s.provenance_chain) THEN json_extract(s.provenance_chain, '$.draft_id') END
        JOIN contributors k ON k.id = d.contributor_id AND k.name = s.submitted_by
       WHERE s.provenance_chain IS NOT NULL`);
    db.exec(`INSERT OR IGNORE INTO signal_authors (signal_id, contributor_id, via)
      SELECT signal_id, contributor_id, 'note' FROM relation_notes`);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('signal_authors_backfill', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))").run();
  }
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error("Database not initialized. Call initDb() first.");
  return db;
}
