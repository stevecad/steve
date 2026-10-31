import { Activity, Eye, EyeOff, Layers, MousePointer2, Pencil, Trash2 } from 'lucide-react';
import { ContactIcon, FixedIcon, ForceIcon, GravityIcon, MaterialIcon, MeshIcon, MomentIcon, PinIcon, PressureIcon, StressIcon, StudyIcon, ThermalIcon } from '@/icons/cad';
import { MenuLines, commandEntry, type Line } from '@/workspaces/design/ItemMenu';
import TreeRow from '@/shell/TreeRow';
import { BrowserGroup } from '@/shell/Browser';
import { get, set, useApp, type Study, type StudyLoad } from '@/state/store';
import { persistWorkspaceData } from '@/state/workspaceData';
import { useOnChange, useTreeMemory } from '@/state/treeOpen';
import { chosen, inspect } from '@/state/layout';
import { moveToTrash } from '@/state/trash';
import { useStudyMaterial } from '@/materials/usePhysical';
import { LOAD_TYPES, NEW_STUDY_TYPES, STUDY_TYPES } from './commands';
import { runStudy, showAllStudies, statusOf, useSimulation } from './state';
import { allowedBoundaries } from './physics';
import { terminal } from './api';
import { show } from './units';
import { GAS_BOUNDARIES } from './CompressibleSetup';
import { hiddenKey, toggleStudy } from '@/state/visibility';
import styles from '@/shell/Browser.module.css';

/** A compressible inlet's or outlet's absolute pressure as flow pressures read (kPa above 10 kPa): "1000 kPa", not "1000000 Pa". */
const gasPressure = (load: StudyLoad) => load.magnitude !== undefined && GAS_BOUNDARIES.has(load.type) && LOAD_TYPES[load.type].unit === 'Pa'
  ? (({ value, unit }) => `${value} ${unit}`)(show(load.magnitude, 'Pa', true)) : undefined;

const LOAD_ICONS: Record<StudyLoad['type'], typeof FixedIcon> = { fixed: FixedIcon, pin: PinIcon, force: ForceIcon, pressure: PressureIcon, moment: MomentIcon, gravity: GravityIcon, temperature: ThermalIcon, heat_flux: ThermalIcon, convection: ThermalIcon, velocity_inlet: ForceIcon, pressure_inlet: PressureIcon, pressure_outlet: PressureIcon, no_slip: FixedIcon, slip: PinIcon,
  stagnation_inlet: PressureIcon, mass_flow_inlet: ForceIcon, ambient_outlet: PressureIcon, symmetry: FixedIcon, named: FixedIcon };

function removeLoad(studyId: string, loadId: string) {
  set((state) => ({ studies: state.studies.map((study) => (study.id === studyId ? { ...study, loads: study.loads.filter((load) => load.id !== loadId) } : study)) }));
  persistWorkspaceData();
}

/** A saved study goes to the Trash (Undo in the toast, or Open → Trash); an unsaved draft is just dropped. */
async function removeStudy(study: Study) {
  if (study.revision && !(await moveToTrash([{ id: study.id, name: study.name }]))) return;
  const studyId = study.id;
  set((state) => {
    const studies = state.studies.filter((study) => study.id !== studyId);
    return { studies, activeStudy: state.activeStudy === studyId ? studies[0]?.id ?? null : state.activeStudy };
  });
  persistWorkspaceData();
}

/** What a study's two boundary groups are called, in its physics' words. */
const GROUPS: Record<string, [string, string]> = {
  static: ['Supports', 'Loads'], thermal_stress: ['Supports and temperatures', 'Loads and heat flows'], modal: ['Supports', 'Loads'],
  thermal: ['Temperatures', 'Heat flows'], flow: ['Walls', 'Inlets and outlets'], cht: ['Walls and temperatures', 'Inlets, outlets and heat flows'],
  buckling: ['Supports', 'Loads'], compressible: ['Walls and symmetry', 'Inlets and outlets'],
  openfoam_case: ['Named faces', 'Loads'], calculix_deck: ['Named faces', 'Loads'],
};

/* ───────── Right-click menus (the model browser's, drawn by MenuLines) ───────── */

