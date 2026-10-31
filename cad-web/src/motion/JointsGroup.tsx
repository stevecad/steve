/**
 * The design's couplings, joints and animations in the model tree (select one to see and move it; right-click a joint for
 * its menu), and its explodes in a group of their own (ExplodesGroup). Grouping: motion/treeGroups.ts.
 */
import { Clapperboard, Cog, Layers, Workflow } from 'lucide-react';
import TreeRow from '@/shell/TreeRow';
import { BrowserGroup } from '@/shell/Browser';
import { get, set } from '@/state/store';
import { ItemMenu, RenameField, itemKeyDown, startRename, useEditing } from '@/workspaces/design/ItemMenu';
import styles from '@/shell/Browser.module.css';
import { JOINT_ICONS, JOINT_LABELS } from './MotionPanel';
import { selectClip, selectJoint, useMotion } from './state';
import { setDesignTab } from '@/state/designTab';
import { openMotionTool } from './motionTool';
import { openExplodeTool } from './explodeTool';
import { motionTreeGroups } from './treeGroups';
import { num } from '@/lib/format';

const NONE: never[] = [];

function inspectJoint(name: string, selected: boolean) {
  const { dockOpen, dockTab } = get();
  // An already selected joint can be hidden behind Source or another panel.
  // Clicking its row should reveal it; only an already visible inspector toggles off.
  selectJoint(selected && dockOpen && dockTab === 'properties' ? null : name);
  set({ selection: [], activeFeature: null, dockOpen: true, dockTab: 'properties' });
}

export default function JointsGroup() {
  const joints = useMotion((state) => state.kinematics?.joints ?? NONE);
  const couplings = useMotion((state) => state.kinematics?.couplings ?? NONE);
  const animations = useMotion((state) => state.kinematics?.animations ?? NONE);
  const groups = motionTreeGroups(useMotion((state) => state.kinematics));
  const active = useMotion((state) => state.active);
  const playing = useMotion((state) => state.playing);
  const clip = useMotion((state) => state.clip);
  const clipPlaying = useMotion((state) => !!state.clipStart);
  return (
    <BrowserGroup title="Joints" icon={<Workflow size={15} />} count={groups.joints} depth={1} defaultOpen
      item="group:joints" menu={<ItemMenu target={{ kind: 'group', group: 'joints' }} />}>
      {couplings.map((coupling) => (
        <TreeRow key={coupling.name} depth={2} icon={<Cog size={14} />} label={<span className={styles.mono}>{coupling.name}</span>}
          meta={playing === coupling.name ? 'playing' : `gears ${Object.keys(coupling.gears).length}`} testId={`coupling-${coupling.name}`} item={`coupling:${coupling.name}`}
          title={`Coupling ${coupling.name}: moves ${Object.keys(coupling.gears).join(', ')} in fixed ratios`} selected={active === coupling.name}
          menu={<ItemMenu target={{ kind: 'coupling', name: coupling.name }} />} onContextSelect={() => { selectJoint(coupling.name); set({ selection: [], activeFeature: null }); }}
          onClick={() => inspectJoint(coupling.name, active === coupling.name)} />
      ))}
      {joints.map((joint) => <JointRow key={joint.name} name={joint.name} type={joint.type} parent={joint.parent} child={joint.child} selected={active === joint.name} playing={playing === joint.name} />)}
      {animations.map((animation) => (
        <TreeRow key={animation.name} depth={2} icon={<Clapperboard size={14} />} label={<span className={styles.mono}>{animation.name}</span>}
          meta={clip === animation.name && clipPlaying ? 'playing' : `${animation.keys.length} keys · ${animation.duration}s`} testId={`animation-${animation.name}`} item={`animation:${animation.name}`}
          title={`Animation ${animation.name}: ${animation.keys.map((key) => key.pose ?? 'values').join(' → ')}`} selected={clip === animation.name}
          menu={<ItemMenu target={{ kind: 'animation', name: animation.name }} />} onContextSelect={() => selectClip(animation.name)}
          onClick={() => { setDesignTab('motion'); selectClip(animation.name); }} onDoubleClick={() => openMotionTool('animation', animation.name)} />
      ))}
      {groups.jointsHint && <p className={styles.emptyHint}>Connect two instances: Motion → Revolute or Slider. Joints move parts without changing geometry.</p>}
    </BrowserGroup>
  );
}

function JointRow({ name, type, parent, child, selected, playing }: { name: string; type: keyof typeof JOINT_ICONS; parent: string; child: string; selected: boolean; playing: boolean }) {
  const Icon = JOINT_ICONS[type];
  const target = { kind: 'joint' as const, name };
  const editing = useEditing(`joint:${name}`);
  return (
    <TreeRow depth={2} icon={<Icon size={14} />} label={<span className={styles.mono}>{name}</span>}
      meta={playing ? 'playing' : `${parent} → ${child}`.length > 16 ? `→ ${child}` : `${parent} → ${child}`}
      title={`${JOINT_LABELS[type]} joint ${name}: ${child} moves on ${parent}`} selected={selected} testId={`joint-${name}`} item={`joint:${name}`}
      menu={<ItemMenu target={target} />} editor={editing ? <RenameField editKey={editing} /> : undefined} onContextSelect={() => { selectJoint(name); set({ selection: [], activeFeature: null }); }}
      onClick={() => inspectJoint(name, selected)}
      onDoubleClick={() => startRename(target)} onKeyDown={(event) => itemKeyDown(event, target)} />
  );
}

/** The design's explodes (design.explode): select one to show it on the timeline, double-click to edit it. */
export function ExplodesGroup() {
  const kinematics = useMotion((state) => state.kinematics);
  const clip = useMotion((state) => state.clip);
  const clipPlaying = useMotion((state) => !!state.clipStart);
  if (!motionTreeGroups(kinematics).explodes) return null;
  const explodes = kinematics?.explodes ?? NONE;
  return (
    <BrowserGroup title="Explodes" icon={<Layers size={15} />} count={explodes.length} depth={1} defaultOpen
      item="group:explodes" menu={<ItemMenu target={{ kind: 'group', group: 'explodes' }} />}>
      {explodes.map((explode) => (
        <TreeRow key={explode.name} depth={2} icon={<Layers size={14} />} label={<span className={styles.mono}>{explode.name}</span>}
          meta={clip === explode.name && clipPlaying ? 'playing' : `${explode.steps.length} step${explode.steps.length === 1 ? '' : 's'} · ${num(explode.duration, 2)} s`}
          testId={`explode-${explode.name}`} item={`explode:${explode.name}`}
          title={`Explode ${explode.name}: ${explode.steps.length} steps, ${explode.duration} s${explode.auto ? ', automatic' : ''}`} selected={clip === explode.name}
          menu={<ItemMenu target={{ kind: 'explode', name: explode.name }} />} onContextSelect={() => selectClip(explode.name)}
          onClick={() => { setDesignTab('motion'); selectClip(explode.name); set({ selection: [], activeFeature: null, dockOpen: true, dockTab: 'properties' }); }}
          onDoubleClick={() => openExplodeTool(explode.name)} />
      ))}
    </BrowserGroup>
  );
}
