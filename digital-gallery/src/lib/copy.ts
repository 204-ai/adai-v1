// Every word the stage can show. Nothing else renders text over the void.
import { workUrl } from './commons.ts'
import type { ManifestWork } from './manifest.ts'

export const KEY_HINT = 'space pause · ← → step · m mode · i credit · f fullscreen'
export const TOUCH_HINT = 'tap background to pause · swipe to step'
export const COMMONS = 'A(DAI) Digital Arts Commons'
export const RIGHTS_NOTE = 'Image rights stay with the artist and other rights holders.'
export const NOTICE = 'No manifest yet. Run npm run manifest.'
/** the page's name, before a work is on stage */
export const TITLE = 'A(DAI) Digital Gallery'

export const STAGE_COPY = { KEY_HINT, TOUCH_HINT, COMMONS, RIGHTS_NOTE, NOTICE }

export interface CreditLines {
  title: string
  by: string
  date: string
  basis: string
  where: string
  link: string
  note: string
}

/** The credit panel (`i`): the work, who made it, when and on what basis, and its record in the commons. */
export function creditLines(work: ManifestWork, site: string, run: { seed: number; turn: number }): CreditLines {
  return {
    title: work.title,
    by: work.by.join(', '),
    date: work.date,
    basis: work.basis,
    where: `${COMMONS} · via ${work.source} · seed ${run.seed} · turn ${run.turn + 1}`,
    link: workUrl(work, site),
    note: RIGHTS_NOTE,
  }
}

/** The coil and strip label: who, what, when. */
export const workLabel = (work: ManifestWork) => `${work.by[0] ?? ''} · ${work.title} · ${work.date}`
