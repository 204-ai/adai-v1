import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { initDb } from "./db.js";
import pageRoutes from "./routes/pages.js";
import whitepaperRoutes from "./routes/whitepaper.js";
import apiRoutes from "./routes/api.js";
import contributorApiRoutes from "./routes/contributor-api.js";
import archivistRoutes from "./routes/archivist.js";
import intakeRoutes from "./routes/intake.js";
import claimRoutes from "./routes/claim.js";
import offlineRoutes from "./routes/offline.js";
import internalRoutes, { workerKey } from "./routes/internal.js";
import { startSpawnerInterval, isSpawnerConfigured } from "./intake/spawn.js";
import { isSessionConfigured } from "./intake/auth.js";
import { getDb } from "./db.js";
import { backfillInviteClaims } from "./claim/store.js";
import { htmlPage, HTML_HEADERS } from "./templates.js";
import { isStaging, publicSwitches, stagingBanner } from "./utils/staging.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env into process.env when present. Node ≥20.6 ships
// `process.loadEnvFile()` natively. On Fly, R2_* and friends come from
// `flyctl secrets`, so no .env is needed and the missing-file path below
// is the expected one. We do this BEFORE anything else so the R2 client
// (and the DB_PATH override) see the values.
const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
    console.log("[env] loaded .env");
  } catch (e: any) {
    console.warn("[env] failed to load .env:", e?.message ?? e);
  }
}

const dbPath = process.env.DB_PATH || "adai.db";
const port = parseInt(process.env.PORT || "8080", 10);

console.log("Setting database path:", dbPath);
initDb(dbPath);
console.log("Database initialized.");
{
  // Every invite that named a node is an approved claim (docs/CLAIM-SPEC.md §1.1).
  const n = backfillInviteClaims(getDb());
  if (n) console.log(`[claims] ${n} invite(s) became approved claims`);
}

const app = express();
// 12 MB matches the multer cap on /api/v1/images and gives base64 payloads
// (4/3 size of the raw bytes) plus a small envelope room. The archivist
// chat endpoint is unauthenticated, so it skips this generous cap and
// declares its own tight one at the router level — otherwise an attacker
// could amplify a single POST into 16 MB of JSON parsing per request
// before hitting the rate-limit gate.
const generousJson = express.json({ limit: "16mb" });
app.use((req, res, next) => {
  if (req.path.startsWith("/api/archivist/") || req.path.startsWith("/api/intake/") || req.path.startsWith("/internal/") ||
      req.path.startsWith("/api/claims") || req.path.startsWith("/api/me/") || req.path.startsWith("/api/review/access/")) return next();
  return generousJson(req, res, next);
});

