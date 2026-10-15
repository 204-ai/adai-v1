// Contributor-facing surface of the URL intake (docs/URL-INTAKE-SPEC.md
// §9.1, §12): login, session, drafts JSON, the three pages.
//
// Session cookie for the browser; `requireContributor` also accepts a
// /api/v1 bearer token so an external assistant can drive drafts.

import express, { Router } from "express";
import { getDb } from "../db.js";
import { JSON_HEADERS, HTML_HEADERS, htmlPage } from "../templates.js";
import {
  normaliseEmail,
  loginRateOk,
  isInvited,
  recordAccessRequest,
  recordRequestDetails,
  clientIp,
  consumeMagicLink,
  ensureContributorForEmail,
  contributorByEmail,
  issueSession,
  readSession,
  deleteSession,
  setSessionCookie,
  clearSessionCookie,
  requireSession,
  requireContributor,
  setContributorName,
  emailFor,
  isSessionConfigured,
  sweepAuth,
} from "../intake/auth.js";
import {
  createDraft,
  listDrafts,
  getDraft,
  toOwnerJson,
  enqueueChat,
  abandonDraft,
  enqueueContinue,
  contributorPatchCandidate,
  confirmDraft,
  batchReceipt,
  DraftError,
} from "../intake/draft.js";
import { CandidateError } from "../intake/candidate.js";
import { sendLoginEmail, sendReceiptEmail, sendAccessRequestEmail, sendAccessRequestDetailsEmail } from "../intake/mail.js";
import { spawnAsync } from "../intake/spawn.js";
import { contributePage, draftPage, batchPage } from "../intake/pages.js";
import { myNodes } from "../claim/log.js";
import { postIntakeClaimPrompt } from "../claim/screens.js";
import { assistantGuidePage } from "../intake/assistant-guide.js";

const router = Router();

router.use(["/api/intake", "/auth"], express.json({ limit: "256kb" }));

function fail(res: express.Response, e: unknown): void {
  if (e instanceof DraftError) {
    res.status(e.status).set(JSON_HEADERS).json({ error: e.code, message: e.message });
  } else if (e instanceof CandidateError) {
    res.status(422).set(JSON_HEADERS).json({ error: "invalid_candidate", message: e.message, field: e.field ?? null });
  } else {
    console.error("[intake]", (e as any)?.message ?? e);
    res.status(500).set(JSON_HEADERS).json({ error: "internal_error", message: (e as any)?.message ?? String(e) });
  }
}

function unconfigured(res: express.Response): boolean {
  if (isSessionConfigured()) return false;
  res.status(503).set(JSON_HEADERS).json({ error: "intake_unconfigured", message: "SESSION_SECRET is not set" });
  return true;
}

// ---- login ------------------------------------------------------------------------

router.post("/api/intake/login", async (req, res) => {
  if (unconfigured(res)) return;
  const email = normaliseEmail(req.body?.email);
  // Always 200 — no account enumeration. Bad addresses and rate-limited
  // callers get the same answer; the email simply never arrives.
  res.set(JSON_HEADERS).json({ ok: true });
  if (!email) return;
  const ip = clientIp(req);
  if (!loginRateOk(email, ip)) return;
  const db = getDb();
  sweepAuth(db);
  const redirect = typeof req.body?.redirect === "string" ? req.body.redirect : "/contribute";
  try {
    // Invite-only: a link goes to invited addresses; anyone else becomes an
    // access request for the admins. Same answer to the caller either way.
    if (isInvited(db, email)) await sendLoginEmail(db, email, ip, redirect);
    else if (recordAccessRequest(db, email)) await sendAccessRequestEmail(email);
  } catch (e: any) {
    console.error("[intake] login email failed:", e?.message ?? e);
  }
});

// After the sign-in form: how a NEW contributor would like to appear, and an
// optional note (issue #72). Asked of everyone and always 200, so it says
// nothing about who is invited; it only lands on a recent access request.
router.post("/api/intake/request-details", (req, res) => {
  const email = normaliseEmail(req.body?.email);
  const name = typeof req.body?.name === "string" ? req.body.name.trim().replace(/\s+/g, " ") : "";
  const about = typeof req.body?.about === "string" ? req.body.about.trim().slice(0, 1000) || null : null;
  if (name.length < 2 || name.length > 120) {
    res.status(400).set(JSON_HEADERS).json({ error: "bad_name", message: "a name is 2–120 characters" });
    return;
  }
  res.set(JSON_HEADERS).json({ ok: true });
  if (!email || !loginRateOk(email, clientIp(req))) return;
  try {
    if (recordRequestDetails(getDb(), email, name, about)) void sendAccessRequestDetailsEmail(email, name, about).catch((e) => console.error("[intake] details email failed:", e?.message ?? e));
  } catch (e: any) {
    console.error("[intake] request details failed:", e?.message ?? e);
  }
});

