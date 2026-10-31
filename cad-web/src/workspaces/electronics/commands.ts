/**
 * The Electronics workspace's commands and ribbon (docs/ELECTRONICS.md). The place-and-wire tools come from the
 * code-rewrite engine through slots.ts; the views, code, STEVE and exports are here.
 */
import { ClipboardCheck, Code2, Download, FilePlus2, MessageSquare, Move, RefreshCw, Route } from 'lucide-react';
import { get, set, toast, type AppState } from '@/state/store';
import { ensureFullBuild, updateModel } from '@/state/actions';
import { openTab } from '@/state/tabs';
import type { Command, RibbonGroup } from '@/commands';
import { KEEP, HIGH, MID } from '@/ribbonPriority';
import { BoardIcon, SchematicIcon, SplitViewIcon, ViewCubeIcon } from '@/icons/cad';
import { setView, type CircuitView } from './state';
import { startWiring, stopWiring, useSchematicTool } from './schematicEdits';
import { WireIcon } from '@/icons/cad';
import { placeCommands, placeRibbon } from './slots';
import { setMoveParts, usePcbEditState } from './pcbEdits';
import { isRunning, routeBoard, useRouting } from './routing';
import { guardExport, openReadiness } from './readiness';
import { withWorkspace } from '@/teams/current';

const inCircuit = (state: AppState) => (state.workspace === 'electronics' && state.doc.open && state.doc.kind === 'circuit') || 'Open a circuit first.';
const built = (state: AppState) => (state.displayed?.kind === 'circuit' ? true : 'Build the circuit first.');
const idle = (state: AppState) => !state.busy || 'Wait for the current operation to finish.';
const all = (...checks: ((state: AppState) => true | string)[]) => (state: AppState) => {
  for (const check of checks) { const result = check(state); if (result !== true) return result; }
  return true as const;
};

const viewCommand = (view: CircuitView, label: string, icon: Command['icon'], key: string, shortcut: string, description: string): Command => ({
  id: `circuit.view.${view}`, label, short: label.replace(/ view$/, ''), icon, category: 'Electronics', shortcut, keys: [key], description,
  run: () => setView(view), enabled: inCircuit, active: (state) => state.circuitView === view,
});

async function exportFabrication() {
  const build = await ensureFullBuild(false, 'fabrication files');
  const url = build?.artifacts.fabrication;
  if (!build) return;
  if (!url) { toast('warning', 'No fabrication files', 'This build has no Gerbers yet; the electronics service may be older than this app.'); return; }
  const name = get().doc.name || build.name;
  const link = document.createElement('a');
  link.href = withWorkspace(`${url}?name=${encodeURIComponent(name)}`);
  link.download = `${name.replace(/[^\w.-]+/g, '_')}-fabrication.zip`;
  link.click();
  toast('success', 'Exporting fabrication files', 'Gerbers and drill files, BOM and pick-and-place, ready for a board house.');
}

