import { useEffect, useState, type CSSProperties } from 'react'
import { BOX, CENTRE, bow, constellation, type Star } from '../lib/constellation.ts'
import { KIND_LABEL, LEGEND, NEIGHBOURHOOD, OPEN, entityUrl, workUrl } from '../lib/commons.ts'
import { detailUrl, type Detail } from '../lib/detail.ts'
import type { ManifestWork } from '../lib/manifest.ts'
import type { PanelFrame } from '../lib/panel.ts'

const short = (s: string, n = 24) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/**
 * The open work, up close: the panel beside it (under it on a tall screen). Its title, makers and date at once, from
 * the manifest; its words, facts, tags and neighbourhood in the commons as soon as its detail file arrives. Works in
 * the neighbourhood that hang here open in place; everything else opens in A(DAI).
 */
export function WorkPanel(props: { work: ManifestWork; index: number; site: string; frame: PanelFrame; onOpen: (id: string) => void; onClose: () => void }) {
  const { work, index, site, frame, onOpen, onClose } = props
  const [detail, setDetail] = useState<Detail | null>(null)

  useEffect(() => {
    setDetail(null)
    const ctl = new AbortController()
    fetch(detailUrl(index), { signal: ctl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<Detail>) : null))
      .then((d) => d && d.id === work.id && setDetail(d))
      .catch(() => undefined)
    return () => ctl.abort()
  }, [index, work.id])

  const kind = detail?.facts.find(([k]) => k === 'Object')?.[1]
  const facts = detail?.facts.filter(([k]) => k !== 'Object') ?? []
  const text = detail?.text ?? detail?.artists.find((a) => a.about)?.about ?? null
  return (
    <aside className="work-panel" data-side={frame.side} style={{ '--panel-size': `${frame.size}px` } as CSSProperties} aria-label={`${work.title}, up close`}>
      <header>
        <p className="eyebrow">
          {work.source}
          {kind ? ` · ${kind}` : ''}
        </p>
        <button className="work-panel-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <h1>{work.title}</h1>
      <p className="by">
        {(detail?.artists ?? []).length
          ? detail!.artists.map((a, i) => (
              <span key={a.id}>
                {i > 0 && ', '}
                <a href={entityUrl(site, a.type, a.slug)} target="_blank" rel="noreferrer">
                  {a.name}
                </a>
              </span>
            ))
          : work.by.join(', ')}
      </p>
      <p className="when">
        <strong>{work.date}</strong> · {work.basis}
      </p>

      {!detail ? (
        <div className="work-panel-wait" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : (
        <>
          {text && <p className="text">{text}</p>}
          {facts.length > 0 && (
            <dl className="facts">
              {facts.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          )}
          <section className="neighbourhood">
            <h2>{NEIGHBOURHOOD}</h2>
            <Constellation work={work} detail={detail} site={site} onOpen={onOpen} />
            <p className="legend">
              <span className="solid" /> {LEGEND[0]} <span className="dashed" /> {LEGEND[1]}
            </p>
          </section>
          {detail.artists
            .filter((a) => a.about && a.about !== text)
            .map((a) => (
              <section key={a.id} className="maker">
                <h2>{a.name}</h2>
                <p>{a.about}</p>
              </section>
            ))}
          {detail.tags.length > 0 && (
            <ul className="tags">
              {detail.tags.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          )}
        </>
      )}
      <footer>
        <a href={workUrl(work, site)} target="_blank" rel="noreferrer">
          {OPEN}
        </a>
        {detail?.source && (
          <a href={detail.source} target="_blank" rel="noreferrer">
            source record ↗
          </a>
        )}
        {detail?.artists[0]?.website && (
          <a href={detail.artists[0].website} target="_blank" rel="noreferrer">
            maker’s site ↗
          </a>
        )}
      </footer>
    </aside>
  )
}

function Constellation({ work, detail, site, onOpen }: { work: ManifestWork; detail: Detail; site: string; onOpen: (id: string) => void }) {
  const stars = constellation(detail.artists, detail.related)
  const [hover, setHover] = useState<Star | null>(null)
  return (
    <svg className="constellation" viewBox={`0 0 ${BOX.w} ${BOX.h}`} role="group" aria-label="This work's neighbourhood in the commons">
      <defs>
        <clipPath id="star-thumb" clipPathUnits="objectBoundingBox">
          <circle cx="0.5" cy="0.5" r="0.5" />
        </clipPath>
      </defs>
      <g className="threads">
        {stars.map((s, i) => (
          <path key={s.id} d={bow(s.from, s)} data-kind={s.kind} data-inferred={s.inferred || s.kind === 'affine' || s.kind === 'kin' || undefined} style={{ animationDelay: `${120 + i * 28}ms` }} />
        ))}
      </g>
      <g className="centre">
        <circle cx={CENTRE.x} cy={CENTRE.y} r={38} className="ring" />
        <image href={work.img} x={CENTRE.x - 34} y={CENTRE.y - 34} width={68} height={68} preserveAspectRatio="xMidYMid slice" clipPath="url(#star-thumb)" crossOrigin="anonymous" />
      </g>
      {stars.map((s, i) => {
        const open = s.img && s.here
        const body = (
          <g
            className="star"
            data-kind={s.kind}
            data-hovered={hover?.id === s.id || undefined}
            style={{ animationDelay: `${180 + i * 28}ms`, transformOrigin: `${s.x}px ${s.y}px` }}
            onPointerEnter={() => setHover(s)}
            onPointerLeave={() => setHover((h) => (h?.id === s.id ? null : h))}
          >
            <title>{`${s.name} — ${KIND_LABEL[s.kind]}${s.inferred ? ` (${LEGEND[1]})` : ''}`}</title>
            {s.img ? (
              <>
                <circle cx={s.x} cy={s.y} r={19} className="ring" />
                <image href={s.img} x={s.x - 17} y={s.y - 17} width={34} height={34} preserveAspectRatio="xMidYMid slice" clipPath="url(#star-thumb)" />
              </>
            ) : (
              <>
                <circle cx={s.x} cy={s.y} r={s.kind === 'maker' ? 6 : 3.5} className="dot" />
                <text x={s.x + (s.anchor === 'start' ? 9 : s.anchor === 'end' ? -9 : 0)} y={s.y + (s.anchor === 'middle' ? (s.kind === 'maker' ? -12 : s.drop) : 4)} textAnchor={s.anchor}>
                  {short(s.name, s.kind === 'maker' ? 30 : 22)}
                </text>
              </>
            )}
          </g>
        )
        return open ? (
          <a key={s.id} href="#" onClick={(e) => (e.preventDefault(), onOpen(s.id))} aria-label={`Open ${s.name}`}>
            {body}
          </a>
        ) : (
          <a key={s.id} href={entityUrl(site, s.type, s.slug)} target="_blank" rel="noreferrer" aria-label={`${s.name} in A(DAI)`}>
            {body}
          </a>
        )
      })}
      {hover && (
        <text className="caption" x={BOX.w / 2} y={BOX.h - 6} textAnchor="middle">
          {`${KIND_LABEL[hover.kind]} · ${short(hover.name, 48)}${hover.year ? ` · ${Math.floor(hover.year)}` : ''}`}
        </text>
      )}
    </svg>
  )
}
