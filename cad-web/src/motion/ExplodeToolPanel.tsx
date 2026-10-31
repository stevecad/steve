/**
 * The Explode steps tool's panel (Dock): the explode's name, its steps in order (parts, move, timing), Automatic, loop.
 * Picks happen on the canvas (click parts into the active step, drag its arrows); values are edited here. OK writes
 * `design.explode(...)` into main.py and rebuilds.
 */
import { ArrowDown, ArrowUp, Layers, Pause, Play, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { Button, IconButton, NumberField, Segmented, Switch } from '@/ui';
import { Panel } from '@/viewport/CommandPanels';
import ToolFooter from '@/shell/ToolFooter';
import styles from '@/viewport/Viewport.module.css';
import { num } from '@/lib/format';
import { EXPLODE_DURATION, EXPLODE_HOLD } from './code';
import {
  activateStep, addSelectionToStep, addStep, closeExplodeTool, commitExplodeTool, deleteExplode, explodeProblem, generateAutomatic, moveStep, removeStep,
  setStepMove, setStepTiming, stepMove, togglePart, uniform, updateExplodeTool, useExplodeTool, writeOutSteps, type DraftStep,
} from './explodeTool';
import { pauseClip, playClip, useMotion } from './state';
import motionStyles from './Motion.module.css';

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <div className={styles.panelRow} title={hint}><span className={styles.panelLabel}>{label}</span>{children}</div>;
}

/** "↑ 30 mm", "→ 12 mm", or "each its own way". */
function moveLabel(step: DraftStep): string {
  if (step.out !== undefined) return `out ${step.out === true ? 'along axes' : `${num(step.out)} mm`}`;
  if (!uniform(step)) return 'each its own way';
  const [x, y, z] = stepMove(step);
  return `${num(Math.hypot(x, y, z))} mm`;
}

function StepRow({ step, index, count, active, auto }: { step: DraftStep; index: number; count: number; active: boolean; auto: boolean }) {
  const parts = Object.keys(step.moves);
  const move = stepMove(step);
  return (
    <div className={motionStyles.explodeStep} data-active={active || undefined} data-explode-step={index}>
      <div className={motionStyles.explodeStepHead} onClick={() => activateStep(active ? null : index)} role="button" tabIndex={0}
        onKeyDown={(event) => { if (event.key === 'Enter') activateStep(active ? null : index); }}>
        <b>{index + 1}</b>
        <span title={parts.join(', ')}>{step.name ?? (parts.length ? parts.join(', ') : 'no parts yet')}</span>
        <em>{parts.length ? moveLabel(step) : ''}</em>
        {!auto && (
          <>
            <IconButton small label="Earlier" disabled={!index} onClick={(event) => { event.stopPropagation(); moveStep(index, -1); }}><ArrowUp size={12} /></IconButton>
            <IconButton small label="Later" disabled={index === count - 1} onClick={(event) => { event.stopPropagation(); moveStep(index, 1); }}><ArrowDown size={12} /></IconButton>
            <IconButton small label="Remove step" onClick={(event) => { event.stopPropagation(); removeStep(index); }}><Trash2 size={13} /></IconButton>
          </>
        )}
      </div>
      {active && !auto && (
        <>
          <div className={motionStyles.explodeParts} data-explode-parts>
            {parts.map((part) => (
              <span key={part} className={motionStyles.explodePart}>{part}
                <button type="button" aria-label={`Take ${part} out of the step`} onClick={() => togglePart(index, part)}><X size={10} /></button>
              </span>
            ))}
            <Button size="sm" variant="ghost" icon={<Plus />} id="explode-add-selection" onClick={() => addSelectionToStep(index)}>Add selected</Button>
          </div>
          <div className={motionStyles.moveFields} data-explode-move>
            {(['X', 'Y', 'Z'] as const).map((axis, k) => (
              <NumberField key={axis} value={uniform(step) ? move[k] : 0} prefix={axis} prefixColor={['var(--axis-x, #e5484d)', 'var(--axis-y, #30a46c)', 'var(--axis-z, #3e63dd)'][k]}
                step={1} ariaLabel={`Move ${axis}`} disabled={!parts.length}
                onChange={(value) => setStepMove(index, move.map((v, i) => (i === k ? value : uniform(step) ? v : 0)) as [number, number, number])} />
            ))}
          </div>
          <div className={motionStyles.timingFields}>
            <NumberField value={step.duration ?? EXPLODE_DURATION} unit="s" step={0.25} min={0.05} ariaLabel="Step duration" onChange={(duration) => setStepTiming(index, { duration })} />
            <NumberField value={step.hold ?? EXPLODE_HOLD} unit="s hold" step={0.25} min={0} ariaLabel="Step hold" onChange={(hold) => setStepTiming(index, { hold })} />
          </div>
        </>
      )}
    </div>
  );
}

