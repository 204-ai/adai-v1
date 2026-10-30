// The A(DAI) commons as this gallery addresses it: where its data lives under the app's base (public/data/, built by
// `npm run manifest`), the pages its works and their makers have on the A(DAI) site, and the words the panel uses for
// a work's neighbourhood.
import type { ManifestWork } from './manifest.ts'

/** the neighbourhood's kinds of relation, as the panel names them */
export type KindLabel = 'maker' | 'sibling' | 'kin' | 'concept' | 'regime' | 'venue' | 'holder' | 'affine'
export const KIND_LABEL: Record<KindLabel, string> = {
  maker: 'maker',
  sibling: 'by the same maker',
  kin: 'close in style',
  concept: 'embodies',
  regime: 'classified as',
  venue: 'shown at',
  holder: 'held by',
  affine: 'visually close',
}
/** the neighbourhood's heading, and its legend: recorded, then machine-derived */
export const NEIGHBOURHOOD = 'In the commons'
export const LEGEND: [string, string] = ['recorded', 'machine-derived (embeddings)']
/** what the link to a record says */
export const OPEN = 'open in A(DAI) ↗'

/** a work's page on the A(DAI) site */
export const workUrl = (w: Pick<ManifestWork, 'slug'>, site: string) => `${site}/artwork/${encodeURIComponent(w.slug)}`
/** any other record's page: a practitioner, a collective, a concept, an institution … */
export const entityUrl = (site: string, type: string, slug: string) => `${site}/${type}/${encodeURIComponent(slug)}`

/** a file in the gallery's data folder */
export const dataUrl = (path: string) => `${import.meta.env.BASE_URL}data/${path}`
