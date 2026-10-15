// The candidate model for URL-intake drafts (docs/URL-INTAKE-SPEC.md §5.2, §7).
//
// A draft is a list of candidates the worker proposes and the contributor
// accepts, rejects or edits. Nothing here touches the graph — confirm
// (src/intake/draft.ts) is the only path from a candidate to a signal.
//
// The validator is hand-written (no schema dependency) and runs on EVERY
// worker write, so the relation policy in §7 is enforced in code, not in
// the prompt. worker/src/candidate.ts is a types-only copy; keep the two in
// step when a field changes.

import { normaliseOrgKinds, orgKindsError } from "../utils/org-kinds.js";
import { legacySlugify } from "../utils/slug.js";

export type Ref = string; // existing node id, or 'cid:c_03' for a node candidate in this draft

export interface Evidence {
  page_url: string;
  quote: string; // <= 300 chars, verbatim
}

export type CandidateState = "proposed" | "accepted" | "rejected" | "context_only" | "answered";
export type Origin = "site" | "graph" | "embedding" | "contributor";

export const CANDIDATE_STATES: ReadonlySet<string> = new Set([
  "proposed", "accepted", "rejected", "context_only", "answered",
]);
export const ORIGINS: ReadonlySet<string> = new Set(["site", "graph", "embedding", "contributor"]);

export const CANDIDATE_NODE_TYPES = [
  "practitioner", "artwork", "project", "institution", "collective", "concept", "platform",
] as const;
export type CandidateNodeType = (typeof CANDIDATE_NODE_TYPES)[number];

// §7 — the only edge types a page may attest. INFLUENCES / RESPONDS_TO reach
// the graph only through a `question` the contributor answered.
export const SUGGESTABLE_EDGE_TYPES = [
  "CREATED_BY", "EXHIBITED_AT", "HELD_BY", "PARTICIPATED_IN", "PRESENTED_BY", "CURATED_BY",
  "REPRESENTS", "USES_TECHNIQUE", "EMBODIES", "BELONGS_TO", "COLLABORATES_WITH",
] as const;
export type SuggestableEdgeType = (typeof SUGGESTABLE_EDGE_TYPES)[number];
export const QUESTION_EDGE_TYPES = [...SUGGESTABLE_EDGE_TYPES, "INFLUENCES", "RESPONDS_TO"] as const;

// Which way each relation runs, by node type (source → target). The type
// names alone were checked before; direction was left to the prompt, and a
// Fellowship run produced "John Gerrard REPRESENTS Fellowship" from a quote
// that said the opposite. Matches every live edge on the graph (Sept 2026).
const ARTIST = ["practitioner", "collective"];
export const EDGE_DIRECTIONS: Record<string, { source: readonly string[]; target: readonly string[]; symmetric?: boolean }> = {
  CREATED_BY: { source: ["artwork"], target: ARTIST },
  EXHIBITED_AT: { source: ["artwork"], target: ["institution", "project", "platform"] },
  HELD_BY: { source: ["artwork"], target: ["institution"] },
  PARTICIPATED_IN: { source: ARTIST, target: ["project"] },
  PRESENTED_BY: { source: ["project"], target: ["institution", "platform", "collective"] },
  CURATED_BY: { source: ["project"], target: ARTIST },
  REPRESENTS: { source: ["institution", "platform"], target: ARTIST },
  USES_TECHNIQUE: { source: ["artwork", ...ARTIST], target: ["concept"] },
  EMBODIES: { source: ["artwork"], target: ["concept"] },
  BELONGS_TO: { source: ARTIST, target: ["collective", "scene"] },
  COLLABORATES_WITH: { source: ARTIST, target: ARTIST, symmetric: true },
  INFLUENCES: { source: ["artwork", ...ARTIST], target: ["artwork", ...ARTIST] },
  RESPONDS_TO: { source: ["artwork"], target: ["artwork"] },
};

/**
 * Refuse an edge whose endpoints have the wrong types for its relation,
 * with a message the agent can act on — a swapped pair says "swap".
 * `typeOf` returns null when a ref's type cannot be known (then no check).
 */