router.get("/auth/:token", (req, res) => {
  const db = getDb();
  if (!isSessionConfigured()) {
    res.status(503).set(HTML_HEADERS).send(htmlPage("Sign in", "<h2>Sign-in is not configured</h2>"));
    return;
  }
  const r = consumeMagicLink(db, String(req.params.token));
  if (!r.ok) {
    // A used notification link with a valid session still lands the reader
    // on the target — that is the "tap from your phone twice" case.
    const existing = readSession(db, req);
    if (r.reason === "used" && existing && r.redirect) {
      res.redirect(302, r.redirect);
      return;
    }
    const why = r.reason === "expired" ? "That link has expired." : r.reason === "used" ? "That link was already used." : "That link is not valid.";
    res.status(400).set(HTML_HEADERS).send(htmlPage("Sign in", `<h2>${why}</h2><p><a href="/contribute">Request a new one.</a></p>`));
    return;
  }
  // A link issued before an invite was revoked must not open a session.
  if (!isInvited(db, r.email)) {
    res.status(403).set(HTML_HEADERS).send(htmlPage("Sign in", "<h2>This address is not invited to the URL intake.</h2><p>Your request has been passed on to the A(DAI) team.</p>"));
    return;
  }
  const c = contributorByEmail(db, r.email) ?? ensureContributorForEmail(db, { email: r.email, verified: true });
  ensureContributorForEmail(db, { email: r.email, verified: true });
  const { signed } = issueSession(db, c.id, { ip: clientIp(req), user_agent: req.header("user-agent") ?? null });
  setSessionCookie(res, signed);
  res.redirect(302, r.redirect || "/contribute");
});

router.post("/api/intake/logout", (req, res) => {
  const s = readSession(getDb(), req);
  if (s) deleteSession(getDb(), s.session_id);
  clearSessionCookie(res);
  res.set(JSON_HEADERS).json({ ok: true });
});

router.get("/api/intake/me", requireContributor, (req, res) => {
  const db = getDb();
  const c = req.contributor!;
  res.set(JSON_HEADERS).json({
    contributor_id: c.id,
    name: c.name,
    email: req.intakeSession?.email ?? emailFor(db, c.id),
    trust_tier: c.trust_tier,
    self_node_id: req.intakeSession?.self_node_id ?? null,
    claims: myNodes(db, c.id),
    curator: c.scope === "admin",
    via: req.intakeSession ? "session" : "token",
  });
});

router.post("/api/intake/me", requireSession, (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim().replace(/\s+/g, " ") : "";
  if (name.length < 2 || name.length > 120) {
    res.status(400).set(JSON_HEADERS).json({ error: "bad_name", message: "name must be 2–120 characters" });
    return;
  }
  setContributorName(getDb(), req.contributor!.id, name);
  res.set(JSON_HEADERS).json({ ok: true, name });
});

// ---- drafts -----------------------------------------------------------------------

router.post("/api/intake/drafts", requireContributor, (req, res) => {
  try {
    const db = getDb();
    if (!req.contributor!.name) throw new DraftError("set a display name first (POST /api/intake/me)", 409, "name_required");
    const d = createDraft(db, req.contributor!.id, req.body?.source_url);
    spawnAsync(db, d);
    res.status(202).set(JSON_HEADERS).json({ draft_id: d.id, status: d.status, draft_url: `/draft/${d.id}` });
  } catch (e) {
    fail(res, e);
  }
});

router.get("/api/intake/drafts", requireContributor, (req, res) => {
  res.set(JSON_HEADERS).json({ drafts: listDrafts(getDb(), req.contributor!.id) });
});

function ownDraft(req: express.Request, res: express.Response) {
  const d = getDraft(getDb(), String(req.params.id));
  if (!d) { res.status(404).set(JSON_HEADERS).json({ error: "not_found" }); return null; }
  if (d.contributor_id !== req.contributor!.id && req.contributor!.scope !== "admin") {
    res.status(403).set(JSON_HEADERS).json({ error: "forbidden" });
    return null;
  }
  return d;
}

