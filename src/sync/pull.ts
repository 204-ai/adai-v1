// Fork the commons: pull a source's cr-sqlite changes into a local database
// (npm run fork:pull, src/cli/fork-pull.ts). The local database is created
// by the app's own initDb, so its CRR tables are real CRRs and the merge is
// cr-sqlite's (INSERT INTO crsql_changes), page by page, each page in one
// transaction with its cursor. Re-running pulls only what is new.
//
// Settings (local table) it keeps:
//   fork_source_url, fork_source_site_id, fork_cursor (the source's
//   db_version up to which everything is applied), fork_pulled_at.

import type { DatabaseSync } from "node:sqlite";
import { applyChanges, crrSchema, CRR_TABLES, parseCursor, SYNC_FORMAT, type ChangesPage, type SyncInfo } from "./changes.js";

export interface PullOptions {
  from: string;
  force?: boolean;
  limit?: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface PullResult {
  source_site_id: string;
  pages: number;
  changes: number;
  cursor: string;
  source_db_version: number;
}

export class ForkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForkError";
  }
}

const setting = (db: DatabaseSync, key: string): string | null =>
  ((db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any)?.value as string | undefined) ?? null;
const setSetting = (db: DatabaseSync, key: string, value: string) =>
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(f: typeof fetch, url: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await f(url, { headers: { accept: "application/json", "accept-encoding": "gzip" } });
    if ((res.status === 429 || res.status === 503) && attempt < 8) {
      const wait = Math.min(60, Number(res.headers.get("retry-after")) || 2 ** attempt);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new ForkError(`${url}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

export async function pullFork(db: DatabaseSync, opts: PullOptions): Promise<PullResult> {
  const f = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const base = opts.from.replace(/\/+$/, "");
  const info = (await getJson(f, `${base}/api/sync/info`)) as SyncInfo;
  if (info.format !== SYNC_FORMAT) throw new ForkError(`unknown sync format ${info.format} (this code speaks ${SYNC_FORMAT})`);

  const mine = crrSchema(db);
  if (mine.hash !== info.schema.hash) {
    throw new ForkError(`the source's CRR schema differs from this code's (${info.schema.hash.slice(0, 12)} vs ${mine.hash.slice(0, 12)}): update the code to the source's version, then pull again`);
  }
  const localSite = String((db.prepare("SELECT hex(crsql_site_id()) AS s").get() as any).s).toLowerCase();
  if (localSite === info.site_id) throw new ForkError("refusing to pull a database into itself");

  const known = setting(db, "fork_source_site_id");
  let cursor = setting(db, "fork_cursor") ?? "0";
  if (!parseCursor(cursor)) throw new ForkError(`settings.fork_cursor is malformed: ${cursor}`);
  if (known && known !== info.site_id) {
    if (!opts.force) throw new ForkError(`this database is a fork of site ${known}, not ${info.site_id}: refusing (--force to pull anyway, from 0)`);
    cursor = "0";
  }
  if (!known) {
    const rows = CRR_TABLES.reduce((n, t) => n + Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n), 0);
    if (rows && !opts.force) throw new ForkError(`this database already holds ${rows} CRR rows and is no fork: refusing (--force to merge into it anyway)`);
    cursor = "0";
  }
  setSetting(db, "fork_source_url", base);
  setSetting(db, "fork_source_site_id", info.site_id);
  if (!known || known !== info.site_id) setSetting(db, "fork_cursor", cursor);

  // A value a later change overwrites (a revocation's words) is zeroed on
  // disk, not left in a free page.
  db.exec("PRAGMA secure_delete = ON");
  let pages = 0;
  let changes = 0;
  let sourceVersion = info.db_version;
  for (;;) {
    const q = `${base}/api/sync/changes?since=${encodeURIComponent(cursor)}${opts.limit ? `&limit=${opts.limit}` : ""}`;
    const page = (await getJson(f, q)) as ChangesPage;
    if (page.site_id !== info.site_id) throw new ForkError(`the source changed site id mid-pull (${page.site_id}): pull again`);
    const a = parseCursor(cursor)!;
    const b = parseCursor(String(page.next));
    if (!b) throw new ForkError(`the source sent a malformed cursor: ${page.next}`);
    const advanced = b.v > a.v || (b.v === a.v && (a.seq !== null && (b.seq === null || b.seq > a.seq)));
    if (page.more && !advanced) throw new ForkError(`the source's cursor did not advance (${cursor} → ${page.next})`);
    applyChanges(db, page.changes, { key: "fork_cursor", value: String(page.next) });
    pages++;
    changes += page.count;
    cursor = String(page.next);
    sourceVersion = page.db_version;
    log(`page ${pages}: ${page.count} changes, cursor ${cursor} / ${page.db_version}`);
    if (!page.more) break;
  }
  setSetting(db, "fork_pulled_at", new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* not in WAL mode */ }
  return { source_site_id: info.site_id, pages, changes, cursor, source_db_version: sourceVersion };
}
