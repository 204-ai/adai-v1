// Who a signal belongs to — the one place that decides it.
//
// signals.submitted_by is a display name, and the public form
// (POST /api/contribute) lets anyone type any name. So ownership — whose
// history lists a signal, whose counters it adds to, whose node its byline
// links to, whose name a rename rewrites — is never taken from it alone:
//
//   1. its authenticated author (signal_authors, recorded by insertSignal
//      for every authenticated write);
//   2. a public-form submission approved into a contributor row of its own
//      (form_signals: signal → its 'form' row, recorded at approval);
//   3. FORM-SHAPED and neither of the above — a plain contribution with no
//      batch id (the form never sets one; an anonymous signal's batch id is
//      looked up on the private side) — belongs to no one;
//   4. otherwise a LEGACY write (an /api/v1 write from before signal_authors
//      existed): by its name, only when exactly one non-form contributor has
//      that name (or id) — ambiguous history stays unowned.

import type { DatabaseSync } from "node:sqlite";

const has = (db: DatabaseSync, t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

/**
 * SQL: whether signal alias `s` is form-shaped (rule 3, before the author /
 * form-row checks). Shared by every query that needs it.
 */
export function formShapedSql(s = "s"): string {
  return `(COALESCE(${s}.source_type, 'contribution') = 'contribution'
    AND COALESCE((SELECT fp.batch_id FROM signal_private fp WHERE fp.signal_id = ${s}.id), ${s}.batch_id) IS NULL)`;
}

/**
 * SQL: whether signal alias `s` belongs to the contributor bound as
 * `:owner_id` (display name `:owner_name`) — rules 1, 2 and 4.
 */
export function ownedBySql(s = "s"): string {
  return `(EXISTS (SELECT 1 FROM signal_authors oa WHERE oa.signal_id = ${s}.id AND oa.contributor_id = :owner_id)
    OR EXISTS (SELECT 1 FROM form_signals ofs WHERE ofs.signal_id = ${s}.id AND ofs.contributor_id = :owner_id)
    OR (NOT EXISTS (SELECT 1 FROM signal_authors oa2 WHERE oa2.signal_id = ${s}.id)
        AND NOT EXISTS (SELECT 1 FROM form_signals ofs2 WHERE ofs2.signal_id = ${s}.id)
        AND NOT ${formShapedSql(s)}
        AND (${s}.submitted_by = :owner_name OR ${s}.submitted_by = :owner_id)
        AND (SELECT COUNT(*) FROM contributors ok WHERE (ok.name = ${s}.submitted_by OR ok.id = ${s}.submitted_by) AND ok.type IS NOT 'form') = 1))`;
}

/** Whether a signal is a public-form submission without a recorded author (rule 3 territory). */
export function isFormShaped(db: DatabaseSync, signalId: string | null | undefined): boolean {
  if (!signalId) return false;
  if (has(db, "signal_authors") && db.prepare("SELECT 1 FROM signal_authors WHERE signal_id = ?").get(signalId)) return false;
  return !!db.prepare(`SELECT 1 FROM signals s WHERE s.id = ? AND ${formShapedSql("s")}`).get(signalId);
}

/** The contributor a signal belongs to, and how that is known; null when it belongs to no one provably. */
export function signalOwner(db: DatabaseSync, signalId: string | null | undefined): { id: string; how: "author" | "form" | "legacy" } | null {
  if (!signalId) return null;
  if (has(db, "signal_authors")) {
    const a = (db.prepare("SELECT contributor_id FROM signal_authors WHERE signal_id = ?").get(signalId) as any)?.contributor_id;
    if (a) return { id: a, how: "author" };
  }
  if (has(db, "form_signals")) {
    const f = (db.prepare("SELECT contributor_id FROM form_signals WHERE signal_id = ?").get(signalId) as any)?.contributor_id;
    if (f) return { id: f, how: "form" };
  }
  const s = db.prepare(`SELECT s.submitted_by, ${formShapedSql("s")} AS form FROM signals s WHERE s.id = ?`).get(signalId) as any;
  if (!s || s.form || !s.submitted_by) return null;
  const k = db.prepare("SELECT id FROM contributors WHERE (name = ? OR id = ?) AND type IS NOT 'form'").all(s.submitted_by, s.submitted_by) as any[];
  return k.length === 1 ? { id: k[0].id, how: "legacy" } : null;
}

/** Record that an approved public-form signal belongs to its own form row. */
export function recordFormSignal(db: DatabaseSync, signalId: string, contributorId: string): void {
  db.prepare("INSERT OR REPLACE INTO form_signals (signal_id, contributor_id) VALUES (?, ?)").run(signalId, contributorId);
}
