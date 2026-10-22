// CLI entry for the embedding derive pipeline.
//
//   npm run embed:derive       — chained centroids → derive (canonical)
//   npm run embed:centroids    — diagnostics only (embed:derive already runs it)
//   npm run embed:calibrate    — print similarity histograms against
//                                seed/_build/calibration_pairs.json
//   npm run embed:report-drift — JSON snapshot of the current similarity
//                                distribution vs the hard-coded τ thresholds.
//                                Designed for cron / GH Action logs so a human
//                                notices when re-tuning is warranted (we don't
//                                auto-recalibrate — that's how the graph
//                                silently changes shape).
//   npm run embed:backfill     — embed any node missing an identity vector
//                                (catches anything that slipped past the
//                                embed-on-write path in the contributor API)
//                                or holding one of another model (a model
//                                switch re-embeds everything; see provider.ts).
//                                Calls the embedding provider: GEMINI_API_KEY,
//                                or EMBED_API_KEY with EMBED_PROVIDER=openai.
//
// All commands read/write the live DB. Path resolution via resolveCliDbPath:
// explicit DB_PATH wins, otherwise /data/adai.db if present (Fly volume),
// falling back to ./adai.db for local dev. Without this guard the legacy
// `./adai.db` default silently creates an empty DB next to the bundle when
// invoked via `flyctl ssh console -C ...`. See src/utils/db-path.ts.

import { initDb } from "../db.js";
import { resolveCliDbPath } from "../utils/db-path.js";
import { computeCentroids } from "./centroids.js";
import { computeIslands } from "./islands.js";
import { derive } from "./derive.js";
import { loadAll, cosine } from "./vectors.js";
import { embedNodeNow } from "./server.js";
import { embedModel, embedProvider } from "./provider.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const dbPath = resolveCliDbPath();

// Hard-coded τ defaults — kept in sync with src/embed/derive.ts DEFAULTS.
// Imported as constants for the drift report (we want to compare the
// distribution against whatever values are currently shipped, not against
// runtime env overrides).
const TAU_DEFAULTS = {
  tau_attribute: 0.88,
  tau_kin: 0.91,
  tau_visual: 0.84,
} as const;

function parseEnvFloat(name: string, def?: number): number | undefined {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  if (Number.isNaN(n)) {
    console.error(`bad ${name}=${v} — must be a number`);
    process.exit(2);
  }
  return n;
}

function cmdCentroids() {
  const db = initDb(dbPath);
  const s = computeCentroids(db);
  console.log(JSON.stringify(s, null, 2));
}

function cmdDerive() {
  const db = initDb(dbPath);
  const tauAttribute = parseEnvFloat("TAU_ATTRIBUTE");
  const tauKin = parseEnvFloat("TAU_KIN");
  const tauVisual = parseEnvFloat("TAU_VISUAL");
  const kinTopK = parseEnvFloat("KIN_TOP_K");
  const visualTopK = parseEnvFloat("VISUAL_TOP_K");
  // Tier-2 concept-propagation knobs (only set keys that are present in env,
  // so unset ones fall back to CONCEPT_DEFAULTS rather than become undefined).
  const conceptEnv: Record<string, number> = {};
  const concPairs: Array<[string, string]> = [
    ["TAU_CONCEPT_COH", "tauCoherence"],
    ["CONCEPT_MIN_CREATORS", "minCreators"],
    ["CONCEPT_MIN_MEMBERS", "minMembers"],
    ["CONCEPT_KNN_K", "knnK"],
    ["CONCEPT_VOTE", "voteThreshold"],
    ["CONCEPT_MAX_PER", "maxPerConcept"],
  ];
  for (const [envName, key] of concPairs) {
    const v = parseEnvFloat(envName);
    if (v !== undefined) conceptEnv[key] = v;
  }
  const dryRun = process.argv.includes("--dry-run");
  const t0 = Date.now();
  const stats = derive(db, { tauAttribute, tauKin, tauVisual, kinTopK, visualTopK, dryRun, concept: conceptEnv });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`derive complete in ${dt}s${dryRun ? " (dry-run)" : ""}:`);
  console.log(JSON.stringify(stats, null, 2));

  // Latent islands for the /field macro-layout. Recomputed every run from the
  // same vectors; cheap (a few seconds) and deterministic. Env-tunable k.
  const kEnv = Number(process.env.ISLAND_K);
  const islandStats = computeIslands(db, {
    k: Number.isFinite(kEnv) && kEnv >= 2 ? Math.floor(kEnv) : undefined,
    dryRun,
  });
  console.log(`islands: k=${islandStats.k} over ${islandStats.n} nodes in ${islandStats.iters} iters; sizes ${JSON.stringify(islandStats.sizes)}`);

  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

interface CalibPair {
  positives: [string, string][];
  negatives: [string, string][];
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  if (p <= 0) return sorted[0]!;
  if (p >= 100) return sorted[sorted.length - 1]!;
  const idx = ((sorted.length - 1) * p) / 100;
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, sorted.length - 1);
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