const I = { size: 15 };
const activate = (study: Study) => set({ activeStudy: study.id, dockOpen: true, dockTab: 'properties', ...chosen() });
/** A click on a study's row: its setup in the inspector, or on a phone the model with the browser out of the way. */
const choose = (study: Study) => set({ activeStudy: study.id, ...inspect(), ...chosen() });
const running = (study: Study) => { const run = useSimulation.getState().runs[study.id]; return run && !terminal(run) ? 'This study is running.' : null; };

function studyMenu(study: Study, hidden: boolean, toggleHidden: () => void): Line[] {
  const solved = !!statusOf(study).solved;
  const mine = () => set({ activeStudy: study.id });
  // Choosing from the menu leaves the all-studies view (StudyTree), except hiding, which is about that view.
  const overview = get().studyOverview;
  return [
    { label: 'Edit study', icon: <Pencil {...I} />, run: () => activate(study) },
    { label: hidden ? 'Show in all studies' : 'Hide from all studies', icon: hidden ? <Eye {...I} /> : <EyeOff {...I} />, shortcut: 'Space', run: () => { toggleHidden(); set({ studyOverview: overview }); } },
    'sep',
    { ...commandEntry('sim.mesh', 'Mesh', mine), reason: running(study) ?? commandEntry('sim.mesh').reason },
    { ...commandEntry('sim.solve', 'Solve', mine), reason: running(study) ?? commandEntry('sim.solve').reason },
    solved && { label: 'Show results', icon: <StressIcon {...I} />, run: () => activate(study) },
    'sep',
    { label: 'Delete study', icon: <Trash2 {...I} />, danger: true, reason: running(study), run: () => { void removeStudy(study); } },
  ];
}

/** "Add …" for the boundary group: the ribbon's commands for this physics, with their reasons when unavailable. */
function boundaryMenu(study: Study, group: 'Constraint' | 'Load'): Line[] {
  const allowed = allowedBoundaries(study);
  return (Object.keys(LOAD_TYPES) as StudyLoad['type'][])
    .filter((type) => LOAD_TYPES[type].group === group && allowed.includes(type))
    .map((type) => commandEntry(`sim.load.${type}`, `Add ${LOAD_TYPES[type].label.toLowerCase()}…`, () => set({ activeStudy: study.id })));
}

function loadMenu(study: Study, load: StudyLoad): Line[] {
  return [
    { label: 'Select faces', icon: <MousePointer2 {...I} />, reason: load.picks.length ? null : 'No faces picked yet.', run: () => set({ selection: load.picks, activeStudy: study.id }) },
    { label: 'Edit', icon: <Pencil {...I} />, run: () => activate(study) },
    'sep',
    { label: 'Remove', icon: <Trash2 {...I} />, danger: true, run: () => removeLoad(study.id, load.id) },
  ];
}

const Status = ({ tone, children }: { tone: 'ok' | 'warn' | 'soon'; children: string }) => (
  <span className={styles.status}><span className={styles.statusDot} data-tone={tone} />{children}</span>
);

