// Claims, handles and the personal log (docs/CLAIM-SPEC.md §7).
//
//   GET  /@:handle[/data|/history]   302 → the node
//   GET  /claim/:type/:slug           claim page (signed in or not)
//   GET  /me                          the personal log
//   POST /api/claims                  claim a node            (session / bearer)
//   POST /api/claims/request          signed-out claim → link or access request
//   POST /api/claims/:id/withdraw
//   GET  /api/claims/handle?h=&node=  availability
//   POST /api/claims/handle           {node_id, handle}
//   GET  /api/me/log?node=
//   GET  /api/me/notifications        {email: immediate|daily|off} (issue #81)
//   POST /api/me/notifications        {email}
//   POST /api/me/contest | /context | /objection | /invite
//   POST /api/me/notes/:signal_id/withdraw
//   POST /api/review/access/approve | /reject   curator: a signed-out claim request

import { Router, type Request, type Response } from "express";
import express from "express";
import { getDb } from "../db.js";
import { HTML_HEADERS, JSON_HEADERS, PRIVATE_HTML_HEADERS, htmlPage } from "../templates.js";
import {
  clientIp, ensureContributorForEmail, isInvited, loginRateOk, normaliseEmail, recordAccessRequest,
  requireContributor, requireCurator, contributorByEmail,
} from "../intake/auth.js";
import { sendLoginEmail } from "../intake/mail.js";
import {
  ClaimError, CLAIMABLE_TYPES, approveClaim, contributorById, endClaim, handleAvailability, normaliseHandle,
  requestClaim, resolveHandle, setHandle, suggestHandle, HANDLE_RULE,
} from "../claim/store.js";
import { checkInvite, fileNote, recordPeerInviteClaim, withdrawNote } from "../claim/notes.js";
import { buildLog, myNodes } from "../claim/log.js";
import { sendAdminClaimRequestEmail, sendClaimConflictEmail, sendClaimDecisionEmail, sendPeerInviteEmail } from "../claim/mail.js";
import { claimPage, mePage } from "../claim/screens.js";
import { EMAIL_MODES, getNotifyPrefs, setEmailMode } from "../notify/claimants.js";

const router = Router();
// Same tight body cap as /api/intake/*; these bodies are a sentence or two.
const json = express.json({ limit: "64kb" });

function fail(res: Response, e: unknown): void {
  if (e instanceof ClaimError) {
    res.status(e.status).set(JSON_HEADERS).json({ error: e.code, message: e.message });
    return;
  }
  console.error("[claim]", e);
  res.status(500).set(JSON_HEADERS).json({ error: "internal" });
}

const str = (v: unknown, max = 4000): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

// ---- handles ------------------------------------------------------------------------

router.get(["/@:handle", "/@:handle/data", "/@:handle/history"], (req, res) => {
  const n = resolveHandle(getDb(), String(req.params.handle));
  if (!n) {
    res.status(404).set(HTML_HEADERS).send(htmlPage("Not found", `<h2>No page has that handle.</h2>`));
    return;
  }
  const tail = req.path.endsWith("/data") ? "/data" : req.path.endsWith("/history") ? "/history" : "";
  res.redirect(302, `/${encodeURIComponent(n.type)}/${encodeURIComponent(n.slug)}${tail}`);
});

router.get("/api/claims/handle", requireContributor, (req, res) => {
  const db = getDb();
  const h = normaliseHandle(req.query.h);
  const node = typeof req.query.node === "string" ? req.query.node : null;
  if (!h) { res.set(JSON_HEADERS).json({ ok: false, reason: HANDLE_RULE }); return; }
  res.set(JSON_HEADERS).json({ handle: h, ...handleAvailability(db, h, node) });
});

router.post("/api/claims/handle", json, requireContributor, (req, res) => {
  try {
    res.set(JSON_HEADERS).json(setHandle(getDb(), { contributor: req.contributor!, node_id: str(req.body?.node_id, 300), handle: str(req.body?.handle, 60) }));
  } catch (e) { fail(res, e); }
});

