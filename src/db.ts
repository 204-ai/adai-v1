import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionPath } from "@shards-lang/crsqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

let db: DatabaseSync;

export function initDb(dbPath: string): DatabaseSync {
  db = new DatabaseSync(dbPath, { allowExtension: true });
  db.loadExtension(extensionPath);

  const schema = readFileSync(join(PROJECT_ROOT, "db.sql"), "utf-8");
  db.exec(schema);

  runMigrations(db);

  return db;
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
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error("Database not initialized. Call initDb() first.");
  return db;
}