export function checkDirection(edge: { source: string; target: string; edge_type: string }, typeOf: (ref: string) => string | null, field = "edge"): void {
  const rule = EDGE_DIRECTIONS[edge.edge_type];
  if (!rule) return;
  const s = typeOf(edge.source);
  const t = typeOf(edge.target);
  if (!s || !t) return;
  if (rule.source.includes(s) && rule.target.includes(t)) return;
  const swapped = rule.source.includes(t) && rule.target.includes(s);
  throw new CandidateError(
    `${edge.edge_type} runs ${rule.source.join("/")} -> ${rule.target.join("/")}; got ${s} -> ${t}` +
      (swapped ? `. Swap source and target: ${edge.target} ${edge.edge_type} ${edge.source}.` : "."),
    `${field}.edge_type`
  );
}

// Relations that describe the present ("represents"), as opposed to events
// ("was shown at", 2021). An event stays true after the site moves on; a
// present-tense claim can lapse, so a later read of the same site may
// propose ending it — an `ended` card, never an automatic supersession.
export const PRESENT_TENSE_EDGE_TYPES = ["REPRESENTS"] as const;

export type Confidence = "high" | "medium" | "low";

export interface CandidateBase {
  cid: string;
  state: CandidateState;
  origin: Origin;
  evidence?: Evidence;
  note?: string;
  edited: boolean;
  // The reader's proposal, kept the first time the contributor changes the
  // card's content (not its state). Set only by contributorPatchCandidate —
  // validateCandidate drops it, so the worker can never supply one. Confirm
  // copies it into the signal's provenance: what was proposed vs. what landed.
  proposed_as?: Record<string, unknown>;
}

export interface NodeCandidate extends CandidateBase {
  kind: "node";
  node: {
    type: CandidateNodeType;
    name: string;
    metadata: Record<string, unknown>;
    aliases: Array<{ source: "web"; external_id: string }>;
  };
  resolves_to: string | null;
  resolution: "exact" | "alias" | "fuzzy" | "none";
}

export interface EdgeSpec {
  source: Ref;
  target: Ref;
  edge_type: SuggestableEdgeType | "INFLUENCES" | "RESPONDS_TO";
  event_time?: string;
  confidence: Confidence;
}

export interface EdgeCandidate extends CandidateBase {
  kind: "edge";
  edge: EdgeSpec & { edge_type: SuggestableEdgeType };
}

export interface ImageCandidate extends CandidateBase {
  kind: "image";
  image: { for: Ref; image_url: string; page_url: string; alt?: string; width?: number; height?: number };
}

export interface PatchCandidate extends CandidateBase {
  kind: "patch";
  patch: { node_id: string; key: string; existing: unknown; proposed: unknown };
}

export interface QuestionCandidate extends CandidateBase {
  kind: "question";
  question: { text: string; if_yes: EdgeSpec; answer?: string; answered_yes?: boolean };
}

export interface KnownCandidate extends CandidateBase {
  kind: "known";
  known: { node_id: string; edge_type?: string; other_id?: string; summary: string };
}

/**
 * A present-tense relation this site attested on an earlier read and no
 * longer shows. Accepting it ends the edge (valid_until) — it never deletes
 * it. Evidence is the page as it reads now.
 */
export interface EndedCandidate extends CandidateBase {
  kind: "ended";
  ended: { edge_id: string; edge_type: string; source_id: string; target_id: string; last_seen?: string; summary: string };
}

export type Candidate =
  | NodeCandidate
  | EdgeCandidate
  | ImageCandidate
  | PatchCandidate
  | QuestionCandidate
  | KnownCandidate
  | EndedCandidate;

export const MAX_CANDIDATES = 300;
export const MAX_PAGES = 240;
export const MAX_QUESTIONS = 10;
export const MAX_QUOTE_CHARS = 300;
export const MAX_NOTE_CHARS = 400;
export const MAX_NAME_CHARS = 200;

export class CandidateError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "CandidateError";
  }
}

// ---- small helpers ---------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown, field: string, max: number, opts: { required?: boolean } = {}): string | undefined {
  if (v === undefined || v === null) {
    if (opts.required) throw new CandidateError(`${field} is required`, field);
    return undefined;
  }
  if (typeof v !== "string") throw new CandidateError(`${field} must be a string`, field);
  const s = v.trim();
  if (!s && opts.required) throw new CandidateError(`${field} must not be empty`, field);
  if (s.length > max) throw new CandidateError(`${field} exceeds ${max} chars`, field);
  return s;
}

