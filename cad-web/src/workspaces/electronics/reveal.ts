/** Selects a line of the circuit's code in Source (1-based; null just opens Source). */
import { get, set } from '@/state/store';

export function revealLine(line: number | null | undefined) {
  const code = get().doc.code;
  if (!line) { set({ dockOpen: true, dockTab: 'source' }); return; }
  const lines = code.split('\n');
  const from = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0);
  set({ dockOpen: true, dockTab: 'source', sourceReveal: { from, to: from + (lines[line - 1]?.length ?? 0), nonce: Date.now() } });
}