function cmdCalibrate() {
  const db = initDb(dbPath);
  computeCentroids(db); // refresh first — same logic as derive
  const all = loadAll(db);
  const centroids = new Map<string, Float32Array>();
  const identities = new Map<string, Float32Array>();
  for (const [, v] of all) {
    if (v.kind === "style_centroid") centroids.set(v.node_id, v.vec);
    else if (v.kind === "identity") identities.set(v.node_id, v.vec);
  }
  console.log(`loaded ${identities.size} identity vectors, ${centroids.size} centroids`);

  const pairs: CalibPair = JSON.parse(
    readFileSync(join(PROJECT_ROOT, "seed", "_build", "calibration_pairs.json"), "utf-8")
  );

  function score(art: string, prac: string): number | null {
    const av = identities.get(art);
    const cv = centroids.get(prac);
    if (!av || !cv) return null;
    return cosine(av, cv);
  }

  const pos: number[] = [];
  const neg: number[] = [];
  for (const [a, p] of pairs.positives) {
    const s = score(a, p);
    if (s !== null) pos.push(s);
  }
  for (const [a, p] of pairs.negatives) {
    const s = score(a, p);
    if (s !== null) neg.push(s);
  }
  pos.sort((x, y) => x - y);
  neg.sort((x, y) => x - y);

  function summary(label: string, vals: number[]) {
    if (!vals.length) {
      console.log(`${label}: (empty)`);
      return;
    }
    console.log(
      `${label}  n=${vals.length}  min=${vals[0]!.toFixed(4)} ` +
        `med=${percentile(vals, 50).toFixed(4)} max=${vals[vals.length - 1]!.toFixed(4)}`
    );
  }

  console.log("\nτ_attribute — artwork ↔ practitioner style_centroid");
  summary("  POSITIVES", pos);
  summary("  NEGATIVES", neg);
  if (pos.length && neg.length) {
    const gapLo = neg[neg.length - 1]!;
    const gapHi = pos[0]!;
    if (gapHi > gapLo) {
      console.log(`  CLEAN GAP: τ_attribute ≈ ${((gapLo + gapHi) / 2).toFixed(4)}`);
    } else {
      console.log(
        `  OVERLAP: max(neg)=${gapLo.toFixed(4)} ≥ min(pos)=${gapHi.toFixed(4)}; ` +
          `τ_attribute ≈ ${percentile(pos, 50).toFixed(4)} (median of positives — precision-biased)`
      );
    }
  }

  // τ_kin: pairwise centroid distribution.
  const pracs = [...centroids.keys()];
  const kinSims: number[] = [];
  for (let i = 0; i < pracs.length; i++) {
    const a = centroids.get(pracs[i]!)!;
    for (let j = i + 1; j < pracs.length; j++) {
      kinSims.push(cosine(a, centroids.get(pracs[j]!)!));
    }
  }
  kinSims.sort((x, y) => x - y);
  console.log(`\nτ_kin — practitioner pairs (n=${kinSims.length})`);
  if (kinSims.length) {
    console.log(
      `  p50=${percentile(kinSims, 50).toFixed(4)}  p95=${percentile(kinSims, 95).toFixed(4)}  p99=${percentile(kinSims, 99).toFixed(4)}`
    );
    console.log(`  RECOMMEND τ_kin ≈ ${percentile(kinSims, 95).toFixed(4)} (top 5%)`);
  }

  // τ_visual: sampled artwork pairs (full pairwise is ~200K pairs, fine in JS).
  const arts = [...identities.keys()].filter((k) => k.startsWith("artwork:"));
  const sample = arts.slice(0, 200);
  const visSims: number[] = [];
  for (let i = 0; i < sample.length; i++) {
    const a = identities.get(sample[i]!)!;
    for (let j = i + 1; j < sample.length; j++) {
      visSims.push(cosine(a, identities.get(sample[j]!)!));
    }
  }
  visSims.sort((x, y) => x - y);
  console.log(`\nτ_visual — artwork pairs (sampled ${sample.length} → ${visSims.length} pairs)`);
  if (visSims.length) {
    console.log(
      `  p50=${percentile(visSims, 50).toFixed(4)}  p95=${percentile(visSims, 95).toFixed(4)}  p99=${percentile(visSims, 99).toFixed(4)}`
    );
    console.log(`  RECOMMEND τ_visual ≈ ${percentile(visSims, 99).toFixed(4)} (top 1%)`);
  }
}

function percentileOf(sorted: number[], value: number): number {
  // Returns the percentile of `value` in `sorted` (0–100). Used to ask
  // "where does our hard-coded τ sit in the current distribution?".
  if (!sorted.length) return NaN;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return (lo / sorted.length) * 100;
}

interface DriftBlock {
  value: number;
  percentile_in_current_distribution: number;
  p50: number;
  p95: number;
  p99: number;
}