export default function ExplodeToolPanel() {
  const draft = useExplodeTool();
  const playing = useMotion((state) => !!state.clipStart && state.clip === (draft.name || 'explode'));
  const problem = draft.error ?? explodeProblem(draft);
  const length = draft.steps.reduce((sum, step) => sum + (step.duration ?? draft.duration) + (step.hold ?? draft.hold), 0);
  return (
    <Panel id="explode-steps" icon={<Layers size={16} />} title={draft.editing ? `Edit ${draft.editing}` : 'Explode steps'} onClose={closeExplodeTool}
      footer={<ToolFooter onCancel={closeExplodeTool} onOk={() => { void commitExplodeTool(); }} okId="explode-ok" okTitle="Save explode" okDisabled={explodeProblem(draft)}
        extra={draft.editing && <Button size="sm" variant="ghost" icon={<Trash2 />} id="explode-delete" onClick={() => { void deleteExplode(); }}>Delete</Button>} />}>
      <Row label="Name"><input className={motionStyles.nameInput} aria-label="Explode name" value={draft.name} spellCheck={false}
        onChange={(event) => updateExplodeTool({ name: event.target.value.trim() })} /></Row>
      <Segmented value={draft.auto ? 'auto' : 'steps'} onChange={(mode) => (mode === 'auto' ? void generateAutomatic() : writeOutSteps())}
        options={[{ value: 'steps', label: 'Steps', title: 'Your own steps: pick parts, drag them apart' },
          { value: 'auto', label: <span id="explode-auto"><Sparkles size={12} /> Automatic</span>, title: 'Worked out from the geometry at each build: the reverse of the assembly steps, screws first' }]} />
      {draft.auto && (
        <div className={styles.panelHint} data-explode-auto>
          Worked out at each build: the reverse of the assembly steps (or layer by layer), screws first along their axes, each part out the way it’s free to go.
          {' '}<button type="button" className={motionStyles.checkJump} onClick={writeOutSteps} id="explode-write-steps">Edit as steps</button>
        </div>
      )}
      <div className={motionStyles.explodeSteps} data-explode-steps>
        {draft.steps.map((step, index) => <StepRow key={step.key} step={step} index={index} count={draft.steps.length} active={draft.active === index} auto={draft.auto} />)}
      </div>
      {!draft.auto && <Button size="sm" variant="ghost" icon={<Plus />} id="explode-add-step" onClick={addStep}>Add step</Button>}
      <Row label="Loop"><Switch label="Loop" checked={draft.loop} onCheckedChange={(loop) => updateExplodeTool({ loop })} /></Row>
      <Row label={`Preview · ${num(length, 2)} s`}>
        <IconButton small label={playing ? 'Pause' : 'Play the explode'} id="explode-play" active={playing} disabled={!draft.steps.length}
          onClick={() => (playing ? pauseClip() : playClip(draft.name || 'explode'))}>{playing ? <Pause size={13} /> : <Play size={13} />}</IconButton>
      </Row>
      <div className={styles.panelHint} data-tone={problem ? 'warning' : undefined} data-explode-hint>
        {problem ?? (draft.active !== null && !draft.auto
          ? 'Click parts to add them to this step (Alt-click: a part inside a linked design); drag the arrows or type the move. Shift snaps to 10 mm.'
          : `Writes design.explode("${draft.name}", …) into main.py. Display only: placements, the STEP export and the BOM don’t change.`)}
      </div>
    </Panel>
  );
}
