/**
 * The Machine form's Model and Controller: one machine, one form. A machine is an installed machine (machine_instance)
 * that pins its model (machine_model) and its controller (controller); people pick those here, from a catalogue, and
 * never manage them as lists of their own. A custom model or controller is still defined from here ("Define a new
 * model…"), for the advanced case; the records themselves are unchanged.
 */
import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';
import type { Kind, LibraryRecord, Pin } from '../api';
import type { ControlProps } from '../SchemaForm';
import InstanceView from './InstanceView';
import styles from './Machine.module.css';

const TYPE_LABEL: Record<string, string> = {
  vertical_mill: 'Vertical mill', horizontal_mill: 'Horizontal mill', router: 'Router', lathe: 'Lathe', mill_turn: 'Mill-turn', swiss: 'Swiss lathe',
  laser: 'Laser', plasma: 'Plasma', waterjet: 'Waterjet', fff: '3D printer', hybrid: 'Hybrid', custom: 'Custom',
};

type Joint = { id: string; kind?: string; limits?: { unit?: string; minimum?: number; maximum?: number } | null };

/** A model's travel: each linear axis's stroke, e.g. "X 600 · Y 400 · Z 200 mm". */
export function travelOf(definition: Record<string, unknown>): string {
  const axes = ((definition.nodes as Joint[] | undefined) ?? [])
    .filter((node) => node.kind === 'linear' && node.limits && node.limits.unit !== 'rad' && Number.isFinite(node.limits.maximum) && Number.isFinite(node.limits.minimum))
    .map((node) => `${node.id.replace(/^axis_?/i, '').toUpperCase()} ${Math.round(Number(node.limits!.maximum) - Number(node.limits!.minimum))}`);
  return axes.length ? `${axes.join(' · ')} mm` : 'Travel not given';
}

const pinOf = (record: LibraryRecord): Pin => ({ id: record.id, revision: record.revision, kind: record.kind, sha256: record.sha256 });
// 3D printing is backend-only for now: printers aren't offered as machines.
const printerOnly = (record: LibraryRecord) => ((record.definition.processes as string[] | undefined) ?? []).every((process) => process === 'fff');

function Choices({ kind, value, onChange, context, define, describe, empty }: ControlProps & {
  kind: Kind; define?: () => void; describe: (record: LibraryRecord) => ReactNode; empty: string;
}) {
  const pin = value as Pin | null;
  const records = context.records.filter((record) => record.kind === kind && (!record.archived || record.id === pin?.id) && !printerOnly(record))
    .sort((a, b) => String(a.definition.name).localeCompare(String(b.definition.name)));
  const current = pin ? context.records.find((record) => record.id === pin.id) : undefined;
  if (context.readOnly) {
    return current ? <button type="button" className={styles.choiceLink} onClick={() => context.onOpenPin?.(pin!)} data-pin={pin!.id}>{String(current.definition.name)} · rev {pin!.revision}</button> : <span>—</span>;
  }
  return (
    <div className={styles.choices} role="listbox" aria-label={kind === 'machine_model' ? 'Model' : 'Controller'} data-choices={kind}>
      {!records.length && <p className={styles.choiceEmpty}>{empty}</p>}
      {records.map((record) => {
        const chosen = record.id === pin?.id;
        return (
          <button key={record.id} type="button" role="option" aria-selected={chosen} className={styles.choice} data-chosen={chosen || undefined} data-choice={record.id}
            onClick={() => onChange(chosen && pin!.revision === record.revision ? pin : pinOf(record))}>
            <span className={styles.choiceName}>{String(record.definition.name)}<small> · rev {chosen ? pin!.revision : record.revision}</small></span>
            <span className={styles.choiceMeta}>{describe(record)}</span>
            {chosen && current && pin!.revision !== current.revision && (
              <span className={styles.choiceMeta}>Pinned to revision {pin!.revision}. <span role="link" tabIndex={0} className={styles.choiceLink}
                onClick={(event) => { event.stopPropagation(); onChange(pinOf(current)); }}>Use revision {current.revision}</span></span>
            )}
          </button>
        );
      })}
      {define && (
        <button type="button" className={styles.choiceDefine} onClick={define} data-define={kind}>
          <Plus size={13} />{kind === 'machine_model' ? 'Define a new model…' : 'Define a new controller…'}
        </button>
      )}
    </div>
  );
}

function ModelField(props: ControlProps & { define?: () => void }) {
  const pin = props.value as Pin | null;
  const chosen = pin ? props.context.records.find((record) => record.id === pin.id) : undefined;
  return (
    <>
      <Choices {...props} kind="machine_model" empty="No models yet: add the reference machines (Add examples), or define one."
        describe={(record) => `${TYPE_LABEL[String(record.definition.machine_type)] ?? 'Machine'} · ${travelOf(record.definition)}`} />
      {chosen && !!(chosen.definition.collision_geometry as unknown[] | undefined)?.length && (
        <div className={styles.choicePreview} data-model-preview>
          <InstanceView model={chosen.definition as Parameters<typeof InstanceView>[0]['model']} instance={undefined} pose={null} />
        </div>
      )}
    </>
  );
}

function ControllerField(props: ControlProps & { define?: () => void }) {
  return (
    <Choices {...props} kind="controller" empty="No controllers yet: add the reference machines (Add examples), or define one."
      describe={(record) => [record.definition.dialect, ...((record.definition.processes as string[] | undefined) ?? [])].filter(Boolean).join(' · ')} />
  );
}

/** The Machine form's own controls (SchemaForm `controls`): Model from a catalogue, Controller in the same form. */
export function machineControls(define?: (kind: Kind, field: string) => void): Record<string, (props: ControlProps) => ReactNode> {
  return {
    model: (props) => <ModelField {...props} define={define ? () => define('machine_model', 'model') : undefined} />,
    controller: (props) => <ControllerField {...props} define={define ? () => define('controller', 'controller') : undefined} />,
  };
}
