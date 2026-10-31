/**
 * Keys in presentation view: Esc leaves it, Space plays or pauses, and the view's own keys (fit, the standard views,
 * display style, projection, grid) work. Every other shortcut waits, so nothing opens over the picture.
 */
import { commands, eventKey, handleShortcut } from '@/commands';
import { get } from '@/state/store';
import { exitPresentation, presentTake, togglePlaying } from './state';

const VIEW_COMMANDS = new Set(['view.fit', 'view.iso', 'view.front', 'view.back', 'view.left', 'view.right', 'view.top', 'view.bottom', 'view.cycleStyle', 'view.projection', 'view.grid', 'view.present', 'doc.save']);

/** Handles a key while presentation view is open; true when it was handled (or held back). */
export function handlePresentationKey(event: KeyboardEvent): boolean {
  if (get().dialog || event.defaultPrevented) return false;
  const typing = (event.target as HTMLElement | null)?.closest?.('input, textarea, [contenteditable]');
  if (typing) return false;
  const key = eventKey(event);
  if (key === 'escape') { event.preventDefault(); exitPresentation(); return true; }
  // Space and K, as video players have them; a focused button keeps its own Space.
  if ((key === 'space' && !(event.target as HTMLElement | null)?.closest?.('button, [role="slider"]')) || key === 'k') {
    event.preventDefault();
    if (presentTake()) togglePlaying();
    return true;
  }
  if (commands.some(cmd => VIEW_COMMANDS.has(cmd.id) && cmd.keys?.includes(key))) handleShortcut(event);
  // The rest is held back from the app (the browser's own keys still work).
  return true;
}