// ---- public read surface for /field ------------------------------------------------------

// Open contests, so /field can draw contested relations dashed (kept off the
// cached graph stream: its stamp only tracks node / relation counts).
router.get("/api/contested", (_req, res) => {
  const relations = getDb()
    .prepare("SELECT DISTINCT source_id, edge_type, target_id FROM relation_notes WHERE kind = 'contest' AND state = 'open' AND source_id IS NOT NULL")
    .all();
  res.set(JSON_HEADERS).json({ relations });
});

// The claim badge for the field's entity panel.
router.get("/api/claimed/:type/:slug", (req, res) => {
  const type = String(req.params.type);
  const n = nodeBySlug(type, String(req.params.slug));
  if (!n) { res.status(404).set(JSON_HEADERS).json({ error: "not_found" }); return; }
  let claimed: any = null;
  try { claimed = JSON.parse(n.metadata ?? "{}")?.claimed ?? null; } catch { /* bad metadata */ }
  const claimable = (CLAIMABLE_TYPES as readonly string[]).includes(type);
  res.set(JSON_HEADERS).json({
    claimed: claimed ? { handle: claimed.handle ?? null, by: Array.isArray(claimed.by) ? claimed.by : [], at: claimed.at ?? null } : null,
    claimable,
    claim_url: claimable ? `/claim/${encodeURIComponent(type)}/${encodeURIComponent(n.slug)}` : null,
  });
});

// ---- claiming ---------------------------------------------------------------------------

function nodeBySlug(type: string, slug: string): any {
  return getDb().prepare("SELECT id, type, name, slug, metadata FROM nodes WHERE type = ? AND slug = ?").get(type, slug);
}

router.get("/claim/:type/:slug", (req, res) => {
  const type = String(req.params.type);
  const n = nodeBySlug(type, String(req.params.slug));
  if (!n || !(CLAIMABLE_TYPES as readonly string[]).includes(type)) {
    res.status(404).set(HTML_HEADERS).send(htmlPage("Not found", `<h2>No claimable page here.</h2>`));
    return;
  }
  res.set(HTML_HEADERS).send(claimPage({ id: n.id, type: n.type, name: n.name, slug: n.slug, suggested: suggestHandle(getDb(), n.id) }));
});

router.post("/api/claims", json, requireContributor, async (req, res) => {
  const db = getDb();
  const c = req.contributor!;
  if (!c.name) { res.status(400).set(JSON_HEADERS).json({ error: "name_required", message: "set the name A(DAI) credits you by first" }); return; }
  const via = req.body?.via === "post_intake" ? "post_intake" : undefined;
  try {
    const r = requestClaim(db, {
      contributor: c,
      node_id: str(req.body?.node_id, 300),
      via,
      evidence: str(req.body?.evidence) || null,
      handle: str(req.body?.handle, 60) || null,
      public_name: req.body?.public_name !== false,
    });
    res.status(r.created ? 201 : 200).set(JSON_HEADERS).json({ claim: r.claim, created: r.created });
    if (r.created && r.claim.status === "pending") {
      await sendAdminClaimRequestEmail(db, r.claim.node_id, c.name, r.claim.evidence);
      if (r.conflicts_with.length) await sendClaimConflictEmail(db, r.conflicts_with, r.claim.node_id, c.name);
    }
  } catch (e) { fail(res, e); }
});

