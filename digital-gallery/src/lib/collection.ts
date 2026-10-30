// The gallery the coil shows: the A(DAI) commons (public/data/, built by `npm run manifest`), and its words for what it
// holds. One gallery in this fork; kept as one place for those words and the data folder.
import type { ManifestWork } from './manifest.ts'

/** the neighbourhood's kinds of relation */
export type KindLabel = 'maker' | 'sibling' | 'kin' | 'concept' | 'regime' | 'venue' | 'holder' | 'affine'

export interface Collection {
  /** its short name, for the title */
  name: string
  /** what it is, in a line */
  long: string
  /** where its data lives, under the app's base */
  root: string
  /** the neighbourhood's heading, its kinds of relation, and its legend: recorded, then computed */
  whole: string
  kinds: Record<KindLabel, string>
  legend: [string, string]
  /** where "open" goes for a work, and what the link says */
  open: string
  workUrl: (w: ManifestWork, site: string) => string
  /** a non-work neighbour's page */
  entityUrl: (site: string, type: string, slug: string) => string | null
  /** what to run when its data is missing */
  build: string
}

const ADAI: Collection = {
  name: 'A(DAI)',
  long: 'A(DAI) Digital Arts Commons',
  root: 'data/',
  whole: 'In the commons',
  kinds: { maker: 'maker', sibling: 'by the same maker', kin: 'close in style', concept: 'embodies', regime: 'classified as', venue: 'shown at', holder: 'held by', affine: 'visually close' },
  legend: ['recorded', 'machine-derived (embeddings)'],
  open: 'open in A(DAI) ↗',
  workUrl: (w, site) => `${site}/artwork/${encodeURIComponent(w.slug)}`,
  entityUrl: (site, type, slug) => `${site}/${type}/${encodeURIComponent(slug)}`,
  build: 'npm run manifest',
}

export const collection = () => ADAI

/** a file in the gallery's data folder */
export const dataUrl = (path: string) => `${import.meta.env.BASE_URL}${ADAI.root}${path}`
