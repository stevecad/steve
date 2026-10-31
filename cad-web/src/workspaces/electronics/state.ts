/**
 * The Electronics workspace's own state (docs/ELECTRONICS.md): the Circuit JSON of the circuit build on screen, the
 * view (schematic, PCB, 3D or split), and the selection by part name, shared by every view and the tree.
 *
 * The open document and its builds stay in the app store: a circuit is generated, saved and shown like a part, and its
 * `preview.glb` is the 3D view. This adds what only circuits have.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { get as getApp, set as setApp, useApp } from '@/state/store';
import type { Build, CircuitRouting } from '@/lib/api';
import { circuitModel, type CircuitElement, type CircuitModel } from './circuit';
import { stopWiring, useSchematicTool } from './schematicEdits';
import { boardPick, circuitIndex, netByKey, netPick, pickContext, pinPick, type CircuitPick, type PickContext } from './picks';

export type CircuitView = 'schematic' | 'pcb' | '3d' | 'split';
export const VIEWS: { id: CircuitView; label: string; key: string }[] = [
  { id: 'schematic', label: 'Schematic', key: '1' },
  { id: 'pcb', label: 'PCB', key: '2' },
  { id: '3d', label: '3D', key: '3' },
  { id: 'split', label: 'Split', key: '4' },
];

export interface CircuitState {
  /** The build whose Circuit JSON is loaded. */
  buildId: string | null;
  json: CircuitElement[] | null;
  model: CircuitModel | null;
  loading: boolean;
  /** Reading the Circuit JSON failed (the build itself succeeded). */
  error: string | null;
  view: CircuitView;
  /** Selected parts, by name (R1, U2). */
  selection: string[];
  /** The part under the pointer in any view or the tree. */
  hover: string | null;
  /** A net picked in the tree: its ports light up. */
  net: string | null;
  /** Everything picked that isn't a whole part: pins, pads, traces, nets, vias, holes, the board, net labels (picks.ts). */
  picks: CircuitPick[];
  /** Bumped to ask the views to frame the selection (double-click in the tree). */
  focus: number;
  /** Parts to select once the next build has them (a part just placed or renamed in the code). */
  pending: string[] | null;
}

const VIEW_KEY = 'steve-circuit-view';
// A phone has room for one view at a time: Split starts as the schematic there.
const phone = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 600px)').matches;
const initialView = (): CircuitView => {
  let value: string | null = null;
  try { value = localStorage.getItem(VIEW_KEY); } catch { /* storage unavailable */ }
  const view = VIEWS.some((item) => item.id === value) ? value as CircuitView : 'split';
  return view === 'split' && phone() ? 'schematic' : view;
};

export const useCircuit = create<CircuitState>()(subscribeWithSelector((): CircuitState => ({
  buildId: null, json: null, model: null, loading: false, error: null, view: initialView(), selection: [], hover: null, net: null, picks: [], focus: 0, pending: null,
})));

export function setView(view: CircuitView) {
  useCircuit.setState({ view });
  setApp({ circuitView: view });
  try { localStorage.setItem(VIEW_KEY, view); } catch { /* Optional. */ }
}

/** Selects parts by name; `additive` toggles one in or out (Shift/Ctrl+click). A new selection drops the picks. */
export function selectParts(names: string[], additive = false) {
  const current = useCircuit.getState().selection;
  if (!additive) { useCircuit.setState({ selection: names, net: null, picks: [] }); return; }
  const next = new Set(current);
  for (const name of names) { if (next.has(name)) next.delete(name); else next.add(name); }
  useCircuit.setState({ selection: [...next], net: null });
}

/** The net a set of picks lights up: the one net or net label picked. */
const netShown = (picks: CircuitPick[]) => picks.find((pick) => pick.kind === 'net' || pick.kind === 'label')?.net ?? null;

/**
 * Picks a pin, pad, trace, net, via, hole, the board or a net label (picks.ts); `additive` toggles it in or out
 * (Shift/Ctrl+click) and keeps the selected parts. A plain pick replaces the parts too: one thing is picked.
 */
export function pickItem(pick: CircuitPick | null, additive = false) {
  if (!pick) { if (!additive) useCircuit.setState({ picks: [], selection: [], net: null }); return; }
  const { picks } = useCircuit.getState();
  if (!additive) { useCircuit.setState({ picks: [pick], selection: [], net: netShown([pick]) }); return; }
  const next = picks.some((item) => item.key === pick.key) ? picks.filter((item) => item.key !== pick.key) : [...picks, pick];
  useCircuit.setState({ picks: next, net: netShown(next) });
}

