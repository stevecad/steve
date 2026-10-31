/**
 * The Design workspace's Motion tab (docs/MOTION.md): joints, gears and links, motors, poses and keyframed
 * animations, collision checks and export, for designs. Like the Solid and Sheet metal tabs, every tool
 * writes the Python STEVE writes into main.py.
 */
import { ArrowLeftRight, Bookmark, Clapperboard, Cog, Download, Film, Gauge, Layers, Link2, Pause, Play, Radar, RotateCcw, RotateCw, Rows3, Video, Waypoints, Workflow } from 'lucide-react';
import type { Command, RibbonGroup } from '@/commands';
import { KEEP, HIGH, MID } from '@/ribbonPriority';
import { set, type AppState } from '@/state/store';
import { updateModel } from '@/state/actions';
import { openJointTool, useJointTool } from './jointTool';
import { openMotionTool } from './motionTool';
import { openExplodeTool } from './explodeTool';
import { clipOf, explodeOf, resetPose, toggleClip, togglePlay, useMotion } from './state';
import { driveCall, writeAnimation, writeDrive } from './code';
import { exportAnimatedGlb } from './exportMotion';
import { exportSimulationModel } from './simulationExport';
import type { JointType } from './kinematics';

const needsDesign = (state: AppState) => (state.doc.open && state.doc.kind === 'design') || 'Motion belongs to designs: open or create one.';
const needsIdle = (state: AppState) => !state.busy || 'Wait for the current operation to finish.';
const needsModel = (state: AppState) => !!state.displayed || 'Generate the design first.';
const kinematics = () => useMotion.getState().kinematics;
const hasJoints = () => (kinematics()?.joints.some((joint) => joint.type !== 'rigid') ? true : 'Add a revolute or slider joint first.');
const hasPoses = () => (Object.keys(kinematics()?.poses ?? {}).length >= 2 || !!kinematics()?.animations?.length ? true : 'Save two poses first (Pose).');
const hasMotion = () => (kinematics()?.drives.length || kinematics()?.animations?.length || kinematics()?.explodes?.length ? true : 'Add a motor, an animation or an explode first.');
const all = (...checks: ((state: AppState) => true | string)[]) => (state: AppState) => {
  for (const check of checks) { const result = check(state); if (result !== true) return result; }
  return true as const;
};

const joint = (type: JointType, label: string, icon: Command['icon'], description: string): Command => ({
  id: `motion.${type}`, label, icon, category: 'Motion', description,
  run: () => openJointTool(undefined, type), enabled: all(needsDesign, needsIdle, needsModel),
  active: (state) => state.tool === 'joint' && useJointTool.getState().type === type,
});

/** Turns the build's collision check on or off for the shown animation, or else the active (or first) drive. */
async function toggleCheck() {
  const clip = clipOf();
  if (clip) {
    writeAnimation({ name: clip.name, keys: clip.keys.map((key) => ({ pose: key.pose ?? key.values, time: key.time })), loop: clip.loop, easing: clip.easing, check: !clip.check });
  } else {
    const { active } = useMotion.getState();
    const target = kinematics()?.drives.find((drive) => drive.joint === active)?.joint ?? kinematics()?.drives[0]?.joint;
    const drive = target ? driveCall(target) : null;
    if (!drive) return;
    writeDrive({ ...drive, check: !drive.check });
  }
  await updateModel();
}

const playing = () => !!useMotion.getState().clipStart || !!useMotion.getState().playing;

