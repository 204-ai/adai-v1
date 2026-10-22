// External identities on the PUBLIC entity view (issue #86).
//
// node_aliases holds whatever an import keyed a node by: wallet addresses,
// contract:project pairs, a platform's own spelling of a name, folksonomy
// terms. Printed verbatim ("fxhash :user:tz1eJF…") they read as noise, or
// worse, as something A(DAI) vouches for. The public strip shows only what
// a visitor can follow: a plain labelled link ("on fxhash ↗"), built from
// an id whose shape we recognise exactly. An alias we cannot turn into a
// safe URL is left off the page; /record still lists every alias raw.
//
// The URL shapes are the ones the importers recorded in metadata.source_url
// for the same ids (checked against the live DB).

export interface ExternalLink { label: string; href: string }

/** Art Blocks flagship contracts (v0, v1, v3): their project ids share one
 *  numbering, so /project/<n> is unambiguous only for them. */
const ARTBLOCKS_CONTRACTS = new Set([
  "0x059edd72cd353df5106d2b9cc5ab83a52287ac3a",
  "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270",
  "0x99a9b7c1116f9ceeb1652de04d5969cce509b069",
]);

const ETH_ADDRESS = /^0x[0-9a-f]{40}$/i;

type Builder = (id: string) => string | null;

const BUILDERS: Record<string, { label: string; href: Builder }> = {
  wikidata: {
    label: "on Wikidata",
    href: (id) => (/^Q[1-9]\d*$/.test(id) ? `https://www.wikidata.org/wiki/${id}` : null),
  },
  fxhash: {
    label: "on fxhash",
    href: (id) => {
      const user = /^user:(tz[1-4][1-9A-HJ-NP-Za-km-z]{33})$/.exec(id);
      if (user) return `https://www.fxhash.xyz/u/${user[1]}`;
      return /^[1-9]\d*$/.test(id) ? `https://www.fxhash.xyz/generative/${id}` : null;
    },
  },
  artblocks: {
    label: "on Art Blocks",
    href: (id) => {
      const m = /^(0x[0-9a-f]{40}):(\d+)$/i.exec(id);
      return m && ARTBLOCKS_CONTRACTS.has(m[1].toLowerCase()) ? `https://www.artblocks.io/project/${Number(m[2])}` : null;
    },
  },
  superrare: {
    label: "on SuperRare",
    href: (id) => {
      const m = /^1-(0x[0-9a-f]{40})-(\d+)$/i.exec(id);
      return m ? `https://superrare.com/${m[1].toLowerCase()}/${Number(m[2])}` : null;
    },
  },
  superrare_artist: {
    label: "on SuperRare",
    href: (id) => (ETH_ADDRESS.test(id) ? `https://superrare.com/${id.toLowerCase()}` : null),
  },
  va: {
    label: "at the V&A",
    href: (id) => (/^O\d+$/.test(id) ? `https://collections.vam.ac.uk/item/${id}` : null),
  },
  // Not listed, so never public: artblocks_artist and va_maker (a platform's
  // spelling of a name — no address to build), term and folksonomy_tag
  // (import vocabulary), handle and slug (shown elsewhere / redirects), web
  // (a raw URL — the strip's own `web` row covers the node's site).
};

/** The public link for one alias, or null when it stays off the page. */
export function externalLink(source: string, externalId: string): ExternalLink | null {
  const b = BUILDERS[source];
  if (!b) return null;
  const href = b.href(String(externalId).trim());
  return href ? { label: b.label, href } : null;
}

/** Every alias that makes a link, one per URL, in the order given. */
export function externalLinks(aliases: Array<{ source: string; external_id: string }>): ExternalLink[] {
  const seen = new Set<string>();
  const out: ExternalLink[] = [];
  for (const a of aliases) {
    const l = externalLink(a.source, a.external_id);
    if (!l || seen.has(l.href)) continue;
    seen.add(l.href);
    out.push(l);
  }
  return out;
}
