import { useEffect, useRef, useState } from 'react'
import { fieldUrl } from '../lib/field.ts'
import type { ManifestWork } from '../lib/manifest.ts'

/** the keys the field hands back to the gallery (A(DAI)'s js-interface/embed.js) */
const KEYS = ['m']

/**
 * The field: A(DAI)'s own view of the commons (its `/field` page, the Shape of Time field), shown as it is, untouched,
 * from the A(DAI) site (`?field=<base url>` points it at a local A(DAI) while developing; lib/field.ts). It opens on
 * the work that was on stage; from there it is A(DAI)'s to drive. The run holds while it is open, since none of the
 * gallery's own stage shows.
 *
 * A framed page keeps the keyboard once clicked, so the gallery's `m` would be lost there. On load the gallery asks the
 * field for it back, and the field (A(DAI)'s embed.js) hands `m` back as a message instead of using it; only messages
 * from this frame, from the origin the field was loaded from, are taken.
 */
export function Field(props: { site: string; current: ManifestWork | null; onBrowse: (b: boolean) => void; onKey: (key: string) => void }) {
  const { site, current, onBrowse, onKey } = props
  // the address is fixed when the field opens: changing it would reload the whole field
  const [src] = useState(() => fieldUrl(site, current, window.location.search))
  const [ready, setReady] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
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
      if (d?.adai === 'embed-key' && typeof d.key === 'string' && KEYS.includes(d.key)) cb.current(d.key)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [src])

  const hello = () => {
    setReady(true)
    frame.current?.contentWindow?.postMessage({ adai: 'embed-hello', keys: KEYS }, new URL(src).origin)
  }
  return <iframe ref={frame} className="field-frame" src={src} title="A(DAI) field: the commons' own view" data-ready={ready || undefined} onLoad={hello} allow="fullscreen" />
}
