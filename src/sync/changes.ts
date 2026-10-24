// Public CRDT sync (fork the commons): read cr-sqlite's own change stream,
// encode it losslessly, and apply it to another database.
//
// The rule that makes this safe to publish unfiltered: the CRR tables only
// ever hold what the commons publishes (src/utils/signal-private.ts). So the
// server streams `crsql_changes` as it is — no per-cell filtering, no mirror
// database — and a consent change (a revocation, a restriction) is an
// ordinary cell change that reaches every fork on its next pull.
//
// Wire format, one change = one JSON array:
//   [table, pk, cid, val, col_version, db_version, site_id, cl, seq]
//   pk       — base64 of cr-sqlite's packed primary key (a blob)
//   site_id  — hex of the 16-byte site id
//   val      — exact SQLite type: null | "text" | integer as a JSON number
//              (or {"i": "<decimal>"} beyond 2^53) | {"r": <real>} |
//              {"b": "<base64 blob>"}
//   the rest — integers.
// Pages are cut on whole db_versions (a transaction is never split), read in
// one read transaction, ordered by (db_version, seq).

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const SYNC_FORMAT = "adai-crsql-changes/1";
export const CRR_TABLES = ["nodes", "edges", "signals", "contributors", "node_aliases"] as const;
export const DEFAULT_LIMIT = 5000;
export const MAX_LIMIT = 20000;
/** About this many bytes of encoded changes per page (the JSON array, before gzip). */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export type EncodedVal = null | string | number | { i: string } | { r: number | string } | { b: string };
export type WireChange = [string, string, string, EncodedVal, number, number, string | null, number, number];

const toNum = (v: unknown): number => {
  if (typeof v === "bigint") {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error(`integer out of range: ${v}`);
    return Number(v);
  }
  return Number(v);
};

const hex = (b: unknown): string | null => (b instanceof Uint8Array ? Buffer.from(b).toString("hex") : b === null || b === undefined ? null : String(b));

/** A cell value with its SQLite type kept (the statement reads integers as bigint). */
export function encodeVal(v: unknown): EncodedVal {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "bigint") {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : { i: v.toString() };
  }
  if (typeof v === "number") return { r: Number.isFinite(v) ? v : String(v) };
  if (v instanceof Uint8Array) return { b: Buffer.from(v).toString("base64") };
  throw new Error(`unsupported value type ${typeof v}`);
}

/** The value to bind for an encoded cell (node:sqlite binds a JS number as REAL, a bigint as INTEGER). */
export function decodeVal(v: EncodedVal): null | string | number | bigint | Uint8Array {
  if (v === null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return BigInt(v);
  if ("i" in v) return BigInt(v.i);
  if ("r" in v) return typeof v.r === "number" ? v.r : Number(v.r);
  if ("b" in v) return new Uint8Array(Buffer.from(v.b, "base64"));
  throw new Error("bad encoded value");
}

/**
 * What a fork must match: every CRR table's columns (name, declared type,
 * pk position, not-null, default), in order. cr-sqlite merges by column
 * name, so two databases with the same hash can exchange changes.
 */
export function crrSchema(db: DatabaseSync): { hash: string; tables: Record<string, string[]> } {
  const tables: Record<string, string[]> = {};
  for (const t of CRR_TABLES) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all() as any[];
    tables[t] = cols.map((c) => `${c.name} ${String(c.type).toUpperCase()}${c.pk ? ` pk${c.pk}` : ""}${c.notnull ? " notnull" : ""}${c.dflt_value !== null && c.dflt_value !== undefined ? ` default ${c.dflt_value}` : ""}`);
  }
  const hash = crypto.createHash("sha256").update(JSON.stringify(tables)).digest("hex");
  return { hash, tables };
}

export interface SyncInfo {
  format: string;
  site_id: string;
  db_version: number;
  schema: { hash: string; tables: Record<string, string[]> };
  tables: string[];
}

export function syncInfo(db: DatabaseSync): SyncInfo {
  const r = db.prepare("SELECT hex(crsql_site_id()) AS site, crsql_db_version() AS v").get() as any;
  return {
    format: SYNC_FORMAT,
    site_id: String(r.site).toLowerCase(),
    db_version: Number(r.v),
    schema: crrSchema(db),
    tables: [...CRR_TABLES],
  };
}

export interface ChangesPage {
  format: string;
  site_id: string;
  since: string;
  /**
   * The cursor for the next request: "<db_version>" — every change up to
   * that db_version is in this page or an earlier one — or, only when one
   * transaction is larger than the limit, "<db_version>:<seq>" (that
   * transaction delivered up to seq).
   */
  next: string;
  more: boolean;
  /** The source's db_version when the page was read. */
  db_version: number;
  count: number;
  changes: WireChange[];
}

export interface Cursor { v: number; seq: number | null }

/** "<db_version>" or "<db_version>:<seq>"; null when malformed. */
export function parseCursor(raw: string): Cursor | null {
  const m = /^(\d{1,15})(?::(\d{1,15}))?$/.exec(raw);
  if (!m) return null;
  return { v: Number(m[1]), seq: m[2] === undefined ? null : Number(m[2]) };
}
export const formatCursor = (c: Cursor): string => (c.seq === null ? String(c.v) : `${c.v}:${c.seq}`);

