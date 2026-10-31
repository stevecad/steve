import { HOSTED_SERVICES } from '@/localCapabilities';
/**
 * The export list every export menu shows (the ribbon's Export, File → Export and the top bar's split button):
 * STEP · 3MF · STL, the selected component (STEP/3MF) when a component or instance is selected, the print set (3MF/STL)
 * in a design with the print bed its plates are laid out on, the mesh resolution those use (remembered per browser), the code's drawing sheets (and the whole
 * product's: every linked document's sheets and STEP), then image and source; in Manufacture first the machine file (G-code). A circuit exports what a board is made and fitted from instead: fabrication files,
 * the board's STEP and its TSX. Availability and reasons come from the command registry.
 */
import { Camera, Download, Factory, FileCode, FileText, Package, Share2 } from 'lucide-react';
import { MenuItem, MenuLabel, MenuSeparator } from '@/ui';
import { availability, command, EXPORT_MENU, runCommand } from '@/commands';
import type { MeshResolution } from '@/lib/api';
import { selectionTarget } from '@/state/componentStep';
import { sourceFiles } from '@/state/design';
import { exportMesh } from '@/state/meshExport';
import { exportPrintSet } from '@/state/printSet';
import { MESH_RESOLUTIONS, PRINT_BEDS, rememberBed, rememberFormat, rememberResolution, useMeshResolution, usePrintBed } from '@/state/exportFormat';
import { useApp, type AppState } from '@/state/store';

/** Electronics' exports: the circuit open, or the workspace with nothing open yet. */
export const exportsCircuit = (state: AppState) => (state.doc.open ? state.doc.kind === 'circuit' : state.workspace === 'electronics');
const CIRCUIT_MENU = ['circuit.export.fabrication', 'circuit.export.step', 'export.source'];
/** A Blender document's exports: its scene file, a picture, its source. */
const BLENDER_MENU = ['blender.render', 'blender.open', 'export.blend', 'export.image', 'export.source'];

