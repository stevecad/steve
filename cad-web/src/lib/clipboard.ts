/**
 * Copies text. `navigator.clipboard` exists only in secure contexts (HTTPS or localhost); a studio opened over
 * plain HTTP from another machine falls back to a hidden textarea and the browser's copy command.
 */
export async function copyText(text: string): Promise<boolean> {
  // Bound permission waits in embedded browsers so callers can show a failure.
  try {
    if (navigator.clipboard && window.isSecureContext && await Promise.race([
      navigator.clipboard.writeText(text).then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1500)),
    ])) return true;
  } catch { /* Try a selected textarea within the active focus scope. */ }
  const focused = document.activeElement as HTMLElement | null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  (focused?.closest('[role="dialog"]') ?? document.body).appendChild(area);
  area.select();
  let copied = false;
  try { copied = document.execCommand('copy'); }
  catch { /* Report failure to the caller. */ }
  finally {
    area.remove();
    focused?.focus({ preventScroll: true });
  }
  return copied;
}