// Signed out: an invited address gets a sign-in link back to the claim page;
// anyone else becomes an access request naming the node. Same answer.
router.post("/api/claims/request", json, async (req, res) => {
  const db = getDb();
  const email = normaliseEmail(req.body?.email);
  const nodeId = str(req.body?.node_id, 300);
  const evidence = str(req.body?.evidence) || null;
  const n = db.prepare("SELECT id, type, slug FROM nodes WHERE id = ?").get(nodeId) as any;
  if (!email || !n || !(CLAIMABLE_TYPES as readonly string[]).includes(n.type)) {
    res.status(400).set(JSON_HEADERS).json({ error: "bad_request", message: "an email and a claimable page are required" });
    return;
  }
  res.set(JSON_HEADERS).json({ ok: true });
  const ip = clientIp(req);
  if (!loginRateOk(email, ip)) return;
  try {
    if (isInvited(db, email)) {
      await sendLoginEmail(db, email, ip, `/claim/${encodeURIComponent(n.type)}/${encodeURIComponent(n.slug)}`);
    } else {
      const notify = recordAccessRequest(db, email);
      db.prepare("UPDATE intake_access_requests SET node_id = ?, evidence = ? WHERE email = ?").run(n.id, evidence, email);
      if (notify) await sendAdminClaimRequestEmail(db, n.id, `${email} (not invited yet)`, evidence);
    }
  } catch (e: any) {
    console.error("[claim] request failed:", e?.message ?? e);
  }
});

router.post("/api/claims/:id/withdraw", json, requireContributor, (req, res) => {
  try {
    res.set(JSON_HEADERS).json({ claim: endClaim(getDb(), String(req.params.id), { actor: req.contributor!, mode: "withdrawn", reason: str(req.body?.reason) || null }) });
  } catch (e) { fail(res, e); }
});

// ---- curator: a signed-out claim request (intake_access_requests.node_id) ---------------

router.post("/api/review/access/approve", json, requireCurator, async (req, res) => {
  const db = getDb();
  const email = normaliseEmail(req.body?.email);
  const r = email ? (db.prepare("SELECT email, node_id, evidence FROM intake_access_requests WHERE email = ? AND node_id IS NOT NULL").get(email) as any) : null;
  if (!r) { res.status(404).set(JSON_HEADERS).json({ error: "no claim request for that address" }); return; }
  const node = db.prepare("SELECT id, type, name, slug FROM nodes WHERE id = ?").get(r.node_id) as any;
  if (!node) { res.status(404).set(JSON_HEADERS).json({ error: "the node is gone" }); return; }
  try {
    // The node's name is the default credit: they claimed to be it.
    const name = str(req.body?.name, 120) || node.name;
    const rec = contributorByEmail(db, r.email) ?? ensureContributorForEmail(db, { email: r.email, name, invite: true });
    ensureContributorForEmail(db, { email: r.email, invite: true });
    const who = contributorById(db, rec.id)!;
    const claim = requestClaim(db, { contributor: who, node_id: node.id, evidence: r.evidence });
    const done = claim.claim.status === "pending" ? approveClaim(db, claim.claim.id, { by: req.contributor!.name || "curator" }) : claim.claim;
    res.set(JSON_HEADERS).json({ claim: done });
    await sendClaimDecisionEmail(db, rec.id, node.id, true);
  } catch (e) { fail(res, e); }
});

router.post("/api/review/access/reject", json, requireCurator, (req, res) => {
  const email = normaliseEmail(req.body?.email);
  if (!email) { res.status(400).set(JSON_HEADERS).json({ error: "email is required" }); return; }
  getDb().prepare("UPDATE intake_access_requests SET node_id = NULL, evidence = NULL WHERE email = ?").run(email);
  res.set(JSON_HEADERS).json({ ok: true });
});

// ---- the personal log ------------------------------------------------------------------

router.get("/me", (req, res) => {
  res.set(PRIVATE_HTML_HEADERS).send(mePage());
});

router.get("/api/me/log", requireContributor, (req, res) => {
  const node = typeof req.query.node === "string" ? req.query.node : null;
  res.set({ ...JSON_HEADERS, "Cache-Control": "private, no-store" }).json(buildLog(getDb(), req.contributor!.id, node));
});

// How often a claimant hears what was added about their pages (issue #81).
router.get("/api/me/notifications", requireContributor, (req, res) => {
  res.set(JSON_HEADERS).json({ ...getNotifyPrefs(getDb(), req.contributor!.id), modes: EMAIL_MODES });
});

