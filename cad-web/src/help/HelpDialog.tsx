import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { ArrowLeft, ArrowRight, BookOpen, Home, Search, X } from 'lucide-react';
import { Button, Dialog, IconButton, Spinner } from '@/ui';
import { copyText } from '@/lib/clipboard';
import { closeHelp, moveHelp, showHelp, useHelp } from './state';
import styles from './Help.module.css';

interface Page { path: string; title: string; description: string; group: string; html: string; search: string; headings: { id: string; title: string; level: number }[] }
interface Manual { version: number; groups: string[]; aliases: Record<string, string>; pages: Page[] }
let cached: Manual | null = null;

export default function HelpDialog({ open }: { open: boolean }) {
  const history = useHelp();
  const [manual, setManual] = useState<Manual | null>(cached);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const article = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const url = history.urls[history.index];
  const path = url.split('#')[0];
  const resolved = (manual?.aliases[path] ?? path) + (url.includes('#') ? '#' + url.split('#')[1] : '');
  const page = manual?.pages.find((item) => item.path === resolved.split('#')[0]);
  const hash = resolved.split('#')[1];

  useEffect(() => {
    if (!open || cached) { if (cached) setManual(cached); return; }
    let cancelled = false;
    setError('');
    void fetch('/help/content.json', { cache: 'no-cache' }).then(async (response) => {
      if (!response.ok) throw new Error('The bundled manual could not be loaded.');
      const data = await response.json() as Manual;
      if (data.version !== 1 || !Array.isArray(data.pages) || !data.pages.length) throw new Error('The bundled manual is incomplete.');
      cached = data;
      if (!cancelled) setManual(data);
    }).catch((failure: Error) => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; };
  }, [open, retry]);
  useEffect(() => { if (!open) setQuery(''); }, [open]);
  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      // The dialog's header/close control sits outside the reader grid. These
      // shortcuts must work from there as well as from article and sidebar.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault(); event.stopPropagation(); search.current?.focus();
      }
      if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault(); event.stopPropagation(); moveHelp(event.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [open]);

  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const results = useMemo(() => {
    if (!manual || !query.trim()) return [];
    const terms = query.trim().toLocaleLowerCase().split(/\s+/);
    return manual.pages.filter((item) => terms.every((word) => `${item.title} ${item.description} ${item.search}`.toLocaleLowerCase().includes(word)))
      .sort((a, b) => terms.reduce((sum, term) => sum + Number(b.title.toLocaleLowerCase().includes(term)) - Number(a.title.toLocaleLowerCase().includes(term)), 0));
  }, [manual, query]);
  const navigate = (target: string) => { setQuery(''); showHelp(target); };

  // Render only inert manual content. All navigation stays in this reader; images are bundled resources.
  const content = useCallback((node: HTMLDivElement | null) => {
    article.current = node;
    if (!node || !page) return;
    const fragment = DOMPurify.sanitize(page.html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'], FORBID_ATTR: ['style'], RETURN_DOM_FRAGMENT: true });
    fragment.querySelectorAll('a').forEach((link) => { if (!link.getAttribute('href')?.startsWith('/docs/')) link.removeAttribute('href'); });
    fragment.querySelectorAll('img').forEach((img) => { if (!/^\/help\/media\/[a-f0-9]+\.(png|jpe?g|webp|svg)$/.test(img.getAttribute('src') ?? '')) img.remove(); });
    node.replaceChildren(fragment);
    node.querySelectorAll('pre').forEach((pre) => {
      const code = pre.textContent ?? '';
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = 'Copy code'; button.className = styles.copy;
      button.addEventListener('click', () => { void copyText(code).then((ok) => { button.textContent = ok ? 'Copied' : 'Copy failed'; }); });
      pre.append(button);
    });
  }, [page]);

  const position = useCallback(() => {
    const heading = hash && article.current?.querySelector(`#${CSS.escape(decodeURIComponent(hash))}`);
    if (heading) heading.scrollIntoView({ block: 'start' });
    else scroll.current?.scrollTo({ top: positions.current.get(url) ?? 0 });
  }, [hash, url]);
  useEffect(() => { if (open) { const frame = requestAnimationFrame(position); return () => cancelAnimationFrame(frame); } }, [open, page, position]);
  const reader = useCallback((node: HTMLDivElement | null) => { scroll.current = node; if (node) requestAnimationFrame(position); }, [position]);

  return <Dialog open={open} onOpenChange={(value) => { if (!value) closeHelp(); }} fill className={styles.dialog}
    title="Steve CAD help" description="Modeling guides and local workspace reference · available offline" icon={<BookOpen size={24} />}>
    <div className={styles.shell} id="cad-help">
      <aside className={styles.sidebar}>
        <div className={styles.search}><Search size={15} /><input ref={search} type="search" aria-label="Search CAD help" placeholder="Search the manual…" value={query} onChange={(event) => setQuery(event.target.value)} />
          {query && <button aria-label="Clear help search" onClick={() => setQuery('')}><X size={14} /></button>}</div>
        <nav aria-label="CAD help topics" className={styles.nav}>
          {words.length ? <>
            <div className={styles.group}>{results.length} {results.length === 1 ? 'result' : 'results'}</div>
            {!results.length && <p className={styles.empty}>No topics match “{query}”. Try a tool name such as fillet, joint or dimension.</p>}
            {results.map((item) => <button key={item.path} className={styles.result} onClick={() => navigate(item.path)} data-help-path={item.path}><b>{item.title}</b><span>{item.description}</span></button>)}
          </> : manual?.groups.map((group) => <div key={group}><div className={styles.group}>{group}</div>
            {manual.pages.filter((item) => item.group === group).map((item) => <button key={item.path} className={styles.topic} aria-current={item === page ? 'page' : undefined}
              data-help-path={item.path} onClick={() => navigate(item.path)}>{item.title}</button>)}
          </div>)}
        </nav>
        <div className={styles.local}>On this device <span>{manual?.pages.length ?? '…'} topics</span></div>
      </aside>
      <main className={styles.main}>
        <div className={styles.toolbar}>
          <IconButton label="Previous help page" disabled={history.index === 0} onClick={() => moveHelp(-1)}><ArrowLeft /></IconButton>
          <IconButton label="Next help page" disabled={history.index === history.urls.length - 1} onClick={() => moveHelp(1)}><ArrowRight /></IconButton>
          <IconButton label="Help home" onClick={() => navigate('/docs/local/start/')}><Home /></IconButton>
          <span>{page?.group ?? 'CAD manual'}</span><small>Offline</small>
        </div>
        {error ? <div className={styles.empty}><h2>Help could not be loaded</h2><p>{error}</p><Button onClick={() => setRetry(retry + 1)}>Try again</Button></div>
          : !manual ? <div className={styles.empty}><Spinner /> Loading the local manual…</div>
          : !page ? <div className={styles.empty}><h2>This topic is not included locally</h2><p>Choose a CAD topic from the sidebar or search the manual.</p><Button onClick={() => navigate('/docs/local/start/')}>Open CAD guide</Button></div>
          : <div className={styles.scroll} ref={reader} onScroll={(event) => positions.current.set(url, event.currentTarget.scrollTop)}>
            <article className={styles.article}>
              <header><h1>{page.title}</h1><p className={styles.lead}>{page.description}</p></header>
              <div ref={content} className={styles.prose} onClick={(event) => {
                const link = (event.target as Element).closest('a[href]');
                if (link) { event.preventDefault(); navigate(link.getAttribute('href')!); }
              }} />
              <footer>Steve · CAD reference for the bundled Studio runtime</footer>
            </article>
          </div>}
      </main>
      <nav className={styles.contents} aria-label="On this page">
        <div className={styles.group}>On this page</div>
        {page?.headings.filter((heading) => heading.level <= 3).map((heading) => <button key={heading.id} data-level={heading.level} onClick={() => navigate(`${page.path}#${heading.id}`)}>{heading.title}</button>)}
      </nav>
    </div>
  </Dialog>;
}
