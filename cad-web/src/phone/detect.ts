/**
 * Phones get their own shell (phone/PhoneShell.tsx); tablets and desktops keep the desktop shell unchanged.
 *
 * A phone is a touch-first device whose screen is phone-sized on its short side:
 *   (pointer: coarse)  and  min(screen.width, screen.height) < 600 CSS px.
 * Phones measure 320–440 px on the short side; the smallest tablets (iPad mini) 744 px, so tablets never match, in
 * either orientation, with the keyboard up or in split view. A desktop or laptop (fine pointer) never matches however
 * small its window. The screen, not the window, decides, and only once at load, so the layout never flips mid-session
 * (rotating a phone keeps the phone shell; it lays itself out for landscape).
 *
 * `?ui=phone` or `?ui=desktop` overrides the rule for this browser (remembered; `?ui=auto` forgets it).
 */
const KEY = 'steve-ui';

function override(): 'phone' | 'desktop' | null {
  try {
    const asked = new URLSearchParams(location.search).get('ui');
    if (asked === 'phone' || asked === 'desktop') localStorage.setItem(KEY, asked);
    else if (asked === 'auto') localStorage.removeItem(KEY);
    const kept = localStorage.getItem(KEY);
    return kept === 'phone' || kept === 'desktop' ? kept : null;
  } catch {
    return null;
  }
}

function detect(): boolean {
  if (typeof window === 'undefined') return false;
  const forced = override();
  if (forced) return forced === 'phone';
  const coarse = !!window.matchMedia?.('(pointer: coarse)').matches;
  return coarse && Math.min(window.screen.width, window.screen.height) < 600;
}

const PHONE = detect();
if (PHONE && typeof document !== 'undefined') document.documentElement.dataset.ui = 'phone';

/** This device uses the phone shell (decided once at load). */
export const isPhone = () => PHONE;
