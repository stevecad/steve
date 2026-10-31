import { useMemo } from 'react';
import * as THREE from 'three';
import { Box, Boxes, Component, ExternalLink, Factory, Layers3, Link2, MousePointer2, SquareDashed } from 'lucide-react';
import { shopMetadata } from '@/lib/api';
import { kindLabel as libraryKindLabel } from '@/workspaces/manufacture/kinds';
import { Button, Section } from '@/ui';
import { get, set, toast, useApp, type Pick } from '@/state/store';
import { linkDocument, openPart, updateLink } from '@/state/actions';
import { catalogue } from '@/workspaces/manufacture/api';
import { openMaterials } from '@/materials/actions';
import { PartMass, PartMaterial, PickMaterial } from '@/materials/Inspector';
import { areaText, lengthNum, volumeText } from '@/lib/format';
import { useSetting } from '@/settings/store';
import { withWorkspace } from '@/teams/current';
import { viewer } from '@/viewport/viewer';
import { describe } from '@/viewport/measure';
import { analyze } from '@/viewport/semantics';
import StudyInspector from '@/workspaces/simulate/StudyInspector';
import SetupInspector from '@/workspaces/manufacture/SetupInspector';
import FeatureInspector from '@/workspaces/design/FeatureInspector';
import ParametersInspector from '@/workspaces/design/ParametersInspector';
import ParametersTable from '@/modeling/ParametersTable';
import ModelingFeatureInspector from '@/modeling/FeatureInspector';
import { PARAMETERS_ID } from '@/workspaces/design/featureEdit';
import type { DesignResult } from '@/lib/modeling';
import { JointInspector, MotionSection } from '@/motion/MotionPanel';
import { useMotion } from '@/motion/state';
import { SheetSection } from '@/workspaces/sheetmetal/SheetPanels';
import CircuitInspector from '@/workspaces/electronics/CircuitInspector';
import DrawingInspector, { useDrawingSelection } from '@/drawing/Inspector';
import styles from './Panels.module.css';

const AXIS = [['X', 'var(--axis-x)'], ['Y', 'var(--axis-y)'], ['Z', 'var(--axis-z)']] as const;

export function Axes({ values, id }: { values: number[]; id?: string }) {
  const units = useSetting('display.units');
  return (
    <div className={styles.axes}>
      {AXIS.map(([name, color], i) => (
        <div key={name} className={styles.axis} style={{ ['--c' as string]: color }}>
          <span className={styles.axisName}>{name}</span>
          <span className={styles.axisValue} id={id ? `${id}-${name.toLowerCase()}` : undefined}>{lengthNum(values[i], units)}<span className={styles.axisUnit}>{units}</span></span>
        </div>
      ))}
    </div>
  );
}