export default function StudyTree() {
  const studies = useApp((state) => state.studies);
  const active = useApp((state) => state.activeStudy);
  const material = useStudyMaterial();
  // The status comes from each study's durable outcome (statusOf); these re-draw the tree when it or the design changes.
  useSimulation((state) => state.runs);
  useSimulation((state) => state.outcomes);
  useApp((state) => state.doc.saved?.revision);
  useApp((state) => state.doc.branch);
  const saved = useApp((state) => !!state.doc.saved);
  // Studies start expanded and stay as left (remembered per document); one that becomes active (ribbon, STEVE, a
  // click) opens so its setup is in view. Not when the tree is only drawn again, or a design's studies load (the first
  // is made active then, from none or from another document's study), so a closed study stays closed.
  const memory = useTreeMemory();
  const expanded = (id: string) => memory.isOpen(`study:${id}`, true);
  useOnChange(active, (now, before) => {
    if (now && before && studies.some((study) => study.id === before) && !expanded(now)) memory.setOpen(`study:${now}`, true);
  });
  const toggle = (id: string) => memory.setOpen(`study:${id}`, !expanded(id));
  // The eye hides a study from the all-studies view, as a component's hides it from the model.
  const isHidden = (id: string) => memory.isOpen(hiddenKey(id), false);
  const hiddenStudies = studies.filter((study) => isHidden(study.id));
  const overview = useApp((state) => state.studyOverview);
  const allReason = studies.length ? null : 'Create a study first.';
  return (
    <BrowserGroup title="Studies" icon={<Activity size={15} />} count={studies.length} item="group:studies" selected={overview}
      onClick={allReason ? undefined : showAllStudies} tooltip={allReason ? undefined : 'Show all studies on the model (hide one with its eye)'}
      menu={<MenuLines lines={[{ label: 'Show all studies', icon: <Layers {...I} />, reason: allReason, run: showAllStudies },
        { label: 'Unhide all studies', icon: <Eye {...I} />, reason: hiddenStudies.length ? null : 'No study is hidden.', run: () => hiddenStudies.forEach((study) => memory.setOpen(hiddenKey(study.id), false)) }, 'sep',
        ...NEW_STUDY_TYPES.map((type) => commandEntry(`sim.study.${type}`, `New ${STUDY_TYPES[type].label.toLowerCase()} study`))]} />}>
      {!studies.length && <p className={styles.emptyHint}>{saved ? 'Create a study from New study in the ribbon.' : 'Save the design to create simulation studies.'}</p>}
      {studies.map((study) => {
        const constraints = study.loads.filter((load) => LOAD_TYPES[load.type].group === 'Constraint');
        const loads = study.loads.filter((load) => LOAD_TYPES[load.type].group === 'Load');
        const status = statusOf(study);
        const hidden = isHidden(study.id);
        const row = (load: StudyLoad) => {
          const Icon = LOAD_ICONS[load.type];
          return (
            <TreeRow
              key={load.id}
              depth={3}
              icon={<Icon size={14} />}
              label={load.type === 'named' ? load.id : LOAD_TYPES[load.type].label}
              meta={load.type !== 'gravity' && !load.refs?.length ? 'no faces' : load.magnitude !== undefined ? (load.type === 'temperature' ? `${Number((load.magnitude - 273.15).toFixed(1))} °C` : gasPressure(load) ?? `${load.magnitude} ${LOAD_TYPES[load.type].unit ?? ''}`) : `${load.refs?.length ?? load.picks.length} face${(load.refs?.length ?? load.picks.length) === 1 ? '' : 's'}`}
              onClick={() => set({ selection: load.picks, activeStudy: study.id })}
              item={`load:${load.id}`} menu={<MenuLines lines={loadMenu(study, load)} />} onContextSelect={() => set({ selection: load.picks, activeStudy: study.id })}
              onHover={(hovering) => set({ hover: hovering ? load.picks[0] ?? null : null })}
              actions={<button type="button" className={styles.eye} aria-label="Remove" onClick={() => removeLoad(study.id, load.id)}><Trash2 size={12} /></button>}
            />
          );
        };
        return (
          // Choosing anything of a study (a row, its menu) leaves the all-studies view for that study; its eye doesn't.
          <div key={study.id} onClickCapture={(event) => { if (overview && !(event.target as HTMLElement).closest?.('[data-study-eye]')) set({ studyOverview: false }); }}>
            <TreeRow
              depth={1}
              expanded={expanded(study.id)}
              onToggle={() => toggle(study.id)}
              icon={<StudyIcon size={15} />}
              label={study.name}
              dimmed={hidden}
              meta={<Status tone={status.tone}>{status.label}</Status>}
              selected={study.id === active && !overview}
              title={status.outdated ?? STUDY_TYPES[study.type].description}
              onClick={() => choose(study)}
              item={`study:${study.id}`} menu={<MenuLines lines={studyMenu(study, hidden, () => toggleStudy(study.id))} />} onContextSelect={() => set({ activeStudy: study.id })}
              actions={<>
                <button type="button" className={styles.eye} data-study-eye data-hidden={hidden || undefined} aria-label={`${hidden ? 'Show' : 'Hide'} ${study.name}`} aria-pressed={!hidden}
                  title={hidden ? 'Show in all studies' : 'Hide from all studies'} onClick={() => toggleStudy(study.id)}>
                  {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button type="button" className={styles.eye} aria-label="Delete study" onClick={() => { void removeStudy(study); }}><Trash2 size={12} /></button>
              </>}
            />
            {expanded(study.id) && <>
            <TreeRow depth={2} icon={<MaterialIcon size={14} />} label={study.type === 'flow' ? 'Fluid' : study.type === 'compressible' ? 'Gas' : 'Material'} meta={study.type === 'flow' ? study.definition?.fluid?.name ?? 'Set properties' : study.type === 'compressible' ? study.definition?.gas?.name ?? 'Choose a gas' : study.definition ? `Design revision ${study.definition.design.revision}` : material?.name ?? 'Assign'} onClick={() => choose(study)}
              item={`study-material:${study.id}`} onContextSelect={() => set({ activeStudy: study.id })} menu={<MenuLines lines={[study.type === 'flow' || study.type === 'compressible' ? { label: study.type === 'flow' ? 'Edit fluid' : 'Edit gas', icon: <Pencil {...I} />, run: () => activate(study) } : commandEntry('sim.material', 'Assign material…', () => set({ activeStudy: study.id })), { label: 'Edit study', icon: <Pencil {...I} />, run: () => activate(study) }]} />} />
            <TreeRow depth={2} icon={<FixedIcon size={14} />} label={GROUPS[study.type][0]} meta={constraints.length || undefined} item={`study-constraints:${study.id}`} onContextSelect={() => set({ activeStudy: study.id })} menu={<MenuLines lines={boundaryMenu(study, 'Constraint')} />} />
            {constraints.map(row)}
            <TreeRow depth={2} icon={<ForceIcon size={14} />} label={GROUPS[study.type][1]} meta={loads.length || undefined} item={`study-loads:${study.id}`} onContextSelect={() => set({ activeStudy: study.id })} menu={<MenuLines lines={boundaryMenu(study, 'Load')} />} />
            {loads.map(row)}
            {study.type === 'cht' ? <TreeRow depth={2} icon={<ContactIcon size={14} />} label="Thermal interfaces" meta={study.definition?.interfaces?.length ?? 0} onClick={() => choose(study)}
                item={`study-interfaces:${study.id}`} onContextSelect={() => set({ activeStudy: study.id })} menu={<MenuLines lines={[{ label: 'Edit interfaces', icon: <Pencil {...I} />, run: () => activate(study) }]} />} />
              : <TreeRow depth={2} icon={<ContactIcon size={14} />} label="Contacts" meta={<Status tone="soon">Solver</Status>} dimmed item={`study-contacts:${study.id}`} menu={<MenuLines lines={[commandEntry('sim.contacts')]} />} />}
            <TreeRow depth={2} icon={<MeshIcon size={14} />} label="Mesh" meta={`${study.meshSize} mm`} onClick={() => { set({ activeStudy: study.id }); void runStudy('mesh'); }}
              item={`study-mesh:${study.id}`} onContextSelect={() => set({ activeStudy: study.id })} menu={<MenuLines lines={[{ ...commandEntry('sim.mesh', 'Generate mesh', () => set({ activeStudy: study.id })), reason: running(study) ?? commandEntry('sim.mesh').reason },
                { label: 'Mesh size…', icon: <Pencil {...I} />, run: () => activate(study) }]} />} />
            <TreeRow depth={2} icon={<StressIcon size={14} />} label="Results" meta={status.results} onClick={() => choose(study)}
              item={`study-results:${study.id}`} onContextSelect={() => set({ activeStudy: study.id })} menu={<MenuLines lines={[{ label: 'Show results', icon: <StressIcon {...I} />, reason: status.solved ? null : 'Solve the study first.', run: () => activate(study) },
                { ...commandEntry('sim.solve', 'Solve', () => set({ activeStudy: study.id })), reason: running(study) ?? commandEntry('sim.solve').reason }]} />} />
            </>}
          </div>
        );
      })}
    </BrowserGroup>
  );
}
