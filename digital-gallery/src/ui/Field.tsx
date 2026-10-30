import { useEffect, useRef, useState } from 'react'
import type { ManifestWork } from '../lib/manifest.ts'

/** the keys the field hands back to the coil (A(DAI)'s js-interface/embed.js) */
const KEYS = ['m']

/**
 * The field: A(DAI)'s own view of the commons (its `/field` page, the Shape of Time field), shown as it is, untouched,
 * from the A(DAI) site (`?field=<base url>` points it at another, e.g. a local A(DAI) on http://localhost:8080). It
 * opens on the work that was on stage; from there it is A(DAI)'s to drive. The run holds while it is open, since none
 * of the coil's own stage shows.
 *
 * A framed page keeps the keyboard once clicked, so the coil's `m` would be lost there. The coil asks the field for it
 * back (a postMessage handshake the field answers when it has embed.js); a field that does not answer is an older A(DAI),
 * and then the coil takes the keyboard back each time the field takes it: `m` still works, but nothing can be typed
 * into the field.
 */
export function Field(props: { site: string; current: ManifestWork | null; onBrowse: (b: boolean) => void; onKey: (key: string) => void }) {
  const { site, current, onBrowse, onKey } = props
  // the address is fixed when the field opens: changing it would reload the whole field
  const [src] = useState(() => fieldUrl(site, current))
  const [ready, setReady] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const keeper = useRef<HTMLSpanElement>(null)
  const bridged = useRef(false)
  const cb = useRef(onKey)
  cb.current = onKey

  useEffect(() => {
    onBrowse(true)
    return () => onBrowse(false)
  }, [onBrowse])

  useEffect(() => {
    const origin = new URL(src).origin
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== origin) return
      const d = e.data as { adai?: string; key?: string } | null
      if (d?.adai === 'embed-ready') bridged.current = true
      else if (d?.adai === 'embed-key' && typeof d.key === 'string' && KEYS.includes(d.key)) cb.current(d.key)
    }
    // an A(DAI) without the handshake: take the keyboard back whenever the field takes it
    const onBlur = () =>
      setTimeout(() => {
        if (!bridged.current && document.activeElement === frame.current) keeper.current?.focus({ preventScroll: true })
      }, 0)
    window.addEventListener('message', onMessage)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('message', onMessage)
      window.removeEventListener('blur', onBlur)
    }
  }, [src])

  const hello = () => {
    setReady(true)
    frame.current?.contentWindow?.postMessage({ adai: 'embed-hello', keys: KEYS }, new URL(src).origin)
  }
  return (
    <>
      <iframe ref={frame} className="field-frame" src={src} title="A(DAI) field: the commons' own view" data-ready={ready || undefined} onLoad={hello} allow="fullscreen" />
      <span ref={keeper} tabIndex={-1} className="field-keeper" aria-hidden="true" />
    </>
  )
}

/** where the field is: the A(DAI) site (or `?field=`), focused on a work when one is given */
export function fieldUrl(site: string, work: Pick<ManifestWork, 'slug'> | null, search = window.location.search): string {
  const asked = new URLSearchParams(search).get('field')
  const base = (asked && /^https?:\/\/[^\s]+$/.test(asked) ? asked : site).replace(/\/+$/, '')
  return work ? `${base}/field/artwork/${encodeURIComponent(work.slug)}` : `${base}/field`
}
