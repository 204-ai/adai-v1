// How a relation reads in prose: "held by", "participated in". Shared by the
// profile/record page, the entity view and contribution sentences.

export const EDGE_TYPE_LABEL: Record<string, string> = {
  PRACTICES: "practices",
  BELONGS_TO: "belongs to",
  RELATED_TO: "related to",
  COLLABORATES_WITH: "collaborates with",
  CREATED_BY: "created by",
  EXHIBITED_AT: "exhibited at",
  HELD_BY: "held by",
  DOCUMENTS: "documents",
  CLASSIFIED_BY: "classified by",
  LEGIBLE_TO: "legible to",
  PARTICIPATED_IN: "participated in",
  PRESENTED_BY: "presented by",
  CURATED_BY: "curated by",
  REPRESENTS: "represents",
  EMBODIES: "embodies",
  USES_TECHNIQUE: "uses technique",
  INFLUENCES: "influences",
  RESPONDS_TO: "responds to",
};

export function edgeLabel(edgeType: string): string {
  return EDGE_TYPE_LABEL[edgeType] ?? edgeType.toLowerCase().replace(/_/g, " ");
}
