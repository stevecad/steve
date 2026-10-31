/**
 * The browser for a circuit: the board, its parts grouped by kind (value and footprint alongside), the nets that
 * connect them, the circuit's other files, and the problems tscircuit found. Rows select in every view; double-click
 * frames; right-click has what each row can do.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, AlertTriangle, ClipboardCheck, Code2, Copy, Crosshair, Download, FileCode, Info, Layers3, PenLine, ScanSearch } from 'lucide-react';
import { ContextItem, ContextLabel, ContextSeparator } from '@/ui';
import { get, toast, useApp } from '@/state/store';
import { exportStep } from '@/state/actions';
import { openTab } from '@/state/tabs';
import { BrowserGroup } from '@/shell/Browser';
import TreeRow from '@/shell/TreeRow';
import { RenameField, startRename, useEditing } from '@/workspaces/design/ItemMenu';
import {
  BoardIcon, CapacitorIcon, CircuitIcon, ConnectorIcon, DiodeIcon, InductorIcon, LedIcon, NetIcon, ResistorIcon, SchematicIcon,
} from '@/icons/cad';
import { focusSelection, hoverPart, selectParts, setView, useCircuit } from './state';
import { GROUP_ORDER, lineOf, plainMessage, type CircuitPart, type CircuitProblem } from './circuit';
import { revealLine } from './reveal';
import { mergeProblems, openReadiness, useReadinessView } from './readiness';
import styles from './Electronics.module.css';

const GROUP_ICONS: Record<string, typeof CircuitIcon> = {
  Resistors: ResistorIcon, Capacitors: CapacitorIcon, Inductors: InductorIcon, Diodes: DiodeIcon, LEDs: LedIcon, Connectors: ConnectorIcon, Chips: CircuitIcon,
};
export const iconFor = (group: string) => GROUP_ICONS[group] ?? CircuitIcon;

/** The line that declares a part (`name="R1"`). */
const partLine = (name: string) => lineOf({ id: '', type: '', message: '', severity: 'warning', parts: [name], line: null }, get().doc.code);

function copy(text: string, what: string) {
  void navigator.clipboard?.writeText(text).then(() => toast('success', `Copied ${what}`, text), () => toast('warning', 'Couldn’t copy', 'The browser didn’t allow it.'));
}

function PartMenu({ part }: { part: CircuitPart }) {
  return (
    <>
      <ContextItem icon={<SchematicIcon size={14} />} onSelect={() => { selectParts([part.name]); setView('schematic'); requestAnimationFrame(focusSelection); }}>Show in schematic</ContextItem>
      <ContextItem icon={<BoardIcon size={14} />} onSelect={() => { selectParts([part.name]); setView('pcb'); }}>Show on the board</ContextItem>
      <ContextItem icon={<Code2 size={14} />} onSelect={() => revealLine(partLine(part.name))}>Show in source</ContextItem>
      <ContextSeparator />
      <ContextItem icon={<Copy size={14} />} onSelect={() => copy(part.name, 'the name')}>Copy name</ContextItem>
      <ContextItem icon={<Copy size={14} />} disabled={!part.ports.length} onSelect={() => copy(`.${part.name} > .${part.ports[0]?.name ?? 'pin1'}`, 'a pin selector')}>Copy pin selector</ContextItem>
    </>
  );
}

function PartRow({ part, depth }: { part: CircuitPart; depth: number }) {
  const selected = useCircuit((state) => state.selection.includes(part.name));
  const hovered = useCircuit((state) => state.hover === part.name);
  const Icon = iconFor(part.group);
  const meta = (
    <span className={styles.partMeta}>
      {part.value && <b>{part.value}</b>}
      {/* The footprinter string's family (pinrow3_p2.54_nopinlabels → pinrow3); the whole string is in the tooltip. */}
      {part.footprint && <span>{part.footprint.split('_')[0]}</span>}
    </span>
  );
  return (
    <TreeRow depth={depth} icon={<Icon size={15} />} label={part.name} meta={meta} item={`part:${part.name}`} testId={part.name}
      selected={selected} partial={hovered && !selected}
      title={[part.name, part.value, part.footprint, part.layer === 'bottom' ? 'bottom side' : null].filter(Boolean).join(' · ')}
      onClick={(event) => selectParts([part.name], event.shiftKey || event.ctrlKey || event.metaKey)}
      onDoubleClick={() => { selectParts([part.name]); focusSelection(); }}
      onHover={(on) => hoverPart(on ? part.name : null)}
      onContextSelect={() => { if (!useCircuit.getState().selection.includes(part.name)) selectParts([part.name]); }}
      menu={<PartMenu part={part} />} />
  );
}