router.get("/api/intake/drafts/:id", requireContributor, (req, res) => {
  const d = ownDraft(req, res);
  if (!d) return;
  res.set(JSON_HEADERS).json({ draft: toOwnerJson(d), trust_tier: req.contributor!.trust_tier });
});

router.post("/api/intake/drafts/:id/chat", requireContributor, (req, res) => {
  const d = ownDraft(req, res);
  if (!d) return;
  try {
    const next = enqueueChat(getDb(), d, req.body?.message);
    spawnAsync(getDb(), next);
    res.status(202).set(JSON_HEADERS).json({ ok: true, draft: toOwnerJson(next) });
  } catch (e) {
    fail(res, e);
  }
});

router.post("/api/intake/drafts/:id/continue", requireContributor, (req, res) => {
  const d = ownDraft(req, res);
  if (!d) return;
  try {
    const next = enqueueContinue(getDb(), d, req.body?.focus);
    spawnAsync(getDb(), next);
    res.status(202).set(JSON_HEADERS).json({ ok: true, draft: toOwnerJson(next) });
  } catch (e) {
    fail(res, e);
  }
});

router.patch("/api/intake/drafts/:id/candidates/:cid", requireContributor, (req, res) => {
  const d = ownDraft(req, res);
  if (!d) return;
  try {
    const c = contributorPatchCandidate(getDb(), d, String(req.params.cid), req.body ?? {});
    res.set(JSON_HEADERS).json({ ok: true, candidate: c });
  } catch (e) {
    fail(res, e);
  }
});

router.post("/api/intake/drafts/:id/abandon", requireContributor, (req, res) => {
  const d = ownDraft(req, res);
  if (!d) return;
  try {
    res.set(JSON_HEADERS).json({ ok: true, draft: toOwnerJson(abandonDraft(getDb(), d)) });
  } catch (e) {
    fail(res, e);
  }
});

router.post("/api/intake/drafts/:id/confirm", requireContributor, async (req, res) => {
  const d = ownDraft(req, res);
  if (!d) return;
  const db = getDb();
  try {
    const result = await confirmDraft(db, d, req.contributor!);
    res.set(JSON_HEADERS).json(result);
    const email = emailFor(db, req.contributor!.id);
    const fresh = getDraft(db, d.id);
    if (email && fresh) await sendReceiptEmail(db, email, req.contributor!.name, fresh, result);
  } catch (e) {
    if (!res.headersSent) fail(res, e);
    else console.error("[intake] receipt email failed:", (e as any)?.message ?? e);
  }
});

router.get("/api/intake/batches/:batch_id", requireContributor, (req, res) => {
  const d = getDraft(getDb(), String(req.params.batch_id));
  if (!d || d.status !== "submitted") { res.status(404).set(JSON_HEADERS).json({ error: "not_found" }); return; }
  if (d.contributor_id !== req.contributor!.id && req.contributor!.scope !== "admin") {
    res.status(403).set(JSON_HEADERS).json({ error: "forbidden" }); return;
  }
  const r = batchReceipt(getDb(), String(req.params.batch_id));
  if (!r) { res.status(404).set(JSON_HEADERS).json({ error: "not_found" }); return; }
  res.set(JSON_HEADERS).json(r);
});

// ---- pages --------------------------------------------------------------------------

router.get(["/contribute", "/contribute/url"], (_req, res) => {
  res.set(HTML_HEADERS).send(contributePage());
});

router.get("/contribute/assistant", (_req, res) => {
  res.set(HTML_HEADERS).send(assistantGuidePage());
});

router.get("/draft/:id", (req, res) => {
  res.set(HTML_HEADERS).send(draftPage(String(req.params.id)));
});

router.get("/batch/:batch_id", (req, res) => {
  const db = getDb();
  const r = batchReceipt(db, String(req.params.batch_id));
  if (!r) {
    res.status(404).set(HTML_HEADERS).send(htmlPage("Receipt", "<h2>No such batch</h2>"));
    return;
  }
  const s = readSession(db, req);
  const draft = getDraft(db, String(req.params.batch_id));
  const isOwner = !!(s && draft && draft.contributor_id === s.contributor.id);
  const admins = (process.env.ADMIN_NOTIFY_EMAILS || "").split(/[,\s]+/).filter(Boolean);
  // "Is one of these you?" (docs/CLAIM-SPEC.md §6) — the owner only.
  const prompt = isOwner && draft ? postIntakeClaimPrompt(db, s!.contributor.id, draft.id, r) : "";
  res.set(HTML_HEADERS).send(batchPage(r, isOwner, admins, prompt));
});

export default router;
