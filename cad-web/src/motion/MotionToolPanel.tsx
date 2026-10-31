/**
 * The Motion tab's panel for gears and links, motors, poses and animations (the Joint tool has its own).
 * Every field is what the code says; OK writes `design.couple/drive/pose/animation(…)` into main.py.
 */
import { ArrowDown, ArrowUp, Cog, Crosshair, Film, Gauge, Plus, Trash2, Bookmark } from 'lucide-react';
import { Button, IconButton, NumberField, Segmented, Select, Switch } from '@/ui';
import { Panel } from '@/viewport/CommandPanels';
import ToolFooter from '@/shell/ToolFooter';
import styles from '@/viewport/Viewport.module.css';
import { num } from '@/lib/format';
import { poseNames } from './code';
import { couplingUnit, dofKey, unitOf, type Kinematics } from './kinematics';
import {
  closeMotionTool, commitMotionTool, linkPlan, linkRatio, motorCanSpin, removeEdited, setMotorTarget, toolProblem, trainFor, updateTool, useMotionTool,
  type LinkMode, type MotionTool,
} from './motionTool';
import { useMotion } from './state';
import motionStyles from './Motion.module.css';

const LINKS: { value: LinkMode; label: string; title: string }[] = [
  { value: 'gear', label: 'Gear mesh', title: 'Two gears in mesh: the driven one turns by the tooth ratio' },
  { value: 'rack', label: 'Rack', title: 'Rack and pinion: a turning pinion slides a rack' },
  { value: 'belt', label: 'Belt', title: 'Belt or chain: pulleys turn the same way, by their diameters' },
  { value: 'couple', label: 'Custom', title: 'Any joints in fixed ratios' },
];

const TITLES = { gear: 'Gears & links', rack: 'Gears & links', belt: 'Gears & links', couple: 'Gears & links', motor: 'Motor', pose: 'Pose', animation: 'Animation' } as const;
const ICONS = { gear: Cog, rack: Cog, belt: Cog, couple: Cog, motor: Gauge, pose: Bookmark, animation: Film } as const;

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <div className={styles.panelRow} title={hint}><span className={styles.panelLabel}>{label}</span>{children}</div>;
}

function JointSlot({ slot, label, joints }: { slot: 'driver' | 'driven'; label: string; joints: { value: string; label: string; hint?: string }[] }) {
  const value = useMotionTool((s) => s[slot]);
  const active = useMotionTool((s) => s.slot === slot);
  return (
    <div className={styles.panelRow} data-slot={slot} data-picking={active || undefined}>
      <span className={styles.panelLabel}>{label}</span>
      <div className={motionStyles.slot}>
        <Select ariaLabel={label} value={value} options={value ? joints : [{ value: '', label: 'Pick a part…' }, ...joints]}
          onOpenChange={(open) => { if (open) updateTool({ slot: null }); }}
          onChange={(next) => {
            const draft = { ...useMotionTool.getState(), [slot]: next };
            // Chosen from the list: stop waiting for a click (or wait for the other one if it's still empty).
            updateTool({ [slot]: next, extend: trainFor(useMotion.getState().kinematics, draft), slot: draft.driver && draft.driven ? null : slot === 'driver' ? 'driven' : 'driver' });
          }} />
        <button type="button" className={motionStyles.pickButton} data-active={active || undefined} aria-pressed={active} aria-label={`Pick ${label.toLowerCase()}`}
          title={active ? 'Click a moving part in the viewport' : `Pick the ${label.toLowerCase()} by clicking its part`}
          onClick={() => updateTool({ slot: active ? null : slot })}>
          <Crosshair size={13} />
        </button>
      </div>
    </div>
  );
}

function jointOptions(kinematics: Kinematics | null, filter: (type: string) => boolean) {
  return (kinematics?.joints ?? []).filter((joint) => joint.type !== 'rigid' && filter(joint.type))
    .map((joint) => ({ value: joint.name, label: joint.name, hint: `${joint.type} · ${joint.child}` }));
}