/** Nothing picked: no parts, pins, traces or nets (Esc). */
export const clearSelection = () => useCircuit.setState({ selection: [], picks: [], net: null });

/** Picks that still mean something in a rebuilt circuit, found again by name: pins by part and pin, nets by name, the board. */
function carryPicks(picks: CircuitPick[], previous: CircuitModel | null, model: CircuitModel, json: CircuitElement[]): CircuitPick[] {
  if (!picks.length) return picks;
  const index = circuitIndex(json);
  const out: CircuitPick[] = [];
  for (const pick of picks) {
    if ((pick.kind === 'pin' || pick.kind === 'pad') && pick.part && pick.ids.source_port_id) {
      const old = previous?.portOf.get(pick.ids.source_port_id);
      const port = old ? model.parts.find((part) => part.name === pick.part)?.ports.find((item) => item.name === old.name) : undefined;
      const again = port ? pinPick(model, index, port.id, pick.kind) : null;
      if (again) out.push({ ...again, layer: pick.layer });
    } else if (pick.kind === 'net' || pick.kind === 'label') {
      const name = netByKey(previous ?? model, pick.net)?.name;
      const net = name ? model.nets.find((item) => item.name === name) : undefined;
      if (net) out.push(netPick(net));
    } else if (pick.kind === 'board') {
      const again = boardPick(index);
      if (again) out.push(again);
    }
  }
  return out;
}

/** Selects parts as soon as a build has them: a part just added to the code isn't in the circuit until it's rebuilt. */
export const selectSoon = (names: string[]) => useCircuit.setState({ pending: names });

export const hoverPart = (name: string | null) => { if (useCircuit.getState().hover !== name) useCircuit.setState({ hover: name }); };
export const focusSelection = () => useCircuit.setState((state) => ({ focus: state.focus + 1 }));

const cache = new Map<string, Promise<CircuitElement[]>>();
const circuitUrl = (build: Build) => build.artifacts.circuit ?? `/v1/builds/${build.id}/artifacts/circuit`;

/** Reads a build's Circuit JSON (cached: tabs switching back and forth don't refetch). */
export function loadCircuitJson(build: Build): Promise<CircuitElement[]> {
  let request = cache.get(build.id);
  if (!request) {
    request = fetch(circuitUrl(build)).then(async (response) => {
      if (!response.ok) throw new Error(response.status === 404 ? 'This build has no Circuit JSON.' : `Couldn’t read the circuit (${response.status}).`);
      const value = await response.json() as unknown;
      if (!Array.isArray(value)) throw new Error('The circuit file isn’t Circuit JSON.');
      return value as CircuitElement[];
    });
    request.catch(() => cache.delete(build.id));
    cache.set(build.id, request);
    while (cache.size > 8) cache.delete(cache.keys().next().value!);
  }
  return request;
}

/** Shows a Circuit JSON directly (tests and fixtures): what a build's would show. */
export function showCircuit(json: CircuitElement[], buildId = 'fixture') {
  const metadata = getApp().displayed?.id === buildId ? getApp().displayed?.metadata : null;
  const has = (name: string) => json.some((element) => element.type === 'source_component' && element.name === name);
  useCircuit.setState((state) => {
    const pending = state.pending?.filter(has) ?? [];
    const model = circuitModel(json, metadata);
    const picks = pending.length ? [] : carryPicks(state.picks, state.model, model, json);
    return {
      buildId, json, model, loading: false, error: null,
      // Parts that are still there stay selected across rebuilds; parts just placed are selected once they arrive.
      selection: pending.length ? pending : state.selection.filter(has),
      pending: pending.length ? null : state.pending,
      picks, net: picks.length ? netShown(picks) : state.net && model.nets.some((item) => item.key === state.net) ? state.net : null,
    };
  });
}

let installed = false;

/**
 * Keeps the Circuit JSON in step with the circuit build on screen, and the workspace with the document: opening a
 * circuit shows Electronics; going back to a part or design from a circuit shows Design.
 */