const CHANGES_SQL = `SELECT "table" AS tbl, pk, cid, val, col_version, db_version, site_id, cl, seq
  FROM crsql_changes`;

/**
 * One page of changes after the cursor, ordered by (db_version, seq), within
 * two budgets: at most `limit` changes and about `maxBytes` of encoded JSON.
 * Pages end on whole db_versions (a transaction is never split) — except a
 * single transaction larger than a budget (the genesis load, a nightly
 * re-derive), delivered in seq order across pages with a
 * "<db_version>:<seq>" cursor. A page always carries at least one change, so
 * a single cell larger than `maxBytes` makes a page of its own (over budget).
 * One read transaction: a consistent picture while the server writes; a cell
 * written later leaves its old db_version for a newer one, so nothing behind
 * a cursor is ever missed.
 */
export function readChanges(db: DatabaseSync, since: Cursor | number, limit = DEFAULT_LIMIT, maxBytes = DEFAULT_MAX_BYTES): ChangesPage {
  const cur: Cursor = typeof since === "number" ? { v: since, seq: null } : since;
  const lim = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
  const budget = Math.max(1, Math.floor(maxBytes));
  db.exec("BEGIN");
  try {
    const head = db.prepare("SELECT hex(crsql_site_id()) AS site, crsql_db_version() AS v").get() as any;
    const rest = db.prepare(`${CHANGES_SQL} WHERE db_version > ? ORDER BY db_version, seq LIMIT ?`);
    const within = db.prepare(`${CHANGES_SQL} WHERE db_version = ? AND seq > ? ORDER BY seq LIMIT ?`);
    rest.setReadBigInts(true);
    within.setReadBigInts(true);
    // candidates: the rest of a transaction split by an earlier page, then what follows
    let rows: any[] = cur.seq !== null ? (within.all(BigInt(cur.v), BigInt(cur.seq), BigInt(lim + 1)) as any[]) : [];
    if (rows.length < lim + 1) rows = rows.concat(rest.all(BigInt(cur.v), BigInt(lim + 1 - rows.length)) as any[]);

    const out: Array<{ c: WireChange; v: bigint; seq: bigint }> = [];
    let bytes = 0;
    let stop = -1; // the first candidate not taken
    for (let i = 0; i < rows.length; i++) {
      if (out.length >= lim) { stop = i; break; }
      const r = rows[i];
      const c: WireChange = [
        String(r.tbl),
        Buffer.from(r.pk as Uint8Array).toString("base64"),
        String(r.cid),
        encodeVal(r.val),
        toNum(r.col_version),
        toNum(r.db_version),
        hex(r.site_id),
        toNum(r.cl),
        toNum(r.seq),
      ];
      const size = JSON.stringify(c).length + 1;
      if (out.length && bytes + size > budget) { stop = i; break; }
      out.push({ c, v: r.db_version as bigint, seq: r.seq as bigint });
      bytes += size;
    }

    let page = out;
    let more = false;
    let next: Cursor;
    if (stop < 0) {
      next = { v: out.length ? Number(out[out.length - 1]!.v) : cur.v, seq: null };
    } else {
      more = true;
      const cut = rows[stop].db_version as bigint; // the first version not wholly in the page
      const whole = out.filter((x) => x.v < cut);
      if (whole.length) {
        page = whole;
        next = { v: Number(whole[whole.length - 1]!.v), seq: null };
      } else {
        // everything taken is one transaction that does not fit: split it by seq
        next = { v: Number(cut), seq: Number(out[out.length - 1]!.seq) };
      }
    }
    return {
      format: SYNC_FORMAT,
      site_id: String(head.site).toLowerCase(),
      since: formatCursor(cur),
      next: formatCursor(next),
      more,
      db_version: Number(head.v),
      count: page.length,
      changes: page.map((x) => x.c),
    };
  } finally {
    try { db.exec("COMMIT"); } catch { /* nothing to commit */ }
  }
}

/** Apply one page to a database: one transaction, the cursor written with it. */
export function applyChanges(db: DatabaseSync, changes: WireChange[], cursor: { key: string; value: string } | null): number {
  const crr = new Set<string>(CRR_TABLES);
  const ins = db.prepare(
    `INSERT INTO crsql_changes ("table", pk, cid, val, col_version, db_version, site_id, cl, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const c of changes) {
      const [table, pk, cid, val, colVersion, dbVersion, siteId, cl, seq] = c;
      if (!crr.has(table)) throw new Error(`change for a table that is not a CRR: ${table}`);
      ins.run(
        table,
        new Uint8Array(Buffer.from(pk, "base64")),
        cid,
        decodeVal(val) as any,
        BigInt(colVersion),
        BigInt(dbVersion),
        siteId ? new Uint8Array(Buffer.from(siteId, "hex")) : null,
        BigInt(cl),
        BigInt(seq)
      );
    }
    if (cursor) db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(cursor.key, cursor.value);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
  return changes.length;
}
