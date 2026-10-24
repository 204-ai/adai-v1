// Tell an operator when the archivist's daily budget runs low or out.
//
// The cap (ARCHIVIST_DAILY_BUDGET_USD, src/archivist/ratelimit.ts) is ours
// alone: Anthropic's Console only knows monthly limits, so when the gate
// closes nobody would hear of it. After each chat's usage is recorded,
// maybeAlertBudget looks at today's estimated spend and, at most once per
// UTC day and level, emails ARCHIVIST_ALERT_EMAILS (falls back to
// ADMIN_NOTIFY_EMAILS):
//
//   warn    — today's spend reached 80 % of the cap
//   reached — the cap is hit; new chats are refused until 00:00 UTC
//
// "Once" is a claim row in `settings` (archivist_budget_alert:<date>:<level>),
// taken with INSERT OR IGNORE so two chats finishing together send one mail;
// a failed send drops the claim so the next chat tries again. Resend's
// Idempotency-Key covers a retry of the same alert within 24 h.

import type { DatabaseSync } from "node:sqlite";
import { sendMail, textToHtml } from "../utils/mail.js";
import { dailyBudgetUsd, todayUtc } from "./ratelimit.js";

export type BudgetAlertLevel = "warn" | "reached";

export const WARN_FRACTION = 0.8;

export function alertRecipients(): string[] {
  const raw = process.env.ARCHIVIST_ALERT_EMAILS || process.env.ADMIN_NOTIFY_EMAILS || "";
  return raw.split(/[,\s]+/).filter(Boolean);
}

/** The highest level today's spend has reached, or null. */
export function budgetLevel(spentUsd: number, capUsd: number): BudgetAlertLevel | null {
  if (!(capUsd > 0)) return null; // 0 / negative disables the gate, and the alert with it
  if (spentUsd >= capUsd) return "reached";
  if (spentUsd >= capUsd * WARN_FRACTION) return "warn";
  return null;
}

function claimKey(date: string, level: BudgetAlertLevel): string {
  return `archivist_budget_alert:${date}:${level}`;
}

/** Take today's claim for this level; false when it was already taken. */
export function claimAlert(db: DatabaseSync, date: string, level: BudgetAlertLevel): boolean {
  const r = db
    .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
    .run(claimKey(date, level), new Date().toISOString());
  return Number(r.changes) > 0;
}

export function releaseAlert(db: DatabaseSync, date: string, level: BudgetAlertLevel): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(claimKey(date, level));
}

export function alertMessage(level: BudgetAlertLevel, date: string, spentUsd: number, capUsd: number) {
  const spent = `$${spentUsd.toFixed(2)}`;
  const cap = `$${capUsd.toFixed(2)}`;
  const subject =
    level === "reached"
      ? `Archivist budget reached: ${spent} of ${cap} today`
      : `Archivist at ${Math.round((spentUsd / capUsd) * 100)}% of today's budget (${spent} of ${cap})`;
  const text = [
    level === "reached"
      ? `The archivist has spent ${spent} today (${date}, UTC), reaching its daily cap of ${cap}. New chats are refused (it shows as "resting") until 00:00 UTC.`
      : `The archivist has spent ${spent} today (${date}, UTC), ${Math.round(WARN_FRACTION * 100)}% or more of its daily cap of ${cap}. At the cap it stops taking new chats until 00:00 UTC.`,
    "",
    `Model: ${process.env.ARCHIVIST_MODEL || "claude-haiku-4-5-20251001"}. Spend is estimated from token usage at list prices.`,
    "",
    "To raise the cap (restarts the app):",
    "  flyctl secrets set ARCHIVIST_DAILY_BUDGET_USD=<dollars> -a adai-basel",
  ].join("\n");
  return { subject, text };
}

function sender(): string {
  return process.env.RESEND_FROM || process.env.INTAKE_FROM || "A(DAI) <contribute@fragcolor.com>";
}

/**
 * Check today's spend and send the alert it calls for, if not sent yet.
 * Never throws; resolves once the mail went out (or was skipped / failed).
 */
export async function maybeAlertBudget(
  db: DatabaseSync,
  opts: { send?: typeof sendMail; date?: string; capUsd?: number } = {}
): Promise<BudgetAlertLevel | null> {
  try {
    const date = opts.date ?? todayUtc();
    const cap = opts.capUsd ?? dailyBudgetUsd();
    const row = db.prepare("SELECT est_cost_usd FROM archivist_usage WHERE date = ?").get(date) as
      | { est_cost_usd: number }
      | undefined;
    const spent = row?.est_cost_usd ?? 0;
    const level = budgetLevel(spent, cap);
    if (!level) return null;
    const to = alertRecipients();
    if (!to.length) return null;
    // Crossing straight past 80 % to the cap sends only the "reached" mail,
    // and claims the warning too so it doesn't follow on the next chat.
    if (level === "reached") claimAlert(db, date, "warn");
    if (!claimAlert(db, date, level)) return null;
    const { subject, text } = alertMessage(level, date, spent, cap);
    try {
      await (opts.send ?? sendMail)({
        from: sender(),
        to,
        subject,
        text,
        html: textToHtml(text),
        idempotencyKey: `archivist-budget-${date}-${level}`,
      });
    } catch (e: any) {
      releaseAlert(db, date, level);
      console.warn("[archivist] budget alert mail failed:", e?.message ?? e);
      return null;
    }
    return level;
  } catch (e: any) {
    console.warn("[archivist] budget alert check failed:", e?.message ?? e);
    return null;
  }
}
