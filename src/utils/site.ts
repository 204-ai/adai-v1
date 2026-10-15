/** The live site address (ADAI_BASE_URL, else the public domain), no trailing slash. */
export function siteBase(): string {
  const env = (process.env.ADAI_BASE_URL || "").replace(/\/+$/, "");
  return /^https?:\/\//i.test(env) ? env : "https://digitalartsinstitute.io";
}
