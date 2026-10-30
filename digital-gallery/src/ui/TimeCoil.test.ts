import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Manifest } from '../lib/manifest.ts'
import { parseParams } from '../lib/params.ts'
import { TimeCoil } from './TimeCoil.tsx'

const manifest: Manifest = {
  version: 1, from: 'fixture', built: '', site: 'https://digitalartsinstitute.io',
  artists: [{ id: 'artist:a', slug: 'a', name: 'A', type: 'practitioner' }, { id: 'artist:b', slug: 'b', name: 'B', type: 'practitioner' }],
  works: ['a', 'b'].map((slug, i) => ({ id: `artwork:${slug}`, slug, title: slug, artist: `artist:${slug}`, by: [slug], year: 2000 + i, date: String(2000 + i), basis: 'fixture', firm: true, img: `/${slug}.png`, source: 'A(DAI)' })),
}

afterEach(() => vi.unstubAllGlobals())

describe('the field on the first render, before any image decodes', () => {
  for (const [query, slug] of [['?work=b', 'b'], ['?artist=b', 'b'], ['', 'a'], ['?work=missing', 'a']]) {
    it(`opens the selected work for ${query || 'the default start'}`, () => {
      const search = `${query}${query ? '&' : '?'}seed=1&fuzz=0`
      vi.stubGlobal('window', { location: { search }, innerWidth: 1000, innerHeight: 700, matchMedia: () => ({ matches: false }) })
      const html = renderToStaticMarkup(createElement(TimeCoil, { manifest, settings: parseParams(search) }))
      expect(html).toContain(`src="https://digitalartsinstitute.io/field/artwork/${slug}"`)
    })
  }
})
