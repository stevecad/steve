import { useApp } from '@/state/store';
import FrameLayer from '@/workspaces/manufacture/FrameLayer';
import CamLayer from '@/workspaces/manufacture/cam/CamLayer';
import CamSync from '@/workspaces/manufacture/cam/CamSync';
import LoadsLayer from '@/workspaces/simulate/LoadsLayer';
import ConstructionLayer from '@/workspaces/design/ConstructionLayer';
import StudySync from '@/workspaces/simulate/StudySync';
import ResultsLayer from '@/workspaces/simulate/ResultsLayer';

/** Workspace-specific scene content: CAM tool frames and simulation, CAE loads and constraints, design construction geometry. */
export default function WorkspaceLayer() {
  const workspace = useApp((state) => state.workspace);
  if (workspace === 'manufacture') return <><CamSync /><FrameLayer /><CamLayer /></>;
  if (workspace === 'simulate') return <><StudySync /><LoadsLayer /><ResultsLayer /></>;
  return <ConstructionLayer />;
}
