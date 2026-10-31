/**
 * All studies at once (clicking Studies in the browser): each study's latest solved result drawn in place of what it
 * analysed, on the whole model. The canvas side is ResultsLayer's OverviewLayer; this is what it found, shown in the
 * inspector (not over the viewport): each study's state, and one colour scale per kind of result (studies of the same
 * field and unit share its range). Read-only and light: no animation, section caps, probes or recording; choosing a
 * study opens it.
 */
import { create } from 'zustand';
import { Eye, EyeOff, Layers } from 'lucide-react';
import { Button, Section } from '@/ui';
import { set, useApp } from '@/state/store';
import { inspect } from '@/state/layout';
import { useTreeMemory } from '@/state/treeOpen';
import { hiddenKey } from '@/state/visibility';
import { legendGradient } from './colormap';
import { SAFETY_CAP, statusOf, useSimulation } from './state';
import { fieldLabel, show } from './units';
import styles from '@/panels/Panels.module.css';
import tree from '@/shell/Browser.module.css';
import sim from './Simulate.module.css';

/** The most results drawn at once: each is a full result mesh in the browser. */
export const OVERVIEW_LIMIT = 8;

/**
 * A study hidden from this view by its eye in the browser (or Space), remembered like the browser's open rows
 * (treeOpen: this browser, per account and document). A view choice, not part of the study: opening it still shows
 * its results.
 */
export { hiddenKey };

export interface OverviewEntry {
  id: string; name: string;
  /** Drawn on the model, still loading, or not drawn (`note` says why). */
  state: 'shown' | 'loading' | 'hidden';
  note: string;
  /** Hidden by the person (the study's eye in the browser), so neither loaded nor drawn. */
  off?: boolean;
  /** Why the drawn result no longer matches the design or study (see `staleness`). */
  stale: string | null;
}

/** A shared colour scale: every drawn result of one field in one unit. Values in SI. */
export interface OverviewScale { key: string; field: string; title: string; unit: string | null | undefined; flow: boolean; min: number; max: number; studies: string[] }

export const useOverview = create<{ entries: OverviewEntry[]; scales: OverviewScale[] }>(() => ({ entries: [], scales: [] }));

/** The scale a result of `field` joins: "Mode 1" for mode shapes, else the field's name. */
export const scaleTitle = (field: string, analysis?: string) => (field.startsWith('mode_') ? `Mode ${field.slice(5)}` : fieldLabel(field, analysis) ?? field);

const value = (number: number, scale: OverviewScale) => {
  const shown = show(number, scale.unit, scale.flow);
  return `${shown.value}${shown.unit ? ` ${shown.unit}` : ''}`;
};

/** Leaves the overview for one study, its setup and results in the inspector. */
function open(id: string) {
  set({ studyOverview: false, activeStudy: id, ...inspect() });
}

/** The colour scales of the drawn results, shared by results of one field and unit. */
export function useOverviewScales() {
  const scales = useOverview((s) => s.scales);
  const colormap = useSimulation((s) => s.colormap);
  const banded = useSimulation((s) => s.contours === 'banded');
  const bands = useSimulation((s) => s.bands);
  const palette = { kind: 'field' as const, colormap, safety: 'gradient' as const, cap: SAFETY_CAP };
  return scales.map((scale) => ({ ...scale, background: legendGradient(palette, banded, 'to right', bands), low: value(scale.min, scale), high: value(scale.max, scale) }));
}

/**
 * The all-studies view in the inspector: how many show on the model, each study with its state (open it, or hide it
 * from this view with its eye, as in the browser), then the colour scales.
 */
export function AllStudies() {
  const entries = useOverview((s) => s.entries);
  const scales = useOverviewScales();
  const studies = useApp((s) => s.studies);
  const active = useApp((s) => s.activeStudy);
  const memory = useTreeMemory();
  // Each study's status is its durable outcome (statusOf, as in the browser); these re-draw when it or the design changes.
  useSimulation((s) => s.runs);
  useSimulation((s) => s.outcomes);
  useApp((s) => s.doc.saved?.revision);
  useApp((s) => s.doc.branch);
  const total = studies.length;
  const shown = entries.filter((entry) => entry.state === 'shown').length;
  const off = entries.filter((entry) => entry.off).length;
  const loading = entries.some((entry) => entry.state === 'loading');
  const names = new Map(studies.map((study) => [study.id, study.name]));
  return (
    <div id="studies-overview" aria-label="All studies" data-shown={shown}>
      <div className={styles.hero}>
        <div className={styles.heroIcon}><Layers size={20} /></div>
        <div className={styles.heroText}><div className={styles.heroTitle}>All studies</div>
          <div className={styles.heroSub}>{loading ? 'Loading results…' : total && off === total ? 'All studies are hidden: show one with its eye.'
            : `${shown} of ${total} shown on the model${off ? ` · ${off} hidden` : ''}`}</div></div>
        {active && names.has(active) && <Button size="sm" variant="ghost" id="studies-overview-back" title={`Back to ${names.get(active)} alone`} onClick={() => set({ studyOverview: false })}>Back to study</Button>}
      </div>
      <Section title={`Studies · ${total}`} id="overview-studies"><div className={styles.stack}>
        <ul className={sim.overviewList}>
          {entries.map((entry) => {
            const hidden = memory.isOpen(hiddenKey(entry.id), false);
            const study = studies.find((item) => item.id === entry.id);
            const status = study ? statusOf(study) : null;
            return <li key={entry.id} data-study={entry.id} data-state={entry.state}>
              <div className={sim.overviewRow}>
                <button type="button" title="Open this study: its setup, solve and results" onClick={() => open(entry.id)}>{entry.name}</button>
                {status && <span className={tree.status} data-study-status title={status.outdated ?? undefined}><span className={tree.statusDot} data-tone={status.tone} />{status.label}</span>}
                <button type="button" className={sim.headButton} data-overview-eye aria-label={hidden ? `Show ${entry.name} on the model` : `Hide ${entry.name} from this view`}
                  title={hidden ? 'Show in all studies' : 'Hide from all studies'} onClick={() => memory.setOpen(hiddenKey(entry.id), !hidden)}>{hidden ? <EyeOff size={13} /> : <Eye size={13} />}</button>
              </div>
              <small title={entry.stale ?? undefined}>{entry.state === 'shown' ? (entry.stale ? 'Shown · out of date' : 'Shown') : entry.state === 'loading' ? 'Loading…' : entry.note}</small>
            </li>;
          })}
        </ul>
        <small className={styles.muted}>Open a study to edit, solve or explore its results.</small>
      </div></Section>
      {scales.length > 0 && <Section title="Colour scales" id="overview-scales"><div className={styles.stack}>
        {scales.map((scale) => (
          <div key={scale.key} className={sim.overviewScale} data-field={scale.field}>
            <span className={sim.overviewTitle}>{scale.title}</span>
            <div className={sim.overviewBar} style={{ background: scale.background }} />
            <span className={sim.overviewEnds}><span>{scale.low}</span><span>{scale.high}</span></span>
            <small className={styles.muted}>{scale.studies.map((id) => names.get(id) ?? id).join(', ')}</small>
          </div>
        ))}
        <small className={styles.muted}>Results of the same quantity share one scale, so their colours compare.</small>
      </div></Section>}
    </div>
  );
}
