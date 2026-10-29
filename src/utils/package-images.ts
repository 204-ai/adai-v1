// Images that travel with a package node (POST /api/v1/packages `image_url`).
//
// An image never decides the fate of a package: a bad URL or a failed fetch is
// a warning / a recorded failure, the node still goes in.
//
//  - reviewed / auto: mirrored right after validation (`mirrorPackageImages`),
//    before the write transaction (network stays outside it).
//  - probationary: the queued item carries
//    { op: 'attach_image', node_id, image_url } with NO cdn_image_url yet.
//    Nothing is fetched while the item waits (a rejected package costs no
//    fetch and no R2 write). `mirrorQueuedImages` runs just before approval
//    (approveIntakeItem is synchronous, so the network step is separate),
//    fills cdn_image_url / sha256, or turns the op into
//    { op: 'image_failed', node_id, image_url, image_error }; approval attaches
//    what was mirrored and ignores the rest.
//
// The fetch itself is mirrorImageFromUrl — the code behind POST /api/v1/images
// `image_url` (SSRF guard, 20 MiB cap, magic-byte sniff, R2 upload).

import type { DatabaseSync } from "node:sqlite";
import { mirrorImageFromUrl, type MirroredImage } from "./images.js";

export const IMAGE_URL_MAX_LENGTH = 2048;
// Parallel fetches per call: a package holds up to 100 nodes.
export const IMAGE_FETCH_CONCURRENCY = 4;

let mirrorFn: (url: string) => Promise<MirroredImage> = mirrorImageFromUrl;
/** Test hook: replace the network fetch + R2 upload. Returns the previous one. */
export function setImageMirrorForTests(fn: ((url: string) => Promise<MirroredImage>) | null) {
  const prev = mirrorFn;
  mirrorFn = fn ?? mirrorImageFromUrl;
  return prev;
}

/** Up-front check: a string, https only, no credentials, bounded length. SSRF
 *  (private hosts, redirects) is enforced at fetch time by safeFetch. */
export function checkPackageImageUrl(v: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof v !== "string" || !v.trim()) return { ok: false, error: "image_url must be a non-empty string" };
  const s = v.trim();
  if (s.length > IMAGE_URL_MAX_LENGTH) return { ok: false, error: `image_url is longer than ${IMAGE_URL_MAX_LENGTH} characters` };
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, error: "image_url is not a valid URL" }; }
  if (u.protocol !== "https:") return { ok: false, error: "image_url must be https" };
  if (u.username || u.password) return { ok: false, error: "image_url must not carry credentials" };
  if (!u.hostname) return { ok: false, error: "image_url has no host" };
  return { ok: true, url: s };
}

export type ImageJob = { node_id: string; image_url: string };
export type ImageOutcome =
  | { ok: true; node_id: string; image_url: string; mirrored: MirroredImage }
  | { ok: false; node_id: string; image_url: string; error: string };

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

function describe(e: any): string {
  return `${e?.code ? `${e.code}: ` : ""}${e?.message ?? String(e)}`;
}

/** Fetch and mirror each job; never throws. */
export async function mirrorPackageImages(jobs: ImageJob[]): Promise<ImageOutcome[]> {
  return pool(jobs, IMAGE_FETCH_CONCURRENCY, async (j): Promise<ImageOutcome> => {
    try {
      return { ok: true, node_id: j.node_id, image_url: j.image_url, mirrored: await mirrorFn(j.image_url) };
    } catch (e: any) {
      return { ok: false, node_id: j.node_id, image_url: j.image_url, error: describe(e) };
    }
  });
}

/**
 * Before approving a queued item: mirror every attach_image op that still has
 * only an image_url, and store the result on the op (cdn_image_url + sha256, or
 * image_error). Returns warnings for the ones that failed. Never throws; an
 * item without such ops is untouched and costs no query beyond one SELECT.
 */
export async function mirrorQueuedImages(db: DatabaseSync, intakeId: string): Promise<string[]> {
  const row = db.prepare("SELECT proposed_nodes FROM intake_queue WHERE id = ? AND status = 'pending'").get(intakeId) as any;
  if (!row?.proposed_nodes) return [];
  let ops: any[];
  try { ops = JSON.parse(row.proposed_nodes); } catch { return []; }
  if (!Array.isArray(ops)) return [];
  const todo = ops.filter((o) => o?.op === "attach_image" && !o.cdn_image_url && typeof o.image_url === "string");
  if (!todo.length) return [];
  const results = await mirrorPackageImages(todo.map((o) => ({ node_id: String(o.node_id), image_url: o.image_url })));
  const warnings: string[] = [];
  todo.forEach((o, i) => {
    const r = results[i]!;
    if (r.ok) {
      o.cdn_image_url = r.mirrored.upload.url;
      o.sha256 = r.mirrored.upload.sha256;
    } else {
      // Not an attach_image any more: nothing downstream (history, activity,
      // notifications, snapshot) should read it as "an image was added".
      o.op = "image_failed";
      o.image_error = r.error;
      warnings.push(`image for ${o.node_id} not attached: ${r.error}`);
    }
  });
  db.prepare("UPDATE intake_queue SET proposed_nodes = ? WHERE id = ? AND status = 'pending'").run(JSON.stringify(ops), intakeId);
  return warnings;
}

/** Warnings an approved item left behind (for the approve responses). */
export function queuedImageFailures(db: DatabaseSync, intakeId: string): string[] {
  const row = db.prepare("SELECT proposed_nodes FROM intake_queue WHERE id = ?").get(intakeId) as any;
  if (!row?.proposed_nodes) return [];
  try {
    return (JSON.parse(row.proposed_nodes) as any[])
      .filter((o) => o?.op === "image_failed")
      .map((o) => `image for ${o.node_id} not attached: ${o.image_error}`);
  } catch { return []; }
}
