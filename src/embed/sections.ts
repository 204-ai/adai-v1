// Shared "embedding-derived sections" builder.
//
// The same logic that drives the HTML "Style kin / Visually affine / Style
// proximity / Closest artworks / AI-suggested attributions" sections on the
// profile pages (`src/routes/pages.ts`) is also what the /field entity-view
// (1k overlay) and the /field 10k zoom layer fetch over the wire. Keeping
// the section computation in one place means the JSON endpoint and the HTML
// page can never drift.

import type { DatabaseSync } from "node:sqlite";
import { topKByNodeId, topKCentredArtworks, withMetadata, type Neighbour } from "./neighbours.js";

// Quality floor for the concept/scene "Closest artworks" section, applied in
// the MEAN-CENTRED artwork space (see topKCentredArtworks for why raw cosine
// can't gate this). Calibrated June 2026 against the live canon: a concept
// with no genuinely-related artworks (concept:protocol-art at mint time)
// topped out at 0.369 centred; related concepts (pixel, glitch, bitcoin,
// landscape …) reach 0.53–0.64. 0.40 sits in the gap. Env-tunable like the
// derive τs; re-check with the calibration script if the canon reshapes.
const TAU_CLOSEST_ARTWORKS = (() => {
  const v = Number(process.env.TAU_CLOSEST_ARTWORKS);
  return Number.isFinite(v) ? v : 0.4;
})();

export interface EmbeddingSection {
  /** Stable machine key — used by the client to colour/route a section. */
  key:
    | "style_kin"
    | "visually_affine"
    | "style_proximity"
    | "closest_artworks"
    | "ai_attributions";
  /** Human-readable section heading. */
  title: string;
  /** Short prose blurb shown below the heading. */
  blurb: string;
  /** Decorated neighbours (with name/type/slug/image where available). */
  neighbours: Neighbour[];
}

export interface SectionsNode {
  id: string;
  type: string;
  name: string;
  slug?: string;
}

/**
 * Compute every embedding-derived section that applies to `node`. Nodes
 * without a relevant vector (institution, publication, classification_regime,
 * etc.) get an empty array — the caller can then render nothing rather than
 * an empty heading.
 *
 * Mirrors the same thresholds and K values used by the original
 * `renderEmbeddingSections` in `src/routes/pages.ts`.
 */
export function buildEmbeddingSections(
  db: DatabaseSync,
  node: SectionsNode
): EmbeddingSection[] {
  const sections: EmbeddingSection[] = [];

  if (node.type === "practitioner" || node.type === "collective") {
    // Style kin: practitioners / collectives closest to this one in
    // style-centroid space. Empty when this practitioner has no centroid
    // (no live CREATED_BY edges).
    const styleKin = withMetadata(
      db,
      topKByNodeId(db, node.id, {
        queryKind: "style_centroid",
        candidateKind: "style_centroid",
        typePrefixes: ["practitioner:", "collective:"],
        k: 8,
      })
    );
    if (styleKin.length) {
      sections.push({
        key: "style_kin",
        title: "Resemblances to explore",
        blurb:
          "Each artist gets a single style signature — the centre of gravity of their works — and those signatures are matched. The model reads each artwork's image and its description as we hold them, including title, year and medium. It doesn't read interviews, biographies or the relationships people have added. Artists are compared through the works represented in A(DAI), which may cover only part of a practice. A resemblance can leap across decades or link scenes that never met: a lead to explore, not a school, lineage or influence.",
        neighbours: styleKin,
      });
    }

    // AI-suggested attributions: any pending intake_queue ai_suggestion rows
    // that name this practitioner as the candidate creator.
    const proposals = db
      .prepare(
        `SELECT id, target_node, proposed_edges
           FROM intake_queue
          WHERE kind = 'ai_suggestion' AND status = 'pending'`
      )
      .all() as Array<{ id: string; target_node: string; proposed_edges: string }>;
    const matchingProposals: Array<{ artwork_id: string; sim: number }> = [];
    for (const p of proposals) {
      let arr: any[] = [];
      try {
        arr = JSON.parse(p.proposed_edges || "[]");
      } catch {
        /* ignore */
      }
      for (const spec of arr) {
        if (spec.target_id === node.id && spec.edge_type === "CREATED_BY") {
          matchingProposals.push({
            artwork_id: spec.source_id,
            sim: spec.similarity ?? 0,
          });
        }
      }
    }
    if (matchingProposals.length) {
      matchingProposals.sort((a, b) => b.sim - a.sim);
      const decorated = withMetadata(
        db,
        matchingProposals.map((m) => ({
          node_id: m.artwork_id,
          similarity: m.sim,
        }))
      );
      sections.push({
        key: "ai_attributions",
        title: "AI-suggested attributions",
        blurb: `Unattributed artworks the embedding pipeline thinks may be by ${node.name}. Review at /review?kind=ai_suggestion.`,
        neighbours: decorated,
      });
    }
  }

  if (node.type === "artwork") {
    const affine = withMetadata(
      db,
      topKByNodeId(db, node.id, {
        queryKind: "identity",
        candidateKind: "identity",
        typePrefixes: ["artwork:"],
        k: 8,
      })
    );
    if (affine.length) {
      sections.push({
        key: "visually_affine",
        title: "Visually affine",
        blurb:
          "Artworks closest in the embedding space: each work's image and its description as we hold them (title, year, medium), read together into one vector. Leads to explore, not claims.",
        neighbours: affine,
      });
    }

    const candidates = withMetadata(
      db,
      topKByNodeId(db, node.id, {
        queryKind: "identity",
        candidateKind: "style_centroid",
        typePrefixes: ["practitioner:", "collective:"],
        k: 5,
        minSimilarity: 0.75,
      })
    );
    if (candidates.length) {
      sections.push({
        key: "style_proximity",
        title: "Style proximity",
        blurb:
          "Practitioners whose style-centroid sits closest to this artwork.",
        neighbours: candidates,
      });
    }
  }

  if (node.type === "concept" || node.type === "scene") {
    // Mean-centred similarity with a quality floor: a concept with no
    // genuinely-related artworks gets an empty list (and therefore no
    // section), instead of eight nearest-by-weak-math strangers.
    const closest = withMetadata(
      db,
      topKCentredArtworks(db, node.id, {
        k: 8,
        minSimilarity: TAU_CLOSEST_ARTWORKS,
      })
    );
    if (closest.length) {
      sections.push({
        key: "closest_artworks",
        title: "Closest artworks in embedding space",
        blurb: `Artworks whose mean-centred text+image vector sits closest to this ${node.type}'s text embedding. Matches below the quality floor are hidden.`,
        neighbours: closest,
      });
    }
  }

  return sections;
}