export function installCircuitSync() {
  if (installed) return;
  installed = true;
  let run = 0;
  const sync = (build: Build | null) => {
    const current = ++run;
    if (!build || build.kind !== 'circuit' || build.status !== 'succeeded') {
      if (getApp().doc.kind !== 'circuit' || !build) useCircuit.setState({ buildId: null, json: null, model: null, loading: false, error: null });
      return;
    }
    if (useCircuit.getState().buildId === build.id && useCircuit.getState().json) return;
    useCircuit.setState({ loading: true, error: null });
    loadCircuitJson(build).then((json) => { if (current === run) showCircuit(json, build.id); })
      .catch((error: Error) => { if (current === run) useCircuit.setState({ loading: false, error: error.message }); });
  };
  useApp.subscribe((state) => state.displayed, sync);
  sync(getApp().displayed);
  setApp({ circuitView: useCircuit.getState().view });

  useApp.subscribe((state) => [state.doc.open, state.doc.kind, state.activeTab] as const, ([open, kind], previous) => {
    const state = getApp();
    if (!state.workspaces.includes('electronics')) return;
    if (open && kind === 'circuit' && state.workspace !== 'electronics') {
      setApp({ workspace: 'electronics', tool: 'select', measurePicks: [] });
    } else if (open && kind !== 'circuit' && previous[1] === 'circuit' && state.workspace === 'electronics') {
      setApp({ workspace: 'design', tool: 'select', measurePicks: [] });
    }
    if (kind !== 'circuit') useCircuit.setState({ selection: [], hover: null, net: null, picks: [] });
    stopWiring();  // A wire never carries over to another document.
  }, { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] });

  installThreeDSync();
  // Esc lets go of everything picked (after the tools have taken their Esc: a wire, a placement).
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || getApp().workspace !== 'electronics' || getApp().dialog) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, .cm-editor, [contenteditable], [role="menu"], [role="dialog"]')) return;
    if (useSchematicTool.getState().tool !== 'select') return;
    const { selection, picks, net } = useCircuit.getState();
    if (selection.length || picks.length || net) clearSelection();
  });
}

/**
 * The 3D view picks whole parts (the board model's nodes are named after them, the board itself `Box0`): a pick there is
 * the part (or the board) everywhere, and parts picked in another view light up in 3D.
 */
function installThreeDSync() {
  let echo = false;
  useApp.subscribe((state) => state.selection, (selection) => {
    if (echo || getApp().doc.kind !== 'circuit' || useCircuit.getState().view !== '3d') return;
    const model = useCircuit.getState().model;
    if (!model) return;
    const tree = getApp().tree;
    const names = [...new Set(selection.map((pick) => tree[pick.node]?.name).filter((name): name is string => !!name))];
    const parts = names.filter((name) => model.parts.some((part) => part.name === name));
    if (parts.length) { selectParts(parts); return; }
    const json = useCircuit.getState().json;
    if (names.length && json) { const pick = boardPick(circuitIndex(json)); if (pick) { pickItem(pick); return; } }
    if (!selection.length) clearSelection();
  });
  useCircuit.subscribe((state) => [state.selection, state.view] as const, ([selection, view]) => {
    if (view !== '3d' || getApp().doc.kind !== 'circuit') return;
    const tree = getApp().tree;
    const wanted = Object.values(tree).filter((node) => selection.includes(node.name)).map((node) => ({ kind: 'component' as const, node: node.id }));
    const current = getApp().selection;
    if (wanted.length === current.length && wanted.every((pick) => current.some((item) => item.kind === 'component' && item.node === pick.node))) return;
    echo = true;
    try { setApp({ selection: wanted }); } finally { echo = false; }
  }, { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] });
}

/** What a circuit pick is, said for STEVE: `selection_detail` entries (app/assistant.py ChatRequest). */
export function circuitSelectionContext(): PickContext[] {
  const { model, selection, net, picks, json } = useCircuit.getState();
  if (!model) return [];
  const out: PickContext[] = [];
  const netOf = new Map<string, string>();
  for (const item of model.nets) for (const port of item.ports) netOf.set(port.id, item.name);
  for (const name of selection) {
    const part = model.parts.find((item) => item.name === name);
    if (!part) continue;
    const kind = part.ftype.replace(/^simple_/, '').replace(/_/g, ' ');
    out.push({
      kind: 'component', component: part.name,
      description: [part.name, [kind, part.value].filter(Boolean).join(' '), part.footprint].filter(Boolean).join(' · '),
      ...(part.pcb ? { geometry: { pcb: { x: Number(part.pcb.x.toFixed(3)), y: Number(part.pcb.y.toFixed(3)), rotation: part.pcb.rotation }, layer: part.layer } } : {}),
    });
  }
  const routing = (getApp().displayed?.metadata as { routing?: CircuitRouting } | null | undefined)?.routing ?? null;
  if (json) for (const pick of picks) out.push(pickContext(pick, model, json, routing));
  // A net lit from the tree (picks carry their own).
  const picked = net && !picks.some((pick) => pick.net === net) ? model.nets.find((item) => item.key === net) : null;
  if (picked) out.push({ kind: 'net', description: `net ${picked.name} · ${picked.ports.map((port) => `${port.part}.${port.label}`).join(', ')}`.slice(0, 300) });
  return out.slice(0, 12);
}