function Links({ draft, kinematics }: { draft: MotionTool; kinematics: Kinematics | null }) {
  const turning = jointOptions(kinematics, (type) => type === 'revolute' || type === 'cylindrical');
  const sliding = jointOptions(kinematics, (type) => type === 'slider' || type === 'cylindrical');
  const plan = linkPlan(draft, kinematics);
  const ratio = linkRatio(draft);
  const coupling = draft.extend ? kinematics?.couplings?.find((item) => item.name === draft.extend) : undefined;
  return (
    <>
      {!draft.editing && <Segmented value={draft.mode as LinkMode} onChange={(mode) => updateTool({ mode, extend: trainFor(kinematics, { ...draft, mode }) })}
        options={LINKS.map((link) => ({ value: link.value, label: <span data-link-mode={link.value}>{link.label}</span>, title: link.title }))} />}
      {draft.mode !== 'couple' && (
        <>
          <JointSlot slot="driver" label={draft.mode === 'rack' ? 'Pinion' : 'Driver'} joints={turning} />
          <JointSlot slot="driven" label={draft.mode === 'rack' ? 'Rack' : 'Driven'} joints={draft.mode === 'rack' ? sliding : turning} />
        </>
      )}
      {draft.mode === 'gear' && (
        <>
          <Row label="Set by"><Segmented size="sm" value={draft.byRatio ? 'ratio' : 'teeth'} onChange={(by) => updateTool({ byRatio: by === 'ratio', ratio: ratio ?? draft.ratio })}
            options={[{ value: 'teeth', label: 'Teeth' }, { value: 'ratio', label: 'Ratio' }]} /></Row>
          {draft.byRatio ? (
            <Row label="Ratio" hint="How far the driven gear turns per degree of the driver; negative turns the other way.">
              <div style={{ width: 118 }}><NumberField value={draft.ratio} unit="×" step={0.05} ariaLabel="Gear ratio" onChange={(value) => updateTool({ ratio: value })} /></div>
            </Row>
          ) : (
            <>
              <Row label="Teeth">
                <div className={motionStyles.limitFields}>
                  <NumberField value={draft.teeth[0]} unit="z" step={1} min={1} ariaLabel="Driver teeth" onChange={(value) => updateTool({ teeth: [Math.round(value), draft.teeth[1]] })} />
                  <NumberField value={draft.teeth[1]} unit="z" step={1} min={1} ariaLabel="Driven teeth" onChange={(value) => updateTool({ teeth: [draft.teeth[0], Math.round(value)] })} />
                </div>
              </Row>
              <Row label="Mesh"><Segmented size="sm" value={draft.internal ? 'internal' : 'external'} onChange={(mesh) => updateTool({ internal: mesh === 'internal' })}
                options={[{ value: 'external', label: 'External', title: 'Spur gears side by side: they turn opposite ways' }, { value: 'internal', label: 'Internal', title: 'A gear inside a ring gear: they turn the same way' }]} /></Row>
            </>
          )}
        </>
      )}
      {draft.mode === 'rack' && (
        <>
          <Row label="Pitch radius" hint="The pinion's pitch radius: one turn moves the rack 2πr.">
            <div style={{ width: 118 }}><NumberField value={draft.pitchRadius} unit="mm" step={0.5} min={0.1} ariaLabel="Pitch radius" onChange={(value) => updateTool({ pitchRadius: value })} /></div>
          </Row>
          <Row label="Reverse"><Switch label="Reverse rack direction" checked={draft.reverse} onCheckedChange={(reverse) => updateTool({ reverse })} /></Row>
        </>
      )}
      {draft.mode === 'belt' && (
        <>
          <Row label="Diameters">
            <div className={motionStyles.limitFields}>
              <NumberField value={draft.diameters[0]} unit="mm" step={1} min={0.1} ariaLabel="Driver pulley diameter" onChange={(value) => updateTool({ diameters: [value, draft.diameters[1]] })} />
              <NumberField value={draft.diameters[1]} unit="mm" step={1} min={0.1} ariaLabel="Driven pulley diameter" onChange={(value) => updateTool({ diameters: [draft.diameters[0], value] })} />
            </div>
          </Row>
          <Row label="Crossed belt"><Switch label="Crossed belt" checked={draft.reverse} onCheckedChange={(reverse) => updateTool({ reverse })} /></Row>
        </>
      )}
      {draft.mode === 'couple' && <CouplingRows draft={draft} kinematics={kinematics} />}
      {draft.mode === 'couple' && (
        <Row label="Joints only follow" hint="Its joints move only through couplings (follow=True): set them with the couplings, never on their own, as in a mixer.">
          <Switch label="Joints only follow" checked={draft.follow} onCheckedChange={(follow) => updateTool({ follow })} />
        </Row>
      )}
      {draft.mode !== 'couple' && trainFor(kinematics, draft) && (
        <Row label={`Add to ${trainFor(kinematics, draft)}`} hint="Join the existing gear train, so one input turns all of it">
          <Switch label="Add to gear train" checked={!!coupling} onCheckedChange={(on) => updateTool({ extend: on ? trainFor(kinematics, draft) : null })} />
        </Row>
      )}
      {(draft.mode === 'couple' || !coupling) && (
        <Row label="Name"><input className={motionStyles.nameInput} aria-label="Coupling name" value={draft.name} spellCheck={false}
          onChange={(event) => updateTool({ name: event.target.value.trim() })} /></Row>
      )}
      {typeof plan !== 'string' && <div className={motionStyles.ratioReadout} data-link-summary>{plan.summary}</div>}
    </>
  );
}

