/**
 * Manufacture tree (CAM): the part's programs, their setups, each with its operations in the order they run and each
 * operation's state. Click selects (the Inspector shows it, the ribbon acts on it), double-click edits, right-click has
 * everything else: edit, rename, duplicate, move, delete (with what depends on it carried on), generate, simulate and
 * post. On the selected row: Delete deletes, F2 renames, Ctrl/Cmd+D duplicates. Every change is one new revision of the
 * program (a CAM program's code, or a program's source) and every destructive one offers Undo. A program row shows only
 * when the part has several; the Setups group's menu has the program's own actions. 3D-print (FFF) programs stay in
 * the backend but aren't part of this workspace.
 */
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Copy, CornerDownRight, Factory, Pencil, PenLine, Plus, Trash2 } from 'lucide-react';
import { SetupIcon } from '@/icons/cad';
import { Button, Dialog } from '@/ui';
import TreeRow from '@/shell/TreeRow';
import { BrowserGroup } from '@/shell/Browser';
import { useApp } from '@/state/store';
import { modKey } from '@/lib/format';
import { MenuLines, commandEntry, type Line } from '@/workspaces/design/ItemMenu';
import type { JobRecord, ProgramRecord } from './api';
import { programProcess, useMfg } from './state';
import { OpIcon, StatusPill } from './cam/ProgramView';
import { operationJob, useCamRunJobs } from './cam/CamProgram';
import { editableKind, kindOf, OP_LABEL, opsOfSetup, type OpKind } from './cam/program';
import {
  addSetup, capable, deleteOperationChecked, deleteProgram, deleteSetupConfirmed, duplicateOperationOf, duplicateProgram, duplicateSetupOf, editOperation, editSetup, moveOperationOf,
  moveOperationTo, newOperationTool, newProgram, newSetupTool, rename, renameOperationOf, selectOperation, selectSetup, useCam, useTreeConfirm,
} from './cam/state';
import styles from '@/shell/Browser.module.css';
import field from '@/workspaces/design/ItemMenu.module.css';

const I = { size: 15 };
const ADD: OpKind[] = ['face', 'rough', 'contour', 'pocket', 'rest', 'slot', 'bore', 'peck_drill', 'engrave', 'chamfer', 'parallel', 'waterline'];
const addLabel = (kind: OpKind) => `Add ${kind === 'peck_drill' ? 'drilling' : OP_LABEL[kind].replace('2D ', '').toLowerCase()}`;

type Op = { id: string; name?: string; setup?: string; strategy?: Record<string, unknown> };
type Renaming = { program: string; setup?: string; op?: string } | null;

function setupMenu(program: ProgramRecord, setupId: string, onRename: () => void): Line[] {
  const select = () => selectSetup(program.id, setupId);
  const mine = opsOfSetup(program.compiled, setupId);
  return [
    { label: 'Edit setup', icon: <Pencil {...I} />, run: () => editSetup(program, setupId) },
    { label: 'Rename', icon: <PenLine {...I} />, shortcut: 'F2', run: onRename },
    { label: 'Duplicate setup', icon: <Copy {...I} />, shortcut: `${modKey}+D`, run: () => duplicateSetupOf(program, setupId) },
    'sep',
    // Only what the engine runs (nothing shows that can't be used); rest machining follows an operation already there.
    ...ADD.filter((kind) => capable(kind) === true && (kind !== 'rest' || mine.length > 0))
      .map((kind): Line => ({ label: addLabel(kind), icon: <Plus {...I} />, run: () => newOperationTool(program, setupId, kind) })),
    'sep',
    commandEntry('cam.generate', 'Generate this setup', select),
    commandEntry('cam.simulate', 'Simulate this setup', select),
    commandEntry('cam.post', 'Post this setup (download)', select),
    'sep',
    { label: 'New setup (turn the part over)', icon: <SetupIcon {...I} />, reason: mine.length ? null : 'Add an operation first: the next setup machines the stock this one leaves.', run: () => addSetup(program) },
    { label: 'Delete setup', icon: <Trash2 {...I} />, danger: true, shortcut: 'Del', run: () => deleteSetupConfirmed(program, setupId) },
  ];
}

