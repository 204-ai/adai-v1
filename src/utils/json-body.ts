// The app-wide JSON body parser (src/index.ts) and the routes it must leave
// alone. 16 MB fits base64 image uploads on /api/v1/images; routes whose
// bodies are a sentence or two declare their own tight parser (64 KB) at the
// router level — but a body the generous parser already consumed never
// reaches it, so those paths are skipped here. Kept in one place so a test
// can mount it exactly as production does.

import express, { type RequestHandler } from "express";

export const TIGHT_JSON_PREFIXES = [
  "/api/archivist/", "/api/intake/", "/internal/", "/api/claims", "/api/me/", "/api/review/access/",
  // readings (#80): any contributor, so the tight cap matters
  "/api/readings", "/api/v1/readings",
];

export function generousJsonUnlessTight(limit = "16mb"): RequestHandler {
  const generous = express.json({ limit });
  return (req, res, next) => {
    // Express routes case-insensitively (/API/V1/READINGS reaches the readings
    // router), so the exclusion must too.
    const path = req.path.toLowerCase();
    if (TIGHT_JSON_PREFIXES.some((p) => path.startsWith(p))) return next();
    return generous(req, res, next);
  };
}