function CouplingRows({ draft, kinematics }: { draft: MotionTool; kinematics: Kinematics | null }) {
  const keys = (kinematics?.joints ?? []).filter((joint) => joint.type !== 'rigid').flatMap((joint) => joint.type === 'cylindrical'
    ? [dofKey(joint, 'turn'), dofKey(joint, 'travel')] : [joint.name]);
  const options = keys.map((key) => ({ value: key, label: key }));
  return (
    <div className={motionStyles.keyRows} data-coupling-rows>
      {draft.rows.map((row, index) => (
        <div key={index} className={motionStyles.keyRow}>
          <Select ariaLabel={`Coupled joint ${index + 1}`} value={row.key} options={row.key ? options : [{ value: '', label: 'Joint…' }, ...options]}
            onChange={(key) => updateTool({ rows: draft.rows.map((item, i) => (i === index ? { ...item, key } : item)) })} />
          <div style={{ width: 98 }}><NumberField value={row.ratio} unit="×" step={0.05} ariaLabel={`Ratio ${index + 1}`}
            onChange={(ratio) => updateTool({ rows: draft.rows.map((item, i) => (i === index ? { ...item, ratio } : item)) })} /></div>
          <IconButton small label="Remove" onClick={() => updateTool({ rows: draft.rows.filter((_, i) => i !== index) })}><Trash2 size={13} /></IconButton>
        </div>
      ))}
      <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => updateTool({ rows: [...draft.rows, { key: '', ratio: 1 }] })}>Add joint</Button>
    </div>
  );
}

function Motor({ draft, kinematics }: { draft: MotionTool; kinematics: Kinematics | null }) {
  const joint = kinematics?.joints.find((item) => item.name === draft.target);
  const coupling = kinematics?.couplings?.find((item) => item.name === draft.target);
  const unit = joint ? unitOf(joint) : coupling && kinematics ? couplingUnit(kinematics, coupling) : '°';
  const options = [
    ...(kinematics?.couplings ?? []).map((coupling) => ({ value: coupling.name, label: coupling.name, hint: 'coupling' })),
    // A follower is moved by its couplings, never driven itself.
    ...jointOptions(kinematics, () => true).filter((option) => !kinematics?.joints.find((joint) => joint.name === option.value)?.follows),
  ];
  const spin = motorCanSpin(draft);
  return (
    <>
      <Row label="Drives">{draft.editing ? <span className={motionStyles.fixedValue}>{draft.target}</span>
        : <Select ariaLabel="Motor target" value={draft.target} options={options} onChange={setMotorTarget} />}</Row>
      <Row label="Speed"><div style={{ width: 118 }}><NumberField value={draft.speed} unit={`${unit}/s`} step={unit === 'mm' ? 5 : 15} min={0.01}
        ariaLabel="Motor speed" onChange={(speed) => updateTool({ speed: Math.abs(speed) })} /></div></Row>
      <Row label="Direction"><Segmented size="sm" value={draft.direction === 1 ? 'forward' : 'reverse'} onChange={(value) => updateTool({ direction: value === 'forward' ? 1 : -1 })}
        options={[{ value: 'forward', label: 'Forward', title: 'Positive about the joint axis (right-handed)' }, { value: 'reverse', label: 'Reverse' }]} /></Row>
      <Row label="Motion">
        <Segmented size="sm" value={draft.continuous && spin ? 'spin' : 'sweep'} onChange={(value) => updateTool({ continuous: value === 'spin' })}
          options={[{ value: 'spin', label: 'Continuous', disabled: !spin, title: spin ? 'Turns on and on' : 'Only a turning joint without limits turns continuously' },
            { value: 'sweep', label: 'Back & forth', title: 'Sweeps the range and back' }]} />
      </Row>
      {!(draft.continuous && spin) && (
        <Row label="Range">
          <div className={motionStyles.limitFields}>
            <NumberField value={draft.range[0]} unit={unit} ariaLabel="Motor range min" onChange={(value) => updateTool({ range: [value, draft.range[1]] })} />
            <NumberField value={draft.range[1]} unit={unit} ariaLabel="Motor range max" onChange={(value) => updateTool({ range: [draft.range[0], value] })} />
          </div>
        </Row>
      )}
      <Row label="Check collisions" hint="At each build, sweeps the motion with exact solids and reports what collides, and where.">
        <Switch label="Check collisions" checked={draft.check} onCheckedChange={(check) => updateTool({ check })} />
      </Row>
    </>
  );
}