function operationMenu(program: ProgramRecord, operation: string, onRename: () => void): Line[] {
  const select = () => selectOperation(program.id, operation);
  const ops = program.compiled.operations as Op[];
  const op = ops.find((item) => item.id === operation)!;
  const setupId = op.setup ?? 'setup';
  // Up and down within the operation's setup (setups keep their order).
  const mine = ops.filter((item) => (item.setup ?? 'setup') === setupId).map((item) => item.id), at = mine.indexOf(operation);
  const others = (program.compiled.setups as { id?: string; name?: string }[]).filter((setup) => String(setup.id) !== setupId);
  return [
    { label: editableKind(op as Record<string, unknown>) ? `Edit ${OP_LABEL[kindOf(op as Record<string, unknown>)].replace('2D ', '').toLowerCase()}` : 'Edit', icon: <Pencil {...I} />, run: () => editOperation(program, operation) },
    { label: 'Rename', icon: <PenLine {...I} />, shortcut: 'F2', run: onRename },
    { label: 'Duplicate', icon: <Copy {...I} />, shortcut: `${modKey}+D`, run: () => duplicateOperationOf(program, operation) },
    'sep',
    { label: 'Move up', icon: <ArrowUp {...I} />, reason: at === 0 ? 'It runs first in its setup.' : null, run: () => moveOperationOf(program, operation, -1) },
    { label: 'Move down', icon: <ArrowDown {...I} />, reason: at === mine.length - 1 ? 'It runs last in its setup.' : null, run: () => moveOperationOf(program, operation, 1) },
    // Into another setup of the program, at its end (a submenu of the setups; none when there's only this one).
    { label: 'Move to setup', icon: <CornerDownRight {...I} />, id: 'cam-move-to-setup',
      items: others.map((setup) => ({ label: String(setup.name ?? setup.id), icon: <SetupIcon {...I} />, run: () => moveOperationTo(program, operation, String(setup.id)) })) },
    'sep',
    commandEntry('cam.generate', undefined, select),
    commandEntry('cam.simulate', undefined, select),
    commandEntry('cam.post', 'Post process (download)', select),
    'sep',
    { label: 'Delete', icon: <Trash2 {...I} />, danger: true, shortcut: 'Del', run: () => deleteOperationChecked(program, operation) },
  ];
}

function programMenu(program: ProgramRecord | null, onRename: () => void): Line[] {
  return [
    ...(program ? [
      { label: 'Rename program', icon: <PenLine {...I} />, run: onRename },
      { label: 'Duplicate program', icon: <Copy {...I} />, run: () => void duplicateProgram(program) },
      { label: 'Delete program', icon: <Trash2 {...I} />, danger: true, run: () => void deleteProgram(program) },
      'sep' as const,
    ] : []),
    { label: 'New setup', icon: <SetupIcon {...I} />, run: () => void newSetupTool() },
    { label: 'New program', icon: <Plus {...I} />, run: () => void newProgram() },
  ];
}

/** A name edited in place (Enter saves, Esc or leaving keeps the old one). */
function NameEditor({ value, onDone }: { value: string; onDone: (name: string | null) => void }) {
  const [name, setName] = useState(value);
  return (
    <span className={field.field} data-place="tree"><input className={field.input} autoFocus spellCheck={false} autoComplete="off" value={name} aria-label="Name" onChange={(event) => setName(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') onDone(name.trim() && name.trim() !== value ? name.trim() : null);
        if (event.key === 'Escape') onDone(null);
      }} onBlur={() => onDone(null)} onFocus={(event) => event.target.select()} /></span>
  );
}

/** A program's operations' jobs as their cards read them (a CAM program's are its last run's), once per program. */
function ProgramJobs({ program, children }: { program: ProgramRecord; children: (jobOf: (operation: string) => { job: JobRecord | null; revision: number | undefined }) => ReactNode }) {
  const runJobs = useCamRunJobs(program);
  const list = useCam((state) => state.jobs[program.id]);
  return <>{children((operation) => operationJob(program, runJobs, list ?? [], operation))}</>;
}

/** Delete, F2 and Ctrl/Cmd+D on a selected row. */
const rowKeys = (actions: { remove: () => void; rename: () => void; duplicate: () => void }) => (event: KeyboardEvent<HTMLButtonElement>) => {
  if (event.key === 'Delete' || (event.key === 'Backspace' && (event.metaKey || event.ctrlKey))) { event.preventDefault(); actions.remove(); }
  else if (event.key === 'F2') { event.preventDefault(); actions.rename(); }
  else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); actions.duplicate(); }
};

/** The one short confirmation a destructive tree action asks for. */
function ConfirmDialog() {
  const confirm = useTreeConfirm((state) => state.confirm);
  const close = () => useTreeConfirm.setState({ confirm: null });
  return (
    <Dialog open={!!confirm} onOpenChange={(open) => { if (!open) close(); }} title={confirm?.title ?? ''} description={confirm?.detail} width={420}
      footer={confirm && <>
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button variant="danger" id="tree-confirm" autoFocus onClick={() => { close(); confirm.run(); }}>{confirm.action}</Button>
      </>} />
  );
}

