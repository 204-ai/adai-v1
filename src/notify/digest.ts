// Review-queue email digest.
//
// A scheduled GitHub Action (.github/workflows/notify-digest.yml) wakes the
// Fly machine and runs `node /app/dist/cli/notify-digest.js` against the live
// /data/adai.db. This module is the reusable core: it reads the pending
// `intake_queue`, renders a digest email, and sends it via the Resend HTTP API
// (global fetch on Node 22 — no SMTP, no npm dependency).
//
// Design notes
// ------------
//  - "New since last run" gating. We persist the last successful-send time in
//    settings(last_review_digest_at). Each run counts items whose created_at
//    is newer than that marker and only sends when something is new (or
//    --force). This stops a static backlog from re-emailing every day.
//      ⚠️ Caveat: embed:derive DELETEs + re-INSERTs its ai_suggestion intake
//      rows nightly (see src/embed/derive.ts), so those created_at timestamps
//      reset each night and the AI portion reads as "fresh" daily. That's
//      acceptable: the digest runs after the 04:00 derive and reports that
//      night's standing AI proposals. Human contributions have stable
//      created_at, so their dedup is exact.
//  - Race-free marker. We capture `now` once at the start, count fresh items
//    as created_at > previousMarker (no upper bound), then advance the marker
//    to that captured `now` only on a successful send. Rows written during the
//    run land after `now` and are caught by the next digest — no gap, no
//    double count.
//  - Config posture. Missing config is tolerated in --dry-run (so a preview
//    works before secrets exist) but is a hard error on a real send.

import { sendMail } from "../utils/mail.js";
import type { DatabaseSync } from "node:sqlite";

const MARKER_KEY = "last_review_digest_at";
const EPOCH = "1970-01-01T00:00:00Z";
const DEFAULT_BASE_URL = "https://adai-basel.fly.dev";

// Human-friendly labels for the intake `kind` discriminator.
const KIND_LABEL: Record<string, string> = {
  human_signal: "Human contributions",
  ai_suggestion: "AI suggestions",
};

export class ConfigError extends Error {}

export interface DigestItem {
  intake_id: string;
  kind: string;
  submitted_by: string;
  trust_tier: string;
  title: string | null;
  target_node: string | null;
  batch_id: string | null;
  created_at: string;
  fresh: boolean;
}

export interface KindSummary {
  kind: string;
  label: string;
  total: number; // all pending of this kind
  fresh: number; // pending newer than the last marker
  samples: DigestItem[];
}

export interface Digest {
  generatedAt: string;
  since: string; // previous marker ('' / epoch on first run)
  totalPending: number;
  freshPending: number;
  byKind: KindSummary[];
  oldestPendingAt: string | null;
}

export interface NotifyConfig {
  apiKey: string | null;
  from: string;
  recipients: string[];
  baseUrl: string;
}