function PoseFields({ draft }: { draft: MotionTool }) {
  return (
    <>
      <Row label="Name"><input className={motionStyles.nameInput} aria-label="Pose name" value={draft.name} spellCheck={false} onChange={(event) => updateTool({ name: event.target.value })} /></Row>
      <div className={styles.panelHint}>Saves where the mechanism is now. Move it with the sliders or by dragging parts, then save.</div>
      <div className={motionStyles.keyRows} data-pose-values>
        {Object.entries(draft.values).map(([key, value]) => (
          <div key={key} className={motionStyles.keyRow}>
            <span className={motionStyles.switchCell}><Switch label={`Include ${key}`} checked={!!draft.include[key]} onCheckedChange={(on) => updateTool({ include: { ...draft.include, [key]: on } })} /></span>
            <span className={motionStyles.keyName}>{key}</span>
            <div style={{ width: 98 }}><NumberField value={value} unit="" step={1} ariaLabel={`${key} in pose`} disabled={!draft.include[key]}
              onChange={(next) => updateTool({ values: { ...draft.values, [key]: next } })} /></div>
          </div>
        ))}
      </div>
    </>
  );
}

function AnimationFields({ draft }: { draft: MotionTool }) {
  const poses = poseNames();
  const options = poses.map((pose) => ({ value: pose, label: pose }));
  const move = (index: number, by: -1 | 1) => {
    const keys = [...draft.keys];
    const other = index + by;
    if (other < 0 || other >= keys.length) return;
    // Swap the poses, keep the times: keys stay in time order.
    [keys[index], keys[other]] = [{ ...keys[other], time: keys[index].time }, { ...keys[index], time: keys[other].time }];
    updateTool({ keys });
  };
  return (
    <>
      <Row label="Name"><input className={motionStyles.nameInput} aria-label="Animation name" value={draft.name} spellCheck={false} onChange={(event) => updateTool({ name: event.target.value.trim() })} /></Row>
      <div className={motionStyles.keyRows} data-animation-keys>
        {draft.keys.map((key, index) => (
          <div key={index} className={motionStyles.keyRow} data-key-row={index}>
            {typeof key.pose === 'string'
              ? <Select ariaLabel={`Key ${index + 1} pose`} value={key.pose} options={options} onChange={(pose) => updateTool({ keys: draft.keys.map((item, i) => (i === index ? { ...item, pose } : item)) })} />
              : <span className={motionStyles.keyName} title={JSON.stringify(key.pose)}>values</span>}
            <div style={{ width: 86 }}><NumberField value={key.time} unit="s" step={0.25} min={0} ariaLabel={`Key ${index + 1} time`}
              onChange={(time) => updateTool({ keys: draft.keys.map((item, i) => (i === index ? { ...item, time } : item)) })} /></div>
            <IconButton small label="Earlier" onClick={() => move(index, -1)} disabled={!index}><ArrowUp size={12} /></IconButton>
            <IconButton small label="Later" onClick={() => move(index, 1)} disabled={index === draft.keys.length - 1}><ArrowDown size={12} /></IconButton>
            <IconButton small label="Remove key" onClick={() => updateTool({ keys: draft.keys.filter((_, i) => i !== index) })} disabled={draft.keys.length <= 2}><Trash2 size={13} /></IconButton>
          </div>
        ))}
        <Button size="sm" variant="ghost" icon={<Plus />} id="animation-add-key"
          onClick={() => { const last = draft.keys[draft.keys.length - 1]; updateTool({ keys: [...draft.keys, { pose: poses[0] ?? '', time: Number(((last?.time ?? 0) + 1).toFixed(2)) }] }); }}>Add key</Button>
      </div>
      <Row label="Easing"><Segmented size="sm" value={draft.easing} onChange={(easing) => updateTool({ easing })}
        options={[{ value: 'ease', label: 'Smooth', title: 'Each move starts and stops gently' }, { value: 'linear', label: 'Linear', title: 'Constant speed between keys' }]} /></Row>
      <Row label="Loop"><Switch label="Loop" checked={draft.loop} onCheckedChange={(loop) => updateTool({ loop })} /></Row>
      <Row label="Check collisions" hint="At each build, sweeps the animation with exact solids and marks clashes on the timeline.">
        <Switch label="Check collisions" checked={draft.check} onCheckedChange={(check) => updateTool({ check })} />
      </Row>
      <div className={styles.panelHint}>{`Length ${num(draft.keys[draft.keys.length - 1]?.time ?? 0)} s · a pose twice in a row holds it.`}</div>
    </>
  );
}

