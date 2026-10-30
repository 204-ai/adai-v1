// The generated manifest (public/data/manifest.json): what `npm run manifest` writes from an A(DAI) database and the app
// reads. Images stay where A(DAI) mirrors them (its R2 bucket); nothing is copied here.

export interface ManifestArtist {
  /** A(DAI) node id: "practitioner:vera-molnar" */
  id: string
  name: string
  type: string
  slug: string
}

export interface ManifestWork {
  /** A(DAI) node id: "artwork:fidenza" */
  id: string
  slug: string
  title: string
  /** the artist the work braids with (its first creator by name) */
  artist: string
  /** every creator's display name */
  by: string[]
  /** fractional year on the coil */
  year: number
  /** how the date reads on screen */
  date: string
  /** why the work sits there */
  basis: string
  firm: boolean
  img: string
  /** where the record came from: V&A, fxhash, Art Blocks, SuperRare, A(DAI) */
  source: string
}

export interface Manifest {
  version: 1
  /** where the data was read from, and when */
  from: string
  built: string
  /** the A(DAI) site the credit links to */
  site: string
  artists: ManifestArtist[]
  works: ManifestWork[]
}
