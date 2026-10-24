// HTTP surface for the archivist chat.
//
// Two routes:
//   POST /api/archivist/session — issues / refreshes the HMAC-signed
//     visitor cookie. Idempotent; safe to call from the chat module on
//     every page load.
//   POST /api/archivist/chat — SSE stream. Body { messages: [...] } in
//     the same shape the Anthropic SDK takes. Streams typed SSE events
//     back: text, tool_use_start/end, client_tool, usage, stop, error.
//
// The chat route is stateless on conversation — the client sends its
// full history every time (capped on the client to ~20 turns).

import express, { Router } from "express";
import { getDb } from "../db.js";
import { JSON_HEADERS } from "../templates.js";
import {
  getOrIssueSession,
  readSession,
  bumpSession,
  isConfigured as sessionConfigured,
} from "../archivist/session.js";
import {
  checkSessionLimit,
  checkGlobalBudget,
  recordUsage,
  SESSION_QUOTA_VALUE,
} from "../archivist/ratelimit.js";
import { runArchivist, isConfigured as agentConfigured, type UsageReport } from "../archivist/agent.js";
import { maybeAlertBudget } from "../archivist/budget-alert.js";
import type { VisitorContext } from "../archivist/prompt.js";

const router = Router();

// Tight per-route body cap. src/index.ts skips the global 16 MB
// express.json for /api/archivist/* so this is the only parser that runs
// on these routes. Sized to fit a worst-case sanitised body (~24 messages
// × 4000 chars text + structured tool_use/tool_result blocks + visitor
// context) with comfortable headroom, but small enough that an
// unauthenticated attacker can't amplify a single POST into multi-MB JSON
// parsing per request.
router.use(express.json({ limit: "1mb" }));

// Cap how much history we'll forward to the model — both for cost and for
// prompt-injection blast radius. The browser already trims to 20; this is
// belt-and-braces.
const MAX_HISTORY_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 4000;

// Visitor-context limits. The browser ships these per turn; we never trust
// the strings directly (we look node-id names up in the DB on the server
// side) but we still bound length so a malicious client can't blow the
// prompt up with megabytes of junk.
const MAX_CONTEXT_ID_LEN = 200;
const MAX_CONTEXT_TRAIL = 8;
// These MUST track the viewLevel strings the field actually emits
// (graph-field.js: bundle.viewLevel). Drift here silently drops the
// zoomed-in signal — sanitiseContext rejects any value not in this set,
// so a stale list leaves the archivist unable to tell the visitor is on a
// node. Current field states: '30k' (overview) | 'field-focus' |
// 'field-reveal'. If the field renames a level, update this in lockstep.
const ALLOWED_VIEW_LEVELS = new Set(["30k", "field-focus", "field-reveal"]);
const ALLOWED_FIELD_MODES = new Set(["curatorial", "embeddings"]);

function sanitiseContext(raw: unknown): VisitorContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: VisitorContext = {};

  if (typeof r.focused_id === "string" && r.focused_id.length > 0 && r.focused_id.length <= MAX_CONTEXT_ID_LEN) {
    out.focused_id = r.focused_id;
  }
  if (typeof r.view_level === "string" && ALLOWED_VIEW_LEVELS.has(r.view_level)) {
    out.view_level = r.view_level;
  }
  if (typeof r.field_mode === "string" && ALLOWED_FIELD_MODES.has(r.field_mode)) {
    out.field_mode = r.field_mode;
  }
  if (Array.isArray(r.recent_focus_ids)) {
    const trail: string[] = [];
    for (const v of r.recent_focus_ids) {
      if (typeof v !== "string") continue;
      if (v.length === 0 || v.length > MAX_CONTEXT_ID_LEN) continue;
      trail.push(v);
      if (trail.length >= MAX_CONTEXT_TRAIL) break;
    }
    if (trail.length > 0) out.recent_focus_ids = trail;
  }

  // Drop entirely if nothing useful survived sanitisation.
  if (
    out.focused_id == null &&
    out.view_level == null &&
    out.field_mode == null &&
    !out.recent_focus_ids
  ) {
    return undefined;
  }
  return out;
}

function sanitiseMessages(raw: unknown): { ok: true; messages: any[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "messages must be an array" };
  if (raw.length === 0) return { ok: false, error: "messages is empty" };
  const trimmed = raw.slice(-MAX_HISTORY_MESSAGES);
  const out: any[] = [];
  for (const m of trimmed) {
    if (!m || typeof m !== "object") continue;
    const role = (m as any).role;
    if (role !== "user" && role !== "assistant") continue;
    const content = (m as any).content;
    if (typeof content === "string") {
      out.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) });
    } else if (Array.isArray(content)) {
      // Allow structured content blocks coming back (e.g. when the client
      // replays prior assistant tool-use turns). Pass through but truncate
      // text blocks. We don't accept image blocks here.
      //
      // TRUST MODEL — DELIBERATE FOOTGUN, READ THIS BEFORE TIGHTENING:
      // We accept tool_use and tool_result blocks straight from the
      // client. A malicious visitor can therefore fabricate a
      // "tool_result" claiming search_nodes returned anything they want,
      // and the model will reason from that on the next turn. This is
      // tolerated because (a) chat history lives in the visitor's own
      // sessionStorage and is replayed per-request — they can only lie
      // to *their own* model, and they see the lie in their own UI; and
      // (b) keeping the structured blocks intact is what lets the system
      // spine + tool definitions stay cacheable across turns, which is
      // material to per-message cost.
      // The realistic abuse is screenshotting a fake "authoritative"
      // reply; that's a misinformation concern, not an integrity one,
      // and the right mitigation lives outside this layer (don't make
      // the archivist's voice screenshot-bait; consider HMAC-signing
      // server-emitted tool_results if it ever matters). Do NOT silently
      // strip tool_use/tool_result here — that breaks the cache path.
      const blocks = content.filter((b: any) => b && (b.type === "text" || b.type === "tool_use" || b.type === "tool_result"));
      for (const b of blocks) {
        if (b.type === "text" && typeof b.text === "string") b.text = b.text.slice(0, MAX_MESSAGE_CHARS);
      }
      out.push({ role, content: blocks });
    }
  }
  if (out.length === 0) return { ok: false, error: "no usable messages" };
  // The first message we send must be a user message (Anthropic requirement).
  while (out.length > 0 && out[0].role !== "user") out.shift();
  if (out.length === 0) return { ok: false, error: "no user message in history" };
  return { ok: true, messages: out };
}

