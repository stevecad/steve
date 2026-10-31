/** Saved section views in the model tree: click one to see that cut, fixed (again, or Esc, to clear it); right-click for more. */
import { useMemo } from 'react';
import { Code2, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import { SectionIcon } from '@/icons/cad';
import TreeRow from '@/shell/TreeRow';
import { BrowserGroup } from '@/shell/Browser';
import { useApp, type AppState } from '@/state/store';
import { MAIN, filesOf } from '@/state/design';
import { num } from '@/lib/format';
import { editSectionView, extent, holdsSections, parseSectionViews, removeSectionView, showSectionViewCode, toggleSectionView, type SectionView } from '@/viewport/sectionViews';
import { MenuLines, type Line } from './ItemMenu';
import styles from '@/shell/Browser.module.css';

const I = { size: 15 };
const BUSY = 'Wait for the current operation to finish.';

const codeOf = (state: AppState) => (state.doc.kind !== 'design' || state.doc.activeFile === MAIN ? state.doc.code : filesOf(state.doc)[MAIN] ?? '');
const shownOf = (state: AppState) => (state.section.enabled ? state.section.saved ?? null : null);

function menu(view: SectionView, shown: boolean, busy: boolean): Line[] {
  return [
    { label: shown ? 'Hide section' : 'Show section', icon: shown ? <EyeOff {...I} /> : <Eye {...I} />, run: () => toggleSectionView(view) },
    { label: 'Edit section…', icon: <Pencil {...I} />, reason: busy ? BUSY : null, run: () => editSectionView(view) },
    { label: 'Show in source', icon: <Code2 {...I} />, run: () => showSectionViewCode(view) },
    'sep',
    { label: 'Delete', icon: <Trash2 {...I} />, danger: true, reason: busy ? BUSY : null, run: () => removeSectionView(view.name) },
  ];
}

function SectionRow({ view, depth }: { view: SectionView; depth: number }) {
  const shown = useApp((state) => shownOf(state) === view.name);
  const busy = useApp((state) => !!state.busy);
  const version = useApp((state) => state.modelVersion);
  const range = useMemo(() => extent(view.axis), [view.axis, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const outside = !!range && (view.at < range[0] || view.at > range[1]);
  const where = `${view.axis.toUpperCase()} = ${num(view.at)} mm`;
  return (
    <TreeRow depth={depth} icon={<SectionIcon size={14} />} label={<span className={styles.mono}>{view.name}</span>} meta={where} item={`section-view:${view.name}`}
      selected={shown} dimmed={outside}
      title={`Section ${view.name}: cut at ${where}, ${view.flip ? 'keeping the side above' : 'keeping the side below'}${outside && range ? ` · outside the model now (${num(range[0])} to ${num(range[1])} mm)` : ''} · click to ${shown ? 'clear' : 'show'} it · double-click for its code`}
      menu={<MenuLines lines={menu(view, shown, busy)} />} onClick={() => toggleSectionView(view)} onDoubleClick={() => showSectionViewCode(view)}
      actions={(
        <button type="button" className={styles.eye} data-hidden={!shown || undefined} data-section-view={view.name} aria-pressed={shown}
          aria-label={`${shown ? 'Hide' : 'Show'} section ${view.name}`} onClick={(event) => { event.stopPropagation(); toggleSectionView(view); }}>
          {shown ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
      )} />
  );
}

/** Shown only once the document has a saved section view (Section analysis → Save, or `section_view(...)` in the code). */
export default function SectionsGroup({ depth = 1 }: { depth?: number }) {
  const code = useApp(codeOf);
  const kind = useApp((state) => state.doc.kind);
  const views = useMemo(() => (holdsSections() ? parseSectionViews(code) : []), [code, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!views.length) return null;
  return (
    <BrowserGroup title="Sections" icon={<SectionIcon size={15} />} count={views.length} depth={depth} defaultOpen item="group:sections"
      tooltip="Saved section views: click one to see that cut. Save more from Section analysis (X).">
      {views.map((view) => <SectionRow key={`${view.name}:${view.line}`} view={view} depth={depth + 1} />)}
    </BrowserGroup>
  );
}