router.post("/api/me/notifications", json, requireContributor, (req, res) => {
  const mode = typeof req.body?.email === "string" ? req.body.email : "";
  if (!(EMAIL_MODES as readonly string[]).includes(mode)) {
    res.status(400).set(JSON_HEADERS).json({ error: "bad_mode", message: `email is one of ${EMAIL_MODES.join(", ")}` });
    return;
  }
  res.set(JSON_HEADERS).json({ ...setEmailMode(getDb(), req.contributor!.id, mode), modes: EMAIL_MODES });
});

function noteRoute(kind: "contest" | "context" | "objection") {
  return (req: Request, res: Response) => {
    const b = req.body ?? {};
    try {
      const n = fileNote(getDb(), {
        contributor: req.contributor!,
        kind,
        node_id: str(b.node_id, 300),
        note: typeof b.note === "string" ? b.note : "",
        relation: b.relation && typeof b.relation === "object" ? { source_id: str(b.relation.source_id, 300), edge_type: str(b.relation.edge_type, 60), target_id: str(b.relation.target_id, 300) } : undefined,
        edit: b.edit && typeof b.edit === "object" ? { key: str(b.edit.key, 120), signal_id: str(b.edit.signal_id, 120) } : undefined,
        queue_id: str(b.queue_id, 120) || undefined,
      });
      res.status(201).set(JSON_HEADERS).json({ note: n });
    } catch (e) { fail(res, e); }
  };
}

router.post("/api/me/contest", json, requireContributor, noteRoute("contest"));
router.post("/api/me/context", json, requireContributor, noteRoute("context"));
router.post("/api/me/objection", json, requireContributor, noteRoute("objection"));

router.post("/api/me/notes/:signal_id/withdraw", json, requireContributor, (req, res) => {
  try {
    res.set(JSON_HEADERS).json({ note: withdrawNote(getDb(), String(req.params.signal_id), req.contributor!.id) });
  } catch (e) { fail(res, e); }
});

router.post("/api/me/invite", json, requireContributor, async (req, res) => {
  const db = getDb();
  const inviter = req.contributor!;
  const email = normaliseEmail(req.body?.email);
  const nodeId = str(req.body?.node_id, 300);
  const message = str(req.body?.message, 1000) || null;
  if (!email) { res.status(400).set(JSON_HEADERS).json({ error: "bad_email", message: "a valid email is required" }); return; }
  try {
    const bridge = checkInvite(db, inviter.id, nodeId);
    const existing = db.prepare("SELECT contributor_id, revoked_at FROM contributor_emails WHERE email = ?").get(email) as any;
    if (existing?.revoked_at) throw new ClaimError(403, "address_revoked", "that address cannot be invited");
    const node = db.prepare("SELECT name FROM nodes WHERE id = ?").get(nodeId) as any;
    // A new address starts probationary, credited by the page's name until
    // they choose one; an existing contributor keeps their tier and name.
    const rec = existing
      ? contributorByEmail(db, email)!
      : ensureContributorForEmail(db, { email, name: str(req.body?.name, 120) || node?.name || "", tier: "probationary", invite: true });
    if (existing) ensureContributorForEmail(db, { email, invite: true });
    if (rec.id === inviter.id) throw new ClaimError(400, "self_invite", "that is your own address");
    const claim = recordPeerInviteClaim(db, { inviter, invitee_id: rec.id, node_id: nodeId });
    res.status(201).set(JSON_HEADERS).json({ claim: { id: claim.id, node_id: claim.node_id, status: claim.status } });
    await sendPeerInviteEmail(db, { email, inviterName: inviter.name, inviterNode: bridge.from_node, nodeId, edgeType: bridge.edge_type, message });
  } catch (e) { fail(res, e); }
});

/** For /api/intake/me: the contributor's claims, newest state. */
export function claimsForMe(contributorId: string) {
  return myNodes(getDb(), contributorId);
}

export default router;
