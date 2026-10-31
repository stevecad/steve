import { BookOpen, Cpu, FileCode, Library, Wrench } from 'lucide-react';
import type { Command, RibbonGroup } from '@/commands';
import { KEEP, HIGH, MID } from '@/ribbonPriority';
import {
  BoreIcon, ChamferOpIcon, RoughIcon, ContourIcon, DrillOpIcon, EngraveIcon, FaceMillIcon, ParallelFinishIcon, PocketIcon, PostIcon, RestIcon, SetupIcon, SimulateToolIcon, SlotIcon,
  ToolpathIcon, WaterlineIcon,
} from '@/icons/cad';
import { openLibrary, useMfg } from './state';
import { operationReason, commandBore, commandChamfer, commandEngrave, commandSlot, commandContour, commandDrill, commandFace, commandGenerate, commandParallel, commandPocket, commandPost, commandRest, commandRough, commandSetup, commandSimulate, commandWaterline } from './cam/state';
import type { OpKind } from './cam/program';

// Codex's native milling engine runs facing, roughing around a part (rings or engagement-controlled adaptive clearing), 2D contours (with tabs), 2D pockets (plunge, ramp or helical entry), rest
// machining, slots, circular bores, drilling, peck drilling, trace engraving, chamfers and ball-end parallel and waterline 3D
// finishing (GET /v1/manufacturing/capabilities: docs/MANUFACTURING_FACING.md, _ROUGHING.md, _CONTOURS.md, _TABS.md, _BORING.md, _REST.md,
// _SLOTS.md, _DRILLING.md, _ENGRAVING.md, _CHAMFER.md, _SURFACES.md), one after
// another on the stock each leaves, and posts them as one program with tool changes. Processes and operations without an
// engine (turning, sheet cutting) aren't offered: nothing shows that can't be used.
// 3D printing isn't part of Manufacture: designs export 3MF/STL for the person's own slicer.
/** Generate, Simulate and Post act on the selected program or operation. */
const selectedProgram = () => (useMfg.getState().activeProgram || useMfg.getState().programs.length === 1 ? true : useMfg.getState().programs.length ? 'Select a setup or operation in the browser first.' : 'Create a setup first.');
/** Enabled when the server's engine runs the operation and there's a setup to put it in, else why not. */
const runs = (kind: OpKind) => () => operationReason(kind);
const cam = (id: string, label: string, icon: Command['icon'], description: string, run: () => void, short?: string, enabled?: Command['enabled']): Command => ({
  id, label, short, icon, category: 'Manufacture', description, run, ...(enabled ? { enabled } : {}),
});