// Staging (src/utils/staging.ts): kept out of search engines, every HTML
// response carries the switch bar, /api/staging reports the switches.
if (isStaging()) {
  console.log("[staging] switches:", JSON.stringify(publicSwitches()));
  app.use((_req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    const send = res.send.bind(res);
    res.send = (body?: any) => {
      if (typeof body === "string" && /^text\/html/i.test(String(res.getHeader("Content-Type") ?? "text/html")) && body.includes("</body>")) {
        body = body.replace(/<\/body>(?![\s\S]*<\/body>)/, `${stagingBanner()}</body>`);
      }
      return send(body);
    };
    next();
  });
  app.get("/robots.txt", (_req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /\n"));
  app.get("/api/staging", (_req, res) => res.json({ env: "staging", switches: publicSwitches() }));
}

// /field-static serves the public/field tree (p5-derived data-driven graph view).
// Mounted before route handlers so /field-static/* never reaches the page router.
const STATIC_DIR = path.join(__dirname, "..", "public", "field");

// Content-Type for the text assets we pre-compress. We set this explicitly when
// streaming a .br/.gz sibling — otherwise `send` would type it from the sibling's
// own extension (.br → application/octet-stream) and break execution.
const PRECOMPRESS_TYPE: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

// Long-cache `?v=`-busted assets in production only. Unversioned assets under
// /field-static (skill markdown, font files referenced from CSS) must revalidate
// so a deploy can update them. Dev always serves no-cache so edits are live.
const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE_CONTROL = "no-cache";
function assetCacheControl(req: express.Request) {
  if (process.env.NODE_ENV !== "production") return REVALIDATE_CACHE_CONTROL;
  const v = req.query.v;
  const hasVersion = Array.isArray(v) ? v.some(Boolean) : Boolean(v);
  return hasVersion ? IMMUTABLE_ASSET_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
}

app.use("/field-static", (req, res, next) => {
  res.setHeader("Cache-Control", assetCacheControl(req));
  next();
});

// Serve pre-compressed siblings (scripts/precompress.mjs bakes graph-field.js.br
// etc. at Docker build time) with ZERO per-request CPU. Brotli preferred, gzip
// fallback. Falls through to plain express.static when no sibling exists (local
// dev, or an asset type we don't pre-compress) so behaviour is identical there.
// Versioned /field-static URLs are cached immutably; unversioned URLs revalidate.
app.use("/field-static", (req, res, next) => {
  if (req.method !== "GET") return next();
  const rel = path.normalize(req.path);
  if (rel.includes("..")) return next();
  const baseExt = path.extname(rel).toLowerCase();
  const ctype = PRECOMPRESS_TYPE[baseExt];
  if (!ctype) return next();

  const accept = String(req.headers["accept-encoding"] || "");
  const enc = /\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : null;
  if (!enc) return next();

  const target = path.join(STATIC_DIR, rel + (enc === "br" ? ".br" : ".gz"));
  if (!target.startsWith(STATIC_DIR) || !fs.existsSync(target)) return next();

  res.setHeader("Content-Type", ctype);
  res.setHeader("Content-Encoding", enc);
  res.setHeader("Vary", "Accept-Encoding");
  res.setHeader("Cache-Control", assetCacheControl(req));
  fs.createReadStream(target).on("error", () => next()).pipe(res);
});

app.use(
  "/field-static",
  express.static(STATIC_DIR, {
    setHeaders(res, filePath) {
      // HTML (e.g. brand.html) isn't fingerprinted — must revalidate. Other
      // assets keep the Cache-Control chosen by the middleware above: immutable
      // only for production requests with a `?v=` cache buster.
      if (/\.html?$/i.test(filePath)) {
        res.setHeader("Cache-Control", REVALIDATE_CACHE_CONTROL);
      } else {
        // Matches the precompress branch's Vary so a shared cache (none today,
        // but if a CDN is ever fronted) can't hand a br client this plain copy.
        if (PRECOMPRESS_TYPE[path.extname(filePath).toLowerCase()]) {
          res.setHeader("Vary", "Accept-Encoding");
        }
      }
    },
  })
);

// mount routes. The URL intake owns /contribute, /draft/:id, /batch/:id and
// /auth/:token, so it goes before the page router. /internal/* (worker
// surface) is mounted ONLY when WORKER_KEY is set (>=16 chars).
app.use(intakeRoutes);
// Claims, /@handle, /me (docs/CLAIM-SPEC.md).
app.use(claimRoutes);
app.use(offlineRoutes);
if (workerKey()) {
  app.use(internalRoutes);
  console.log("[intake] /internal/intake/* mounted");
} else {
  console.log("[intake] WORKER_KEY unset — worker surface not mounted");
}
if (!isSessionConfigured()) console.log("[intake] SESSION_SECRET unset — magic-link login disabled");
if (isSpawnerConfigured()) {
  startSpawnerInterval(getDb());
  console.log("[intake] spawner interval running");
} else {
  console.log("[intake] spawner not configured (WORKER_IMAGE / FLY_API_TOKEN) — run the worker locally");
}
app.use(whitepaperRoutes);
app.use(pageRoutes);
app.use(apiRoutes);
app.use(contributorApiRoutes);
app.use(archivistRoutes);

// 404 fallback
app.use((_req, res) => {
  res.status(404).set(HTML_HEADERS).send(htmlPage("Not Found", "<h2>404</h2><p>Page not found.</p>"));
});

app.listen(port, () => {
  console.log(`A(DAI) server starting on port ${port}`);
});