export interface RunOptions {
  dryRun?: boolean;
  force?: boolean;
  perKindLimit?: number;
  baseUrl?: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface RunResult {
  sent: boolean;
  reason: "sent" | "nothing_new" | "dry_run";
  digest: Digest;
  recipients: string[];
  messageId?: string;
  rendered?: RenderedEmail;
}

// ----- config ---------------------------------------------------------------

export function getNotifyConfig(baseUrlDefault = DEFAULT_BASE_URL): NotifyConfig {
  const apiKey = process.env.RESEND_API_KEY || null;
  // onboarding@resend.dev is Resend's shared test sender — it only delivers to
  // the Resend account owner's own address, which is enough to get the digest
  // working before a custom domain is verified. Set RESEND_FROM for a real
  // sending domain.
  const from = process.env.RESEND_FROM || "A(DAI) Review <onboarding@resend.dev>";
  const recipients = (process.env.ADMIN_NOTIFY_EMAILS || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const baseUrl = (process.env.ADAI_BASE_URL || baseUrlDefault).replace(/\/+$/, "");
  return { apiKey, from, recipients, baseUrl };
}

export function configErrors(cfg: NotifyConfig): string[] {
  const missing: string[] = [];
  if (!cfg.apiKey) missing.push("RESEND_API_KEY");
  if (!cfg.recipients.length) missing.push("ADMIN_NOTIFY_EMAILS");
  return missing;
}

// ----- marker (settings table) ---------------------------------------------

function readMarker(db: DatabaseSync): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(MARKER_KEY) as
    | { value: string }
    | undefined;
  return row?.value || EPOCH;
}

function writeMarker(db: DatabaseSync, ts: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(MARKER_KEY, ts);
}

// ----- build ----------------------------------------------------------------

export function buildDigest(
  db: DatabaseSync,
  opts: { lastTs: string; perKindLimit: number }
): Digest {
  const { lastTs, perKindLimit } = opts;

  // Counts per kind: total pending + how many are newer than the marker.
  const counts = db
    .prepare(
      `SELECT kind,
              COUNT(*) AS total,
              SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS fresh
         FROM intake_queue
        WHERE status = 'pending'
        GROUP BY kind
        ORDER BY kind`
    )
    .all(lastTs) as Array<{ kind: string; total: number; fresh: number }>;

  const oldestRow = db
    .prepare("SELECT MIN(created_at) AS oldest FROM intake_queue WHERE status = 'pending'")
    .get() as { oldest: string | null };

  const byKind: KindSummary[] = counts.map((c) => {
    const samples = db
      .prepare(
        `SELECT q.id AS intake_id, q.kind, q.submitted_by, q.trust_tier,
                q.created_at, q.target_node,
                s.title AS title, s.batch_id AS batch_id
           FROM intake_queue q
           LEFT JOIN signals_full s ON s.id = q.signal_id
          WHERE q.status = 'pending' AND q.kind = ?
          ORDER BY (q.created_at > ?) DESC, q.created_at DESC
          LIMIT ?`
      )
      .all(c.kind, lastTs, perKindLimit) as Array<Omit<DigestItem, "fresh">>;

    return {
      kind: c.kind,
      label: KIND_LABEL[c.kind] || c.kind,
      total: c.total,
      fresh: c.fresh,
      samples: samples.map((s) => ({ ...s, fresh: s.created_at > lastTs })),
    };
  });

  const totalPending = byKind.reduce((n, k) => n + k.total, 0);
  const freshPending = byKind.reduce((n, k) => n + k.fresh, 0);

  return {
    generatedAt: "",
    since: lastTs === EPOCH ? "" : lastTs,
    totalPending,
    freshPending,
    byKind,
    oldestPendingAt: oldestRow.oldest ?? null,
  };
}

// ----- render ---------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function itemLine(it: DigestItem): string {
  const bits = [it.submitted_by];
  if (it.title) bits.push(`“${it.title}”`);
  if (it.target_node) bits.push(`→ ${it.target_node}`);
  if (it.batch_id) bits.push(`[batch ${it.batch_id}]`);
  bits.push(`(${it.created_at})`);
  return bits.join("  ");
}

