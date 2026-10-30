import { useMemo, useRef, useState } from 'react'
import { workLabel } from '../lib/copy.ts'
import type { ManifestWork } from '../lib/manifest.ts'
import { axisOf, decades, fracOf, tickState, timeAt } from '../lib/timeline.ts'

/**
 * mind.lol's top tabs, now a time axis: one tick per work of this turn — magenta behind, yellow now, cyan ahead.
 * Hover names the nearest work (who · what · when); click shows it.
 */
export function Timeline(props: { order: string[]; pos: number; works: Map<string, ManifestWork>; current: ManifestWork | null; onPick: (id: string) => void }) {
  const { order, pos, works, current, onPick } = props
  const a = useMemo(() => axisOf([...works.values()].map((w) => w.year)), [works])
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ f: number; id: string } | null>(null)
  // the turn's work nearest a point on the axis; none before the first work has taken the stage (the order is empty)
  const nearest = (f: number): string | null => {
    if (!order.length) return null
    const t = timeAt(f, a)
    let best = order[0]!, d = Infinity
    for (const id of order) {
      const dd = Math.abs(works.get(id)!.year - t)
      if (dd < d) (d = dd, (best = id))
    }
    return best
  }
  const fAt = (x: number) => {
    const r = ref.current!.getBoundingClientRect()
    return (x - r.left) / r.width
  }
  return (
    <div
      ref={ref}
      className="timeline"
      role="slider"
      tabIndex={0}
      aria-label="Time"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, order.length - 1)}
      aria-valuenow={pos}
      aria-valuetext={current ? workLabel(current) : undefined}
      onPointerMove={(e) => {
        const f = fAt(e.clientX), id = nearest(f)
        setHover(id ? { f, id } : null)
      }}
      onPointerLeave={() => setHover(null)}
      onClick={(e) => {
        const id = nearest(fAt(e.clientX))
        if (id) onPick(id)
      }}
    >
      <div className="rail" />
      {decades(a).map((y) => (
        <i key={y} className="decade" style={{ left: `${fracOf(y, a) * 100}%` }} />
      ))}
      {order.map((id, i) => {
        const w = works.get(id)
        return w ? <b key={id} className={`tick ${tickState(i, pos)}`} style={{ left: `${fracOf(w.year, a) * 100}%` }} /> : null
      })}
      {hover && (
        <span className="label" style={{ left: `${Math.min(0.88, Math.max(0.12, hover.f)) * 100}%` }}>
          {workLabel(works.get(hover.id)!)}
        </span>
      )}
    </div>
  )
}