function summariseDrift(sorted: number[], tau: number): DriftBlock {
  const round4 = (x: number) => Number(x.toFixed(4));
  if (!sorted.length) {
    return { value: tau, percentile_in_current_distribution: NaN, p50: NaN, p95: NaN, p99: NaN };
  }
  return {
    value: tau,
    percentile_in_current_distribution: Number(percentileOf(sorted, tau).toFixed(2)),
    p50: round4(sorted[Math.floor(sorted.length * 0.5)]!),
    p95: round4(sorted[Math.floor(sorted.length * 0.95)]!),
    p99: round4(sorted[Math.floor(sorted.length * 0.99)]!),
  };
}

function cmdReportDrift() {
  const db = initDb(dbPath);
  const all = loadAll(db);
  const centroids: Float32Array[] = [];
  const artworks: Float32Array[] = [];
  for (const [, v] of all) {
    if (v.kind === "style_centroid") centroids.push(v.vec);
    else if (v.kind === "identity" && v.node_id.startsWith("artwork:")) {
      artworks.push(v.vec);
    }
  }

  // Centroid pairwise (used for τ_kin). With ~150 centroids that's ~11k
  // pairs — full pairwise fits comfortably.
  const kinSims: number[] = [];
  for (let i = 0; i < centroids.length; i++) {
    for (let j = i + 1; j < centroids.length; j++) {
      kinSims.push(cosine(centroids[i]!, centroids[j]!));
    }
  }
  kinSims.sort((a, b) => a - b);

  // Artwork pairwise (used for τ_visual) — sample to stay under ~20K pairs.
  // Same N as cmdCalibrate (200) keeps the two surfaces comparable.
  const artSample = artworks.slice(0, 200);
  const visSims: number[] = [];
  for (let i = 0; i < artSample.length; i++) {
    for (let j = i + 1; j < artSample.length; j++) {
      visSims.push(cosine(artSample[i]!, artSample[j]!));
    }
  }
  visSims.sort((a, b) => a - b);

  // Artwork ↔ centroid (used for τ_attribute) — sample artworks against
  // every centroid to keep the cross-pairwise bounded.
  const attribSims: number[] = [];
  for (const av of artSample) {
    for (const cv of centroids) attribSims.push(cosine(av, cv));
  }
  attribSims.sort((a, b) => a - b);

  const report = {
    timestamp: new Date().toISOString(),
    db_path: dbPath,
    counts: {
      style_centroids: centroids.length,
      artwork_vectors: artworks.length,
      kin_pairs_scored: kinSims.length,
      visual_pairs_scored: visSims.length,
      attribute_pairs_scored: attribSims.length,
      artwork_sample_size: artSample.length,
    },
    thresholds: TAU_DEFAULTS,
    drift: {
      tau_kin: summariseDrift(kinSims, TAU_DEFAULTS.tau_kin),
      tau_visual: summariseDrift(visSims, TAU_DEFAULTS.tau_visual),
      tau_attribute: summariseDrift(attribSims, TAU_DEFAULTS.tau_attribute),
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

async function cmdBackfill() {
  const db = initDb(dbPath);
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Math.max(0, Number(limitArg.split("=")[1]) || 0) : 0;
  const rows = db
    .prepare(
      `SELECT n.id FROM nodes n
       WHERE n.type IN ('artwork','practitioner','collective','concept','scene')
         AND json_extract(n.metadata,'$.retired') IS NOT 1
         AND NOT EXISTS (
           SELECT 1 FROM node_embeddings ne
           WHERE ne.node_id = n.id AND ne.kind = 'identity' AND ne.model = ?
         )
       ORDER BY n.id`
    )
    .all(embedModel()) as Array<{ id: string }>;

  const targets = limit > 0 ? rows.slice(0, limit) : rows;
  console.log(`backfill (${embedProvider()} / ${embedModel()}): ${targets.length} nodes missing a current-model identity vector${limit > 0 ? ` (limit=${limit})` : ""}`);

  let ok = 0;
  let skipped = 0;
  let err = 0;
  const t0 = Date.now();
  for (const r of targets) {
    const result = await embedNodeNow(db, r.id);
    if (result.status === "embedded") {
      ok++;
    } else if (result.status === "error") {
      err++;
      console.error(`  [err] ${r.id}: ${result.detail}`);
    } else {
      skipped++;
    }
    if ((ok + skipped + err) % 25 === 0) {
      console.log(`  [${ok + skipped + err}/${targets.length}] ok=${ok} skipped=${skipped} err=${err}`);
    }
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`backfill complete in ${dt}s: embedded=${ok} skipped=${skipped} errors=${err}`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  if (err > 0) process.exit(1);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case "derive":
      cmdDerive();
      break;
    case "centroids":
      cmdCentroids();
      break;
    case "calibrate":
      cmdCalibrate();
      break;
    case "report-drift":
      cmdReportDrift();
      break;
    case "backfill":
      await cmdBackfill();
      break;
    default:
      console.error(
        "usage: tsx src/embed/cli.ts {derive|centroids|calibrate|report-drift|backfill} [--dry-run] [--limit=N]\n" +
          "  derive          runs centroids first by default.\n" +
          "  backfill        embeds every node missing a current-model identity vector (--limit=N to cap)."
      );
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
