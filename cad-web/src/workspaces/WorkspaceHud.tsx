import { AnimatePresence, motion } from 'motion/react';
import { useApp } from '@/state/store';
import { openFile } from '@/state/actions';
import { fileLabel, MAIN } from '@/state/design';
import { materialById } from '@/lib/materials';
import { STUDY_TYPES } from './simulate/commands';
import { useRunPill } from './simulate/RunPill';
import { useSimulation } from './simulate/state';
import styles from '@/viewport/Viewport.module.css';

/** Workspace context shown over the viewport: the active study or setup at a glance. */
export default function WorkspaceHud() {
  const workspace = useApp((state) => state.workspace);
  const study = useApp((state) => state.studies.find((item) => item.id === state.activeStudy));
  const material = useApp((state) => materialById(state.materials.root));
  const hasModel = useApp((state) => !!state.displayed);
  const component = useApp((state) => (state.doc.kind === 'design' && state.doc.activeFile.startsWith('components/') ? state.doc.activeFile : null));
  const sketching = useApp((state) => !!state.sketching);
  const past = useApp((state) => !!state.pastVersion);
  const running = useRunPill();
  // While a result shows, its header names the study and the animation bar takes this place.
  const showingResult = useSimulation((s) => !!s.result);
  const overview = useApp((state) => state.studyOverview);
  const studies = useApp((state) => state.studies.length);
  let content: React.ReactNode = null;
  if (hasModel && workspace === 'simulate' && (running || !showingResult || overview)) {
    content = running ?? (overview ? (
      <><b>All studies</b><i />{studies} stud{studies === 1 ? 'y' : 'ies'} on the model<i />Choose one to edit or solve it</>
    ) : study ? (
      <>
        <b>{study.name}</b>
        <i />{STUDY_TYPES[study.type].label}
        <i />{study.type === 'flow' ? study.definition?.fluid?.name ?? 'Set fluid properties' : study.type === 'compressible' ? study.definition?.gas?.name ?? 'Choose a gas' : study.definition ? `Materials · design revision ${study.definition.design.revision}` : material?.name ?? 'No material'}
        <i />{study.loads.length ? `${study.loads.length} boundar${study.loads.length === 1 ? 'y' : 'ies'}` : 'No boundaries yet'}
      </>
    ) : <span>No study yet: New study (top left of the ribbon) starts one</span>);
  }
  // Manufacture shows nothing here: the tree and the Inspector already name the program, its setup and stock.
  // Editing one of a design's components (the rest shows faint): name it, with the way back to the whole design.
  if (!content && component && !sketching && !past && workspace !== 'simulate' && workspace !== 'manufacture') {
    content = (
      <>
        <span>Editing</span><b>{fileLabel(component)}</b>
        <button type="button" id="component-done" className={styles.hudAction} title="Back to the whole design (main.py)" onClick={() => openFile(MAIN)}>Done</button>
      </>
    );
  }
  return (
    <AnimatePresence>
      {content && (
        <motion.div key={workspace} className={styles.workspaceHud} data-workspace={workspace} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.22 }}>
          <span className={styles.hudDot} />{content}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
