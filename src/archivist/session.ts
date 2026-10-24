// Anonymous-visitor session tokens for the archivist chat surface.
//
// The chat is open to anyone landing on /field; we don't want the friction
// of a sign-up, but we also don't want a single broken script to drain the
// Anthropic budget. The compromise is a lightweight HMAC-signed cookie:
// first POST to /api/archivist/session mints a random session id and signs
// it with ARCHIVIST_SESSION_SECRET; every subsequent /api/archivist/chat
// call is rate-limited per session_id.
//
// Cookie format: `<sessionId>.<hexHmacSha256(sessionId, secret)>`. Stored
// HttpOnly+SameSite=Lax so cross-origin pages can't piggyback the session
// but the same browser keeps it across reloads (Max-Age=30 days).
//
// This is NOT a contributor token — archivist sessions are anonymous and
// confer no write capability. The contributor-token machinery in
// src/auth.ts is untouched.

import type { Request, Response } from "express";
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SESSION_WINDOW_SECONDS } from "./ratelimit.js";
import { clientIp } from "../intake/auth.js";

const COOKIE_NAME = "adai_arch";
const MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

export interface ArchivistSession {
  session_id: string;
  message_count: number;
  last_message_at: number | null;
}

function secret(): string | null {
  const s = process.env.ARCHIVIST_SESSION_SECRET;
  if (!s || s.length < 16) return null;
  return s;
}

function sign(sessionId: string, key: string): string {
  return crypto.createHmac("sha256", key).update(sessionId).digest("hex");
}

function parseCookie(header: string | undefined): string | null {
  if (!header) return null;
  // Manual cookie parse — keeps the dependency tree small. We only need
  // ours; ignore everything else.
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== COOKIE_NAME) continue;
    const val = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(val);
    } catch {
      return val;
    }
  }
  return null;
}

function verifySigned(signed: string, key: string): string | null {
  const dot = signed.lastIndexOf(".");
  if (dot < 0) return null;
  const sessionId = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  if (!sessionId || !sig) return null;
  // Reject anything that isn't pure hex BEFORE touching Buffer.from. With
  // non-hex input, Buffer.from(s, "hex") silently truncates at the first
  // invalid char — a string-length check then passes but the resulting
  // byte buffers differ in length, and timingSafeEqual throws RangeError.
  // An uncaught throw would bubble out of readSession into the chat route
  // and produce a 500 for any visitor with a malformed cookie.
  if (!/^[0-9a-fA-F]+$/.test(sig)) return null;
  const expected = sign(sessionId, key);
  // Constant-time compare to avoid leaking signature info via timing.
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return null;
  } catch {
    // Belt-and-braces in case the hex check above misses an edge case.
    return null;
  }
  return sessionId;
}

export function isConfigured(): boolean {
  return !!secret();
}

/**
 * Read the session cookie, verify it, and look up the row. Returns null if
 * the cookie is missing, malformed, badly signed, or has no row in DB.
 */
export function readSession(db: DatabaseSync, req: Request): ArchivistSession | null {
  const key = secret();
  if (!key) return null;
  const cookie = parseCookie(req.header("cookie"));
  if (!cookie) return null;
  const sessionId = verifySigned(cookie, key);
  if (!sessionId) return null;
  const row = db
    .prepare("SELECT session_id, message_count, last_message_at FROM archivist_sessions WHERE session_id = ?")
    .get(sessionId) as { session_id: string; message_count: number; last_message_at: number | null } | undefined;
  if (!row) return null;
  return row;
}

/**
 * Issue a new session: insert row, set signed cookie. Idempotent in the
 * sense that callers should `readSession` first; this always mints fresh.
 */
export function issueSession(db: DatabaseSync, req: Request, res: Response): ArchivistSession {
  const key = secret();
  if (!key) {
    throw new Error("archivist_unconfigured: set ARCHIVIST_SESSION_SECRET");
  }
  const sessionId = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  const ip = clientIp(req);
  const ua = req.header("user-agent") || null;
  db.prepare(
    "INSERT INTO archivist_sessions (session_id, created_at, ip, user_agent, message_count, last_message_at) VALUES (?, ?, ?, ?, 0, NULL)"
  ).run(sessionId, now, ip, ua);

  const signed = `${sessionId}.${sign(sessionId, key)}`;
  // SameSite=Lax: the cookie tags along on top-level navigation but not on
  // cross-site XHR. HttpOnly: not readable from JS — which means the chat
  // module relies on the browser sending it back automatically (fetch needs
  // credentials: 'same-origin', which is the default).
  res.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(signed)}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; SameSite=Lax`
  );
  return { session_id: sessionId, message_count: 0, last_message_at: null };
}

/**
 * Read-or-issue. Used by both /api/archivist/session (idempotent) and the
 * chat route (which needs a session before it can rate-limit).
 */
export function getOrIssueSession(db: DatabaseSync, req: Request, res: Response): ArchivistSession {
  return readSession(db, req) ?? issueSession(db, req, res);
}

/**
 * Record that a chat call completed for this session. Updates the rolling
 * window used by the per-session rate limiter.
 *
 * Window-aware reset: if the previous message landed outside the rolling
 * window, message_count drops back to 1 instead of compounding. Without
 * this, message_count grows monotonically — the read-side check in
 * checkSessionLimit only allows the *first* message past the window
 * boundary (because that read returns ok:true unconditionally), then the
 * very next message inside the new window finds message_count already at
 * or above quota and gets denied. Net effect was: any returning visitor
 * got 1-message-per-hour after their first burst.
 */
export function bumpSession(db: DatabaseSync, sessionId: string): void {
  const now = Date.now();
  const cutoffMs = now - SESSION_WINDOW_SECONDS * 1000;
  db.prepare(
    `UPDATE archivist_sessions
        SET message_count = CASE
              WHEN last_message_at IS NULL OR last_message_at < ? THEN 1
              ELSE message_count + 1
            END,
            last_message_at = ?
      WHERE session_id = ?`
  ).run(cutoffMs, now, sessionId);
}
