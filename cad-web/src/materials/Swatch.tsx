import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/state/store';
import { PLAIN, type Surface } from './render';
import { cachedPreview, previewKey, renderPreview } from './preview';
import styles from './Materials.module.css';

/** A rendered PBR sphere of a material (and finish/color), drawn when it scrolls into view. */
export default function Swatch({ surface, size, square, urgent, className }: { surface: Surface; size: number; square?: boolean; urgent?: boolean; className?: string }) {
  const theme = useApp((state) => state.theme);
  const pixels = Math.round(size * Math.min(window.devicePixelRatio || 1, 2));
  const key = previewKey(surface, theme, pixels);
  const [url, setUrl] = useState<string | null | undefined>(() => cachedPreview(key));
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const known = cachedPreview(key);
    setUrl(known);
    if (known !== undefined) return;
    let cancelled = false;
    const load = () => { void renderPreview(surface, theme, pixels, urgent).then((value) => { if (!cancelled) setUrl(value); }); };
    const element = ref.current;
    if (!element || urgent || typeof IntersectionObserver === 'undefined') { load(); return () => { cancelled = true; }; }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); load(); } }, { rootMargin: '120px' });
    observer.observe(element);
    return () => { cancelled = true; observer.disconnect(); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <span ref={ref} className={`${styles.swatch} ${className ?? ''}`} data-square={square || undefined} data-ready={url ? true : undefined} data-class={surface.material?.appearance.class ?? 'dielectric'}
      style={{ width: size, height: size, ['--base' as string]: surface.color ?? surface.material?.appearance.base_color.srgb ?? PLAIN.color }} aria-hidden>
      {url && <img src={url} alt="" draggable={false} />}
    </span>
  );
}
