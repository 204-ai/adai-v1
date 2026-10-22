// Transactional mail over the Resend HTTP API (global fetch, no SDK).
//
// One function for every sender in the codebase — the curator digest
// (src/notify/digest.ts) and the URL-intake emails (src/intake/mail.ts).
// Without RESEND_API_KEY the message is logged to stdout in full; that is
// the dev transport, and it is what makes magic links usable locally.
// On staging the mail switch decides which recipients get real mail; the
// rest are logged the same way (src/utils/staging.ts).

import { isStaging, mailRoute } from "./staging.js";

export interface MailMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  replyTo?: string[];
  /** Resend's Idempotency-Key: a retry with the same key is not sent twice (for 24 h). */
  idempotencyKey?: string;
  /** Give up on the HTTP request after this long (default 30 s) — well under any lease a caller holds. */
  timeoutMs?: number;
}

/**
 * A send that did not go through. `transient`: worth retrying later — the
 * network (including a timeout: the request may or may not have arrived),
 * 429, 5xx, and a 409 `concurrent_idempotent_requests` (the same key is still
 * being processed). A 409 `invalid_idempotent_request` (the key was used with
 * a different body) is not. `code`: Resend's error name, when it gave one.
 */
export class MailError extends Error {
  constructor(message: string, readonly status: number | null, readonly transient: boolean, readonly code: string | null = null) {
    super(message);
  }
}

export const MAIL_TIMEOUT_MS = 30_000;

export interface MailResult {
  id: string;
  transport: "resend" | "stdout";
}

export function resendApiKey(): string | null {
  // MAIL_TRANSPORT=stdout forces the dev transport even when a Resend key is
  // present (a local .env usually has the real key for the digest CLI).
  if (process.env.MAIL_TRANSPORT === "stdout") return null;
  return process.env.RESEND_API_KEY || null;
}

function logMail(msg: MailMessage, why: string): void {
  const banner = "-".repeat(72);
  console.log(
    `\n${banner}\n[mail] (stdout transport — ${why})\nFrom: ${msg.from}\nTo: ${msg.to.join(", ")}` +
      (msg.replyTo?.length ? `\nReply-To: ${msg.replyTo.join(", ")}` : "") +
      `\nSubject: ${msg.subject}\n\n${msg.text}\n${banner}\n`
  );
}

export async function sendMail(msg: MailMessage): Promise<MailResult> {
  const { live, held } = mailRoute(msg.to);
  if (held.length) logMail({ ...msg, to: held }, "held by the staging mail switch");
  if (!live.length) return { id: "", transport: "stdout" };
  const apiKey = resendApiKey();
  if (!apiKey) {
    logMail({ ...msg, to: live }, "RESEND_API_KEY unset");
    return { id: "", transport: "stdout" };
  }
  const body: Record<string, unknown> = {
    from: msg.from,
    to: live,
    subject: isStaging() ? `[staging] ${msg.subject}` : msg.subject,
    html: msg.html,
    text: msg.text,
  };
  if (msg.replyTo?.length) body.reply_to = msg.replyTo;
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  if (msg.idempotencyKey) headers["Idempotency-Key"] = msg.idempotencyKey;
  let resp: Response;
  let text: string;
  try {
    resp = await fetch("https://api.resend.com/emails", {
      method: "POST", headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(msg.timeoutMs ?? MAIL_TIMEOUT_MS),
    });
    text = await resp.text();
  } catch (e: any) {
    throw new MailError(`Resend unreachable: ${e?.message ?? e}`, null, true);
  }
  if (!resp.ok) {
    let code: string | null = null;
    try { code = (JSON.parse(text) as { name?: string }).name ?? null; } catch { /* not JSON */ }
    const transient = resp.status === 429 || resp.status >= 500 || (resp.status === 409 && code === "concurrent_idempotent_requests");
    throw new MailError(`Resend API ${resp.status}: ${text}`, resp.status, transient, code);
  }
  try {
    return { id: (JSON.parse(text) as { id: string }).id ?? "", transport: "resend" };
  } catch {
    return { id: "", transport: "resend" };
  }
}

/** Minimal HTML twin for a plain-text email: escaped, paragraphs, links clickable. */
export function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paras = text.split(/\n{2,}/).map((p) => {
    const withLinks = esc(p).replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}">${u}</a>`);
    return `<p style="margin:0 0 14px;line-height:1.5">${withLinks.replace(/\n/g, "<br>")}</p>`;
  });
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#1a1a1a;max-width:560px;margin:24px auto;padding:0 16px">${paras.join("")}</body></html>`;
}