export function Rows({ rows }: { rows: { label: string; value: React.ReactNode; emphasis?: boolean }[] }) {
  return <dl className={styles.rows}>{rows.map((row) => <div key={row.label} data-emphasis={row.emphasis || undefined}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>;
}

/** Opens the material browser for the whole part (materials live in the code). */
export function MaterialPicker() {
  return <Button size="sm" onClick={() => openMaterials('part')}>Materials…</Button>;
}

function DocumentInspector() {
  const displayed = useApp((state) => state.displayed);
  const doc = useApp((state) => state.doc);
  const pastVersion = useApp((state) => state.pastVersion);
  const metadata = displayed?.metadata;
  const units = useSetting('display.units');
  const Icon = doc.kind === 'design' ? Layers3 : Box;
  // A Blender scene (blender/blender_run.py) is measured from its meshes: objects, no faces or material mass.
  const blender = doc.kind === 'blender';
  return (
    <>
      <div className={styles.hero}>
        <div className={styles.heroIcon}><Icon size={20} /></div>
        <div className={styles.heroText}>
          <div className={styles.heroTitle} id="selection-name">{(pastVersion ? displayed?.name : doc.name) || 'Untitled'}</div>
          <div className={styles.heroSub}><span id="selection-type">{blender ? 'Blender scene' : doc.kind === 'design' ? 'Design' : 'Part'}</span>{doc.saved && <span id="inspector-revision">· revision {pastVersion?.revision ?? doc.saved.revision}{pastVersion ? ' · preview' : ''}</span>}{metadata && <span>· {blender ? `${metadata.objects ?? 0} objects` : doc.kind === 'design' && metadata.components ? `${metadata.components} instances` : `${metadata.faces} faces`}</span>}</div>
        </div>
      </div>
      {metadata ? (
        <>
          <Section title="Dimensions" id="dimensions">
            <div id="bounds-label" className="sr-only">Overall dimensions</div>
            <Axes values={metadata.bounds_mm} id="bound" />
          </Section>
          <Section title="Physical properties">
            <div className={styles.stack}>
              <div className={styles.statGrid}>
                <div className={styles.stat}><span className={styles.statLabel}>Volume</span><span className={styles.statValue} id="selection-volume">{metadata.volume_mm3 == null ? '—' : volumeText(metadata.volume_mm3, units)}</span></div>
                {!blender && <div className={styles.stat}><span className={styles.statLabel}>Mass</span><PartMass /></div>}
              </div>
              <Rows rows={[
                ...(metadata.surface_area_mm2 !== undefined ? [{ label: 'Surface area', value: areaText(metadata.surface_area_mm2, units) }] : []),
                ...(metadata.center_of_mass_mm ? [{ label: 'Center of mass', value: metadata.center_of_mass_mm.map((value) => lengthNum(value, units)).join(', ') }] : []),
                // Surface bodies aren't in the volume, mass or centre of mass: their count and area, apart.
                ...(metadata.surface_bodies ? [{ label: 'Surface bodies', value: `${metadata.surface_bodies.count} · ${areaText(metadata.surface_bodies.area_mm2, units)}, not in volume or mass` }] : []),
                // Instances that aren't hardware (a fluid volume for a flow study): shown, but not in volume, mass or the parts list.
                ...(metadata.not_hardware ? [{ label: 'Not hardware', value: `${metadata.not_hardware.instances.join(', ')}, not in volume, mass or the bill of materials` }] : []),
                blender ? { label: 'Objects', value: metadata.objects ?? 0 }
                  : { label: doc.kind === 'design' ? 'Components' : 'Solids', value: doc.kind === 'design' ? metadata.components : metadata.solids },
                // What the mesh measurements leave out (open meshes have no volume; overlaps count twice).
                ...(blender ? (metadata.warnings ?? []).map((warning, index) => ({ label: index ? `Note ${index + 1}` : 'Note', value: warning })) : []),
              ]} />
              {!blender && <PartMaterial />}
            </div>
          </Section>
          {blender && <SceneAnimation />}
          {doc.kind === 'design' && <MotionSection />}
          {doc.kind === 'design' && <BillOfMaterials metadata={metadata} />}
        </>
      ) : (
        <div className={styles.empty} style={{ height: 'auto', paddingTop: 40 }}>
          <SquareDashed size={28} />
          <h3>No geometry yet</h3>
          <p>Dimensions and physical properties appear once the model has a body.</p>
        </div>
      )}
      <Section title="Selection" defaultOpen={false}>
        <p className={styles.muted} style={{ fontSize: 11.5 }}>Click faces, edges or vertices in the viewport for their properties; double-click selects the whole component. The selection filter in the status bar limits clicks to one kind.</p>
      </Section>
    </>
  );
}

/** A Blender scene's own animation, rendered through its camera by its full build: played in place. */
function SceneAnimation() {
  const url = useApp((state) => state.displayed?.artifacts?.animation);
  const video = useApp((state) => state.displayed?.metadata?.animation);
  if (!url || !video) return null;
  return (
    <Section title="Animation" id="scene-animation">
      <div className={styles.stack}>
        <video className={styles.video} src={withWorkspace(url)} controls loop muted playsInline preload="metadata"
          aria-label="The scene's animation" style={{ aspectRatio: `${video.size[0]} / ${video.size[1]}` }} />
        <Rows rows={[{ label: 'Length', value: `${video.seconds} s · ${video.frames} frames at ${video.fps} fps` },
          { label: 'Size', value: `${video.size[0]} × ${video.size[1]}` }]} />
      </div>
    </Section>
  );
}

/** A shop: its revision and the library records its build makes, counted by kind. */
/** The shops this shop links (each pinned to a revision; Update moves it to the latest), and linking another one. */
function ShopLinks() {
  const doc = useApp((state) => state.doc);
  const busy = useApp((state) => state.busy);
  const links = Object.entries(doc.links ?? {});
  const linkCatalogue = async () => {
    try {
      const listing = await catalogue();
      if (!listing.document_id || !listing.revision) { toast('info', 'Steve’s catalogue', 'It isn’t published on this server yet.'); return; }
      await linkDocument(listing.document_id, listing.name, listing.revision, [0, 0, 0]);
    } catch (error) { toast('danger', 'Couldn’t link Steve’s catalogue', (error as Error).message); }
  };
  const status = doc.saved?.link_status ?? {};
  const catalogueLinked = links.some(([alias]) => status[alias]?.name === 'Steve catalogue') || 'catalogue' in (doc.links ?? {});
  return (
    <Section title="Linked shops" id="shop-links" actions={(
      <Button size="sm" variant="ghost" icon={<Link2 />} disabled={busy} onClick={() => set({ dialog: 'insert' })} id="shop-link-open">Link</Button>
    )}>
      {links.length ? <Rows rows={links.map(([alias, pin]) => {
        const latest = status[alias]?.latest ?? null;
        return {
          label: alias,
          value: <>{status[alias]?.name ?? 'Shop'} · r{pin.revision ?? '?'}{latest && pin.revision && latest > pin.revision
            ? <> <Button size="sm" variant="ghost" disabled={busy} onClick={() => void updateLink(alias)}>Update to r{latest}</Button></> : null}</>,
        };
      })} /> : <p className={styles.muted} style={{ padding: '0 12px' }}>Link another shop to use its machines and tools here.</p>}
      {!catalogueLinked && <div style={{ padding: '6px 12px 0' }}><Button size="sm" disabled={busy} onClick={() => void linkCatalogue()} id="shop-link-catalogue">Link Steve’s catalogue</Button></div>}
    </Section>
  );
}

function ShopInspector() {
  const displayed = useApp((state) => state.displayed);
  const doc = useApp((state) => state.doc);
  const shop = shopMetadata(displayed);
  const counts = Object.entries(shop?.counts ?? {}).filter(([, n]) => n > 0);
  return (
    <>
      <div className={styles.hero}>
        <div className={styles.heroIcon}><Factory size={20} /></div>
        <div className={styles.heroText}>
          <div className={styles.heroTitle} id="selection-name">{doc.name || 'Untitled'}</div>
          <div className={styles.heroSub}><span id="selection-type">Shop</span>{doc.saved && <span>· revision {doc.saved.revision}</span>}{shop && <span>· {shop.records.length} {shop.records.length === 1 ? 'item' : 'items'}</span>}</div>
        </div>
      </div>
      <ShopLinks />
      {counts.length ? (
        <Section title="Library items" id="shop-items">
          <Rows rows={counts.map(([kind, n]) => ({ label: n === 1 ? libraryKindLabel(kind).one : libraryKindLabel(kind).many, value: n }))} />
        </Section>
      ) : (
        <div className={styles.empty} style={{ height: 'auto', paddingTop: 40 }}>
          <Factory size={28} />
          <h3>{shop ? 'No items yet' : 'Not built yet'}</h3>
          <p>Add machines, controllers and tools in the code (shop.add). Building the saved shop updates the manufacturing library.</p>
        </div>
      )}
    </>
  );
}

function PickInspector({ picks }: { picks: Pick[] }) {
  const tree = useApp((state) => state.tree);
  const version = useApp((state) => state.modelVersion);
  const units = useSetting('display.units');
  const model = viewer.model;
  const info = useMemo(() => (model && picks.length === 1 ? describe(model, picks[0]) : null), [model, picks, version, units]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!model) return null;
  if (picks.length > 1) {
    const box = new THREE.Box3();
    for (const pick of picks) box.union(model.bounds(false, pick.node));
    const size = box.getSize(new THREE.Vector3());
    return (
      <>
        <div className={styles.hero}>
          <div className={styles.heroIcon} data-tone="sel"><MousePointer2 size={19} /></div>
          <div className={styles.heroText}><div className={styles.heroTitle}>{picks.length} items selected</div><div className={styles.heroSub}>{[...new Set(picks.map((pick) => pick.kind))].join(', ')}</div></div>
        </div>
        <Section title="Combined bounds"><Axes values={[size.x, size.y, size.z]} /></Section>
        <div style={{ padding: 14 }}><Button size="sm" onClick={() => set({ selection: [] })} id="clear-selection">Clear selection</Button></div>
      </>
    );
  }
  const pick = picks[0];
  const node = tree[pick.node];
  const isComponent = pick.kind === 'component';
  const box = model.bounds(false, pick.node);
  const size = box.getSize(new THREE.Vector3());
  const object = model.objects.get(pick.node);
  const origin = object ? new THREE.Vector3().setFromMatrixPosition(object.matrixWorld) : null;
  return (
    <>
      <div className={styles.hero}>
        <div className={styles.heroIcon} data-tone="sel">{isComponent ? (node?.type === 'assembly' ? <Boxes size={19} /> : <Component size={19} />) : <SquareDashed size={19} />}</div>
        <div className={styles.heroText}>
          <div className={styles.heroTitle} id="selection-name">{isComponent ? node?.name : info?.title}</div>
          <div className={styles.heroSub}><span id="selection-type">{isComponent ? (node?.type === 'assembly' ? 'Assembly' : node?.type === 'body' ? 'Body' : 'Part') : `${pick.kind} of ${node?.name ?? 'body'}`}</span></div>
        </div>
      </div>
      {!isComponent && info && <Section title="Geometry"><Rows rows={info.rows} /></Section>}
      <PickMaterial pick={pick} />
      <Section title="Shared with STEVE" defaultOpen={false}>
        <p className={styles.muted} style={{ fontSize: 11.5, lineHeight: 1.55, userSelect: 'text' }}>{analyze(model, pick).description}</p>
      </Section>
      <Section title={isComponent ? 'Preview bounds' : 'Owner bounds'}>
        <span id="bounds-label" className="sr-only">Preview bounds</span>
        <Axes values={[size.x, size.y, size.z]} id="bound" />
      </Section>
      {isComponent && origin && pick.node !== get().rootId && (
        <Section title="Placement"><Axes values={[origin.x, origin.y, origin.z]} /></Section>
      )}
      <div style={{ padding: 14, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {node?.documentId && <Button size="sm" id="open-selected-part" icon={<ExternalLink />} onClick={() => openPart(node.documentId!)}>Open linked document</Button>}
        <Button size="sm" variant="ghost" id="clear-selection" onClick={() => set({ selection: [] })}>Clear</Button>
      </div>
    </>
  );
}

export default function Properties() {
  const open = useApp((state) => state.doc.open);
  const selection = useApp((state) => state.selection);
  const workspace = useApp((state) => state.workspace);
  const activeFeature = useApp((state) => state.activeFeature);
  const modeling = useApp((state) => state.modeling);
  const joint = useMotion((state) => state.active);
  const kind = useApp((state) => state.doc.kind);
  const drawing = useDrawingSelection();
  if (!open && workspace === 'electronics') return <div className={styles.empty}><Box size={28} /><h3>No circuit open</h3><p>Open a circuit, or start a new one, to inspect its parts.</p></div>;
  if (!open) return <div className={styles.empty}><Box size={28} /><h3>No design open</h3><p>Open or create a design to inspect it.</p></div>;
  // A circuit's parts, pins and nets (docs/ELECTRONICS.md); the CAD inspectors below don't apply.
  if (kind === 'circuit') return <div className={styles.scroll}><CircuitInspector /></div>;
  // A shop has no geometry: what its build makes are library records.
  if (kind === 'shop') return <div className={styles.scroll}><ShopInspector /></div>;
  if (workspace === 'electronics') return <div className={styles.empty}><Box size={28} /><h3>No circuit open</h3><p>Open a circuit, or start a new one, to inspect its parts.</p></div>;
  // On the Drawing tab, what's selected on the sheet.
  if (drawing) return <div className={styles.scroll}><DrawingInspector /></div>;
  return (
    <div className={styles.scroll}>
      {workspace === 'simulate' && <StudyInspector />}
      {workspace === 'manufacture' && <SetupInspector />}
      {workspace === 'design' && activeFeature === PARAMETERS_ID && !selection.length && (modeling ? <ParametersTable /> : <ParametersInspector />)}
      {workspace === 'design' && activeFeature && activeFeature !== PARAMETERS_ID && !selection.length && (modeling?.canonical ? <ModelingFeatureInspector /> : <FeatureInspector />)}
      {selection.length ? <PickInspector picks={selection} /> : workspace === 'design' && !activeFeature ? (kind === 'design' && joint ? <JointInspector name={joint} /> : <DocumentInspector />) : null}
      {/* One place for every selection, so picking a bend from its table doesn't rebuild the table under the pointer. */}
      {workspace === 'design' && activeFeature !== PARAMETERS_ID && <SheetSection />}
    </div>
  );
}

/** A design's bill of materials: components and linked documents (per override set), and the screws, washers, nuts and
 *  inserts of declared fasteners (`design.fasten`), with quantities. */
function BillOfMaterials({ metadata }: { metadata: unknown }) {
  const design = (metadata as { modeling?: { design?: DesignResult & { bom?: BomRow[] } } } | null)?.modeling?.design;
  const rows = design?.bom ?? [];
  if (!rows.length) return null;
  return (
    <Section title="Bill of materials" id="bom">
      <table className={styles.bom}>
        <thead><tr><th>Item</th><th>Qty</th><th>Source</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.item}:${JSON.stringify(row.parameters ?? {})}:${JSON.stringify(row.print ?? null)}`} data-bom={row.item}>
              <td><b>{row.name}</b>{row.parameters && Object.keys(row.parameters).length > 0 && <small>{Object.entries(row.parameters).map(([k, v]) => `${k}=${v}`).join(', ')}</small>}</td>
              <td className={styles.bomQty}>{row.quantity}</td>
              <td className={styles.muted}>{row.link ? `${row.kind} · rev ${row.revision}` : row.hardware ? [row.kind, row.standard].filter(Boolean).join(' · ') : 'component'}
                {row.print && ` · printed (${[row.print.process.toUpperCase(), row.print.material].filter(Boolean).join(', ')})`}
                {row.surface && ` · ${row.note ?? 'surface (not a part)'}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

interface BomRow { item: string; name: string; kind: string; link: boolean; document_id?: string; revision?: number; parameters?: Record<string, number>; quantity: number; print?: { process: string; material?: string }; hardware?: boolean; standard?: string;
  /** Only surface bodies (model.fill, boundary_surface): listed, but no part to make. */
  surface?: boolean; note?: string }
