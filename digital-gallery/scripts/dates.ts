// Where an artwork sits in time. A(DAI) records carry dates in several shapes, depending on where they came from:
// the structured year fields (contributors), the V&A's `date_text`, an fxhash mint opening, a SuperRare token's creation,
// or nothing at all (Art Blocks, looked up by project in work/artblocks.json). Each date keeps the reason it was placed
// there (`basis`) and whether it is firm or an estimate; a work with no readable date stays off the coil.

export interface Dated {
  /** fractional year: 1974.5 is mid-1974 */
  year: number
  /** how the date reads on screen: "1974", "c. 1970s", "6 Nov 2021" */
  label: string
  /** why the work sits there */
  basis: string
  /** false when the year is a reading of a looser date */
  firm: boolean
}

type Meta = Record<string, unknown>

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2021-11-06T17:52:58Z" → 2021.85: a date as a fractional year. */
export function yearOfIso(iso: string): number | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  const y = d.getUTCFullYear()
  const start = Date.UTC(y, 0, 1)
  return y + (t - start) / (Date.UTC(y + 1, 0, 1) - start)
}

const dayLabel = (iso: string) => {
  const d = new Date(Date.parse(iso))
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** A stable spot inside a year for a work dated only to the year, so a year's works spread along its loop. */
export function spread(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return ((h >>> 0) % 1000) / 1000
}

const plausible = (y: number) => y >= 1900 && y <= 2030

/**
 * The V&A's free-text dates. Returns the year (start of it) and whether the text names exactly one year.
 * "1969" firm · "c.1974" / "ca. 1970s" / "1967-1970" / "Spring, 1995" estimates · "late 20th-early 21st century" null.
 */
export function readDateText(text: string): { year: number; label: string; firm: boolean } | null {
  const s = text.trim()
  let m = /^(\d{4})$/.exec(s)
  if (m && plausible(+m[1]!)) return { year: +m[1]!, label: m[1]!, firm: true }
  m = /^(?:c\.|ca\.?|circa)\s*(\d{4})s?$/i.exec(s)
  if (m && plausible(+m[1]!)) return { year: +m[1]! + (s.endsWith('s') ? 5 : 0), label: `c. ${m[1]}${s.endsWith('s') ? 's' : ''}`, firm: false }
  m = /^(\d{4})s$/.exec(s)
  if (m && plausible(+m[1]!)) return { year: +m[1]! + 5, label: `c. ${m[1]}s`, firm: false }
  m = /^(\d{4})\s*[-–]\s*(\d{2,4})$/.exec(s)
  if (m) {
    const a = +m[1]!, b = m[2]!.length === 2 ? Math.floor(a / 100) * 100 + +m[2]! : +m[2]!
    if (plausible(a) && plausible(b) && b >= a) return { year: (a + b) / 2, label: `${a}–${b}`, firm: false }
  }
  const years = [...s.matchAll(/\b(19|20)\d{2}\b/g)].map((x) => +x[0])
  if (years.length === 1 && plausible(years[0]!)) return { year: years[0]!, label: `c. ${years[0]}`, firm: false }
  return null
}

/** Art Blocks has no dates in the commons; work/artblocks.json maps "<contract>:<project id>" → project start. */
export type ArtBlocksDates = Record<string, string>

export function dateOf(id: string, meta: Meta, artblocks: ArtBlocksDates = {}): Dated | null {
  const str = (k: string) => (typeof meta[k] === 'string' && (meta[k] as string).trim() ? (meta[k] as string).trim() : null)
  const num = (k: string) => (typeof meta[k] === 'number' && Number.isFinite(meta[k]) ? (meta[k] as number) : null)
  const inYear = spread(id)

  const ys = num('year_start')
  if (ys !== null && plausible(ys) && !str('year_raw')) {
    const ye = num('year_end')
    const range = ye !== null && ye > ys
    return { year: ys + inYear, label: range ? `${ys}–${ye}` : String(ys), basis: 'year on the A(DAI) record', firm: true }
  }
  const raw = str('year_raw')
  if (raw) {
    const r = readDateText(raw)
    if (r) return { year: r.year + inYear, label: r.label, basis: `"${raw}" on the A(DAI) record`, firm: r.firm }
  }
  // MoMA/Wikidata and older contributions use `year`, sometimes as an ISO date.
  const year = str('year') ?? (num('year') !== null ? String(num('year')) : null)
  if (year) {
    const iso = /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(year) ? yearOfIso(year) : null
    if (iso !== null && plausible(iso)) return { year: iso, label: dayLabel(year), basis: 'date on the A(DAI) record', firm: true }
    const r = readDateText(year)
    if (r) return { year: r.year + inYear, label: r.label, basis: 'year on the A(DAI) record', firm: r.firm }
  }
  const mint = str('mint_opens_at')
  if (mint && yearOfIso(mint) !== null) return { year: yearOfIso(mint)!, label: dayLabel(mint), basis: 'fxhash mint opened', firm: true }
  const created = str('created_at')
  if (created && str('superrare_token_id') !== null && yearOfIso(created) !== null)
    return { year: yearOfIso(created)!, label: dayLabel(created), basis: 'SuperRare token created', firm: true }
  const pid = str('artblocks_project_id'), contract = str('artblocks_contract')
  if (pid !== null && contract) {
    const at = artblocks[`${contract.toLowerCase()}:${pid}`]
    if (at && yearOfIso(at) !== null) return { year: yearOfIso(at)!, label: dayLabel(at), basis: 'Art Blocks project launch', firm: true }
  }
  const text = str('date_text')
  if (text) {
    const r = readDateText(text)
    if (r) return { year: r.year + inYear, label: r.label, basis: `V&A collection record: "${text}"`, firm: r.firm }
  }
  return null
}