const CID_RE = /^c_\d{2,4}$/;
const NODE_ID_RE = /^[a-z_]+:[^\s][^\n]{0,199}$/;
const HTTP_RE = /^https?:\/\/[^\s]+$/i;

function checkUrl(v: unknown, field: string): string {
  const s = str(v, field, 2048, { required: true })!;
  if (!HTTP_RE.test(s)) throw new CandidateError(`${field} must be an absolute http(s) URL`, field);
  return s;
}

export function isCidRef(ref: string): boolean {
  return ref.startsWith("cid:");
}

function checkRef(v: unknown, field: string): string {
  const s = str(v, field, 220, { required: true })!;
  if (isCidRef(s)) {
    if (!CID_RE.test(s.slice(4))) throw new CandidateError(`${field}: malformed cid ref '${s}'`, field);
    return s;
  }
  if (!NODE_ID_RE.test(s)) throw new CandidateError(`${field}: '${s}' is not a node id`, field);
  return s;
}

function checkEvidence(v: unknown, field = "evidence"): Evidence {
  if (!isObj(v)) throw new CandidateError(`${field} is required ({page_url, quote})`, field);
  const page_url = checkUrl(v.page_url, `${field}.page_url`);
  const quote = str(v.quote, `${field}.quote`, MAX_QUOTE_CHARS, { required: true })!;
  return { page_url, quote };
}

function checkConfidence(v: unknown, field: string): Confidence {
  const s = str(v, field, 10) ?? "medium";
  if (s !== "high" && s !== "medium" && s !== "low") {
    throw new CandidateError(`${field} must be high | medium | low`, field);
  }
  return s;
}

function checkEventTime(v: unknown, field: string): string | undefined {
  const s = str(v, field, 32);
  if (s === undefined || s === "") return undefined;
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(s)) {
    throw new CandidateError(`${field} must be YYYY, YYYY-MM or YYYY-MM-DD`, field);
  }
  return s;
}

function checkEdgeSpec(v: unknown, field: string, allowed: readonly string[]): EdgeSpec {
  if (!isObj(v)) throw new CandidateError(`${field} is required`, field);
  const source = checkRef(v.source, `${field}.source`);
  const target = checkRef(v.target, `${field}.target`);
  const edge_type = str(v.edge_type, `${field}.edge_type`, 40, { required: true })!;
  if (!allowed.includes(edge_type)) {
    throw new CandidateError(
      `${field}.edge_type '${edge_type}' is not suggestable from a web page; allowed: ${allowed.join(", ")}`,
      `${field}.edge_type`
    );
  }
  if (source === target) throw new CandidateError(`${field}: source and target are the same`, field);
  const out: EdgeSpec = {
    source,
    target,
    edge_type: edge_type as EdgeSpec["edge_type"],
    confidence: checkConfidence(v.confidence, `${field}.confidence`),
  };
  const et = checkEventTime(v.event_time, `${field}.event_time`);
  if (et) out.event_time = et;
  return out;
}

/**
 * `metadata.kind` on an institution: values from the fixed list (normalised
 * in place to an array), and — when the agent proposes it from a page — the
 * organisation's own words for it in `metadata.kind_source` {page_url, quote}.
 */
function checkOrgKinds(metadata: Record<string, unknown>, origin: Origin): void {
  if (metadata.kind === undefined || metadata.kind === null) return;
  const k = normaliseOrgKinds(metadata.kind);
  if (!k.ok) throw new CandidateError(orgKindsError(k.unknown), "node.metadata.kind");
  metadata.kind = k.kinds;
  if (origin === "site") {
    if (metadata.kind_source === undefined) {
      throw new CandidateError("metadata.kind needs metadata.kind_source {page_url, quote}: how the organisation describes itself on its own site", "node.metadata.kind_source");
    }
    metadata.kind_source = checkEvidence(metadata.kind_source, "node.metadata.kind_source");
  }
}

// ---- the validator -----------------------------------------------------

