// Types-only copy of src/intake/candidate.ts (the main app validates; the
// worker only shapes tool inputs). Keep in step when a field changes.

export type Ref = string;
export interface Evidence { page_url: string; quote: string }
export type CandidateState = "proposed" | "accepted" | "rejected" | "context_only" | "answered" | "open";
export type Origin = "site" | "graph" | "embedding" | "contributor";
export type CandidateNodeType = "practitioner" | "artwork" | "project" | "institution" | "collective" | "concept" | "platform";
export type SuggestableEdgeType =
  | "CREATED_BY" | "EXHIBITED_AT" | "HELD_BY" | "PARTICIPATED_IN" | "PRESENTED_BY" | "CURATED_BY"
  | "REPRESENTS" | "USES_TECHNIQUE" | "EMBODIES" | "BELONGS_TO" | "COLLABORATES_WITH";
export type Confidence = "high" | "medium" | "low";

export interface CandidateBase { cid: string; state: CandidateState; origin: Origin; evidence?: Evidence; note?: string; edited: boolean }
export interface EdgeSpec { source: Ref; target: Ref; edge_type: SuggestableEdgeType | "INFLUENCES" | "RESPONDS_TO"; event_time?: string; confidence: Confidence }
export interface NodeCandidate extends CandidateBase { kind: "node"; node: { type: CandidateNodeType; name: string; metadata: Record<string, unknown>; aliases: Array<{ source: "web"; external_id: string }> }; resolves_to: string | null; resolution: "exact" | "alias" | "fuzzy" | "none" }
export interface EdgeCandidate extends CandidateBase { kind: "edge"; edge: EdgeSpec & { edge_type: SuggestableEdgeType } }
export interface ImageCandidate extends CandidateBase { kind: "image"; image: { for: Ref; image_url: string; page_url: string; alt?: string; width?: number; height?: number } }
export interface PatchCandidate extends CandidateBase { kind: "patch"; patch: { node_id: string; key: string; existing: unknown; proposed: unknown } }
export interface QuestionCandidate extends CandidateBase { kind: "question"; question: { text: string; if_yes: EdgeSpec; answer?: string; answered_yes?: boolean } }
export interface KnownCandidate extends CandidateBase { kind: "known"; known: { node_id: string; edge_type?: string; other_id?: string; summary: string } }
export interface EndedCandidate extends CandidateBase { kind: "ended"; ended: { edge_id: string; edge_type: string; source_id: string; target_id: string; last_seen?: string; summary: string } }
export type Candidate = NodeCandidate | EdgeCandidate | ImageCandidate | PatchCandidate | QuestionCandidate | KnownCandidate | EndedCandidate;