export default function SetupTree() {
  const saved = useApp((state) => !!state.doc.saved);
  const all = useMfg((state) => state.programs);
  const loaded = useMfg((state) => state.programsLoaded);
  const activeProgram = useMfg((state) => state.activeProgram);
  const activeOperation = useCam((state) => state.activeOperation);
  const activeSetup = useCam((state) => state.activeSetup);
  const [renaming, setRenaming] = useState<Renaming>(null);
  const programs = all.filter((program) => programProcess(program.compiled) === 'milling');
  const several = programs.length > 1;
  const current = programs.find((program) => program.id === activeProgram) ?? (programs.length === 1 ? programs[0] : null);
  const count = programs.reduce((total, program) => total + (program.compiled.setups as unknown[]).length, 0);
  const done = (program: ProgramRecord, setup?: string) => (name: string | null) => {
    setRenaming(null);
    if (name) void rename(program, name, setup);
  };

  return (
    <>
      <BrowserGroup title="Setups" icon={<SetupIcon size={15} />} count={saved && loaded ? count : undefined} item="group:setups"
        menu={<MenuLines lines={programMenu(current, () => current && setRenaming({ program: current.id }))} />}>
        {programs.map((program) => {
          const setups = program.compiled.setups as { id?: string; name?: string }[];
          const ops = program.compiled.operations as Op[];
          const base = several ? 2 : 1;
          return (
            <ProgramJobs key={program.id} program={program}>{(jobOf) => (
            <div data-program-row={program.id}>
              {/* Several programs: each is a group of its own. */}
              {several && (
                <TreeRow depth={1} icon={<Factory size={14} />} label={program.compiled.name}
                  meta={<span className={styles.status} title={`Revision ${program.revision}`}>r{program.revision}</span>}
                  selected={program.id === activeProgram && !activeSetup && !activeOperation} onClick={() => useMfg.setState({ activeProgram: program.id })}
                  editor={renaming?.program === program.id && !renaming.setup && !renaming.op ? <NameEditor value={program.compiled.name} onDone={done(program)} /> : undefined}
                  item={`program:${program.id}`} menu={<MenuLines lines={programMenu(program, () => setRenaming({ program: program.id }))} />} />
              )}
              {!several && !setups.length && renaming?.program === program.id && !renaming.setup && (
                <TreeRow depth={1} icon={<Factory size={14} />} label={program.compiled.name} editor={<NameEditor value={program.compiled.name} onDone={done(program)} />} item={`program:${program.id}`} />
              )}
              {setups.map((setup) => {
                const id = String(setup.id ?? 'setup');
                const mine = ops.filter((op) => (op.setup ?? 'setup') === id);
                const key = `${program.id}:${id}`;
                const renameSetup = () => setRenaming({ program: program.id, setup: id });
                return (
                  <div key={id} data-setup-row={id}>
                    <TreeRow depth={base} icon={<SetupIcon size={14} />} label={setup.name ?? 'Setup'}
                      meta={!mine.length ? <span className={styles.status}>no operations</span> : undefined}
                      selected={activeSetup === key} onClick={() => selectSetup(program.id, id)} onDoubleClick={() => editSetup(program, id)}
                      onKeyDown={rowKeys({ remove: () => deleteSetupConfirmed(program, id), rename: renameSetup, duplicate: () => duplicateSetupOf(program, id) })}
                      editor={renaming?.program === program.id && renaming.setup === id ? <NameEditor value={setup.name ?? 'Setup'} onDone={done(program, id)} /> : undefined}
                      item={`setup:${key}`} menu={<MenuLines lines={setupMenu(program, id, renameSetup)} />} onContextSelect={() => selectSetup(program.id, id)} />
                    {mine.map((op) => {
                      const { job: latest, revision } = jobOf(op.id);
                      const renameOp = () => setRenaming({ program: program.id, op: op.id });
                      return (
                        <div key={op.id} data-operation-row={op.id}>
                          <TreeRow depth={base + 1} icon={<OpIcon kind={kindOf(op)} size={14} />} label={op.name ?? op.id}
                            meta={<StatusPill job={latest} compact revision={revision} />}
                            selected={program.id === activeProgram && activeOperation === op.id} onClick={() => selectOperation(program.id, op.id)} onDoubleClick={() => editOperation(program, op.id)}
                            onKeyDown={rowKeys({ remove: () => deleteOperationChecked(program, op.id), rename: renameOp, duplicate: () => duplicateOperationOf(program, op.id) })}
                            editor={renaming?.program === program.id && renaming.op === op.id ? <NameEditor value={op.name ?? op.id} onDone={(name) => { setRenaming(null); if (name) renameOperationOf(program, op.id, name); }} /> : undefined}
                            item={`operation:${op.id}`} menu={<MenuLines lines={operationMenu(program, op.id, renameOp)} />} onContextSelect={() => selectOperation(program.id, op.id)} />
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            )}</ProgramJobs>
          );
        })}
      </BrowserGroup>
      <ConfirmDialog />
    </>
  );
}
