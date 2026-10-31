/**
 * The public page behind a share link (/share/<token>, app/shares.py). No account and no sign-in: the link is the
 * authorization, and this page only ever calls /share/<token>/… (never the app's /v1 API). It shows the design in the
 * app's own viewer (ShareViewer), with the app's look (tokens, fonts, theme) and chrome: its desktop layout, or on phones
 * (phone/detect.ts, which also marks the page data-ui=phone, and `?ui=phone`) its phone shell's.
 */
import '@/phone/detect';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '../styles/tokens.css';
import '../styles/base.css';
import { applyThemeEarly } from '@/state/theme';
import { useApp } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import ShareViewer from './ShareViewer';
import './share.css';

// Test and debugging handle, as the app's `window.steve` (read-only view state and the viewer).
(window as unknown as { steveShare: unknown }).steveShare = { store: useApp, viewer };

applyThemeEarly();
const token = location.pathname.split('/').filter(Boolean)[1] ?? '';
createRoot(document.getElementById('root')!).render(<ShareViewer token={token} />);
