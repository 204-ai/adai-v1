// GET /api/sync/info, GET /api/sync/changes — the public CRDT sync: anyone
// can fork the commons by pulling cr-sqlite's change stream into a fresh
// database (npm run fork:pull) and stay up to date by pulling again.
//
// Unfiltered by design: the CRR tables only ever hold what the commons
// publishes (src/utils/signal-private.ts), and crsql_changes only covers the
// CRR tables — never a local one (tokens, emails, the review queue, the
// private side of signals, embeddings). As a last guard the stream is not
// served while the privacy migration has rows left to move (a database
// restored from before it, say): 503 until `npm run privacy:migrate`.
//
// Not the /api/graph stream (whose IndexedDB stamp is pinned): its own
// route, its own reads. No auth; rate-limited per client. PUBLIC_SYNC=off
// switches it off.

import { Router, type Request, type Response } from "express";
import { gzipSync } from "node:zlib";
import { getDb } from "../db.js";
import { JSON_HEADERS } from "../templates.js";
import { DEFAULT_LIMIT, MAX_LIMIT, parseCursor, readChanges, syncInfo } from "../sync/changes.js";
import { backlogTotal, privacyBacklog } from "../utils/signal-private.js";
import { clientIp } from "../intake/auth.js";

const router = Router();

const WINDOW_MS = 10 * 60_000;
const PER_WINDOW = 240; // a full pull of today's commons is ~25 pages at the max limit
const hits = new Map<string, { at: number; n: number }>();

function rateOk(req: Request): boolean {
  const key = clientIp(req) ?? "unknown";
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.at > WINDOW_MS) {
    hits.set(key, { at: now, n: 1 });
    if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.at > WINDOW_MS) hits.delete(k);
    return true;
  }
  h.n++;
  return h.n <= PER_WINDOW;
}

let backlogCheck: { at: number; total: number } | null = null;
function backlogClear(): boolean {
  const now = Date.now();
  if (!backlogCheck || now - backlogCheck.at > 60_000) backlogCheck = { at: now, total: backlogTotal(privacyBacklog(getDb())) };
  return backlogCheck.total === 0;
}
/** Tests and the migration CLI's in-process callers reset the cached check. */
export function resetSyncGuards(): void {
  backlogCheck = null;
  hits.clear();
}

const enabled = () => process.env.PUBLIC_SYNC !== "off";

function send(req: Request, res: Response, body: unknown, maxAge: number): void {
  const json = JSON.stringify(body);
  res.set({ ...JSON_HEADERS, "Cache-Control": `public, max-age=${maxAge}`, "Access-Control-Allow-Origin": "*", Vary: "Accept-Encoding" });
  if (/\bgzip\b/.test(String(req.headers["accept-encoding"] || "")) && json.length > 1024) {
    res.set("Content-Encoding", "gzip").send(gzipSync(json));
  } else {
    res.send(json);
  }
}

function guard(req: Request, res: Response): boolean {
  if (!enabled()) {
    res.status(404).set(JSON_HEADERS).json({ error: "sync is switched off here" });
    return false;
  }
  if (!rateOk(req)) {
    res.status(429).set({ ...JSON_HEADERS, "Retry-After": "60" }).json({ error: "rate_limited", hint: `at most ${PER_WINDOW} requests per ${WINDOW_MS / 60_000} minutes` });
    return false;
  }
  if (!backlogClear()) {
    res.status(503).set({ ...JSON_HEADERS, "Retry-After": "600" }).json({ error: "privacy_migration_pending", hint: "the operator has to run npm run privacy:migrate first" });
    return false;
  }
  return true;
}

router.get("/api/sync/info", (req, res) => {
  if (!guard(req, res)) return;
  send(req, res, { ...syncInfo(getDb()), changes: "/api/sync/changes?since=<db_version>&limit=<n>", default_limit: DEFAULT_LIMIT, max_limit: MAX_LIMIT }, 10);
});

router.get("/api/sync/changes", (req, res) => {
  const since = parseCursor(String(req.query.since ?? "0"));
  if (!since) {
    res.status(400).set(JSON_HEADERS).json({ error: "since must be a db_version (a non-negative integer; 0 = everything) or the `next` cursor of a page" });
    return;
  }
  const limitRaw = req.query.limit === undefined ? String(DEFAULT_LIMIT) : String(req.query.limit);
  if (!/^\d{1,6}$/.test(limitRaw) || Number(limitRaw) < 1) {
    res.status(400).set(JSON_HEADERS).json({ error: `limit must be 1..${MAX_LIMIT}` });
    return;
  }
  if (!guard(req, res)) return;
  // Synchronous (node:sqlite): one page is read and compressed before the
  // next request is looked at, so pages never pile up on the one core.
  const page = readChanges(getDb(), since, Math.min(MAX_LIMIT, Number(limitRaw)));
  send(req, res, page, page.more ? 30 : 5);
});

export default router;
