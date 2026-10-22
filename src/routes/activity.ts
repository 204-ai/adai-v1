// GET /api/activity — the live activity feed (issue #83, src/utils/activity.ts).
// Its own endpoint, like /api/contested: deliberately off the cached graph
// stream, whose stamp only tracks node / relation counts.
//
//   200 {enabled: false, events: []}        the feed is switched off
//   200 {enabled: true, window_hours, events: [...]}   newest first, ?limit= ≤ 20

import { Router } from "express";
import { getDb } from "../db.js";
import { JSON_HEADERS } from "../templates.js";
import { activityEnabled, recentActivity, ACTIVITY_DEFAULT_LIMIT, ACTIVITY_WINDOW_HOURS } from "../utils/activity.js";

const router = Router();

router.get("/api/activity", (req, res) => {
  const db = getDb();
  // An old answer is the one thing this feed must never show. Never cached outside: the server keeps its own 25 s cache (re-filtered by
  // the window), so a browser or proxy can never hold an old answer
  res.set({ ...JSON_HEADERS, "Cache-Control": "no-store" });
  if (!activityEnabled(db)) {
    res.json({ enabled: false, events: [] });
    return;
  }
  const n = Number.parseInt(String(req.query.limit ?? ""), 10);
  const events = recentActivity(db, { limit: Number.isFinite(n) ? n : ACTIVITY_DEFAULT_LIMIT });
  res.json({
    enabled: true,
    window_hours: ACTIVITY_WINDOW_HOURS,
    events: events.map((e) => ({
      at: e.at,
      kind: e.kind,
      count: e.count,
      text: e.text,
      id: e.node?.id ?? null,
      href: e.node ? `/${encodeURIComponent(e.node.type)}/${encodeURIComponent(e.node.slug)}` : null,
    })),
  });
});

export default router;