/**
 * Validate one candidate in isolation. `existing` is the current candidate
 * list of the draft — needed for cid-ref resolution and the question cap.
 * `nodeExists` answers "does `<type>:<slug>` already live in the graph?" so
 * a `node` candidate whose deterministic id collides must carry
 * `resolves_to` (materialiseCreateNode is first-write-wins).
 *
 * Returns a normalised copy; throws CandidateError with a message the agent
 * can act on.
 */
export function validateCandidate(
  raw: unknown,
  existing: Candidate[],
  ctx: { nodeExists?: (id: string) => boolean; slugify?: (name: string) => string } = {}
): Candidate {
  if (!isObj(raw)) throw new CandidateError("candidate must be an object");
  const cid = str(raw.cid, "cid", 12, { required: true })!;
  if (!CID_RE.test(cid)) throw new CandidateError("cid must look like c_01", "cid");
  const kind = str(raw.kind, "kind", 20, { required: true })!;
  const state = (str(raw.state, "state", 20) ?? "proposed") as CandidateState;
  if (!CANDIDATE_STATES.has(state)) throw new CandidateError(`state '${state}' is invalid`, "state");
  const origin = (str(raw.origin, "origin", 20) ?? "site") as Origin;
  if (!ORIGINS.has(origin)) throw new CandidateError(`origin '${origin}' is invalid`, "origin");
  const note = str(raw.note, "note", MAX_NOTE_CHARS);
  const edited = raw.edited === true;

  const base: CandidateBase = { cid, state, origin, edited };
  if (note) base.note = note;
  if (raw.evidence !== undefined && raw.evidence !== null) base.evidence = checkEvidence(raw.evidence);

  // Every ref must point somewhere real: a node candidate in this draft
  // (cid:) or an existing node in the graph. Without the graph check an
  // edge to a guessed id like 'practitioner:some-curator' would validate and
  // confirm would write a dangling edge.
  const cidRefOk = (ref: string, field: string) => {
    if (isCidRef(ref)) {
      const target = ref.slice(4);
      const hit = existing.find((c) => c.cid === target);
      if (!hit) throw new CandidateError(`${field}: ${ref} does not exist in this draft`, field);
      if (hit.kind !== "node") throw new CandidateError(`${field}: ${ref} is not a node candidate`, field);
      return;
    }
    if (ctx.nodeExists && !ctx.nodeExists(ref)) {
      throw new CandidateError(`${field}: node '${ref}' does not exist in A(DAI) — use resolve_entity to find the real id, or propose_node and reference it as cid:c_NN`, field);
    }
  };

  // The type of a ref: a node card's type, or the prefix of a node id.
  const typeOfRef = (ref: string): string | null => {
    if (isCidRef(ref)) {
      const hit = existing.find((c) => c.cid === ref.slice(4));
      return hit && hit.kind === "node" ? hit.node.type : null;
    }
    const i = ref.indexOf(":");
    return i > 0 ? ref.slice(0, i) : null;
  };

  switch (kind) {
    case "node": {
      if (!isObj(raw.node)) throw new CandidateError("node is required", "node");
      const type = str(raw.node.type, "node.type", 40, { required: true })!;
      if (!(CANDIDATE_NODE_TYPES as readonly string[]).includes(type)) {
        throw new CandidateError(`node.type '${type}' not allowed; use ${CANDIDATE_NODE_TYPES.join(", ")}`, "node.type");
      }
      const name = str(raw.node.name, "node.name", MAX_NAME_CHARS, { required: true })!;
      const metadata = isObj(raw.node.metadata) ? { ...raw.node.metadata } : {};
      if (JSON.stringify(metadata).length > 20_000) throw new CandidateError("node.metadata too large", "node.metadata");
      if (type === "institution") checkOrgKinds(metadata, origin);
      const aliasesRaw = Array.isArray(raw.node.aliases) ? raw.node.aliases : [];
      const aliases: NodeCandidate["node"]["aliases"] = [];
      for (const a of aliasesRaw) {
        if (!isObj(a)) continue;
        const ext = str(a.external_id, "node.aliases.external_id", 2048);
        if (ext) aliases.push({ source: "web", external_id: ext });
      }
      const resolves_to = raw.resolves_to === undefined || raw.resolves_to === null
        ? null
        : checkRef(raw.resolves_to, "resolves_to");
      if (resolves_to && isCidRef(resolves_to)) throw new CandidateError("resolves_to must be an existing node id", "resolves_to");
      if (resolves_to) cidRefOk(resolves_to, "resolves_to");
      const resolution = (str(raw.resolution, "resolution", 10) ?? (resolves_to ? "fuzzy" : "none")) as NodeCandidate["resolution"];
      if (!["exact", "alias", "fuzzy", "none"].includes(resolution)) throw new CandidateError("resolution invalid", "resolution");
      if (resolves_to && resolution === "none") throw new CandidateError("resolution 'none' with resolves_to set", "resolution");
      if (!resolves_to && resolution !== "none") throw new CandidateError(`resolution '${resolution}' without resolves_to`, "resolution");
      if (origin === "site" && !base.evidence) throw new CandidateError("node with origin 'site' needs evidence {page_url, quote}", "evidence");
      if (!resolves_to && ctx.nodeExists && ctx.slugify) {
        // A node made from the same name under the pre-October-2026 slug
        // rules (`toujours-là`) is the same collision.
        const id = [`${type}:${ctx.slugify(name)}`, `${type}:${legacySlugify(name)}`].find(ctx.nodeExists);
        if (id) {
          throw new CandidateError(
            `a node with id '${id}' already exists; set resolves_to to link it, or ask the contributor`,
            "resolves_to"
          );
        }
      }
      return { ...base, kind: "node", node: { type: type as CandidateNodeType, name, metadata, aliases }, resolves_to, resolution };
    }

    case "edge": {
      const edge = checkEdgeSpec(raw.edge, "edge", SUGGESTABLE_EDGE_TYPES);
      cidRefOk(edge.source, "edge.source");
      cidRefOk(edge.target, "edge.target");
      if (origin === "site" && !base.evidence) throw new CandidateError("edge with origin 'site' needs evidence {page_url, quote}", "evidence");
      if (origin === "embedding") throw new CandidateError("sensed (embedding) relations may only be 'known' or 'question', never 'edge'", "origin");
      checkDirection(edge, typeOfRef, "edge");
      if (edge.edge_type === "COLLABORATES_WITH") {
        // The quote must name the other party — check the target's/source's
        // name against the quote when the referent is a candidate in this
        // draft; for existing nodes the caller can't cheaply know the name,
        // so we require at least a quote (already enforced above).
        const q = base.evidence?.quote.toLowerCase() ?? "";
        const named = [edge.source, edge.target]
          .filter(isCidRef)
          .map((r) => existing.find((c) => c.cid === r.slice(4)))
          .filter((c): c is NodeCandidate => !!c && c.kind === "node")
          .map((c) => c.node.name.toLowerCase());
        if (named.length && !named.some((n) => q.includes(n.split(" ")[0] ?? n))) {
          throw new CandidateError("COLLABORATES_WITH needs a quote that names the other party", "evidence.quote");
        }
      }
      return { ...base, kind: "edge", edge: edge as EdgeCandidate["edge"] };
    }

    case "image": {
      if (!isObj(raw.image)) throw new CandidateError("image is required", "image");
      const forRef = checkRef(raw.image.for, "image.for");
      cidRefOk(forRef, "image.for");
      const image_url = checkUrl(raw.image.image_url, "image.image_url");
      const page_url = checkUrl(raw.image.page_url, "image.page_url");
      const alt = str(raw.image.alt, "image.alt", 300);
      const w = typeof raw.image.width === "number" && raw.image.width > 0 ? Math.floor(raw.image.width) : undefined;
      const h = typeof raw.image.height === "number" && raw.image.height > 0 ? Math.floor(raw.image.height) : undefined;
      const image: ImageCandidate["image"] = { for: forRef, image_url, page_url };
      if (alt) image.alt = alt;
      if (w) image.width = w;
      if (h) image.height = h;
      return { ...base, kind: "image", image };
    }

    case "patch": {
      if (!isObj(raw.patch)) throw new CandidateError("patch is required", "patch");
      const node_id = checkRef(raw.patch.node_id, "patch.node_id");
      if (isCidRef(node_id)) throw new CandidateError("patch.node_id must be an existing node", "patch.node_id");
      cidRefOk(node_id, "patch.node_id");
      const key = str(raw.patch.key, "patch.key", 80, { required: true })!;
      if (!/^[a-z0-9_]+$/i.test(key)) throw new CandidateError("patch.key must be a metadata key", "patch.key");
      if (raw.patch.proposed === undefined) throw new CandidateError("patch.proposed is required", "patch.proposed");
      let proposed = raw.patch.proposed;
      if (key === "kind" && node_id.startsWith("institution:")) {
        const k = normaliseOrgKinds(proposed);
        if (!k.ok) throw new CandidateError(orgKindsError(k.unknown), "patch.proposed");
        proposed = k.kinds;
      }
      if (origin === "site" && !base.evidence) throw new CandidateError("patch with origin 'site' needs evidence {page_url, quote}", "evidence");
      return {
        ...base,
        kind: "patch",
        patch: { node_id, key, existing: raw.patch.existing ?? null, proposed },
      };
    }

    case "question": {
      if (!isObj(raw.question)) throw new CandidateError("question is required", "question");
      const text = str(raw.question.text, "question.text", 500, { required: true })!;
      const if_yes = checkEdgeSpec(raw.question.if_yes, "question.if_yes", QUESTION_EDGE_TYPES);
      cidRefOk(if_yes.source, "question.if_yes.source");
      cidRefOk(if_yes.target, "question.if_yes.target");
      checkDirection(if_yes, typeOfRef, "question.if_yes");
      const others = existing.filter((c) => c.kind === "question" && c.cid !== cid).length;
      if (others >= MAX_QUESTIONS) throw new CandidateError(`at most ${MAX_QUESTIONS} questions per draft`, "question");
      const answer = str(raw.question.answer, "question.answer", 1000);
      const q: QuestionCandidate["question"] = { text, if_yes };
      if (answer) q.answer = answer;
      if (typeof raw.question.answered_yes === "boolean") q.answered_yes = raw.question.answered_yes;
      if (state === "accepted") throw new CandidateError("questions are answered, not accepted", "state");
      return { ...base, kind: "question", question: q };
    }

    case "known": {
      if (!isObj(raw.known)) throw new CandidateError("known is required", "known");
      const node_id = checkRef(raw.known.node_id, "known.node_id");
      cidRefOk(node_id, "known.node_id");
      const summary = str(raw.known.summary, "known.summary", 400, { required: true })!;
      const edge_type = str(raw.known.edge_type, "known.edge_type", 40);
      const other_id = raw.known.other_id ? checkRef(raw.known.other_id, "known.other_id") : undefined;
      if (other_id) cidRefOk(other_id, "known.other_id");
      if (state === "accepted") throw new CandidateError("'known' cannot be accepted — A(DAI) already has it", "state");
      const known: KnownCandidate["known"] = { node_id, summary };
      if (edge_type) known.edge_type = edge_type;
      if (other_id) known.other_id = other_id;
      return { ...base, kind: "known", known };
    }

    case "ended": {
      if (!isObj(raw.ended)) throw new CandidateError("ended is required", "ended");
      const edge_id = str(raw.ended.edge_id, "ended.edge_id", 600, { required: true })!;
      const edge_type = str(raw.ended.edge_type, "ended.edge_type", 40, { required: true })!;
      if (!(PRESENT_TENSE_EDGE_TYPES as readonly string[]).includes(edge_type)) {
        throw new CandidateError(`only present-tense relations (${PRESENT_TENSE_EDGE_TYPES.join(", ")}) can end; '${edge_type}' is an event and stays true`, "ended.edge_type");
      }
      const source_id = checkRef(raw.ended.source_id, "ended.source_id");
      const target_id = checkRef(raw.ended.target_id, "ended.target_id");
      if (isCidRef(source_id) || isCidRef(target_id)) throw new CandidateError("ended refers to an edge in the graph, not to draft cards", "ended");
      const summary = str(raw.ended.summary, "ended.summary", 400, { required: true })!;
      const last_seen = str(raw.ended.last_seen, "ended.last_seen", 32);
      if (!base.evidence) throw new CandidateError("ended needs evidence {page_url, quote}: the page as it reads now", "evidence");
      if (origin !== "site") throw new CandidateError("ended cards come from reading the site (origin 'site')", "origin");
      const ended: EndedCandidate["ended"] = { edge_id, edge_type, source_id, target_id, summary };
      if (last_seen) ended.last_seen = last_seen;
      return { ...base, kind: "ended", ended };
    }

    default:
      throw new CandidateError(`unknown candidate kind '${kind}'`, "kind");
  }
}

