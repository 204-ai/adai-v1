import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { gesture, startPaused } from '../lib/gesture.ts'
import { TITLE, workLabel } from '../lib/copy.ts'
import { keyAction, type Action } from '../lib/keys.ts'
import { layout, nextMode, type Mode } from '../lib/layout.ts'
import type { Manifest, ManifestWork } from '../lib/manifest.ts'
import { CoilOrder } from '../lib/order.ts'
import type { Settings } from '../lib/params.ts'
import { Stepper } from '../lib/stepper.ts'
import { Gallery } from './Gallery.tsx'
import { Field } from './Field.tsx'
import { Credit, Hint, ModeButton } from './Overlays.tsx'
import { Timeline } from './Timeline.tsx'
import { Vortex } from './Vortex.tsx'
import { City } from './City.tsx'
import { WorkPanel } from './WorkPanel.tsx'
import { panelFrame } from '../lib/panel.ts'
import { wormholeExit } from '../lib/vortex.ts'

export interface CoilState {
  current: ManifestWork | null
  turn: number
  pos: number
  paused: boolean
}

/** The stream: two pooled images on one stage, fed by the coil's order. */
export function TimeCoil({ manifest, settings }: { manifest: Manifest; settings: Settings }) {
  const works = useMemo(() => new Map(manifest.works.map((w) => [w.id, w])), [manifest])
  const a = useRef<HTMLImageElement>(null)
  const b = useRef<HTMLImageElement>(null)
  const stepper = useRef<Stepper | null>(null)
  // Resolve the start before the first render: the field keeps its initial address, even while the image decodes.
  const order = useMemo(() => {
    const o = new CoilOrder(manifest.works, { seed: settings.seed, fuzz: settings.fuzz })
    const work = settings.work ? manifest.works.find((w) => w.slug === settings.work)?.id : null
    const artist = settings.artist ? manifest.artists.find((x) => x.slug === settings.artist)?.id : null
    o.startAt({ work, artist }, (id) => works.get(id)?.artist)
    return o
  }, [manifest, settings, works])
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  const touch = useMemo(() => window.matchMedia('(pointer: coarse)').matches, [])
  const paused0 = startPaused(settings.paused, reduced)
  const [state, setState] = useState<CoilState>(() => ({ current: works.get(order.current()) ?? null, turn: order.turn, pos: order.pos, paused: paused0 }))
  const [credit, setCredit] = useState(false)
  const [touched, setTouched] = useState(false)
  const [hover, setHover] = useState<string | null>(null)
  const [view, setView] = useState(() => ({ W: window.innerWidth, H: window.innerHeight }))
  // the mode is only the view; the stepper, order and history below never see it
  const [mode, setMode] = useState<Mode>(settings.mode)
  // a hover belongs to the view it happened in
  useEffect(() => setHover(null), [mode])
  // the work open for a closer look in the gallery, if any
  const [open, setOpen] = useState<string | null>(null)
  // jumps into the vortex's wormhole: how many so far, and where the latest lets out
  const [warp, setWarp] = useState<{ n: number; to: string | null }>({ n: 0, to: null })
  // the line shown on the way down a wormhole
  const [note, setNote] = useState<{ n: number; text: string }>({ n: 0, text: '' })
  // down a wormhole: the run holds
  const [diving, setDiving] = useState(false)
  // the A(DAI) field is open: the run holds
  const browsingNow = useRef(false)
  const indexOf = useMemo(() => new Map(manifest.works.map((w, i) => [w.id, i])), [manifest])
  const L = useMemo(() => layout(view.W, view.H), [view])
  const act = useRef<(a: Action) => void>(() => undefined)
  const stroke = useRef<{ x: number; y: number; t: number } | null>(null)
  const suppressClick = useRef(false)

  useEffect(() => {
    const ia = a.current!, ib = b.current!
    const o = order
    const s = new Stepper(
      [ia, ib],
      (id) => works.get(id)!.img,
      o,
      {
        show: (id, slot) => {
          // the swap itself is a class flip on the elements, not a React render
          ia.classList.toggle('on', slot === 0)
          ib.classList.toggle('on', slot === 1)
          setState((st) => ({ ...st, current: works.get(id) ?? null, turn: o.turn, pos: o.pos }))
        },
        // no view here keeps the works that have left the stage
        retire: () => undefined,
        error: (id) => console.warn(`adai coil: could not load ${id}`),
      },
      { hold: settings.hold * 1000 },
    )
    s.setUserPaused(paused0)
    // the field opened before the run existed (a fresh load) holds it from the start
    if (browsingNow.current) s.setHeld(true)
    s.start()
    stepper.current = s
    return () => s.dispose()
  }, [order, settings, works, paused0])

  // keys and the window losing focus
  act.current = (action: Action) => {
    const s = stepper.current
    if (!s) return
    setTouched(true)
    if (action === 'pause') s.setUserPaused(!s.userPaused)
    else if (action === 'next') s.advance()
    else if (action === 'prev') s.back()
    else if (action === 'fullscreen') void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => undefined)
    else if (action === 'mode') (s.setHeld(false), setOpen(null), setDiving(false), setMode(nextMode))
    else if (action === 'credit') setCredit((c) => !c)
    else if (action === 'close') (setCredit(false), s.setHeld(browsingNow.current || diving), setOpen(null))
    else if (action === 'warp' && mode === 'vortex' && turnOrder.length > 1) {
      const to = turnOrder[wormholeExit(state.pos, turnOrder.length, Math.random())]!
      // the run holds while the viewer is down the wormhole, so the work they arrive at is still on stage when they are back
      s.setHeld(true)
      setDiving(true)
      setWarp((w) => ({ n: w.n + 1, to }))
      setNote((x) => ({ n: x.n + 1, text: `through to the ${Math.floor((works.get(to)?.year ?? 0) / 10) * 10}s` }))
    }
    setState((st) => ({ ...st, paused: s.paused }))
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // typing in a text field is not a command
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      const action = keyAction(e.key)
      if (!action) return
      e.preventDefault()
      act.current(action)
    }
    const blur = (b: boolean) => () => {
      stepper.current?.setBlurred(b)
      setState((st) => ({ ...st, paused: stepper.current?.paused ?? st.paused }))
    }
    const lost = blur(true), onFocus = blur(false)
    // focus moving into the framed field is still this page, not another window: the run is not blurred by it (and
    // when the field closes, no focus event comes back to clear it)
    const onBlur = () => setTimeout(() => (document.activeElement instanceof HTMLIFrameElement ? undefined : lost()), 0)
    const onVisible = () => (document.hidden ? lost() : onFocus())
    const onResize = () => setView({ W: window.innerWidth, H: window.innerHeight })
    window.addEventListener('resize', onResize)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const title = state.current ? `${state.current.title}, ${state.current.by.join(', ')}` : TITLE
  const run = { seed: settings.seed, turn: state.turn }
  const pick = (id: string) => (setTouched(true), stepper.current?.jump(id))
  // open a work: bring it on stage and hold the run while it is open
  const openWork = (id: string) => {
    const s = stepper.current
    if (!s) return
    setTouched(true)
    if (state.current?.id !== id) s.jump(id)
    s.setHeld(true)
    setOpen(id)
    setState((st) => ({ ...st, paused: s.paused }))
  }
  const closeWork = () => act.current('close')
  const browse = useCallback((b: boolean) => {
    const s = stepper.current
    browsingNow.current = b
    if (!s) return
    s.setHeld(b)
    setState((st) => ({ ...st, paused: s.paused }))
  }, [])
  const turnOrder = useMemo(() => order.orderOf(state.turn), [order, state.turn])
  const stageVars = { '--stage-x': `${L.stage.x}px`, '--stage-y': `${L.stage.y}px`, '--stage-w': `${L.stage.w}px`, '--stage-h': `${L.stage.h}px`, '--hold': `${settings.hold}s` } as CSSProperties
  return (
    <main
      className="coil"
      data-mode={mode}
      data-paused={state.paused || undefined}
      style={stageVars}
      onPointerDown={(e) => {
        suppressClick.current = false
        // The canvases pick works on a tap; touch swipes still step through the run.
        const target = e.target as Element
        const excluded = target.closest('button, a, .credit, .timeline, .work-panel') || (e.pointerType !== 'touch' && target.closest('.gallery'))
        stroke.current = excluded || !e.isPrimary ? null : { x: e.clientX, y: e.clientY, t: performance.now() }
      }}
      onPointerUp={(e) => {
        const s = stroke.current
        stroke.current = null
        const g = s && gesture(e.clientX - s.x, e.clientY - s.y, performance.now() - s.t)
        if (!g || (g === 'pause' && (e.target as Element).closest('.gallery'))) return
        suppressClick.current = true
        act.current(g)
      }}
      onPointerCancel={() => { stroke.current = null }}
      onClickCapture={(e) => {
        if (!suppressClick.current) return
        suppressClick.current = false
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {mode === 'field' ? (
        <Field site={manifest.site} current={state.current} onBrowse={browse} onKey={(k) => k === 'm' && act.current('mode')} />
      ) : (
        <>
          {mode === 'gallery' ? (
            <Gallery
              manifest={manifest}
              works={works}
              order={turnOrder}
              pos={state.pos}
              paused={state.paused}
              hold={settings.hold}
              open={open}
              onOpen={openWork}
              onClose={closeWork}
              onStep={(dir) => {
                for (let k = 0; k < Math.abs(dir); k++) act.current(dir > 0 ? 'next' : 'prev')
              }}
              onPause={() => act.current('pause')}
              onHover={setHover}
            />
          ) : mode === 'city' ? (
            <City manifest={manifest} works={works} current={state.current} paused={state.paused} hold={settings.hold} onPick={pick} onPause={() => act.current('pause')} onHover={setHover} />
          ) : (
            <Vortex
              works={works}
              order={turnOrder}
              pos={state.pos}
              paused={state.paused}
              hold={settings.hold}
              warp={warp.n}
              onPortal={(id) => {
                stepper.current?.setHeld(true)
                setDiving(true)
                setNote((x) => ({ n: x.n + 1, text: `into ${works.get(id)?.title ?? 'the work'}` }))
              }}
              onLanded={() => {
                stepper.current?.setHeld(false)
                setDiving(false)
                setState((st) => ({ ...st, paused: stepper.current?.paused ?? st.paused }))
              }}
              onArrive={(id) => (id ? pick(id) : warp.to && stepper.current?.jump(warp.to))}
              onPause={() => act.current('pause')}
              onHover={setHover}
            />
          )}
          <Timeline order={turnOrder} pos={state.pos} works={works} current={state.current} onPick={pick} />
          {mode === 'vortex' && (
            <button className="warp-button" onClick={() => act.current('warp')}>
              jump into the wormhole <kbd>j</kbd>
            </button>
          )}
          {mode === 'vortex' && note.n > 0 && (
            <p className="warp-note" key={note.n} aria-live="polite">
              {note.text}
            </p>
          )}
          {mode === 'gallery' && open && works.get(open) && (
            <WorkPanel key={open} work={works.get(open)!} index={indexOf.get(open)!} site={manifest.site} frame={panelFrame(view.W, view.H)} onOpen={openWork} onClose={closeWork} />
          )}
          {!open && (hover ? works.get(hover) : state.current) && (
            <div className="gallery-label" data-hovered={hover || undefined}>
              {workLabel((hover ? works.get(hover) : state.current)!)}
            </div>
          )}
        </>
      )}
      <div className="screen">
        <img ref={a} className="on" crossOrigin="anonymous" alt={title} draggable={false} />
        <img ref={b} crossOrigin="anonymous" alt={title} draggable={false} />
      </div>
      <Hint gone={touched} touch={touch} />
      {touch && <ModeButton mode={mode} onClick={() => act.current('mode')} />}
      {mode === 'field' && (
        <button className="field-next" onClick={() => act.current('mode')} title="The next view (m)">
          mode ›
        </button>
      )}
      {credit && state.current && <Credit work={state.current} site={manifest.site} run={run} onClose={() => act.current('close')} />}
    </main>
  )
}
