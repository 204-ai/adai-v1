// "Something was just contributed" — the write path tells whoever listens
// (issue #81: src/index.ts starts the claimant notifier on it). No imports
// on purpose: src/utils/contribution.ts calls this, and nothing it pulls in
// may reach back into the write path.

type Listener = () => void;
const listeners = new Set<Listener>();

export function onContribution(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function contributionWritten(): void {
  for (const fn of listeners) {
    try { fn(); } catch (e) { console.error("[notify] listener failed:", e); }
  }
}