/** Validate a full list (used when re-reading drafts.candidates defensively). */
export function validateCandidates(raw: unknown): Candidate[] {
  if (!Array.isArray(raw)) throw new CandidateError("candidates must be an array");
  if (raw.length > MAX_CANDIDATES) throw new CandidateError(`more than ${MAX_CANDIDATES} candidates`);
  const out: Candidate[] = [];
  for (const r of raw) out.push(validateCandidate(r, out));
  return out;
}

/** Next free cid for a draft. */
export function nextCid(existing: Candidate[]): string {
  let max = 0;
  for (const c of existing) {
    const n = parseInt(c.cid.slice(2), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `c_${String(max + 1).padStart(2, "0")}`;
}

/**
 * Contributor-side state transition. Keeps the server the source of truth
 * for what a card may do: `known` never accepts, questions are answered.
 */
export function applyContributorPatch(
  c: Candidate,
  patch: { state?: unknown; patch?: unknown; answer?: unknown; answered_yes?: unknown }
): Candidate {
  const next: Candidate = JSON.parse(JSON.stringify(c));
  if (patch.state !== undefined) {
    const s = String(patch.state);
    if (!CANDIDATE_STATES.has(s)) throw new CandidateError(`state '${s}' is invalid`, "state");
    if (c.kind === "known" && s === "accepted") throw new CandidateError("'known' cannot be accepted", "state");
    if (c.kind === "question" && s === "accepted") throw new CandidateError("answer the question instead", "state");
    next.state = s as CandidateState;
  }
  if (next.kind === "question") {
    if (patch.answer !== undefined) {
      next.question.answer = str(patch.answer, "answer", 1000) ?? "";
      next.state = "answered";
    }
    if (typeof patch.answered_yes === "boolean") {
      next.question.answered_yes = patch.answered_yes;
      next.state = "answered";
    }
  }
  if (isObj(patch.patch)) {
    const p = patch.patch;
    if (next.kind === "node") {
      if (p.name !== undefined) next.node.name = str(p.name, "patch.name", MAX_NAME_CHARS, { required: true })!;
      if (p.type !== undefined) {
        const t = String(p.type);
        if (!(CANDIDATE_NODE_TYPES as readonly string[]).includes(t)) throw new CandidateError("patch.type invalid", "patch.type");
        next.node.type = t as CandidateNodeType;
      }
      if (isObj(p.metadata)) next.node.metadata = { ...next.node.metadata, ...p.metadata };
      if (p.resolves_to !== undefined) {
        if (p.resolves_to === null) { next.resolves_to = null; next.resolution = "none"; }
        else { next.resolves_to = checkRef(p.resolves_to, "patch.resolves_to"); next.resolution = "fuzzy"; }
      }
    } else if (next.kind === "edge") {
      if (p.edge_type !== undefined) {
        const t = String(p.edge_type);
        if (!(SUGGESTABLE_EDGE_TYPES as readonly string[]).includes(t)) throw new CandidateError("patch.edge_type outside policy", "patch.edge_type");
        next.edge.edge_type = t as SuggestableEdgeType;
      }
      if (p.event_time !== undefined) {
        const et = checkEventTime(p.event_time, "patch.event_time");
        if (et) next.edge.event_time = et; else delete next.edge.event_time;
      }
    } else if (next.kind === "patch") {
      if (p.proposed !== undefined) next.patch.proposed = p.proposed;
    } else if (next.kind === "image") {
      if (p.alt !== undefined) next.image.alt = str(p.alt, "patch.alt", 300) ?? undefined;
    }
    next.edited = true;
  }
  if (patch.state !== undefined || patch.answer !== undefined || patch.answered_yes !== undefined) next.edited = true;
  return next;
}
