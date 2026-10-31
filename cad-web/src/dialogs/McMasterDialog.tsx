/**
 * McMaster-Carr: browse the catalog in its own window, download a part's 3-D STEP, drop it here (as vibecad's
 * McMasterInsert does). The file is checked like any import, inserted named by its part number, and kept in "Your
 * McMaster parts" for reuse by the person and STEVE. Nothing here contacts mcmaster.com: the site refuses frames
 * and has no open API, so the download is always the person's own.
 */
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, FileUp, Search, Store, X } from 'lucide-react';
import { Button, Dialog, Spinner } from '@/ui';
import { ApiError, importInfo, mcmasterParts, reuseMcmasterPart, uploadMcmaster, type McMasterImport, type McMasterPart } from '@/lib/api';
import { get, set, toast, useApp } from '@/state/store';
import { addImport, formatBytes } from '@/state/imports';
import { catalogDescription, isPartNumber, MCMASTER_SUFFIXES, normalizePartNumber, openMcmaster, partNumberFromFilename, productUrl, useMcmaster } from '@/state/mcmaster';
import { mcmasterUrl } from '@/lib/safeUrl';
import CopyMessage from '@/shell/CopyMessage';
import styles from './McMasterDialog.module.css';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const identifier = (partNumber: string) => `mcmaster_${partNumber.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export default function McMasterDialog({ open }: { open: boolean }) {
  const doc = useApp((state) => state.doc);
  const pending = useMcmaster((state) => state.file);
  const [file, setFile] = useState<File | null>(null);
  const [partNumber, setPartNumber] = useState('');
  const [title, setTitle] = useState('');
  const [lookup, setLookup] = useState('');
  const [search, setSearch] = useState('');
  const [parts, setParts] = useState<McMasterPart[] | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const close = () => { if (!working) { set({ dialog: null }); useMcmaster.setState({ file: null }); } };

  const take = (next: File | null) => {
    setError(null);
    if (next && !MCMASTER_SUFFIXES.test(next.name)) { setError(`${next.name}: drop the 3-D STEP McMaster-Carr sent (.step, .stp, or the .zip it came in).`); return; }
    setFile(next);
    const number = next ? partNumberFromFilename(next.name) : '';
    setPartNumber(number);
    setTitle(next && number ? catalogDescription(number, next.name) : '');
  };

  // A file dropped on the viewport (or on this dialog: the window's drop handler routes it here).
  useEffect(() => { if (open && pending) { take(pending); useMcmaster.setState({ file: null }); } }, [open, pending]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!open) { setFile(null); setError(null); setProgress(0); setDragging(false); } }, [open]);

  // Your McMaster parts, filtered as you type.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      mcmasterParts(search).then((value) => { if (!cancelled) setParts(value.parts); }).catch((caught) => { if (!cancelled) setError((caught as Error).message); });
    }, search ? 200 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, search, working]);

  const target = doc.open && doc.kind === 'part' ? `Insert into ${doc.name || 'this part'}` : doc.open && doc.kind === 'design' ? `Add to ${doc.name || 'this design'}` : 'Insert as a new part';
  const number = normalizePartNumber(partNumber);

  const place = async (record: McMasterImport) => {
    while (record.status === 'validating') {
      await sleep(600);
      record = { ...(await importInfo(record.id)), mcmaster: record.mcmaster };
    }
    if (record.status === 'failed') throw new Error(record.error ?? 'The geometry kernel couldn’t read this file.');
    const { part_number: pn, title: name, provenance } = record.mcmaster;
    set({ dialog: null });
    await addImport(record, provenance, { id: identifier(pn), name: `${pn} ${name}`.slice(0, 120) });
  };

  const insertFile = async () => {
    if (!file || working) return;
    if (number && !isPartNumber(number)) { setError(`${number} doesn’t look like a McMaster-Carr part number (for example 91251A540).`); return; }
    if (get().busy) { toast('info', 'One moment', 'Wait for the current operation to finish.'); return; }
    setWorking(number || file.name); setError(null); setProgress(0);
    try {
      await place(await uploadMcmaster(file, { partNumber: number, title }, setProgress));
    } catch (caught) {
      setError(caught instanceof ApiError || caught instanceof Error ? caught.message : String(caught));
    } finally {
      setWorking(null);
    }
  };

  const insertCached = async (part: McMasterPart) => {
    if (working) return;
    if (get().busy) { toast('info', 'One moment', 'Wait for the current operation to finish.'); return; }
    setWorking(part.part_number); setError(null);
    try {
      await place(await reuseMcmasterPart(part.part_number));
    } catch (caught) {
      setError(`${part.part_number}: ${(caught as Error).message}`);
    } finally {
      setWorking(null);
    }
  };

  const openLookup = () => {
    const value = normalizePartNumber(lookup);
    if (value && !isPartNumber(value)) { setError(`${value} doesn’t look like a McMaster-Carr part number (for example 91251A540).`); return; }
    setError(null);
    openMcmaster(value ? productUrl(value) : undefined);
  };

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) close(); }} width={760} icon={<Store size={18} />} title="McMaster-Carr"
      description="Find the part on McMaster-Carr in its own window, download its 3-D STEP, and drop the file here. It’s inserted named by its part number and kept in your McMaster parts."
      footer={<>
        <span className={styles.note}>Downloads are yours: STEVE never contacts McMaster-Carr.</span>
        <span style={{ flex: 1 }} />
        <Button size="sm" onClick={close} disabled={!!working}>Cancel</Button>
        <Button size="sm" variant="primary" id="insert-mcmaster" disabled={!file || !!working} onClick={() => void insertFile()}>
          {working && file ? <><Spinner size={12} /> {progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : 'Checking the part…'}</> : number ? `${target}: ${number}` : target}
        </Button>
      </>}>
      <div className={styles.body} id="mcmaster">
        <div className={styles.browse}>
          <Button size="sm" variant="primary" icon={<ExternalLink />} id="open-mcmaster" onClick={() => { setError(null); openMcmaster(); }}>Open McMaster-Carr</Button>
          <span className={styles.or}>or go straight to a part</span>
          <label className={styles.lookup}>
            <input value={lookup} id="mcmaster-lookup" aria-label="McMaster-Carr part number" placeholder="91251A540" spellCheck={false}
              onChange={(event) => setLookup(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') openLookup(); }} />
          </label>
          <Button size="sm" onClick={openLookup} disabled={!lookup.trim()} id="open-mcmaster-part">Open on McMaster</Button>
        </div>
        <ol className={styles.steps}>
          <li>Find the part on McMaster-Carr</li>
          <li>Choose <b>3-D STEP</b> and download it</li>
          <li>Drop the file here</li>
        </ol>

        {!file ? (
          <div className={styles.drop} data-dragging={dragging || undefined} id="mcmaster-drop" role="button" tabIndex={0}
            onClick={() => picker.current?.click()} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') picker.current?.click(); }}
            onDragEnter={() => setDragging(true)} onDragLeave={() => setDragging(false)} onDrop={() => setDragging(false)}>
            <FileUp size={26} />
            <span><b>Drop the downloaded STEP or ZIP here</b><br />or <u>choose the file</u> from your Downloads</span>
          </div>
        ) : (
          <div className={styles.file} id="mcmaster-file">
            <FileUp size={18} />
            <div className={styles.fileFields}>
              <span className={styles.fileName} title={file.name}>{file.name} <small>{formatBytes(file.size)}</small></span>
              <div className={styles.fieldRow}>
                <label><span>Part number</span>
                  <input value={partNumber} id="mcmaster-part-number" spellCheck={false} placeholder="91251A540" data-invalid={(number && !isPartNumber(number)) || undefined}
                    onChange={(event) => setPartNumber(event.target.value)} /></label>
                <label data-wide><span>Description</span>
                  <input value={title} id="mcmaster-title" placeholder="From the file name" onChange={(event) => setTitle(event.target.value)} /></label>
              </div>
              {!partNumber && <small className={styles.hint}>No part number in the file name: enter it so the part is named and kept by it.</small>}
            </div>
            <button type="button" className={styles.clear} aria-label="Choose another file" onClick={() => take(null)} disabled={!!working}><X size={14} /></button>
          </div>
        )}
        <input ref={picker} type="file" accept=".step,.stp,.zip" hidden onChange={(event) => { take(event.target.files?.[0] ?? null); event.target.value = ''; }} />

        {error && <div className={styles.error} role="alert"><span>{error}</span><CopyMessage text={error} /></div>}

        <section className={styles.cache} aria-label="Your McMaster parts">
          <div className={styles.cacheHead}>
            <b>Your McMaster parts</b>
            <label className={styles.filter}>
              <Search size={13} />
              <input value={search} aria-label="Search your McMaster parts" placeholder="Search" onChange={(event) => setSearch(event.target.value)} />
            </label>
          </div>
          <div className={styles.list} id="mcmaster-parts">
            {parts === null ? <span className={styles.muted}>Loading…</span>
              : !parts.length ? <span className={styles.muted}>{search ? `Nothing matches “${search}”.` : 'Parts you bring in stay here, so you and STEVE can insert them again without downloading.'}</span>
                : parts.map((part) => (
                  <div key={part.part_number} className={styles.row} data-part-number={part.part_number}>
                    <code>{part.part_number}</code>
                    <span className={styles.rowTitle} title={part.title}>{part.title}</span>
                    <span className={styles.date}>{when(part.last_used)}</span>
                    <a href={mcmasterUrl(part.url)} target="_blank" rel="noopener noreferrer" aria-label={`${part.part_number} on McMaster-Carr`} onClick={(event) => { event.preventDefault(); openMcmaster(part.url); }}><ExternalLink size={12} /></a>
                    <Button size="sm" disabled={!!working} onClick={() => void insertCached(part)}>{working === part.part_number && !file ? <Spinner size={12} /> : 'Insert'}</Button>
                  </div>
                ))}
          </div>
        </section>
      </div>
    </Dialog>
  );
}