export const manufactureCommands: Command[] = [
  cam('cam.setup.milling', 'Setup', SetupIcon, 'A new setup: the machine and its tools, the stock, program zero and fixtures for 3-axis milling. Operations are then added to it.', commandSetup),
  { id: 'cam.tools', label: 'Manufacturing library', short: 'Library', icon: Library, category: 'Manufacture', description: 'Your shop (machines, controllers and tools as code), Steve’s catalogue, and every library record with its revisions.', run: () => openLibrary('shop') },
  { id: 'cam.catalogue', label: 'Steve’s catalogue', icon: BookOpen, category: 'Manufacture', description: 'Machine models and controllers to start your shop from: use a machine to add your own copy.', run: () => openLibrary('catalogue') },
  { id: 'cam.library.machines', label: 'Machines', icon: Cpu, category: 'Manufacture', description: 'Your machines: each with its model and controller.', run: () => openLibrary('machine_instance') },
  { id: 'cam.library.tools', label: 'Tools', icon: Wrench, category: 'Manufacture', description: 'Tool setups, assemblies, cutters and holders.', run: () => openLibrary('tool_setup') },
  { id: 'cam.library.posts', label: 'Posts', icon: FileCode, category: 'Manufacture', description: 'User-authored post processors (JavaScript, isolated).', run: () => openLibrary('post_processor') },
  cam('cam.op.face', 'Face', FaceMillIcon, 'Face the whole stock down to the part’s top.', commandFace, undefined, runs('face')),
  cam('cam.op.rough', 'Rough', RoughIcon, 'Clear the stock around the part, depth by depth from the stock’s edge in, leaving stock on the walls and floor for finishing.', commandRough, undefined, runs('rough')),
  cam('cam.op.contour', '2D Contour', ContourIcon, 'Follow the part’s outline, picked faces or an edge chain, at depth.', commandContour, 'Contour', runs('contour')),
  cam('cam.op.pocket', '2D Pocket', PocketIcon, 'Clear a pocket down to its floor face.', commandPocket, 'Pocket', runs('pocket')),
  cam('cam.op.slot', 'Slot', SlotIcon, 'Mill constant-width slots: rounded slot floors in the part, or centrelines with a width (open and through slots too).', commandSlot, undefined, runs('slot')),
  cam('cam.op.rest', 'Rest machining', RestIcon, 'Clean up what the pocket before left (its corners) with a smaller cutter, from the actual remaining stock.', commandRest, 'Rest', runs('rest')),
  cam('cam.op.drill', 'Drill', DrillOpIcon, 'Drill or peck-drill the part’s holes with a drill of their size.', commandDrill, undefined, runs('peck_drill')),
  cam('cam.op.bore', 'Bore', BoreIcon, 'Mill round bores larger than the cutter: helix or plunge in, rings outward, a finishing circle.', commandBore, undefined, runs('bore')),
  cam('cam.op.engrave', 'Engrave', EngraveIcon, 'Trace sketch curves or edges with a V-bit at a constant depth.', commandEngrave, undefined, runs('engrave')),
  cam('cam.op.chamfer', 'Chamfer', ChamferOpIcon, 'Bevel the part’s top edges with a V-bit: a new chamfer of a set width, or one already modelled.', commandChamfer, undefined, runs('chamfer')),
  cam('cam.op.parallel', 'Parallel finishing', ParallelFinishIcon, 'Finish 3D surfaces with a ball end mill in parallel rows (best on shallow areas).', commandParallel, 'Parallel', runs('parallel')),
  cam('cam.op.waterline', 'Waterline finishing', WaterlineIcon, 'Finish steep 3D walls with a ball end mill in constant-height loops.', commandWaterline, 'Waterline', runs('waterline')),
  cam('cam.generate', 'Generate toolpaths', ToolpathIcon, 'Plan, post, decode and check the selected operation, the selected setup\u2019s operations, or all of them.', commandGenerate, 'Generate', selectedProgram),
  cam('cam.simulate', 'Simulate', SimulateToolIcon, 'Play back the posted program: tools, stock checkpoints and the checks’ events.', commandSimulate, undefined, selectedProgram),
  cam('cam.post', 'Post process', PostIcon, 'Download the machine file: an operation’s, or the whole program’s with its tool changes (failed checks block it).', commandPost, 'Post', selectedProgram),
];

export const manufactureRibbon: RibbonGroup[] = [
  { title: 'Setup', priority: KEEP, items: ['cam.setup.milling'] },
  // One Library button: machines, tools and posts are its tabs (the command palette opens each directly).
  { title: 'Library', priority: HIGH, items: ['cam.tools'] },
  { title: '2D', priority: MID, items: ['cam.op.face', 'cam.op.rough', 'cam.op.contour', 'cam.op.pocket', 'cam.op.rest', 'cam.op.slot', 'cam.op.drill', 'cam.op.bore', 'cam.op.engrave', 'cam.op.chamfer'] },
  { title: '3D', priority: MID, items: ['cam.op.parallel', 'cam.op.waterline'] },
  { title: 'Actions', priority: KEEP, items: ['cam.generate', 'cam.simulate', 'cam.post'] },
  { title: 'Inspect', items: ['inspect.measure', 'inspect.section'] },
];