const OK_LABEL = { gear: 'Add gears', rack: 'Add rack', belt: 'Add belt', couple: 'Save coupling', motor: 'Save motor', pose: 'Save pose', animation: 'Save animation' } as const;

export default function MotionToolPanel() {
  const draft = useMotionTool();
  const kinematics = useMotion((state) => state.kinematics);
  const problem = draft.error ?? (draft.slot ? null : toolProblem(draft));
  const Icon = ICONS[draft.mode];
  const editing = draft.editing && (draft.mode === 'couple' || draft.mode === 'motor' || draft.mode === 'pose' || draft.mode === 'animation');
  const title = editing ? `Edit ${draft.editing}` : TITLES[draft.mode];
  return (
    <Panel id="motion-tool" icon={<Icon size={16} />} title={title} onClose={closeMotionTool}
      footer={<ToolFooter onCancel={closeMotionTool} onOk={() => { void commitMotionTool(); }} okId="motion-tool-ok" okTitle={OK_LABEL[draft.mode]} okDisabled={toolProblem(draft)}
        extra={editing && draft.mode !== 'couple' && <Button size="sm" variant="ghost" icon={<Trash2 />} id="motion-tool-remove" onClick={() => { void removeEdited(); }}>Remove</Button>} />}>
      <div data-motion-mode={draft.mode}>
        {(draft.mode === 'gear' || draft.mode === 'rack' || draft.mode === 'belt' || draft.mode === 'couple') && <Links draft={draft} kinematics={kinematics} />}
        {draft.mode === 'motor' && <Motor draft={draft} kinematics={kinematics} />}
        {draft.mode === 'pose' && <PoseFields draft={draft} />}
        {draft.mode === 'animation' && <AnimationFields draft={draft} />}
      </div>
      <div className={styles.panelHint} data-tone={problem ? 'warning' : undefined} data-motion-hint>
        {draft.slot ? `Click the part the ${draft.slot === 'driver' ? (draft.mode === 'rack' ? 'pinion' : 'driving joint') : (draft.mode === 'rack' ? 'rack' : 'driven joint')} moves.`
          : problem ?? (draft.mode === 'motor' ? `Writes design.drive("${draft.target}", …) into main.py.` : draft.mode === 'pose' ? `Writes design.pose("${draft.name}", …).`
            : draft.mode === 'animation' ? `Writes design.animation("${draft.name}", …).` : 'Writes design.couple(…) into main.py.')}
      </div>
    </Panel>
  );
}
