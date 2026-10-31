import { useEffect, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Boxes, CircleAlert, FileBox, FilePlus2, FileUp, Import, Layers3, PackagePlus } from 'lucide-react';
import { Button, Dialog, Spinner } from '@/ui';
import { useApp } from '@/state/store';
import { num } from '@/lib/format';
import {
  INPUT_ID, MAX_MB, canInsert, canSplit, chooseStepFile, closeImport, confirmImport, formatBytes, installStepDrop, startImport, useImport,
  type ImportChoice,
} from '@/state/imports';
import styles from './ImportDialog.module.css';

const ease = [0.2, 0, 0, 1] as const;

export default function ImportDialog({ open }: { open: boolean }) {
  const flow = useImport();
  const doc = useApp((state) => state.doc);
  const busy = useApp((state) => state.busy);
  const { record, phase } = flow;
  const insertable = canInsert(doc);
  const splittable = canSplit(doc, record);
  const options: { value: ImportChoice; icon: typeof FilePlus2; title: string; detail: string; reason?: string }[] = [
    { value: 'new', icon: FilePlus2, title: 'New part from this file', detail: 'Opens a new tab with the model and this import, generated and ready to save.' },
    { value: 'insert', icon: PackagePlus, title: doc.open && doc.kind === 'part' ? `Insert into ${doc.name.trim() || 'this part'}` : 'Insert into this part',
      detail: 'Adds the solids as new bodies after the last feature.', reason: insertable === true ? undefined : insertable },
    ...(splittable ? [{ value: 'components' as const, icon: Layers3, title: (record?.solids ?? 0) > 1 ? 'Components in this design' : 'A component of this design',
      detail: (record?.solids ?? 0) > 1 ? `Adds ${record?.solids} components, one file each, named after the solids and placed where the file has them.`
        : 'Adds a component file with this solid, placed where the file has it.' }] : []),
    ...(splittable ? [{ value: 'parts' as const, icon: Boxes, title: (record?.solids ?? 0) > 1 ? 'One linked part per solid' : 'Link into this design',
      detail: (record?.solids ?? 0) > 1 ? `Creates ${record?.solids} part documents and links them into this design.` : 'Creates a part document and links it into this design.' }] : []),
  ];
  const choice = options.find((option) => option.value === flow.choice && !option.reason) ? flow.choice : 'new';
  const ready = phase === 'ready' && !!record;
  const label = choice === 'insert' ? 'Insert' : choice === 'parts' ? ((record?.solids ?? 0) > 1 ? `Create ${record?.solids} parts` : 'Create and link')
    : choice === 'components' ? ((record?.solids ?? 0) > 1 ? `Add ${record?.solids} components` : 'Add component') : 'Create part';
  const elapsed = useElapsed(phase === 'checking' ? flow.checkingSince : null);
  const status = phase === 'uploading' ? `Uploading · ${Math.round(flow.progress * 100)}%` : phase === 'checking' ? `Reading the geometry… ${elapsed}s`
    : phase === 'ready' ? 'Checked' : phase === 'failed' ? 'Not imported' : '';
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && ready && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); void confirmImport(); }
  };
  return (
    <Dialog open={open} onOpenChange={(value) => !value && closeImport()} width={540} title="Import"
      description="The file is stored once; the design references it, so the code stays the source of truth."
      icon={<div className={styles.icon}><Import size={17} /></div>}
      footer={<>
        {phase === 'failed' && <Button className={styles.spacer} icon={<FileUp size={14} />} onClick={chooseStepFile}>Choose another file</Button>}
        <Button onClick={closeImport}>Cancel</Button>
        <Button id="import-confirm" variant="primary" disabled={!ready || flow.working || busy} onClick={() => void confirmImport()}>
          {flow.working ? <Spinner size={13} /> : null}{label}
        </Button>
      </>}>
      <div className={styles.body} onKeyDown={onKey}>
        <div className={styles.file} data-phase={phase}>
          <div className={styles.fileIcon}><FileBox size={18} /></div>
          <div className={styles.fileText}>
            <div className={styles.fileName} title={flow.file?.name}>{flow.file?.name ?? 'No file'}</div>
            <div className={styles.fileMeta}>
              <span>{flow.file ? formatBytes(flow.file.size) : ''}</span>
              <span aria-hidden>·</span>
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={phase} id="import-status" className={styles.status} data-phase={phase}
                  initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.14 }}>
                  {phase === 'checking' && <Spinner size={11} />}{status}
                </motion.span>
              </AnimatePresence>
            </div>
          </div>
        </div>
        <div className={styles.track} role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round(flow.progress * 100)} data-phase={phase}>
          <motion.div className={styles.fill} animate={{ width: `${(phase === 'failed' ? 1 : flow.progress) * 100}%` }} transition={{ duration: 0.25, ease }} />
        </div>
        {phase === 'checking' && (
          <p className={styles.working} id="import-working">
            A local CAD worker is opening the file, checking every solid and naming its faces.
            {elapsed >= 8 ? ' Large or detailed files can take a minute or two; you can keep this open or cancel.' : ''}
          </p>
        )}

        <AnimatePresence mode="popLayout" initial={false}>
          {phase === 'failed' && flow.problem && (
            <motion.div key="problem" className={styles.problem} role="alert" id="import-problem"
              initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease }}>
              <CircleAlert size={16} />
              <div><b>{flow.problem.title}</b><p>{flow.problem.detail}</p></div>
            </motion.div>
          )}
          {ready && record && (
            <motion.div key="summary" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.22, ease }}>
              <dl className={styles.stats} id="import-summary">
                {[['Solids', String(record.solids ?? '—')],
                  ['Size', record.bounds_mm ? `${record.bounds_mm.map((v) => num(v, 1)).join(' × ')} mm` : '—'],
                  ['Faces', String(record.faces ?? '—')]].map(([term, value], index) => (
                  <motion.div key={term} className={styles.stat} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.04 * index, duration: 0.2, ease }}>
                    <dt>{term}</dt><dd data-stat={term.toLowerCase()}>{value}</dd>
                  </motion.div>
                ))}
              </dl>
              <SolidNames names={record.solid_names} />
              {record.format === 'f3d' && (
                <p className={styles.note} id="import-fusion">
                  Fusion design: its exact solids come in; its timeline isn’t rebuilt.
                  {record.fusion && ` The file lists ${record.fusion.parameters.length} parameter${record.fusion.parameters.length === 1 ? '' : 's'} and ${record.fusion.features.length} timeline feature${record.fusion.features.length === 1 ? '' : 's'}; STEVE can rebuild them as code if you ask.`}
                </p>
              )}
              <div className={styles.options} role="radiogroup" aria-label="What to do with the file">
                {options.map((option) => (
                  <label key={option.value} className={styles.option} data-checked={choice === option.value || undefined} data-disabled={!!option.reason || undefined}
                    title={option.reason}>
                    <input type="radio" name="import-choice" value={option.value} checked={choice === option.value} disabled={!!option.reason}
                      onChange={() => useImport.setState({ choice: option.value })} autoFocus={choice === option.value} />
                    <option.icon size={18} />
                    <b>{option.title}</b>
                    <span>{option.reason ?? option.detail}</span>
                  </label>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Dialog>
  );
}

function SolidNames({ names }: { names: (string | null)[] }) {
  const named = names.filter(Boolean) as string[];
  if (!named.length) return null;
  const shown = named.slice(0, 6);
  return (
    <ul className={styles.names} aria-label="Solids in the file">
      {shown.map((name, index) => <li key={`${name}-${index}`}>{name}</li>)}
      {named.length > shown.length && <li data-more>+{named.length - shown.length}</li>}
    </ul>
  );
}

/** The file input behind Import, and the drop target shown while a file is dragged over the app. */
export function ImportDrop() {
  const [over, setOver] = useState(false);
  useEffect(() => installStepDrop(setOver), []);
  return (
    <>
      <input id={INPUT_ID} type="file" accept=".step,.stp,.f3d,.STEP,.STP,.F3D" hidden
        onChange={(event) => { const file = event.target.files?.[0]; if (file) startImport(file); }} />
      <AnimatePresence>
        {over && (
          <motion.div className={styles.drop} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}>
            <motion.div className={styles.dropFrame} initial={{ scale: 0.985 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 32 }}>
              <Import size={28} />
              <strong>Drop to import</strong>
              <span>.step, .stp or Fusion .f3d, up to {MAX_MB} MB. Choose a new part or insert it next.</span>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** Whole seconds since `since`, ticking while it is set. */
function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}
