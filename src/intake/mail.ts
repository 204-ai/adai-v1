// The three intake emails (docs/URL-INTAKE-SPEC.md §11): login link,
// draft ready (or failed), receipt. Short, plain text with an HTML twin,
// no tracking. Sending goes through src/utils/mail.ts (stdout in dev).

import type { DatabaseSync } from "node:sqlite";
import { sendMail, textToHtml } from "../utils/mail.js";
import { issueMagicLink, baseUrl } from "./auth.js";
import type { Draft } from "./draft.js";
import type { ConfirmResult } from "./draft.js";

function from(): string {
  return process.env.INTAKE_FROM || "A(DAI) <contribute@fragcolor.com>";
}

export function replyTo(): string[] {
  return (process.env.ADMIN_NOTIFY_EMAILS || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

export async function send(to: string, subject: string, text: string, html?: string): Promise<void> {
  try {
    await sendMail({ from: from(), to: [to], replyTo: replyTo(), subject, text, html: html ?? textToHtml(text) });
  } catch (e: any) {
    console.error(`[intake-mail] failed to send "${subject}" to ${to}: ${e?.message ?? e}`);
  }
}

export async function sendLoginEmail(db: DatabaseSync, email: string, ip: string | null, redirect?: string | null): Promise<void> {
  const link = issueMagicLink(db, { email, purpose: "login", redirect: redirect ?? null, ip });
  const text =
    `Here is your A(DAI) sign-in link. It works once and expires in 15 minutes:\n\n${link.url}\n\n` +
    `If you did not ask for this, ignore it.`;
  await send(email, "Your A(DAI) sign-in link", text);
}

/** To the admins (ADMIN_NOTIFY_EMAILS): an uninvited address asked to sign in. */
export async function sendAccessRequestEmail(email: string): Promise<void> {
  const admins = replyTo();
  if (!admins.length) return;
  const text =
    `${email} asked for a sign-in link to the A(DAI) URL intake, which is invite-only.\n\n` +
    `To invite them (admin token, or ask Claude with the admin skill):\n` +
    `  POST ${baseUrl()}/api/v1/invites {"email": "${email}", "name": "…", "send": true}\n` +
    `or: just invite-prod ${email} "Name" probationary\n\n` +
    `Pending requests: GET ${baseUrl()}/api/v1/invites`;
  for (const to of admins) await send(to, `A(DAI) access request: ${email}`, text);
}

/** The requester said how they'd like to appear (issue #72): once per request. */
export async function sendAccessRequestDetailsEmail(email: string, name: string, about: string | null): Promise<void> {
  const admins = replyTo();
  if (!admins.length) return;
  const text =
    `${email} would like to appear in the commons as: ${name}\n` +
    (about ? `\nAbout them: ${about}\n` : "") +
    `\nTo invite them under that name (it is the default when "name" is left out):\n` +
    `  POST ${baseUrl()}/api/v1/invites {"email": "${email}", "send": true}`;
  // No ready-made shell line here: the name is the requester's own text.
  for (const to of admins) await send(to, `A(DAI) access request: ${name} <${email}>`, text);
}

export function candidateCounts(d: Draft): { works: number; shows: number; people: number; images: number; questions: number; known: number } {
  let works = 0, shows = 0, people = 0, images = 0, questions = 0, known = 0;
  for (const c of d.candidates) {
    if (c.kind === "node") {
      if (c.node.type === "artwork") works++;
      else if (c.node.type === "project" || c.node.type === "institution") shows++;
      else people++;
    } else if (c.kind === "image") images++;
    else if (c.kind === "question") questions++;
    else if (c.kind === "known") known++;
  }
  return { works, shows, people, images, questions, known };
}

export async function sendDraftReadyEmail(db: DatabaseSync, email: string, draft: Draft): Promise<void> {
  const link = issueMagicLink(db, { email, purpose: "draft_ready", redirect: `/draft/${draft.id}` });
  const c = candidateCounts(draft);
  const text =
    `Your draft from ${draft.source_domain} is ready.\n\n` +
    (draft.summary ? `${draft.summary}\n\n` : "") +
    `${c.works} works · ${c.shows} shows and venues · ${c.people} people and organisations · ${c.images} images · ${c.known} already in A(DAI) · ${c.questions} questions for you\n\n` +
    `Review and confirm what you want to submit:\n${link.url}\n\n` +
    `Nothing goes into A(DAI) until you press Confirm. The link signs you in and is valid for 7 days.`;
  await send(email, `Your draft from ${draft.source_domain} is ready`, text);
}

export async function sendDraftFailedEmail(db: DatabaseSync, email: string, draft: Draft): Promise<void> {
  const link = issueMagicLink(db, { email, purpose: "draft_ready", redirect: `/draft/${draft.id}` });
  const text =
    `We could not read ${draft.source_domain}.\n\n` +
    `${draft.error ? `What happened: ${draft.error}\n\n` : ""}` +
    `You can try another URL here:\n${link.url}\n\n` +
    `Reply to this email if you think the site should have worked and a person will look.`;
  await send(email, `We could not read ${draft.source_domain}`, text);
}

// The receipt is the contributor's thank-you (copy by Iri, 2026-10-06). Built
// as blocks so the plain-text body and the HTML twin say the same thing, but
// the HTML can put the links behind their labels.
type Block = { p: string } | { list: string[] } | { link: string; url: string };

function blocksToText(blocks: Block[]): string {
  return blocks.map((b) =>
    "p" in b ? b.p : "list" in b ? b.list.map((l) => `- ${l}`).join("\n") : `${b.link}:\n${b.url}`,
  ).join("\n\n");
}

function blocksToHtml(blocks: Block[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const P = `style="margin:0 0 14px;line-height:1.5"`;
  const body = blocks.map((b) =>
    "p" in b ? `<p ${P}>${esc(b.p).replace(/\n/g, "<br>")}</p>`
    : "list" in b ? `<ul style="margin:0 0 14px;padding-left:20px;line-height:1.5">${b.list.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`
    : `<p ${P}><a href="${esc(b.url)}">${esc(b.link)}</a></p>`,
  ).join("");
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#1a1a1a;max-width:560px;margin:24px auto;padding:0 16px">${body}</body></html>`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function receiptEmail(
  name: string, draft: Draft, result: ConfirmResult, receiptUrl: string, profileUrl: string | null,
): { subject: string; text: string; html: string } {
  const live = result.status === "live";
  const counts: Array<[number, string, string]> = [
    [result.created_nodes.length, "new record for works, people, or exhibitions", "new records for works, people, or exhibitions"],
    [result.linked_nodes.length, "connection to a record already in A(DAI)", "connections to records already in A(DAI)"],
    [result.edges.length, "relationship, such as who made a work or took part in an exhibition", "relationships, such as who made a work or took part in an exhibition"],
    [result.images.length, "image", "images"],
    [result.patched_nodes.length, "update to an existing record", "updates to existing records"],
    [result.ended.length, "relationship marked as ended, because the site no longer shows it", "relationships marked as ended, because the site no longer shows them"],
  ];
  const shown = counts.filter(([n]) => n > 0);
  const total = shown.reduce((a, [n]) => a + n, 0);
  const blocks: Block[] = [
    { p: name.trim() ? `Hi ${name.trim()},` : "Hi," },
    { p: "Thank you for adding to the Digital Arts Commons. Your contribution helps preserve the works, relationships, and context that make up the field’s shared history." },
    { p: live
      ? "We’ve received your contribution, and it is now part of the public record."
      : "We’ve received your contribution and will review it before it becomes public." },
    { p: `From ${draft.source_domain}, you submitted ${plural(total, "addition", "additions")}:` },
  ];
  if (shown.length) blocks.push({ list: shown.map(([n, one, many]) => plural(n, one, many)) });
  if (result.skipped.length) blocks.push({ p: `${plural(result.skipped.length, "item", "items")} could not be added; the page below says why.` });
  blocks.push({ link: live ? "View your contribution" : "View your contribution and its review status", url: receiptUrl });
  if (profileUrl) {
    blocks.push({ p: "You can also explore the existing record around your practice:" });
    blocks.push({ link: "Explore your practice in A(DAI)", url: profileUrl });
  }
  blocks.push({ p: "If something needs correcting or more context, reply to this email, we’ll help. We’d also love to hear how the process felt and what could be clearer." });
  blocks.push({ p: `Warmly,\nA(DAI) team\nContribution reference: ${draft.id}` });
  return { subject: "Thank you for contributing to A(DAI)", text: blocksToText(blocks), html: blocksToHtml(blocks) };
}

export async function sendReceiptEmail(db: DatabaseSync, email: string, name: string, draft: Draft, result: ConfirmResult): Promise<void> {
  const link = issueMagicLink(db, { email, purpose: "receipt", redirect: `/batch/${draft.id}` });
  const subject = draft.subject_node_id && !draft.subject_node_id.startsWith("cid:")
    ? db.prepare("SELECT type, slug FROM nodes WHERE id = ?").get(draft.subject_node_id) as { type: string; slug: string } | undefined
    : undefined;
  const profileUrl = subject?.slug ? `${baseUrl()}/${subject.type}/${encodeURIComponent(subject.slug)}` : null;
  const m = receiptEmail(name, draft, result, link.url, profileUrl);
  await send(email, m.subject, m.text, m.html);
}
