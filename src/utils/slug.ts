// Canonical slugifier for A(DAI) node IDs and URLs. A slug is a URL path
// segment: accents are transliterated to ASCII (là → la, Zürich → zurich),
// `&` reads "and", apostrophes / dots / brackets vanish, and any other run of
// punctuation or whitespace (`#`, `,`, `/`, `?`, en/em dashes …) becomes a
// single `-`, never leading or trailing. Letters of non-Latin scripts are
// kept rather than erased — an empty slug is worse than a percent-encoded one.
//
// Nodes created before October 2026 keep the slugs the old rules gave them
// (`toujours-là`, `light-speculation-#1`); `legacySlugify` reproduces those so
// a re-submission of the same name still finds the existing node.

const LATIN_LETTERS: Record<string, string> = {
  ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d", ð: "d", þ: "th", ı: "i", ħ: "h",
};

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, "and")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[ßæœøłđðþıħ]/g, (c) => LATIN_LETTERS[c])
    .replace(/['’‘`´.()[\]{}]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/** The pre-October-2026 rules — only for finding nodes created under them. */
export function legacySlugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/ /g, "-")
    .replace(/\(/g, "")
    .replace(/\)/g, "")
    .replace(/\./g, "")
    .replace(/'/g, "")
    .replace(/&/g, "and")
    .replace(/--/g, "-");
}

// Compose a canonical node id from (type, name|slug). The seed convention is
// `<type>:<slug-or-spaced-name>` — note that legacy ids in seed/nodes.json
// preserve spaces (e.g. "practitioner:casey reas") while newer ids tend to
// use the slug. The contributor API uses the slug form, which is unambiguous.
export function nodeId(type: string, nameOrSlug: string): string {
  return `${type}:${slugify(nameOrSlug)}`;
}

/**
 * The slug a create of `name` under `type` should use: the existing node's
 * when one was made from the same name under the legacy rules, else the
 * canonical slug. Keeps "Toujours là" from becoming a second node.
 */
export function slugForCreate(nodeExists: (id: string) => boolean, type: string, name: string): string {
  const slug = slugify(name);
  if (nodeExists(`${type}:${slug}`)) return slug;
  const legacy = legacySlugify(name);
  return legacy !== slug && nodeExists(`${type}:${legacy}`) ? legacy : slug;
}