export const motionCommands: Command[] = [
  joint('revolute', 'Revolute joint', RotateCw, 'A part that turns about an axis, like a hinge, wheel or shaft. Pick the moving part, the part it turns on, and a pin, bore or edge for the axis.'),
  joint('slider', 'Slider joint', ArrowLeftRight, 'A part that slides along an axis, like a drawer, carriage or piston.'),
  joint('cylindrical', 'Cylindrical joint', Rows3, 'Turns about and slides along one axis, like a shaft in a bushing.'),
  joint('rigid', 'Fixed joint', Link2, 'Fastens one part to another: it moves with it.'),
  { id: 'motion.gear', label: 'Gear mesh', short: 'Gears', icon: Cog, category: 'Motion',
    description: 'Gear two turning joints by their tooth counts (external gears turn opposite ways, internal the same way). Joins an existing gear train.',
    run: () => openMotionTool('gear'), enabled: all(needsDesign, needsIdle, hasJoints) },
  { id: 'motion.rack', label: 'Rack and pinion', short: 'Rack', icon: Rows3, category: 'Motion',
    description: 'A turning pinion slides a rack: one turn moves it 2πr (r is the pitch radius).',
    run: () => openMotionTool('rack'), enabled: all(needsDesign, needsIdle, hasJoints) },
  { id: 'motion.belt', label: 'Belt or chain', short: 'Belt', icon: Waypoints, category: 'Motion',
    description: 'Two pulleys turn the same way, by the ratio of their diameters (crossed belts turn opposite ways).',
    run: () => openMotionTool('belt'), enabled: all(needsDesign, needsIdle, hasJoints) },
  { id: 'motion.couple', label: 'Coupling', short: 'Coupling', icon: Workflow, category: 'Motion',
    description: 'Any joints in fixed ratios: one input that moves them all (design.couple).',
    run: () => openMotionTool('couple'), enabled: all(needsDesign, needsIdle, hasJoints) },
  { id: 'motion.motor', label: 'Motor', short: 'Motor', icon: Gauge, category: 'Motion',
    description: 'Drive a joint or coupling: a speed, continuous or back and forth, with an optional collision check.',
    run: () => openMotionTool('motor', useMotion.getState().active && driveCall(useMotion.getState().active!) ? useMotion.getState().active! : undefined),
    enabled: all(needsDesign, needsIdle, hasJoints) },
  { id: 'motion.pose', label: 'Save pose', short: 'Pose', icon: Bookmark, category: 'Motion',
    description: 'Save where the mechanism is now as a named pose ("open", "closed"); animations move between poses.',
    run: () => openMotionTool('pose'), enabled: all(needsDesign, needsIdle, hasJoints) },
  { id: 'motion.animation', label: 'New animation', short: 'Animation', icon: Clapperboard, category: 'Motion',
    description: 'Keyframes between poses on a timeline: hold, smooth or linear moves, loop. Then scrub, play or export it.',
    run: () => openMotionTool('animation'), enabled: all(needsDesign, needsIdle, hasPoses) },
  { id: 'motion.explode', label: 'Explode steps', short: 'Explode', icon: Layers, category: 'Motion',
    description: 'A named exploded view saved in the design: pick parts, drag them apart step by step (or Automatic), then play it on the timeline like an animation. Display only.',
    run: () => openExplodeTool(), enabled: all(needsDesign, needsIdle, needsModel), active: (state) => state.tool === 'explodeSteps' },
  { id: 'motion.play', label: 'Play', short: 'Play', icon: Play, category: 'Motion',
    description: 'Play the timeline’s animation or explode (or the first motor); click again to pause.',
    run: () => { if (playing()) { useMotion.setState({ playing: null, playStart: null, clipStart: null }); return; } if (clipOf() || explodeOf()) toggleClip(); else togglePlay(); },
    enabled: all(needsDesign, hasMotion), active: () => playing() },
  { id: 'motion.pause', label: 'Pause motion', icon: Pause, category: 'Motion', description: 'Pause what is playing.',
    run: () => useMotion.setState({ playing: null, playStart: null, clipStart: null }), enabled: () => (playing() ? true : 'Nothing is playing.'), hidden: () => true },
  { id: 'motion.rest', label: 'Rest pose', short: 'Rest', icon: RotateCcw, category: 'Motion',
    description: 'Restore the assembled view and put every joint back where the code has it.', run: resetPose,
    enabled: all(needsDesign, () => hasJoints() === true || !!kinematics()?.explodes?.length || !!useMotion.getState().draft || 'Add a joint or an explode first.') },
  { id: 'motion.check', label: 'Collision check', short: 'Collisions', icon: Radar, category: 'Motion',
    description: 'Sweep the shown animation (or a motor) with exact solids at each build and mark where parts collide; click again to turn it off.',
    run: () => { void toggleCheck(); }, enabled: all(needsDesign, needsIdle, hasMotion),
    active: () => !!(clipOf()?.check ?? kinematics()?.drives.find((drive) => drive.joint === (useMotion.getState().active ?? kinematics()?.drives[0]?.joint))?.check) },
  { id: 'motion.exportGlb', label: 'Animated GLB', icon: Download, category: 'Motion',
    description: 'A glTF file with the motion baked in (the shown animation or explode, or one cycle of a motor), for viewers, slides and the web.',
    run: () => { void exportAnimatedGlb(); }, enabled: all(needsDesign, needsModel, hasMotion) },
  { id: 'motion.exportVideo', label: 'Video', icon: Video, category: 'Motion',
    description: 'An MP4 video of the animation or explode (or a motor cycle) as the view shows it, frame by frame: size, frame rate, holds, speed, plays and a turntable.',
    run: () => set({ dialog: 'video' }), enabled: all(needsDesign, needsModel, hasMotion) },
  { id: 'motion.exportSimulation', label: 'Simulation model (MuJoCo)', icon: Download, category: 'Motion',
    description: 'A zip for physics simulation: MJCF with links, joints and limits, exact masses and inertias from materials, a mesh per body, '
      + 'couplings and poses, a plain JSON inventory of the same tree, and a report checking it against the design.',
    run: () => { void exportSimulationModel(); }, enabled: all(needsDesign, needsIdle, needsModel, hasJoints) },
];

export const motionRibbon: RibbonGroup[] = [
  { title: 'Joints', priority: KEEP, items: ['motion.revolute', 'motion.slider', 'motion.cylindrical', 'motion.rigid'] },
  { title: 'Gears & links', priority: MID, items: ['motion.gear', 'motion.rack', 'motion.belt', 'motion.couple'] },
  { title: 'Drive', priority: HIGH, items: ['motion.motor', 'motion.pose'] },
  { title: 'Animate', priority: HIGH, items: ['motion.animation', 'motion.explode', 'motion.play', 'motion.rest', 'view.present'] },
  { title: 'Check', priority: MID, items: ['motion.check'] },
  { title: 'Export', items: [{ menu: 'motion-export', label: 'Export', icon: Film, items: ['motion.exportGlb', 'motion.exportVideo', 'motion.exportSimulation'] }] },
];