export default function ExportMenuItems({ label }: { label?: string }) {
  const circuit = useApp(exportsCircuit);
  const blender = useApp((state) => state.doc.open && state.doc.kind === 'blender');
  const ids = circuit ? CIRCUIT_MENU : blender ? BLENDER_MENU : EXPORT_MENU;
  const states = useApp((state) => ids.map((id) => availability(command(id), state)).join('|')).split('|');
  const on = (id: string) => states[ids.indexOf(id)] === 'true';
  const component = useApp((state) => (state.doc.kind === 'design' ? selectionTarget(state)?.name ?? null : null));
  const selection = useApp((state) => state.selection.length > 0);
  const shareable = useApp((state) => availability(command('doc.share'), state) === true);
  const sendable = useApp((state) => availability(command('doc.carbon'), state) === true);
  // A design's or circuit's several files download together as a zip.
  const zipped = useApp((state) => state.doc.open && sourceFiles(state.doc).length > 1);
  const item = (id: string, text: string, icon = <Download size={15} />, hint?: string, run = () => runCommand(id)) => (
    <MenuItem key={`${id}:${text}`} icon={icon} disabled={!on(id)} hint={hint} onSelect={run}>{text}</MenuItem>
  );
  // Every hook runs before the circuit's early return: switching a tab between a circuit and a design must never change
  // how many hooks this component calls (React #310, a blank page).
  const kind = useApp((state) => state.doc.kind);
  const manufacture = useApp((state) => state.workspace === 'manufacture');
  const post = useApp((state) => availability(command('cam.post'), state));
  const resolution = useMeshResolution((state) => state.resolution);
  const bed = usePrintBed((state) => state.bed);
  if (circuit) {
    return (
      <>
        {label && <MenuLabel>{label}</MenuLabel>}
        {item('circuit.export.fabrication', 'Fabrication files', undefined, 'Gerbers · BOM · placement')}
        {item('circuit.export.step', 'Board STEP', undefined, 'For CAD')}
        <MenuSeparator />
        {item('export.source', zipped ? 'Source (.zip)' : 'Source (.tsx)', <FileCode size={15} />)}
      </>
    );
  }
  if (blender) {
    return (
      <>
        {label && <MenuLabel>{label}</MenuLabel>}
        {item('blender.render', 'Render scene…')}
          {item('blender.open', 'Open in Blender')}
          {item('export.blend', 'Blender file (.blend)')}
        {item('export.image', 'Image (PNG)', <Camera size={15} />)}
        <MenuSeparator />
        {item('export.source', zipped ? 'Source (.zip)' : 'Source (.py)', <FileCode size={15} />)}
      </>
    );
  }
  // The component's every body, wherever in it the selection is (the 3MF row above exports just the selected bodies).
  const component3mf = () => { if (on('export.3mf')) { rememberFormat('3mf'); void exportMesh('3mf', true); } };
  // Every printed part as binary STL instead of 3MF (the row above).
  const printStl = () => { if (on('export.printSet')) void exportPrintSet('stl'); };
  return (
    <>
      {label && <MenuLabel>{label}</MenuLabel>}
      {manufacture && (
        <>
          {/* The selected operation's, or the whole program's with its tool changes (failed checks block it). */}
          <MenuItem icon={<FileCode size={15} />} disabled={post !== true} hint={post === true ? 'G-code' : String(post)} onSelect={() => runCommand('cam.post')}>Machine file</MenuItem>
          <MenuSeparator />
        </>
      )}
      {item('export.step', 'STEP', undefined, selection ? 'Model' : undefined)}
      {item('export.3mf', '3MF', undefined, selection ? 'Selection' : undefined)}
      {item('export.stl', 'STL', undefined, selection ? 'Selection' : undefined)}
      {component && item('export.component', 'Selected component (STEP)', undefined, component)}
      {component && item('export.3mf', 'Selected component (3MF)', undefined, component, component3mf)}
      {kind === 'design' && (
        <>
          <MenuSeparator />
          {item('export.printSet', 'Print set (3MF)')}
          {item('export.printSet', 'Print set (STL)', undefined, undefined, printStl)}
          {/* The bed the print set lays its plates out on (every copy, ready to slice). */}
          <MenuLabel>Print bed</MenuLabel>
          {Object.entries(PRINT_BEDS).map(([key, { label }]) => (
            <MenuItem key={`bed:${key}`} checked={bed === key} onSelect={() => rememberBed(key)}>{label}</MenuItem>
          ))}
        </>
      )}
      <MenuSeparator />
      {/* How finely the 3MF, STL and print set rows mesh curved faces: coarser is a much smaller file. */}
      <MenuLabel>Mesh resolution</MenuLabel>
      {(Object.keys(MESH_RESOLUTIONS) as MeshResolution[]).map((level) => (
        <MenuItem key={`resolution:${level}`} checked={resolution === level} hint={MESH_RESOLUTIONS[level].hint} onSelect={() => rememberResolution(level)}>{MESH_RESOLUTIONS[level].label}</MenuItem>
      ))}
      <MenuSeparator />
      {item('export.drawingPdf', 'Drawing (PDF)', <FileText size={15} />, 'Every sheet')}
      {item('export.drawing', 'Drawing (view · print)', <FileText size={15} />)}
      {item('export.drawings', 'Drawings (SVG · DXF)', undefined, 'Every sheet')}
      {item('export.productDrawings', 'Product drawings (PDF · STEP)', <FileText size={15} />, 'With linked documents')}
      <MenuSeparator />
      {item('export.image', 'Image (PNG)', <Camera size={15} />)}
      {item('export.project', 'Project archive (.zip)', <Package size={15} />, 'Source + assets')}
      {item('export.source', zipped ? 'Source (.zip)' : 'Source (.py)', <FileCode size={15} />)}
      <MenuSeparator />
      {HOSTED_SERVICES && <MenuItem icon={<Share2 size={15} />} disabled={!shareable} hint="Read-only link" onSelect={() => runCommand('doc.share')}>Share link…</MenuItem>}
      {HOSTED_SERVICES && <MenuItem icon={<Factory size={15} />} disabled={!sendable} hint="ERP" onSelect={() => runCommand('doc.carbon')}>Send to Carbon…</MenuItem>}
      {HOSTED_SERVICES && <MenuItem icon={<Package size={15} />} disabled={!sendable} hint="Made to order" onSelect={() => runCommand('doc.rmfg')}>Order from RMFG…</MenuItem>}
    </>
  );
}
