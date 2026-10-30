// keys → actions (kept pure so the map is tested, not just the handler).
export type Action = 'pause' | 'next' | 'prev' | 'mode' | 'fullscreen' | 'credit' | 'close' | 'warp'

export function keyAction(key: string): Action | null {
  switch (key) {
    case ' ':
    case 'Spacebar':
      return 'pause'
    case 'ArrowRight':
      return 'next'
    case 'ArrowLeft':
      return 'prev'
    case 'm':
    case 'M':
      return 'mode'
    case 'f':
    case 'F':
      return 'fullscreen'
    case 'i':
    case 'I':
      return 'credit'
    case 'Escape':
      return 'close'
    case 'j':
    case 'J':
      return 'warp'
    default:
      return null
  }
}
