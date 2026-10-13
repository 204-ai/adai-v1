// The works a collection holds (artwork → HELD_BY → institution), each with
// its year, image and makers — for the institution's entity view and record.

import type { DatabaseSync } from "node:sqlite";
import { notRetired } from "./visibility.js";
import { formatArtworkYear, YEAR_SQL_FRAGMENT } from "./year.js";

export interface HeldWork {
  id: string;
  name: string;
  slug: string;
  type: string;
  year: string | null;
  image: string | null;
  artists: Array<{ id: string; name: string; slug: string; type: string }>;
}

const isHttp = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);

export function heldWorks(db: DatabaseSync, institutionId: string): HeldWork[] {
  const works = db.prepare(
    `SELECT DISTINCT w.id, w.name, w.slug, w.type,
            json_extract(w.metadata,'$.cdn_image_url') AS cdn_image_url,
            json_extract(w.metadata,'$.image_url') AS image_url,
            ${YEAR_SQL_FRAGMENT.replace(/metadata/g, "w.metadata")}
       FROM edges h JOIN nodes w ON w.id = h.source_id AND ${notRetired("w")}
      WHERE h.target_id = ? AND h.edge_type = 'HELD_BY' AND h.valid_until IS NULL
      ORDER BY w.name COLLATE NOCASE`
  ).all(institutionId) as any[];
  if (!works.length) return [];
  const makers = db.prepare(
    `SELECT c.source_id AS work, n.id, n.name, n.slug, n.type
       FROM edges c JOIN nodes n ON n.id = c.target_id AND ${notRetired("n")}
      WHERE c.edge_type = 'CREATED_BY' AND c.valid_until IS NULL
        AND (c.created_by IS NULL OR c.created_by != 'embedding-multimodal-v1')
        AND c.source_id IN (SELECT source_id FROM edges WHERE target_id = ? AND edge_type = 'HELD_BY' AND valid_until IS NULL)
      ORDER BY n.name`
  ).all(institutionId) as any[];
  const byWork = new Map<string, HeldWork["artists"]>();
  for (const m of makers) {
    const list = byWork.get(m.work) ?? [];
    if (!list.some((a) => a.id === m.id)) list.push({ id: m.id, name: m.name, slug: m.slug, type: m.type });
    byWork.set(m.work, list);
  }
  return works.map((w) => ({
    id: w.id, name: w.name, slug: w.slug, type: w.type,
    year: formatArtworkYear(w),
    image: isHttp(w.cdn_image_url) ? w.cdn_image_url : isHttp(w.image_url) ? w.image_url : null,
    artists: byWork.get(w.id) ?? [],
  }));
}
