/**
 * Manufacture inspector (CAM): the selected milling program (its setups, operations, runs and their checks), or how to
 * start one. The program editor itself is a right-dock tool (cam/ProgramEditor). 3D printing isn't part of
 * Manufacture: designs export 3MF/STL for the person's own slicer (File → Export).
 */
import { Library } from 'lucide-react';
import { SetupIcon } from '@/icons/cad';
import { Button } from '@/ui';
import { useApp } from '@/state/store';
import { openLibrary, programProcess, useMfg } from './state';
import ProgramView from './cam/ProgramView';
import { newProgram, useCam } from './cam/state';
import panel from '@/panels/Panels.module.css';

export default function SetupInspector() {
  // The selected program, or the part's only one (as the tree and the code editor show it, e.g. after a reload).
  const program = useMfg((state) => {
    const milling = state.programs.filter((item) => programProcess(item.compiled) === 'milling');
    return milling.find((item) => item.id === state.activeProgram) ?? (milling.length === 1 ? milling[0] : undefined);
  });
  const activeSetup = useCam((state) => state.activeSetup);
  const saved = useApp((state) => !!state.doc.saved);
  const loaded = useMfg((state) => state.recordsLoaded);
  const machines = useMfg((state) => state.records.some((record) => record.kind === 'machine_instance' && !record.archived));
  // A selected setup shows that setup and its operations; otherwise the program (all its setups).
  const setupId = activeSetup?.startsWith(`${program?.id}:`) ? activeSetup.slice(program!.id.length + 1) : undefined;
  if (program) return <ProgramView program={program} setupId={setupId} />;
  // The one empty state: what's missing first (a saved design, a machine), then the way in.
  const needsMachine = loaded && !machines;
  return (
    <div className={panel.empty} style={{ height: 'auto', paddingTop: 48 }} id="manufacture-empty">
      <SetupIcon size={30} />
      <h3>Machine this part</h3>
      {!saved
        ? <p>Save the design first: a setup pins the saved revision it machines.</p>
        : needsMachine
          ? <p>Add your machine and its tools on Manufacture → Shop, then make a program.</p>
          : <p>Start a program: pick the machine and its tools, the stock and program zero. Then add operations from the ribbon and run it.</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        {needsMachine
          ? <Button size="sm" variant="primary" icon={<Library />} onClick={() => openLibrary('shop')} id="cam-open-library">Your shop</Button>
          : <Button size="sm" variant="primary" icon={<SetupIcon size={14} />} disabled={!saved} onClick={() => void newProgram()} id="cam-new-program">New program</Button>}
      </div>
    </div>
  );
}
