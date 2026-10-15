/** The live site address (ADAI_BASE_URL, else the public domain), no trailing slash. */
export function siteBase(): string {
  const env = (process.env.ADAI_BASE_URL || "").replace(/\/+$/, "");
  return /^https?:\/\//i.test(env) ? env : "https://digitalartsinstitute.io";
}

/** The field focused on a node: /field/<type>/<slug> (issue #71). */
export function fieldPath(n: { type: string; slug: string }): string {
  return `/field/${encodeURIComponent(n.type)}/${encodeURIComponent(n.slug)}`;
}