function ProblemRow({ problem, depth }: { problem: CircuitProblem; depth: number }) {
  const Icon = problem.severity === 'error' ? AlertCircle : problem.severity === 'info' ? Info : AlertTriangle;
  const message = plainMessage(problem.message);
  const readinessIssue = problem.id.startsWith('readiness:');
  return (
    <TreeRow depth={depth} icon={<span className={styles.problemIcon} data-severity={problem.severity}><Icon size={14} /></span>}
      label={<span className={styles.problemText}>{message}</span>} item={`problem:${problem.id}`} title={problem.fix ? `${message}\nFix: ${problem.fix}` : message} error={problem.severity === 'error'}
      onClick={() => { if (problem.parts.length) selectParts(problem.parts); }}
      onDoubleClick={() => { if (problem.parts.length) { selectParts(problem.parts); focusSelection(); } revealLine(lineOf(problem, get().doc.code)); }}
      menu={(
        <>
          <ContextItem icon={<Crosshair size={14} />} disabled={!problem.parts.length} onSelect={() => { selectParts(problem.parts); focusSelection(); }}>Select what it’s about</ContextItem>
          <ContextItem icon={<Code2 size={14} />} onSelect={() => revealLine(lineOf(problem, get().doc.code))}>Show in source</ContextItem>
          <ContextItem icon={<Copy size={14} />} onSelect={() => copy(message, 'the message')}>Copy message</ContextItem>
          {readinessIssue && <ContextSeparator />}
          {readinessIssue && <ContextItem icon={<ClipboardCheck size={14} />} onSelect={() => openReadiness(true)}>Open the ordering checklist</ContextItem>}
        </>
      )} />
  );
}

type Design = { id: string; name: string; trashed?: boolean };

/** The designs that place this circuit's board (GET /v1/documents/{id}/references), refreshed when it's saved. */
function useUsedIn(): { id: string; name: string }[] {
  const id = useApp((state) => state.doc.saved?.id ?? null);
  const revision = useApp((state) => state.doc.saved?.revision ?? 0);
  const [designs, setDesigns] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!id) { setDesigns([]); return; }
    let live = true;
    fetch(`/v1/documents/${id}/references`).then((response) => (response.ok ? response.json() : null))
      .then((body: { designs?: Design[]; references?: { designs?: Design[] } } | null) => {
        if (live) setDesigns((body?.designs ?? body?.references?.designs ?? []).filter((design) => !design.trashed));
      }).catch(() => { if (live) setDesigns([]); });
    return () => { live = false; };
  }, [id, revision]);
  return designs;
}

function BoardRow() {
  const name = useApp((state) => state.doc.name);
  const usedIn = useUsedIn();
  const board = useCircuit((state) => state.model?.board ?? null);
  const editing = useEditing('document');
  const size = board?.width && board.height ? `${Number(board.width.toFixed(2))} × ${Number(board.height.toFixed(2))} mm` : null;
  return (
    <TreeRow depth={0} icon={<CircuitIcon size={15} />} label={name} item="document" meta={size ? <span className={styles.partMeta}>{size}</span> : undefined}
      title={usedIn.length ? `${name} · used in ${usedIn.length} ${usedIn.length === 1 ? 'design' : 'designs'}: ${usedIn.map((design) => design.name).join(', ')}` : name}
      editor={editing ? <RenameField editKey={editing} /> : undefined} onDoubleClick={() => startRename({ kind: 'document' })}
      onClick={() => selectParts([])}
      menu={(
        <>
          <ContextItem icon={<PenLine size={14} />} shortcut="F2" onSelect={() => setTimeout(() => startRename({ kind: 'document' }), 0)}>Rename circuit</ContextItem>
          <ContextItem icon={<Code2 size={14} />} onSelect={() => revealLine(get().doc.code.split('\n').findIndex((line) => /<board\b/.test(line)) + 1 || null)}>Show the board in source</ContextItem>
          <ContextSeparator />
          <ContextItem icon={<ScanSearch size={14} />} onSelect={() => { setView('3d'); }}>View in 3D</ContextItem>
          <ContextItem icon={<Download size={14} />} disabled={!get().displayed} reason={get().displayed ? undefined : 'Build the circuit first.'} onSelect={() => { void exportStep(); }}>Export board STEP</ContextItem>
          {usedIn.length > 0 && <ContextSeparator />}
          {usedIn.length > 0 && <ContextLabel>Used in {usedIn.length} {usedIn.length === 1 ? 'design' : 'designs'}</ContextLabel>}
          {usedIn.slice(0, 8).map((design) => <ContextItem key={design.id} icon={<Layers3 size={14} />} onSelect={() => openTab({ id: design.id })}>Open {design.name}</ContextItem>)}
        </>
      )} />
  );
}

