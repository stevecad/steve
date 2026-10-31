import { useEffect, useState } from 'react';
import { Button, Section } from '@/ui';
import { set, type Study } from '@/state/store';
import { persistWorkspaceData } from '@/state/workspaceData';
import type { CalculixDeck, Definition, OpenFOAMCase } from './api';
import styles from '@/panels/Panels.module.css';
import sim from './Simulate.module.css';

/** A case file's path (simulation/schema.py CASE_PATH): system/, constant/ (not polyMesh) or 0/, one region folder deep at most. */
const CASE_PATH = /^(system|constant|0)(\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}){1,2}$/;
const DECK_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/** Utility command lines, one per line, as the study keeps them (a program and its arguments). */
const commandsText = (commands: string[][] | undefined) => (commands ?? []).map((line) => line.join(' ')).join('\n');
const commandsOf = (text: string) => text.split('\n').map((line) => line.trim().split(/\s+/).filter(Boolean)).filter((line) => line.length);

/**
 * A model-written case's own input (openfoam_case, calculix_deck): the person, or STEVE for them, writes the OpenFOAM
 * case or the CalculiX deck here; STEVE meshes the design, names the faces after the study's named face groups, and
 * runs it. What the input says is solved as written.
 */
export default function CaseSetup({ study }: { study: Study }) {
  const definition = study.definition!;
  const foam = study.type === 'openfoam_case';
  const update = (change: (value: Definition) => Definition) => {
    set((state) => ({ studies: state.studies.map((item) => item.id === study.id && item.definition ? { ...item, definition: change(item.definition) } : item) }));
    persistWorkspaceData();
  };
  const files: Record<string, string> = foam ? definition.analysis.case?.files ?? {} : { 'case.inp': definition.analysis.deck?.input ?? '', ...(definition.analysis.deck?.files ?? {}) };
  const paths = Object.keys(files).sort((a, b) => (a === 'case.inp' ? -1 : b === 'case.inp' ? 1 : a.localeCompare(b)));
  const [open, setOpen] = useState(paths[0] ?? '');
  const [adding, setAdding] = useState('');
  useEffect(() => { if (!paths.includes(open)) setOpen(paths[0] ?? ''); }, [paths.join('\0'), open]);

  const setCase = (patch: Partial<OpenFOAMCase>) => update((d) => ({ ...d, analysis: { ...d.analysis, case: { ...d.analysis.case!, ...patch } } }));
  const setDeck = (patch: Partial<CalculixDeck>) => update((d) => ({ ...d, analysis: { ...d.analysis, deck: { ...d.analysis.deck!, ...patch } } }));
  const writeFile = (path: string, text: string | null) => {
    if (foam) {
      const next = { ...files };
      if (text === null) delete next[path]; else next[path] = text;
      setCase({ files: next });
    } else if (path === 'case.inp') {
      setDeck({ input: text ?? '' });
    } else {
      const next = { ...(definition.analysis.deck?.files ?? {}) };
      if (text === null) delete next[path]; else next[path] = text;
      setDeck({ files: next });
    }
  };
  const valid = adding && !files[adding] && (foam ? CASE_PATH.test(adding) && !/(^|\/)polyMesh(\/|$)/.test(adding) : DECK_FILE.test(adding));

  return <Section title={foam ? 'OpenFOAM case' : 'CalculiX deck'}><div className={styles.stack}>
    <span className={styles.muted}>{foam
      ? 'STEVE meshes the design, names each boundary patch after a named face group (every outer face needs one) and runs the case as written. Code, system calls and paths outside the case are refused.'
      : 'STEVE meshes the design into mesh.inp (SI units: metres) with a node set and a surface per named face group; the deck includes it and says the rest.'}</span>
    {foam && <label className={sim.row}>Application <input className={sim.text} aria-label="OpenFOAM application" value={definition.analysis.case?.application ?? ''}
      onChange={(event) => setCase({ application: event.target.value.trim() })} spellCheck={false} /></label>}
    {!foam && <label className={sim.row}>Bodies <select aria-label="How bodies meet" value={definition.analysis.deck?.bodies ?? 'conformal'}
      onChange={(event) => setDeck({ bodies: event.target.value as 'conformal' | 'separate' })}>
      <option value="conformal">Bonded (shared nodes)</option><option value="separate">Separate (for contact)</option></select></label>}
    <label className={sim.row}>File <select aria-label="Case file" value={open} onChange={(event) => setOpen(event.target.value)}>
      {paths.map((path) => <option key={path} value={path}>{path}</option>)}</select></label>
    {open && <textarea className={sim.code} aria-label={`${open} contents`} spellCheck={false} rows={14} value={files[open] ?? ''}
      onChange={(event) => writeFile(open, event.target.value)} />}
    <div className={sim.buttons}>
      <input className={sim.text} aria-label="New file path" placeholder={foam ? 'constant/transportProperties' : 'loads.inp'} value={adding}
        onChange={(event) => setAdding(event.target.value.trim())} spellCheck={false} />
      <Button size="sm" disabled={!valid} onClick={() => { writeFile(adding, ''); setOpen(adding); setAdding(''); }}>Add file</Button>
      {open && open !== 'case.inp' && open !== 'system/controlDict' && <Button size="sm" variant="ghost" onClick={() => writeFile(open, null)}>Remove</Button>}
    </div>
    {foam && <>
      <span className={sim.label}>Before the solver (one utility per line, e.g. topoSet or setFields)</span>
      <Commands label="Utilities before the solver" value={definition.analysis.case?.before} onChange={(before) => setCase({ before })} />
      <span className={sim.label}>After the solver (e.g. postProcess -func yPlus -latestTime)</span>
      <Commands label="Utilities after the solver" value={definition.analysis.case?.after} onChange={(after) => setCase({ after })} />
    </>}
  </div></Section>;
}

/** Command lines as text: edited freely, kept when the field is left. */
function Commands({ label, value, onChange }: { label: string; value: string[][] | undefined; onChange: (commands: string[][]) => void }) {
  const saved = commandsText(value);
  const [text, setText] = useState(saved);
  useEffect(() => setText(saved), [saved]);
  return <textarea className={sim.code} aria-label={label} spellCheck={false} rows={2} value={text} onChange={(event) => setText(event.target.value)}
    onBlur={() => { if (text !== saved) onChange(commandsOf(text)); }} />;
}
