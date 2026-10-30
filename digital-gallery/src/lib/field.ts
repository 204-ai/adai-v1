// Where A(DAI)'s own field is framed from: the A(DAI) site the manifest names, or, while developing against a local
// A(DAI), `?field=<base url>`. Only a local origin (localhost, 127.0.0.1, [::1], *.localhost) is taken from the query:
// the field fills the screen under this app's own address, so no other site may be framed here. Focused on a work when
// one is given. Kept pure so it is tested.
import type { ManifestWork } from './manifest.ts'

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|[^/]+\.localhost)$/i

/** the A(DAI) the field comes from: the site, or a local one asked for with `?field=` */
export function fieldBase(site: string, search: string): string {
  const asked = new URLSearchParams(search).get('field')
  let base = site
  if (asked) {
    try {
      const u = new URL(asked)
      if ((u.protocol === 'http:' || u.protocol === 'https:') && LOCAL.test(u.hostname)) base = u.origin
    } catch {
      // not a URL: the site it is
    }
  }
  return base.replace(/\/+$/, '')
}

/** the field's address: `/field`, or `/field/artwork/<slug>` when there is a work to open on */
export function fieldUrl(site: string, work: Pick<ManifestWork, 'slug'> | null, search: string): string {
  const base = fieldBase(site, search)
  return work ? `${base}/field/artwork/${encodeURIComponent(work.slug)}` : `${base}/field`
}