function Group({ title, icon, count, children, depth = 1, defaultOpen = true, item }: { title: string; icon: ReactNode; count: number; children: ReactNode; depth?: number; defaultOpen?: boolean; item: string }) {
  if (!count) return null;
  return <BrowserGroup title={title} icon={icon} count={count} depth={depth} defaultOpen={defaultOpen} item={item}>{children}</BrowserGroup>;
}

export default function CircuitTree() {
  const model = useCircuit((state) => state.model);
  const net = useCircuit((state) => state.net);
  const files = useApp((state) => state.doc.files);
  const groups = useMemo(() => {
    const byGroup = new Map<string, CircuitPart[]>();
    for (const part of model?.parts ?? []) {
      const list = byGroup.get(part.group);
      if (list) list.push(part); else byGroup.set(part.group, [part]);
    }
    return [...byGroup.entries()].sort(([a], [b]) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  }, [model]);
  const others = Object.keys(files).sort();
  const readiness = useReadinessView();
  const problems = useMemo(() => mergeProblems(model, readiness), [model, readiness.blocking, readiness.advisories, readiness.available]); // eslint-disable-line react-hooks/exhaustive-deps
  const errors = problems.filter((problem) => problem.severity === 'error').length;
  return (
    <div id="circuit-tree">
      <BoardRow />
      {model && (
        <>
          <Group title="Parts" icon={<CircuitIcon size={15} />} count={model.parts.length} item="parts">
            {groups.map(([group, parts]) => {
              const Icon = iconFor(group);
              return (
                <BrowserGroup key={group} title={group} icon={<Icon size={15} />} count={parts.length} depth={2} item={`parts:${group}`}>
                  {parts.map((part) => <PartRow key={part.id} part={part} depth={3} />)}
                </BrowserGroup>
              );
            })}
          </Group>
          <Group title="Nets" icon={<NetIcon size={15} />} count={model.nets.length} defaultOpen={model.nets.length <= 12} item="nets">
            {model.nets.map((item) => (
              <TreeRow key={item.key} depth={2} item={`net:${item.name}`} testId={`net:${item.name}`}
                icon={<span className={styles.netSwatch} data-kind={item.ground ? 'ground' : item.power ? 'power' : undefined} />}
                label={item.name} meta={<span className={styles.partMeta}>{item.ports.length} {item.ports.length === 1 ? 'pin' : 'pins'}</span>}
                title={item.ports.map((port) => `${port.part}.${port.label}`).join(', ')}
                selected={net === item.key}
                onClick={() => useCircuit.setState({ net: net === item.key ? null : item.key, selection: [...new Set(item.ports.map((port) => port.part))] })}
                menu={(
                  <>
                    <ContextItem icon={<Crosshair size={14} />} onSelect={() => { useCircuit.setState({ net: item.key, selection: [...new Set(item.ports.map((port) => port.part))] }); focusSelection(); }}>Select its parts</ContextItem>
                    <ContextItem icon={<Copy size={14} />} disabled={!item.named} onSelect={() => copy(`net.${item.name}`, 'the net selector')}>Copy net selector</ContextItem>
                  </>
                )} />
            ))}
          </Group>
        </>
      )}
      <Group title="Files" icon={<FileCode size={15} />} count={others.length} defaultOpen={false} item="files">
        {others.map((path) => <TreeRow key={path} depth={2} icon={<FileCode size={14} />} label={path} item={`file:${path}`} />)}
      </Group>
      {model && (
        <Group title={errors ? 'Problems' : 'Notes'} icon={<AlertTriangle size={15} />} count={problems.length} item="problems">
          {problems.map((problem) => <ProblemRow key={problem.id} problem={problem} depth={2} />)}
        </Group>
      )}
    </div>
  );
}
