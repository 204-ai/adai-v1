import { useEffect, useState } from 'react'
import { collection } from '../lib/collection.ts'
import { KEY_HINT, PAUSE_LABEL, TOUCH_HINT, creditLines } from '../lib/copy.ts'
import type { Mode } from '../lib/layout.ts'
import type { ManifestWork } from '../lib/manifest.ts'

/** mind.lol's pause glyph, magenta; click resumes. */
export function PauseGlyph({ onClick }: { onClick: () => void }) {
  return (
    <button className="pause" onClick={onClick} aria-label="Resume">
      <svg viewBox="0 0 28.825 28.824" aria-hidden="true">
        <path d="M12.213,3v22.824c0,1.656-1.343,3-3,3H3.889c-1.658,0-3-1.344-3-3V3c0-1.656,1.342-3,3-3h5.324C10.87,0,12.213,1.344,12.213,3z M24.935,0h-5.323c-1.658,0-3,1.344-3,3v22.824c0,1.656,1.342,3,3,3h5.323c1.658,0,3-1.344,3-3V3C27.935,1.344,26.594,0,24.935,0z" />
      </svg>
      <span>{PAUSE_LABEL}</span>
    </button>
  )
}

/** The hint: keys on desktop, touch on a phone; 3.5 s after load, gone at the first input. */
export function Hint({ gone, touch }: { gone: boolean; touch: boolean }) {
  const [timeUp, setTimeUp] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setTimeUp(true), 3500)
    return () => clearTimeout(t)
  }, [])
  return (
    <p className="hint" data-gone={gone || timeUp || undefined} aria-hidden={gone || timeUp}>
      {touch ? TOUCH_HINT : KEY_HINT}
    </p>
  )
}

/** The credit panel (`i`): the work, its makers, its date and why, and its record in the commons. */
export function Credit({ work, site, run, onClose }: { work: ManifestWork; site: string; run: { seed: number; turn: number }; onClose: () => void }) {
  const c = creditLines(work, site, run)
  return (
    <aside className="credit" aria-label="Credit">
      <button className="credit-close" onClick={onClose} aria-label="Close credit">
        ×
      </button>
      <h1>{c.title}</h1>
      <p className="by">{c.by}</p>
      <p className="era">
        <strong>{c.date}</strong> · {c.basis}
      </p>
      <p className="collab">
        <a href={c.link} target="_blank" rel="noreferrer">
          {collection().open}
        </a>
      </p>
      <p className="where">{c.where}</p>
      <p className="note">{c.note}</p>
    </aside>
  )
}

const NEXT_LABEL: Record<Mode, string> = { field: 'Switch to the gallery', gallery: 'Switch to the vortex', vortex: 'Switch to the city', city: 'Switch to the A(DAI) field' }

/** Touch screens have no `m` key: this button steps through the A(DAI) field, the gallery, the vortex and the city. */
export function ModeButton({ mode, onClick }: { mode: Mode; onClick: () => void }) {
  return (
    <button className="mode-button" onClick={onClick} aria-label={NEXT_LABEL[mode]}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 12m-1.5 0a1.5 1.5 0 1 0 3 0a3 3 0 1 0 -6 0a4.5 4.5 0 1 0 9 0a6 6 0 1 0 -12 0a7.5 7.5 0 0 0 7.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </button>
  )
}
