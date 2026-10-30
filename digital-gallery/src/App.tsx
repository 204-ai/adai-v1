import { useEffect, useState } from 'react'
import { dataUrl } from './lib/commons.ts'
import { NOTICE } from './lib/copy.ts'
import type { Manifest } from './lib/manifest.ts'
import { parseParams } from './lib/params.ts'
import { TimeCoil } from './ui/TimeCoil.tsx'

type Load = { state: 'loading' } | { state: 'missing' } | { state: 'ready'; manifest: Manifest }

/** Loads the generated manifest; without it the stage says how to make one. */
export function App() {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [settings] = useState(() => parseParams(window.location.search))
  useEffect(() => {
    let live = true
    fetch(dataUrl('manifest.json'))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((m: Manifest) => live && setLoad(m.works?.length ? { state: 'ready', manifest: m } : { state: 'missing' }))
      .catch(() => live && setLoad({ state: 'missing' }))
    return () => {
      live = false
    }
  }, [])
  if (load.state === 'missing')
    return (
      <main className="notice">
        <p>{NOTICE}</p>
      </main>
    )
  if (load.state === 'loading') return <main className="coil" aria-busy="true" />
  return <TimeCoil manifest={load.manifest} settings={settings} />
}