export const electronicsCommands: Command[] = [
  { id: 'doc.new.circuit', label: 'New circuit', icon: FilePlus2, category: 'Document', description: 'A circuit board as TSX code: schematic, board and 3D, with tscircuit.',
    run: () => openTab({ kind: 'circuit' }), enabled: idle, hidden: (state) => !state.workspaces.includes('electronics') },
  viewCommand('schematic', 'Schematic view', SchematicIcon, 's', 'S', 'How it’s wired: symbols, pins and nets, laid out by tscircuit.'),
  viewCommand('pcb', 'PCB view', BoardIcon, 'b', 'B', 'The board: parts on copper, routed traces and design-rule errors. Drag a part to move it.'),
  viewCommand('3d', '3D view', ViewCubeIcon, 'd', 'D', 'The assembled board in 3D: measure it, section it, use it in an enclosure.'),
  viewCommand('split', 'Split view', SplitViewIcon, 'shift+s', 'Shift+S', 'Schematic and board side by side; a part selected in one is selected in the other.'),
  { id: 'circuit.move', label: 'Move parts', short: 'Move', icon: Move, category: 'Electronics', shortcut: 'M', keys: ['m'],
    description: 'Drag parts on the board to move them (on a 0.1 mm grid, written into the code as pcbX / pcbY). Off, dragging a part pans the board.',
    run: () => setMoveParts(!usePcbEditState.getState().moveParts),
    enabled: all(inCircuit, (state) => state.circuitView === 'pcb' || state.circuitView === 'split' || 'Show the PCB to move parts on the board.'),
    active: () => usePcbEditState.getState().moveParts },
  { id: 'circuit.wire', label: 'Wire', icon: WireIcon, category: 'Electronics', shortcut: 'W', keys: ['w'],
    description: 'Connect two pins on the schematic: click one, then the other. Each wire becomes a <trace> in the code. Esc stops.',
    run: () => { if (useSchematicTool.getState().tool === 'wire') stopWiring(); else { if (get().circuitView === 'pcb' || get().circuitView === '3d') setView('schematic'); startWiring(); } },
    enabled: all(inCircuit, built), active: (state) => state.circuitTool === 'wire' },
  { id: 'circuit.source', label: 'Circuit code', short: 'Code', icon: Code2, category: 'Electronics', description: 'The TSX that is the circuit: every tool edits it.',
    run: () => set((state) => (state.dockOpen && state.dockTab === 'source' ? { dockOpen: false } : { dockOpen: true, dockTab: 'source' })), enabled: inCircuit,
    active: (state) => state.dockOpen && state.dockTab === 'source' },
  { id: 'circuit.assistant', label: 'Ask STEVE', short: 'STEVE', icon: MessageSquare, category: 'Electronics', description: 'Describe a circuit or a change; STEVE writes the TSX and builds it.',
    run: () => set((state) => (state.dockOpen && state.dockTab === 'assistant' ? { dockOpen: false } : { dockOpen: true, dockTab: 'assistant' })),
    active: (state) => state.dockOpen && state.dockTab === 'assistant' },
  { id: 'circuit.route', label: 'Route board', short: 'Route', icon: Route, category: 'Electronics',
    description: 'Lay copper for every connection: the autorouter, once the parts are placed. Takes minutes and keeps running while you work; builds don’t route on their own. While it runs, this shows its progress.',
    run: () => { void routeBoard(); }, enabled: all(inCircuit, built), active: () => isRunning(useRouting.getState().build) },
  { id: 'circuit.readiness', label: 'Ready to order?', short: 'Ready?', icon: ClipboardCheck, category: 'Electronics',
    description: 'What stands between this board and an order: board-house limits, electrical checks and parts in stock, each with its fix.',
    run: () => openReadiness(true), enabled: all(inCircuit, built) },
  { id: 'circuit.update', label: 'Build circuit', short: 'Build', icon: RefreshCw, category: 'Electronics', description: 'Lay out, place and route the circuit from its code now (it also builds by itself after edits).',
    run: () => { void updateModel(); }, enabled: all(inCircuit, idle) },
  { id: 'circuit.export.fabrication', label: 'Fabrication files', short: 'Gerbers', icon: Download, category: 'Electronics',
    description: 'Gerbers and drill files, the bill of materials and pick-and-place, zipped for a board house.',
    // Not ready to order: say so before handing over files a board house would reject.
    run: () => guardExport(() => { void exportFabrication(); }), enabled: all(inCircuit, built, idle) },
  { id: 'circuit.export.step', label: 'Board STEP', short: 'STEP', icon: Download, category: 'Electronics', description: 'The board as a STEP model, for an enclosure in CAD.',
    run: () => { void import('@/state/actions').then(({ exportStep }) => exportStep()); }, enabled: all(inCircuit, built, idle) },
  ...placeCommands,
];

// The ribbon and the palette re-read a command's state when the app store changes: nudge it when Move parts flips.
usePcbEditState.subscribe((state, previous) => { if (state.moveParts !== previous.moveParts) set({}); });
useRouting.subscribe((state, previous) => { if (isRunning(state.build) !== isRunning(previous.build)) set({}); });

export const electronicsRibbon: RibbonGroup[] = [
  { title: 'Circuit', priority: HIGH, items: ['doc.new.circuit', 'circuit.source', 'circuit.assistant'] },
  { title: 'View', priority: KEEP, items: ['circuit.view.schematic', 'circuit.view.pcb', 'circuit.view.3d', 'circuit.view.split'], visible: (state) => state.doc.kind === 'circuit' },
  ...placeRibbon,
  { title: 'Connect', priority: KEEP, items: ['circuit.wire'], visible: (state) => state.doc.kind === 'circuit' },
  { title: 'Build', priority: KEEP, items: ['circuit.update', 'circuit.route'], visible: (state) => state.doc.kind === 'circuit' },
  { title: 'Order', priority: MID, items: ['circuit.readiness', 'circuit.export.fabrication', 'circuit.export.step'], visible: (state) => state.doc.kind === 'circuit' },
];
