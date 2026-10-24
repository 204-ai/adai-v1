// What the derive pass reads — one definition each, shared by the
// computation and by derive's input fingerprint (src/embed/derive.ts), so
// the check "did my inputs change since I read them?" uses EXACTLY the
// predicates and joins the computation used.

/**
 * The vectors: the current model's rows (bound as the one parameter) of
 * nodes that exist and are not retired. loadAll (src/embed/vectors.ts) reads
 * these columns; the fingerprint hashes them, vector bytes included.
 */
export const VECTORS_SQL = `SELECT ne.node_id, ne.kind, ne.model, ne.dims, ne.vector, ne.has_image, ne.image_hash, ne.text_hash
       FROM node_embeddings ne
       JOIN nodes n ON n.id = ne.node_id
       WHERE json_extract(n.metadata,'$.retired') IS NOT 1
         AND ne.model = ?`;

/**
 * Live attributions (artwork → practitioner / collective) — what "already
 * attributed" and "same creator" mean in derive. Includes creators that are
 * retired: an artwork attributed to them is still attributed.
 */
export const CREATED_BY_SQL = `SELECT e.source_id, e.target_id FROM edges e
         WHERE e.edge_type = 'CREATED_BY'
           AND e.valid_until IS NULL
           AND e.source_id LIKE 'artwork:%'
           AND (e.target_id LIKE 'practitioner:%' OR e.target_id LIKE 'collective:%')`;

/**
 * The attributions a style centroid is built from: as CREATED_BY_SQL, but
 * only to creators that exist and are not retired (as loadAll's node join
 * did when centroids were read back from the table) — a retired creator gets
 * no centroid, so it takes part in neither STYLE_KIN nor SUGGESTS_CREATED_BY.
 * The creator needs no vector of its own.
 */
export const CENTROID_EDGES_SQL = `SELECT e.source_id, e.target_id FROM edges e
         JOIN nodes c ON c.id = e.target_id AND json_extract(c.metadata,'$.retired') IS NOT 1
         WHERE e.edge_type = 'CREATED_BY'
           AND e.valid_until IS NULL
           AND e.source_id LIKE 'artwork:%'
           AND (e.target_id LIKE 'practitioner:%' OR e.target_id LIKE 'collective:%')`;

/**
 * Attested concept membership (artwork → concept EMBODIES that derive did
 * not write itself; a NULL writer is attested). The derived tag is bound as
 * the one parameter.
 */
export const EMBODIES_MEMBERS_SQL = `SELECT e.source_id, e.target_id FROM edges e
       WHERE e.edge_type = 'EMBODIES'
         AND e.valid_until IS NULL
         AND e.created_by IS NOT ?
         AND e.source_id LIKE 'artwork:%'
         AND e.target_id LIKE 'concept:%'`;

/** Curator-rejected attribution pairs (never re-proposed). */
export const REJECTED_SQL = `SELECT pair_hash FROM rejected_ai_suggestions`;
