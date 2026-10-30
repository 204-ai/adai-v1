import { describe, expect, it } from 'vitest'
import { fieldBase, fieldUrl } from './field.ts'

const SITE = 'https://digitalartsinstitute.io'

describe('the field address', () => {
  it('is the site, opened on the work when there is one', () => {
    expect(fieldUrl(SITE, null, '')).toBe(`${SITE}/field`)
    expect(fieldUrl(SITE, { slug: 'fidenza' }, '?mode=field')).toBe(`${SITE}/field/artwork/fidenza`)
  })
  it('encodes a legacy slug and strips trailing slashes off the site', () => {
    expect(fieldUrl(`${SITE}//`, { slug: 'toujours-là' }, '')).toBe(`${SITE}/field/artwork/toujours-l%C3%A0`)
  })
  it('takes a local A(DAI) from ?field=, its origin only', () => {
    expect(fieldBase(SITE, '?field=http://localhost:8080')).toBe('http://localhost:8080')
    expect(fieldBase(SITE, '?field=http://localhost:8080/field?x=1')).toBe('http://localhost:8080')
    expect(fieldBase(SITE, '?field=http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080')
    expect(fieldBase(SITE, '?field=http://adai.localhost')).toBe('http://adai.localhost')
  })
  it('frames no other origin, whatever the query says', () => {
    for (const bad of ['https://evil.example', 'http://localhost.evil.example', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url', 'http://[::1]:8080/../'])
      expect(fieldBase(SITE, `?field=${encodeURIComponent(bad)}`)).toBe(bad.startsWith('http://[::1]') ? 'http://[::1]:8080' : SITE)
  })
})
