import { describe, expect, it } from 'vitest'
import { dateOf, readDateText, spread, yearOfIso } from './dates.ts'

describe('V&A date text', () => {
  it('reads a bare year as firm', () => {
    expect(readDateText('1969')).toEqual({ year: 1969, label: '1969', firm: true })
  })
  it('reads circa years and decades as estimates', () => {
    expect(readDateText('c.1974')).toEqual({ year: 1974, label: 'c. 1974', firm: false })
    expect(readDateText('ca. 1970s')).toEqual({ year: 1975, label: 'c. 1970s', firm: false })
    expect(readDateText('1980s')).toEqual({ year: 1985, label: 'c. 1980s', firm: false })
  })
  it('places a range at its middle', () => {
    expect(readDateText('1967-1970')).toEqual({ year: 1968.5, label: '1967–1970', firm: false })
    expect(readDateText('1967-70')).toEqual({ year: 1968.5, label: '1967–1970', firm: false })
  })
  it('takes the one year out of a longer phrase', () => {
    expect(readDateText('Spring, 1995')).toEqual({ year: 1995, label: 'c. 1995', firm: false })
  })
  it('leaves centuries and nonsense undated', () => {
    expect(readDateText('late 20th-early 21st century')).toBeNull()
    expect(readDateText('undated')).toBeNull()
    expect(readDateText('1969, 1972')).toBeNull()
  })
})

describe('dateOf', () => {
  it('prefers the structured year', () => {
    const d = dateOf('artwork:a', { year_start: 2021, year_end: 2021, date_text: '1990' })!
    expect(Math.floor(d.year)).toBe(2021)
    expect(d).toMatchObject({ label: '2021', firm: true })
  })
  it('uses the fxhash mint date to the day', () => {
    const d = dateOf('artwork:b', { mint_opens_at: '2021-11-06T17:52:58.000Z' })!
    expect(d.label).toBe('6 Nov 2021')
    expect(d.year).toBeCloseTo(yearOfIso('2021-11-06T17:52:58.000Z')!)
  })
  it('reads legacy year fields without losing works dated by MoMA or Wikidata', () => {
    for (const year of ['2018', 2018]) {
      const d = dateOf('artwork:legacy', { year })!
      expect(Math.floor(d.year)).toBe(2018)
      expect(d).toMatchObject({ label: '2018', firm: true })
    }
    expect(dateOf('artwork:legacy', { year: '2019-01-01' })).toMatchObject({ year: 2019, label: '1 Jan 2019', firm: true })
    expect(dateOf('artwork:legacy', { year: '1967–1970' })).toMatchObject({ label: '1967–1970', firm: false })
    expect(dateOf('artwork:legacy', { year_start: 2021, year: '2018' })?.label).toBe('2021')
    expect(dateOf('artwork:legacy', { year: 'undated' })).toBeNull()
  })
  it('looks Art Blocks projects up by contract and id', () => {
    const meta = { artblocks_contract: '0x059EDD72cd353df5106d2b9cc5ab83a52287ac3a', artblocks_project_id: '0' }
    expect(dateOf('artwork:c', meta)).toBeNull()
    expect(dateOf('artwork:c', meta, { '0x059edd72cd353df5106d2b9cc5ab83a52287ac3a:0': '2020-11-27T16:13:20+00:00' })?.label).toBe('27 Nov 2020')
  })
  it('spreads year-only works inside their year, the same way every run', () => {
    const d = dateOf('artwork:d', { date_text: '1969' })!
    expect(d.year).toBeGreaterThanOrEqual(1969)
    expect(d.year).toBeLessThan(1970)
    expect(spread('artwork:d')).toBe(spread('artwork:d'))
  })
  it('returns null with nothing to go on', () => {
    expect(dateOf('artwork:e', { image_url: 'x' })).toBeNull()
  })
})
