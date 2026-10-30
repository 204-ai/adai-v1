// A work's detail file (public/data/works/<index>.json, written by `npm run manifest` beside the manifest): what the panel
// shows when a work is opened. Its words, a few facts, its tags, its makers, and its neighbours in the commons' graph.
// Read only when a work is opened, so the manifest stays small.
import { dataUrl } from './commons.ts'

export type RelKind =
  /** a concept the work embodies; `inferred` when the commons' embeddings proposed it, not a person */
  | 'concept'
  /** a classification the work sits under */
  | 'regime'
  /** where it was shown, or which collection holds it */
  | 'venue'
  | 'holder'
  /** another work the commons' embeddings find visually close (machine-derived) */
  | 'affine'
  /** another work by the same maker */
  | 'sibling'
  /** a maker the embeddings find close in style to this one's (machine-derived) */
  | 'kin'

export interface Related {
  id: string
  name: string
  slug: string
  type: string
  rel: RelKind
  inferred?: boolean
  /** for works: the image, its year, and whether it is in the manifest (so it can be opened here) */
  img?: string
  year?: number
  here?: boolean
}

export interface DetailArtist {
  id: string
  name: string
  slug: string
  type: string
  /** a line or two about them, as the commons has it */
  about: string | null
  website: string | null
}

export interface Detail {
  id: string
  /** the work's own words: its description or summary */
  text: string | null
  facts: Array<[string, string]>
  tags: string[]
  /** the record it came from */
  source: string | null
  artists: DetailArtist[]
  related: Related[]
}

/** where a work's detail file is, by its place in the manifest */
export const detailUrl = (index: number) => dataUrl(`works/${index}.json`)