router.post("/api/archivist/session", (req, res) => {
  if (!sessionConfigured()) {
    res.status(503).set(JSON_HEADERS).json({ error: "archivist_unconfigured" });
    return;
  }
  if (!agentConfigured()) {
    // Return the session anyway — the visitor's cookie is fine. But warn
    // up-front so the UI can show a "the archivist is offline" state
    // without firing a chat round-trip first.
    const db = getDb();
    const s = getOrIssueSession(db, req, res);
    res.set(JSON_HEADERS).json({
      session_id: s.session_id,
      quota: SESSION_QUOTA_VALUE,
      online: false,
      reason: "no_anthropic_key",
    });
    return;
  }
  const db = getDb();
  const s = getOrIssueSession(db, req, res);
  res.set(JSON_HEADERS).json({
    session_id: s.session_id,
    quota: SESSION_QUOTA_VALUE,
    online: true,
  });
});

router.post("/api/archivist/chat", async (req, res) => {
  if (!sessionConfigured() || !agentConfigured()) {
    res.status(503).set(JSON_HEADERS).json({ error: "archivist_offline" });
    return;
  }

  const db = getDb();
  const session = readSession(db, req);
  if (!session) {
    res.status(401).set(JSON_HEADERS).json({ error: "no_session", hint: "POST /api/archivist/session first" });
    return;
  }

  const sessionLimit = checkSessionLimit(session);
  if (!sessionLimit.ok) {
    res
      .status(429)
      .set(JSON_HEADERS)
      .set({ "Retry-After": String(sessionLimit.retry_after_s ?? 60) })
      .json({ error: sessionLimit.reason, retry_after_s: sessionLimit.retry_after_s });
    return;
  }

  const budget = checkGlobalBudget(db);
  if (!budget.ok) {
    res.status(503).set(JSON_HEADERS).json({ error: budget.reason });
    return;
  }

  const parsed = sanitiseMessages(req.body?.messages);
  if (!parsed.ok) {
    res.status(400).set(JSON_HEADERS).json({ error: parsed.error });
    return;
  }
  const visitorContext = sanitiseContext(req.body?.context);

  // Open SSE. X-Accel-Buffering disables Fly/nginx buffering so the bytes
  // actually leave the server promptly; Cache-Control no-store keeps any
  // intermediate proxy from caching the partial stream.
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();

  const ac = new AbortController();
  // Watch the *response* socket, not the request. In Node 22+ / Express 5 the
  // IncomingMessage emits 'close' as soon as the body has been consumed (i.e.
  // within ms of receiving the POST), which is NOT a disconnect — it just
  // means express.json() finished. Aborting on that closes Claude's stream
  // before the first token. res.on('close') with a writableEnded guard fires
  // only when the client actually goes away mid-stream.
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });

  function writeEvent(name: string, data: unknown): void {
    if (res.writableEnded) return;
    try {
      res.write(`event: ${name}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      (res as any).flush?.();
    } catch {
      // Client likely went away; abort will fire.
    }
  }

  // Heartbeat every 15s — keeps proxies from timing the socket out during
  // long tool-use loops.
  const heartbeat = setInterval(() => {
    if (res.writableEnded) { clearInterval(heartbeat); return; }
    try { res.write(": ping\n\n"); (res as any).flush?.(); } catch {}
  }, 15_000);

  let finalUsage: UsageReport | null = null;

  try {
    for await (const evt of runArchivist({ messages: parsed.messages, db, context: visitorContext, signal: ac.signal })) {
      if (evt.type === "usage") {
        finalUsage = evt.usage;
        continue; // don't forward raw usage to the wire
      }
      writeEvent(evt.type, evt);
    }
  } catch (e: any) {
    writeEvent("error", { type: "error", error: e?.message ?? String(e) });
  } finally {
    clearInterval(heartbeat);
    if (finalUsage) {
      try {
        recordUsage(db, finalUsage);
      } catch (e: any) {
        console.warn("[archivist] recordUsage failed:", e?.message ?? e);
      }
      // Email the operator at 80 % and at the cap, once a day each
      // (src/archivist/budget-alert.ts). Fire-and-forget: never delays "done".
      void maybeAlertBudget(db);
      // Only debit the visitor's per-session quota when the model actually
      // issued a request (i.e. we got at least partial usage back). Failing
      // before the first token — Anthropic outage, bad API key on the Fly
      // secret, transport error — shouldn't burn the visitor's hourly
      // window. Without this gate a 5-minute outage can exhaust a visitor's
      // entire 30/hour budget on retries that never reached the model.
      try { bumpSession(db, session.session_id); } catch {}
    }
    writeEvent("done", { type: "done" });
    res.end();
  }
});

export default router;
