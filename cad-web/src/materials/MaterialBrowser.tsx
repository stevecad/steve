import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, Copy, ExternalLink, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { MaterialIcon } from '@/icons/cad';
import { Badge, Button, Dialog, Segmented, Spinner } from '@/ui';
import { get, set, toast } from '@/state/store';
import { updateModel } from '@/state/actions';
import { mass } from '@/lib/format';
import {
  MINE, PROPERTIES, PROPERTY_LABELS, assignmentOf, deleteOwnMaterial, finishOf, finishesFor, formatQuantity, loadLibrary, massOf, ownDraft,
  ownMaterialsFailed, searchMaterials, useMaterialLibrary, type Assignment, type Library, type Material, type OwnMaterialInput,
} from '@/lib/materials';
import { usePhysical } from './usePhysical';
import { assignMaterial, useMaterialDialog, type MaterialTarget } from './actions';
import OwnMaterialEditor from './OwnMaterialEditor';
import Swatch from './Swatch';
import styles from './Materials.module.css';
import { safeHref } from '@/lib/safeUrl';

const narrowQuery = '(max-width: 760px)';

function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(narrowQuery).matches);
  useEffect(() => {
    const query = matchMedia(narrowQuery);
    const change = () => setNarrow(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return narrow;
}

const keyStats = (material: Material) => {
  const p = material.properties;
  return [p.density && formatQuantity(p.density), p.youngs_modulus && `E ${formatQuantity(p.youngs_modulus)}`, p.yield_strength && `σy ${formatQuantity(p.yield_strength)}`]
    .filter(Boolean).join(' · ');
};

/** The open document builds again when it names an own material that changed: its values are part of the build. */
function rebuildIfUsed(id: string) {
  const { doc, displayed } = get();
  const sourceUses = [doc.code, ...Object.values(doc.files)].some((text) => text.includes(`"${id}"`) || text.includes(`'${id}'`));
  // A constant or expression can resolve to this ID without spelling it as a
  // literal in source. Include the successful build's resolved assignments.
  const buildUses = JSON.stringify(displayed?.metadata ?? {}).includes(JSON.stringify(id));
  if (displayed && (sourceUses || buildUses)) void updateModel({ quiet: true });
}

/**
 * The material library and the person's own materials (copies of library materials they changed, or new ones):
 * search, categories, rendered swatches, properties with sources; assigns to the part or bodies.
 */
export default function MaterialBrowser({ open }: { open: boolean }) {
  const physical = usePhysical();
  const library = physical.library;
  const failed = useMaterialLibrary((state) => state.failed);
  const target = useMaterialDialog((state) => state.target);
  const close = () => set({ dialog: null });
  return (
    <Dialog open={open} onOpenChange={(value) => !value && close()} title="Materials" width={1080} className={styles.dialog}
      description={library ? `${library.materials.filter((m) => !m.own).length} engineering materials from open datasets, and your own. Assigning writes model.material(…) into the design, so it versions with it.` : 'Loading the material library…'}
      icon={<div className={styles.dialogIcon}><MaterialIcon size={17} /></div>}>
      {library ? <Browser library={library} target={target} physical={physical} onDone={close} />
        : <div className={styles.loading}>{failed ? <><span>The material library couldn’t load.</span><Button size="sm" onClick={() => void loadLibrary().catch(() => undefined)}>Retry</Button></> : <Spinner size={18} />}</div>}
    </Dialog>
  );
}

function Browser({ library, target: initialTarget, physical, onDone }: { library: Library; target: MaterialTarget; physical: ReturnType<typeof usePhysical>; onDone: () => void }) {
  const narrow = useNarrow();
  const listId = useId();
  const bodies = physical.bodies.filter((body) => body.id);
  const [chosen, setChosen] = useState<string[]>(Array.isArray(initialTarget) ? initialTarget : []);
  const [targetKind, setTargetKind] = useState<'part' | 'bodies'>(chosen.length ? 'bodies' : 'part');
  const toggleBody = (id: string) => setChosen((list) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]));
  const current = targetKind === 'part' ? physical.assignments.part : assignmentOf(physical.assignments, chosen[0] ?? null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(current?.material ?? null);
  const [finish, setFinish] = useState<string | null>(current?.finish ?? null);
  const [color, setColor] = useState<string | null>(current?.color ?? null);
  const [view, setView] = useState<'list' | 'detail'>('list');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; initial: OwnMaterialInput } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const results = useMemo(() => searchMaterials(library, query, category), [library, query, category]);
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const material of searchMaterials(library, query, null)) out.set(material.category, (out.get(material.category) ?? 0) + 1);
    return out;
  }, [library, query]);
  const mine = useMemo(() => searchMaterials(library, query, MINE).length, [library, query]);
  const groups = useMemo(() => [...new Set(library.categories.map((c) => c.group))], [library]);
  const material = (focused && library.byId.get(focused)) || null;
  const finishes = material ? finishesFor(library, material) : [];
  const chosenFinish = material ? finishOf(library, material, finish) : null;
  const targetVolume = targetKind === 'part' ? physical.volume : bodies.filter((b) => chosen.includes(b.id)).reduce((sum, b) => sum + b.volume, 0);

  useEffect(() => { if (!narrow) input.current?.focus(); }, [narrow]);
  useEffect(() => {
    list.current?.querySelector(`[data-id="${CSS.escape(focused ?? '')}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focused]);

  const focus = (id: string) => {
    if (id !== focused) { setFocused(id); setFinish(null); setColor(null); setError(null); setEditing(null); setConfirmDelete(false); }
    if (narrow) setView('detail');
  };
  const edit = (id: string | null, initial: OwnMaterialInput) => {
    setEditing({ id, initial }); setConfirmDelete(false); setError(null);
    if (narrow) setView('detail');
  };
  const categoryName = (id: string | null) => (id === MINE ? 'My materials' : library.categories.find((c) => c.id === id)?.name);
  const remove = async (item: Material) => {
    setBusy(true); setError(null);
    try {
      await deleteOwnMaterial(item.id);
      setFocused(null); setConfirmDelete(false);
      toast('success', `${item.name} deleted from your materials`);
      rebuildIfUsed(item.id);
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const move = (delta: number) => {
    if (!results.length) return;
    const index = results.findIndex((m) => m.id === focused);
    const next = results[Math.min(results.length - 1, Math.max(0, index < 0 ? 0 : index + delta))];
    setFocused(next.id); setFinish(null); setColor(null); setEditing(null); setConfirmDelete(false);
  };
  const targetValue = (): MaterialTarget => (targetKind === 'part' ? 'part' : chosen);
  const apply = async (value: Assignment | null) => {
    setBusy(true); setError(null);
    const problem = await assignMaterial(targetValue(), value);
    setBusy(false);
    if (problem) { setError(problem); return; }
    const where = targetKind === 'part' ? 'the part' : chosen.length === 1 ? (bodies.find((b) => b.id === chosen[0])?.label ?? chosen[0]) : `${chosen.length} bodies`;
    toast('success', value ? `${library.byId.get(value.material)?.name} → ${where}` : `Material cleared from ${where}`);
    onDone();
  };
  const assign = () => {
    if (!material) return;
    const own = chosenFinish && chosenFinish.id !== material.appearance.finish ? chosenFinish.id : null;
    void apply({ material: material.id, finish: own, color });
  };

  return (
    <div className={styles.browser} data-view={view}>
      <nav className={styles.categories} aria-label="Categories">
        <button type="button" className={styles.category} aria-pressed={category === null} onClick={() => setCategory(null)}>
          <span>All materials</span><span className={styles.count}>{[...counts.values()].reduce((a, b) => a + b, 0)}</span>
        </button>
        <button type="button" className={styles.category} aria-pressed={category === MINE} onClick={() => setCategory(category === MINE ? null : MINE)} id="materials-mine">
          <span>My materials</span><span className={styles.count}>{mine}</span>
        </button>
        {groups.map((group) => (
          <div key={group} className={styles.group}>
            <div className={`caps ${styles.groupTitle}`}>{group}</div>
            {library.categories.filter((c) => c.group === group).map((c) => (
              <button key={c.id} type="button" className={styles.category} aria-pressed={category === c.id} disabled={!counts.get(c.id)} onClick={() => setCategory(category === c.id ? null : c.id)}>
                <span>{c.name}</span><span className={styles.count}>{counts.get(c.id) ?? 0}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <section className={styles.results}>
        <label className={styles.search}>
          <Search size={15} />
          <input ref={input} className={styles.searchInput} value={query} placeholder="Search name, grade or standard: 6061, 1.4301, PEEK…" aria-label="Search materials"
            role="combobox" aria-expanded aria-controls={listId} aria-activedescendant={focused ? `${listId}-${focused}` : undefined}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
              if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
              if (event.key === 'Enter' && material) { event.preventDefault(); assign(); }
            }} />
          {query && <button type="button" className={styles.clear} aria-label="Clear search" onClick={() => { setQuery(''); input.current?.focus(); }}><X size={13} /></button>}
        </label>
        <div className={styles.resultMeta}>
          <span>{results.length} {results.length === 1 ? 'material' : 'materials'}</span>
          {category && <button type="button" onClick={() => setCategory(null)}>{categoryName(category)} <X size={11} /></button>}
          <span className={styles.spacer} />
          <button type="button" id="material-new" title="A material of your own, with your values"
            onClick={() => edit(null, ownDraft(null, category && category !== MINE ? category : material?.category ?? library.categories[0].id))}>
            <Plus size={11} />New material
          </button>
        </div>
        <div ref={list} id={listId} className={styles.list} role="listbox" aria-label="Materials">
          {results.map((item) => {
            const isCurrent = current?.material === item.id;
            return (
              <div key={item.id} id={`${listId}-${item.id}`} data-id={item.id} role="option" aria-selected={item.id === focused} className={styles.row}
                onClick={() => focus(item.id)} onDoubleClick={() => { focus(item.id); void apply({ material: item.id }); }}>
                <Swatch surface={{ material: item, finish: finishOf(library, item, null), color: null }} size={34} />
                <span className={styles.rowText}>
                  <span className={styles.rowName}>{item.name}<OwnBadge material={item} />{isCurrent && <Badge tone="ws">Current</Badge>}</span>
                  <span className={styles.rowMeta}>{item.own?.based_on ? `Copy of ${library.byId.get(item.own.based_on)?.name ?? item.own.based_on}`
                    : item.designations.slice(0, 3).join(' · ') || categoryName(item.category)}</span>
                </span>
                <span className={styles.rowStats}>{keyStats(item)}</span>
              </div>
            );
          })}
          {!results.length && <div className={styles.empty}>{category === MINE && !query
            ? (ownMaterialsFailed() ? 'Your materials couldn’t load. Close this and open it again to retry.'
              : 'No materials of your own yet. Copy one from the library to change its values, or make a new one.')
            : `No materials match “${query}”.`}</div>}
        </div>
      </section>

      <section className={styles.detail} aria-live="polite">
        {narrow && <button type="button" className={styles.back} onClick={() => setView('list')}><ArrowLeft size={14} />All materials</button>}
        <AnimatePresence mode="wait" initial={false}>
          {editing ? (
            <motion.div key={`edit-${editing.id ?? 'new'}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}>
              <OwnMaterialEditor library={library} id={editing.id} initial={editing.initial} onCancel={() => setEditing(null)}
                onSaved={(saved) => {
                  setEditing(null); setQuery(''); setCategory(MINE); setFocused(saved.id); setFinish(null); setColor(null);
                  toast('success', editing.id ? `${saved.name} saved` : `${saved.name} added to your materials`);
                  if (editing.id) rebuildIfUsed(saved.id);
                }} />
            </motion.div>
          ) : material ? (
            <motion.div key={material.id} className={styles.detailInner} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}>
              <div className={styles.hero}>
                <Swatch surface={{ material, finish: chosenFinish, color }} size={132} urgent className={styles.heroSwatch} />
                <div className={styles.heroText}>
                  <h3 className={styles.name} id="material-name">{material.name}</h3>
                  <div className={styles.category2}>{categoryName(material.category)}</div>
                  {material.own && <div className={styles.ownLine}><OwnBadge material={material} />
                    <span>{material.own.based_on ? `Your copy of ${library.byId.get(material.own.based_on)?.name ?? material.own.based_on}` : 'Your own material'}</span></div>}
                  <code className={styles.idCode}>{material.id}</code>
                  {targetVolume ? <div className={styles.massLine}>Mass here <b>{mass(massOf(targetVolume, material) ?? NaN)}</b></div> : null}
                </div>
              </div>
              <div className={styles.ownActions}>
                {material.own ? (
                  confirmDelete ? (
                    <>
                      <span className={styles.muted}>Designs that use it will show it as unknown.</span>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep</Button>
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove(material)} id="own-material-delete-confirm">Delete</Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" icon={<Pencil size={13} />} onClick={() => edit(material.id, ownDraft(material, material.category))} id="own-material-edit">Edit</Button>
                      <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setConfirmDelete(true)} id="own-material-delete">Delete</Button>
                    </>
                  )
                ) : (
                  <Button size="sm" icon={<Copy size={13} />} onClick={() => edit(null, ownDraft(material, material.category))} id="material-copy"
                    title="A copy in your materials with values you can change; this one stays as it is">Copy to my materials</Button>
                )}
              </div>
              {material.designations.length > 0 && <div className={styles.chips}>{material.designations.map((d) => <span key={d} className={styles.chip}>{d}</span>)}</div>}
              {material.description && <p className={styles.description}>{material.description}</p>}
              <div className={styles.fieldLabel}>Finish</div>
              <div className={styles.finishes} role="radiogroup" aria-label="Finish">
                {finishes.map((f) => (
                  <button key={f.id} type="button" role="radio" aria-checked={chosenFinish?.id === f.id} className={styles.finish} onClick={() => setFinish(f.id)}>{f.name}</button>
                ))}
              </div>
              <div className={styles.colorRow}>
                <span className={styles.fieldLabel}>{chosenFinish?.use_color ? 'Paint color' : 'Tint'}</span>
                <input type="color" aria-label="Color" value={color ?? material.appearance.base_color.srgb} onChange={(event) => setColor(event.target.value)} />
                {color ? <button type="button" className={styles.link} onClick={() => setColor(null)}>Use the material’s color</button> : <span className={styles.muted}>Material color</span>}
              </div>
              <dl className={styles.props}>
                {PROPERTIES.filter((key) => material.properties[key]).map((key) => {
                  const q = material.properties[key]!;
                  return (
                    <div key={key} title={`${library.sources[q.source]?.name ?? q.source}${q.note ? ` — ${q.note}` : ''}`}>
                      <dt>{PROPERTY_LABELS[key]}</dt><dd>{formatQuantity(q)}{!material.own && <sup>{Object.keys(material.sources).indexOf(q.source) + 1}</sup>}</dd>
                    </div>
                  );
                })}
              </dl>
              <div className={styles.sources}>
                {material.own && <div className={styles.muted}>Your own values: check them against the supplier’s data sheet.</div>}
                {!material.own && Object.entries(material.sources).map(([key, source], index) => (
                  <a key={key} href={safeHref(source.url)} target="_blank" rel="noopener noreferrer" className={styles.source}>
                    <sup>{index + 1}</sup><span>{library.sources[key]?.name ?? key}{source.author ? ` · ${source.author}` : ''}</span><span className={styles.license}>{source.license}</span><ExternalLink size={11} />
                  </a>
                ))}
                <div className={styles.muted}>Appearance: {material.appearance.source === 'steve' ? 'STEVE preset' : library.sources[material.appearance.source]?.name ?? material.appearance.source} ({material.appearance.preset})</div>
              </div>
            </motion.div>
          ) : (
            <motion.div key="none" className={styles.placeholder} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <MaterialIcon size={28} />
              <p>Pick a material to see its properties, finishes and sources.</p>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      <footer className={styles.footer}>
        <div className={styles.targets} id="material-target">
          <span className={styles.fieldLabel}>Assign to</span>
          <Segmented size="sm" value={targetKind} onChange={(kind) => { setTargetKind(kind); if (kind === 'bodies' && !chosen.length && bodies[0]) setChosen([bodies[0].id]); }} options={[
            { value: 'part', label: 'Whole part' },
            { value: 'bodies', label: 'Bodies', disabled: bodies.length < 1, title: bodies.length ? 'Choose which bodies' : 'There are no bodies yet' },
          ]} />
          {targetKind === 'bodies' && (
            <div className={styles.bodyChips} role="group" aria-label="Bodies to assign">
              {bodies.map((body) => (
                <button key={body.id} type="button" className={styles.bodyChip} aria-pressed={chosen.includes(body.id)} data-body={body.id} onClick={() => toggleBody(body.id)}
                  title={`${body.label}${body.material ? ` · now ${body.material.name}` : ''}`}>
                  {body.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {error && <span className={styles.error} role="alert">{error}</span>}
        <span className={styles.spacer} />
        {current && <Button variant="ghost" disabled={busy} onClick={() => void apply(null)} id="material-clear">{targetKind === 'part' ? 'Remove material' : 'Use part material'}</Button>}
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button variant="primary" disabled={!material || busy || !!editing || (targetKind === 'bodies' && !chosen.length)} onClick={assign} id="material-assign">{busy ? <Spinner /> : null}Assign</Button>
      </footer>
    </div>
  );
}

/** Marks the person's own materials: "Modified" for a changed copy of a library material, "Mine" for a new one. */
function OwnBadge({ material }: { material: Material }) {
  if (!material.own) return null;
  return material.own.based_on ? <Badge tone="warning">Modified</Badge> : <Badge>Mine</Badge>;
}
