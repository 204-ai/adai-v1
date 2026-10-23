// Staging: a second Fly app (adai-staging, fly.staging.toml) that runs the
// `staging` branch against a nightly copy of the prod DB. ADAI_ENV=staging turns this on; on
// prod (ADAI_ENV unset) every integration is on and none of this applies.
//
// On staging each outward integration is behind a switch, off by default,
// flipped per debugging session:
//
//   STAGING_SWITCHES="mail=allowlist:a@x.y,@team.org worker=on r2=on gemini=on archivist=off data=keep"
//
//   mail       stdout (default) | allowlist:<addr|@domain>,… | live
//   worker     off (default) | on   spawn real intake machines
//   r2         off (default) | on   upload to the public image bucket
//   gemini     off (default) | on   embed-on-write + embedding lookups
//   archivist  on (default) | off   the /field archivist (read-only, budget-capped)
//   activity   off (default) | on   the live activity feed (issue #83; on prod: ACTIVITY_FEED=on)
//   data       nightly (default) | keep   keep is read by entrypoint.sh
//
// Set with `just staging-set …` (a Fly secret; the machine restarts). The
// value is the whole state: unnamed switches return to their defaults.
// Litestream replication is not a switch — entrypoint.sh never replicates
// on staging.

export function isStaging(): boolean {
  return process.env.ADAI_ENV === "staging";
}

const DEFAULTS: Record<string, string> = {
  mail: "stdout",
  worker: "off",
  r2: "off",
  gemini: "off",
  archivist: "on",
  activity: "off",
  data: "nightly",
};

export type Switch = keyof typeof DEFAULTS;

let parsed: { raw: string; map: Record<string, string> } | null = null;

export function switches(): Record<string, string> {
  const raw = process.env.STAGING_SWITCHES ?? "";
  if (parsed?.raw === raw) return parsed.map;
  const map = { ...DEFAULTS };
  for (const tok of raw.split(/\s+/).filter(Boolean)) {
    const i = tok.indexOf("=");
    const k = i === -1 ? tok : tok.slice(0, i);
    if (!(k in DEFAULTS)) {
      console.warn(`[staging] unknown switch "${k}" ignored`);
      continue;
    }
    map[k] = i === -1 ? "on" : tok.slice(i + 1);
  }
  parsed = { raw, map };
  return map;
}

/** True on prod; on staging, whether this integration is switched on. */
export function switchOn(name: "worker" | "r2" | "gemini" | "archivist"): boolean {
  return !isStaging() || switches()[name] === "on";
}

/** GEMINI_API_KEY, unless staging has gemini switched off. */
export function geminiKey(): string | null {
  return switchOn("gemini") ? process.env.GEMINI_API_KEY || null : null;
}

/** Splits recipients into those mailed for real and those only logged. */
export function mailRoute(to: string[]): { live: string[]; held: string[] } {
  if (!isStaging()) return { live: to, held: [] };
  const mode = switches().mail;
  if (mode === "live") return { live: to, held: [] };
  if (!mode.startsWith("allowlist:")) return { live: [], held: to };
  const allow = mode.slice("allowlist:".length).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const ok = (addr: string) => {
    const a = addr.trim().toLowerCase();
    return allow.some((e) => (e.startsWith("@") ? a.endsWith(e) : a === e));
  };
  return { live: to.filter(ok), held: to.filter((a) => !ok(a)) };
}

/** The switch state with allowlist addresses reduced to a count (shown publicly). */
export function publicSwitches(): Record<string, string> {
  const s = { ...switches() };
  if (s.mail.startsWith("allowlist:")) {
    const n = s.mail.slice("allowlist:".length).split(",").filter((x) => x.trim()).length;
    s.mail = `allowlist (${n})`;
  }
  return s;
}

/** Thin fixed bar on every staging page; "" on prod. */
export function stagingBanner(): string {
  if (!isStaging()) return "";
  const s = publicSwitches();
  const items = Object.entries(s)
    .map(([k, v]) => `<span style="margin-left:14px;opacity:${v === DEFAULTS[k] ? ".55" : "1"}">${k}: <b>${v.replace(/[<>&"]/g, "")}</b></span>`)
    .join("");
  return (
    `<div id="adai-staging-bar" style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;` +
    `background:#c8341c;color:#fff;font:11px/1.9 'SF Mono',Menlo,monospace;padding:0 10px;` +
    `white-space:nowrap;overflow-x:auto;pointer-events:none;letter-spacing:.03em">` +
    `<b>STAGING</b>${items}</div>`
  );
}
