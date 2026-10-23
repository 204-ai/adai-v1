/**
 * A(DAI) — edge-type → brand-accent color mapping (v1, draft)
 *
 * 9 active edge types map to 9 brand accents from adai-system.js.
 * Editorial review pending. To change a mapping, edit this file only.
 *
 * Reds  = human relations (CREATED_BY, COLLABORATES_WITH, INFLUENCES)
 * Greens = structural (EXHIBITED_AT, CLASSIFIED_BY, USES_TECHNIQUE)
 * Yellows = activity / grounding (PRACTICES, BELONGS_TO)
 * Cobalt = the spine (EMBODIES — most common)
 */
window.ADAI_EDGE_COLORS = (() => {
  const MAP = {
    EMBODIES:           { hex: '#4169B0', name: 'Cobalt' },
    CREATED_BY:         { hex: '#D93B2D', name: 'Vermillion' },
    PRACTICES:          { hex: '#E5890A', name: 'Amber' },
    EXHIBITED_AT:       { hex: '#093F43', name: 'Deep Teal' },
    CLASSIFIED_BY:      { hex: '#6E7B2C', name: 'Olive' },
    BELONGS_TO:         { hex: '#B88A1B', name: 'Ochre' },
    COLLABORATES_WITH:  { hex: '#A83A1E', name: 'Rust' },
    USES_TECHNIQUE:     { hex: '#2A7672', name: 'Jade' },
    INFLUENCES:         { hex: '#8F2D2D', name: 'Oxblood' },
    RELATED_TO:         { hex: '#3A3A3C', name: 'Muted' },  // reserved / 0 rows
    STYLE_KIN:          { hex: '#7EB8DA', name: 'Pale cobalt' },
    VISUALLY_AFFINE:    { hex: '#C9A227', name: 'Signal gold' },
    STYLE_PROXIMITY:    { hex: '#9BA67A', name: 'Muted olive' },
    SUGGESTS_CREATED_BY:{ hex: '#C77A4A', name: 'Signal rust' },
    CLOSEST_ARTWORK:    { hex: '#8F8A78', name: 'Warm grey' },
    EMBEDDING_NEAR:     { hex: '#6E7B8D', name: 'Blue grey' },
    // Show / gallery cluster (archive-intake relations around `project`
    // nodes). The 9 brand accents above are taken, so these four extend the
    // family logic into unclaimed hue space — violet/plum for the human
    // relations, forest/glacier for the structural ones. Without entries here
    // they all fell through to NEUTRAL (#E8E6E1) and a show-cluster node's
    // edges rendered as one indistinct off-white. Editorial review pending.
    PARTICIPATED_IN:    { hex: '#7A5AA8', name: 'Violet' },      // practitioner → project
    CURATED_BY:         { hex: '#A84A7A', name: 'Plum' },        // project → practitioner
    PRESENTED_BY:       { hex: '#3F6B35', name: 'Forest' },      // project → institution
    REPRESENTS:         { hex: '#4A8FA8', name: 'Glacier' },     // institution → practitioner
    HELD_BY:            { hex: '#8C6A4F', name: 'Umber' },       // artwork → institution (collection)
    DOCUMENTS:          { hex: '#9A8C5A', name: 'Parchment' },   // publication → project / artwork (#80)
  };
  const NEUTRAL = { hex: '#E8E6E1', name: 'Text' };  // dots with no edges

  function colorFor(edgeType) {
    return MAP[edgeType] || NEUTRAL;
  }

  // Pick the dominant edge type for a node (the one with most edges of that type).
  function dominantEdgeType(nodeId) {
    const g = window.ADAI_GRAPH;
    if (!g) return null;
    const counts = g.edgeTypeCount.get(nodeId);
    if (!counts || counts.size === 0) return null;
    let best = null, bestN = -1;
    for (const [type, n] of counts) {
      if (n > bestN) { best = type; bestN = n; }
    }
    return best;
  }

  function colorForNode(nodeId) {
    const t = dominantEdgeType(nodeId);
    return t ? MAP[t] : NEUTRAL;
  }

  return { MAP, NEUTRAL, colorFor, colorForNode, dominantEdgeType };
})();
