// Every word the stage can show. Nothing else renders text over the void.
import { collection } from './collection.ts'
import type { ManifestWork } from './manifest.ts'

export const KEY_HINT = 'space pause · ← → step · m mode · i credit · f fullscreen'
export const TOUCH_HINT = 'tap pause · swipe step'
export const PAUSE_LABEL = 'press space'
export const COMMONS = 'A(DAI) Digital Arts Commons'
export const RIGHTS_NOTE = 'Image rights stay with the artist and other rights holders.'
export const NOTICE = 'No manifest yet. Run npm run manifest.'
export const notice = () => `No ${collection().name} manifest yet. Run ${collection().build}.`

export const STAGE_COPY = { KEY_HINT, TOUCH_HINT, PAUSE_LABEL, COMMONS, RIGHTS_NOTE, NOTICE }

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
    where: `${collection().long} · via ${work.source} · seed ${run.seed} · turn ${run.turn + 1}`,
    link: collection().workUrl(work, site),
    note: RIGHTS_NOTE,
  }
}

/** The coil and strip label: who, what, when. */
export const workLabel = (work: ManifestWork) => `${work.by[0] ?? ''} · ${work.title} · ${work.date}`
