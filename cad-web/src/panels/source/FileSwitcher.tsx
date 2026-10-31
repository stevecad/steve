/**
 * Where you are in the code, as a breadcrumb: `Design › file ▾`. The menu lists a design's files by what they
 * are (the design itself, its components, helpers, tables), with search and the keyboard (Ctrl/Cmd+P opens it).
 * Import table… adds a .csv beside main.py that code reads with `table("holes.csv")` (patterns at its points); an
 * Excel .xlsx becomes that .csv in the browser (one sheet: the first, or the one picked here when it has several).
 * Import logo… adds a PNG or JPEG beside main.py that a drawing's title block cell draws (`{"image": "logo.png"}`);
 * logos are listed, never opened in the editor.
 * A part is one file: the breadcrumb is all it needs.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Box, ChevronDown, ChevronRight, FileCode, FileCog, Image as ImageIcon, Plus, Search, SlidersHorizontal, Table2 } from 'lucide-react';
import { useApp } from '@/state/store';
import { addComponent, importImage, importTable, openFile } from '@/state/actions';
import { fileLabel, filesOf, hasFiles, isImage, isTable, MAIN, PARAMS } from '@/state/design';
import styles from '../SourcePanel.module.css';

type Group = 'Design' | 'Components' | 'Helpers' | 'Tables' | 'Logos';
interface Entry { path: string; label: string; group: Group }

const groupOf = (path: string): Group => (path === MAIN || path === PARAMS ? 'Design' : path.startsWith('components/') ? 'Components' : isTable(path) ? 'Tables' : isImage(path) ? 'Logos' : 'Helpers');
const labelOf = (path: string) => (path === MAIN ? 'main' : path === PARAMS ? 'Parameters' : path.startsWith('components/') ? fileLabel(path) : path.replace(/\.py$/, ''));
const ICONS = { [MAIN]: FileCode, [PARAMS]: SlidersHorizontal } as Record<string, typeof FileCode>;
const iconOf = (path: string) => ICONS[path] ?? (path.startsWith('components/') ? Box : isTable(path) ? Table2 : isImage(path) ? ImageIcon : FileCog);
const ORDER: Group[] = ['Design', 'Components', 'Helpers', 'Tables', 'Logos'];
const LOGO_HINT = (path: string) => `Drawn in a drawing’s title block: a cell like {"width": 50, "image": "${path}"} in title_block=`;

export default function FileSwitcher({ open, onOpenChange, showName = true }: { open: boolean; onOpenChange: (open: boolean) => void; showName?: boolean }) {
  const doc = useApp((state) => state.doc);
  // A design's or shop's files; only a design has components.
  const design = hasFiles(doc.kind);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // A workbook with several sheets waits here, only until one is picked or the menu closes.
  const [workbook, setWorkbook] = useState<{ file: File; sheets: string[] } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const logoPicker = useRef<HTMLInputElement>(null);
  const entries = useMemo<Entry[]>(() => Object.keys(filesOf(doc))
    .map((path) => ({ path, label: labelOf(path), group: groupOf(path) }))
    .sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group) || (a.path === MAIN ? -1 : b.path === MAIN ? 1 : a.label.localeCompare(b.label))),
  [doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = entries.filter((entry) => !query.trim() || `${entry.label} ${entry.path}`.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => { if (open) { setQuery(''); setActive(Math.max(0, entries.findIndex((e) => e.path === doc.activeFile))); setAdding(null); setWorkbook(null); setTimeout(() => input.current?.focus(), 0); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setActive((index) => Math.min(index, Math.max(0, shown.length - 1))); }, [shown.length]);

  const choose = (path: string) => { if (isImage(path)) return; openFile(path); onOpenChange(false); };  // A logo isn't edited as text.
  const commit = () => {
    const id = (adding ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!id) { setAdding(null); return; }
    const outcome = addComponent(id, '');
    if (outcome === true) { setAdding(null); setProblem(null); onOpenChange(false); } else setProblem(outcome);
  };
  const importPicked = async (file: File | undefined, sheet?: string) => {
    if (!file) return;
    setWorkbook(null);
    const outcome = await importTable(file, sheet);
    if (outcome === true) { setProblem(null); onOpenChange(false); } else if (typeof outcome === 'string') setProblem(outcome); else { setProblem(null); setWorkbook({ file, sheets: outcome.sheets }); }
  };
  const importLogo = async (file: File | undefined) => {
    if (!file) return;
    const outcome = await importImage(file);
    if (outcome === true) { setProblem(null); onOpenChange(false); } else setProblem(outcome);
  };

  const name = doc.name.trim() || 'Untitled';
  const Icon = iconOf(doc.activeFile);
  return (
    <div className={styles.crumbs} id="source-breadcrumb">
      {showName && <span className={styles.crumbDoc} title={name}>{name}</span>}
      {showName && <ChevronRight size={12} className={styles.crumbSep} />}
      {design ? (
        <button type="button" className={styles.crumbFile} id="source-file" aria-haspopup="listbox" aria-expanded={open} data-file={doc.activeFile}
          title={`${doc.activeFile} · Go to file (Ctrl+P)`} onClick={() => onOpenChange(!open)}>
          <Icon size={12} /><span>{labelOf(doc.activeFile)}</span><ChevronDown size={12} />
        </button>
      ) : <span className={styles.crumbFile} data-static data-file={doc.kind === 'circuit' || doc.kind === 'blender' ? doc.activeFile : 'model.py'}><FileCode size={12} /><span>{doc.kind === 'circuit' || doc.kind === 'blender' ? doc.activeFile : 'model.py'}</span></span>}
      <AnimatePresence>
        {open && design && (
          <motion.div className={styles.filePopover} role="dialog" aria-label="Go to file" id="file-switcher"
            initial={{ opacity: 0, y: -4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4, scale: 0.98 }} transition={{ duration: 0.12 }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); onOpenChange(false); }
            }}>
            <label className={styles.fileSearch}>
              <Search size={13} />
              <input ref={input} value={query} placeholder="Go to file…" aria-label="Search files" spellCheck={false}
                onChange={(event) => { setQuery(event.target.value); setActive(0); }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)); }
                  if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
                  if (event.key === 'Enter' && shown[active]) { event.preventDefault(); choose(shown[active].path); }
                }} />
            </label>
            <div className={styles.fileList} role="listbox" aria-label="Design files">
              {ORDER.map((group) => {
                const items = shown.filter((entry) => entry.group === group);
                if (!items.length) return null;
                return (
                  <div key={group} className={styles.fileGroup}>
                    <div className={styles.fileGroupTitle}>{group === 'Design' && doc.kind === 'shop' ? 'Shop' : group}</div>
                    {items.map((entry) => {
                      const index = shown.indexOf(entry);
                      const ItemIcon = iconOf(entry.path);
                      return (
                        <button key={entry.path} type="button" role="option" aria-selected={index === active} data-file={entry.path}
                          className={styles.fileOption} data-active={index === active || undefined} data-current={entry.path === doc.activeFile || undefined}
                          title={isImage(entry.path) ? LOGO_HINT(entry.path) : undefined}
                          onMouseEnter={() => setActive(index)} onClick={() => choose(entry.path)}>
                          <ItemIcon size={13} /><span className={styles.fileOptionLabel}>{entry.label}</span><span className={styles.fileOptionPath}>{entry.path}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              {!shown.length && <div className={styles.fileEmpty}>No file matches “{query}”.</div>}
            </div>
            <div className={styles.fileFooter}>
              {doc.kind !== 'design' || workbook ? null : adding === null ? (
                <button type="button" className={styles.addComponent} id="add-component" onClick={() => { setAdding(''); setProblem(null); }}><Plus size={12} />New component</button>
              ) : (
                <span className={styles.newComponent} data-invalid={problem ? true : undefined} title={problem ?? undefined}>
                  <input autoFocus value={adding} placeholder="component_name" aria-label="New component name" spellCheck={false}
                    onChange={(event) => { setAdding(event.target.value); setProblem(null); }} onBlur={commit}
                    onKeyDown={(event) => { if (event.key === 'Enter') commit(); if (event.key === 'Escape') { event.stopPropagation(); setAdding(null); setProblem(null); } }} />
                </span>
              )}
              {doc.kind === 'design' && adding === null && workbook && (
                <span className={styles.sheetPicker} role="group" aria-label="Sheet to import" id="import-sheet">
                  <span className={styles.fileHint}>Sheet:</span>
                  {workbook.sheets.map((sheet) => (
                    <button key={sheet} type="button" className={styles.addComponent} data-sheet={sheet} title={`Import sheet “${sheet}” as ${workbook.file.name.replace(/\.xlsx$/i, '')} (.csv)`}
                      onClick={() => void importPicked(workbook.file, sheet)}>{sheet}</button>
                  ))}
                  <button type="button" className={styles.fileHint} onClick={() => setWorkbook(null)}>Cancel</button>
                </span>
              )}
              {doc.kind === 'design' && adding === null && !workbook && <>
                <button type="button" className={styles.addComponent} id="import-table" title={'Add a table of values (.csv, or a sheet of an Excel .xlsx saved as .csv) to this design: read it in code with table("name.csv"), e.g. design.pattern(part, points=table("holes.csv"))'}
                  onClick={() => { setProblem(null); picker.current?.click(); }}><Table2 size={12} />Import table…</button>
                <input ref={picker} type="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden aria-label="Import table (.csv or .xlsx)"
                  onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void importPicked(file); }} />
                <button type="button" className={styles.addComponent} id="import-logo" title={'Add a logo (PNG or JPEG, at most 512 KB and 4096 px a side) to this design, for a drawing’s title block: a cell like {"width": 50, "image": "logo.png"}'}
                  onClick={() => { setProblem(null); logoPicker.current?.click(); }}><ImageIcon size={12} />Import logo…</button>
                <input ref={logoPicker} type="file" accept=".png,image/png,.jpg,.jpeg,image/jpeg" hidden aria-label="Import logo (PNG or JPEG)"
                  onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void importLogo(file); }} />
              </>}
              {problem && adding === null && !workbook && <span className={styles.fileProblem} role="alert" title={problem}>{problem}</span>}
              {!workbook && <span className={styles.fileHint}>↑↓ choose · ↵ open</span>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