export function renderDigest(d: Digest, cfg: NotifyConfig): RenderedEmail {
  const human = d.byKind.find((k) => k.kind === "human_signal");
  const ai = d.byKind.find((k) => k.kind === "ai_suggestion");
  const freshHuman = human?.fresh ?? 0;
  const freshAi = ai?.fresh ?? 0;

  const subject =
    d.freshPending > 0
      ? `[A(DAI)] ${d.freshPending} new in review queue` +
        (freshHuman || freshAi ? ` (${freshHuman} human, ${freshAi} AI)` : "")
      : `[A(DAI)] Review queue: ${d.totalPending} pending`;

  const reviewUrl = `${cfg.baseUrl}/review`;

  // ----- plain text -----
  const textLines: string[] = [];
  textLines.push(
    d.freshPending > 0
      ? `${d.freshPending} new item(s) are awaiting review (${d.totalPending} pending in total).`
      : `${d.totalPending} item(s) pending review (none new since last digest).`
  );
  if (d.since) textLines.push(`New since: ${d.since}`);
  if (d.oldestPendingAt) textLines.push(`Oldest pending: ${d.oldestPendingAt}`);
  textLines.push("");
  for (const k of d.byKind) {
    textLines.push(`${k.label}: ${k.total} pending (${k.fresh} new)`);
    for (const it of k.samples) {
      textLines.push(`  ${it.fresh ? "•" : "·"} ${itemLine(it)}`);
    }
    if (k.total > k.samples.length) {
      textLines.push(`  … and ${k.total - k.samples.length} more`);
    }
    textLines.push("");
  }
  textLines.push(`Review queue: ${reviewUrl}`);
  const text = textLines.join("\n");

  // ----- html -----
  const htmlParts: string[] = [];
  htmlParts.push(
    `<p style="margin:0 0 4px"><strong>${
      d.freshPending > 0
        ? `${d.freshPending} new item(s) awaiting review`
        : `${d.totalPending} item(s) pending review`
    }</strong> &mdash; ${d.totalPending} pending in total.</p>`
  );
  if (d.since)
    htmlParts.push(`<p style="margin:0 0 4px;color:#666">New since ${escapeHtml(d.since)}</p>`);
  if (d.oldestPendingAt)
    htmlParts.push(
      `<p style="margin:0 0 12px;color:#666">Oldest pending ${escapeHtml(d.oldestPendingAt)}</p>`
    );
  for (const k of d.byKind) {
    htmlParts.push(
      `<h3 style="margin:16px 0 6px">${escapeHtml(k.label)}: ${k.total} pending <span style="color:#888;font-weight:normal">(${k.fresh} new)</span></h3>`
    );
    htmlParts.push("<ul style=\"margin:0 0 8px;padding-left:18px\">");
    for (const it of k.samples) {
      const weight = it.fresh ? "font-weight:600" : "color:#555";
      htmlParts.push(`<li style="${weight};margin:2px 0">${escapeHtml(itemLine(it))}</li>`);
    }
    if (k.total > k.samples.length) {
      htmlParts.push(
        `<li style="color:#888;margin:2px 0">… and ${k.total - k.samples.length} more</li>`
      );
    }
    htmlParts.push("</ul>");
  }
  htmlParts.push(
    `<p style="margin:16px 0 0"><a href="${reviewUrl}">Open the review queue →</a></p>`
  );
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.5;color:#222">${htmlParts.join(
    ""
  )}</div>`;

  return { subject, text, html };
}

// ----- send ------------------------------------------------------------------

export async function sendViaResend(cfg: NotifyConfig, msg: RenderedEmail): Promise<{ id: string }> {
  // Thin shim over the shared transport in src/utils/mail.ts. Kept so the
  // digest's call site and its tests don't change; new senders should call
  // sendMail directly.
  if (!cfg.apiKey) throw new Error("RESEND_API_KEY is not set");
  const { id } = await sendMail({
    from: cfg.from,
    to: cfg.recipients,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
  });
  return { id };
}

// ----- orchestrate -----------------------------------------------------------

export async function runReviewDigest(db: DatabaseSync, opts: RunOptions = {}): Promise<RunResult> {
  const nowTs = (
    db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now') AS t").get() as { t: string }
  ).t;
  const lastTs = readMarker(db);
  const digest = buildDigest(db, { lastTs, perKindLimit: opts.perKindLimit ?? 10 });
  digest.generatedAt = nowTs;

  const cfg = getNotifyConfig(opts.baseUrl ?? DEFAULT_BASE_URL);
  const rendered = renderDigest(digest, cfg);

  if (opts.dryRun) {
    return { sent: false, reason: "dry_run", digest, recipients: cfg.recipients, rendered };
  }

  const shouldSend = digest.freshPending > 0 || !!opts.force;
  if (!shouldSend) {
    return { sent: false, reason: "nothing_new", digest, recipients: cfg.recipients };
  }

  const missing = configErrors(cfg);
  if (missing.length) {
    throw new ConfigError(`missing config: ${missing.join(", ")}`);
  }

  const { id } = await sendViaResend(cfg, rendered);
  writeMarker(db, nowTs);
  return { sent: true, reason: "sent", digest, recipients: cfg.recipients, messageId: id, rendered };
}
