/**
 * The editor's mechanism in the viewport (PoseLayer: the live pose and the selected joint), with dragging in the
 * Motion tab, the Joint tool's limits as typed, collisions and cables. Lives inside the Canvas.
 */
import { get, useApp } from '@/state/store';
import { shownTab } from '@/state/designTab';
import { viewer } from '@/viewport/viewer';
import { useMotionDrag } from './drag';
import { useJointTool } from './jointTool';
import { JointGlyph, usePose } from './PoseLayer';
import { useMotion } from './state';
import ClashLayer from './ClashLayer';
import { presenting } from '@/present/state';
import CableLayer from './CableLayer';
import TrailLayer from './TrailLayer';
import ExplodeGizmo from './ExplodeGizmo';

export { applyPose, instanceNodes, nodeOfInstance, restMatrix } from './PoseLayer';

/** Dragging moves the mechanism in the Motion tab, with the Select tool. */
const dragging = () => {
  const app = get();
  return app.workspace === 'design' && app.doc.kind === 'design' && shownTab(app) === 'motion' && app.tool === 'select'
    && !app.sketching && !viewer.sectionHot && !presenting();
};

/** `bare`: presentation view, the pose without the selected joint's glyph. */
export default function MotionLayer({ bare = false }: { bare?: boolean }) {
  usePose(false);
  useMotionDrag(dragging);
  // While the Joint tool edits this joint, its limits as typed.
  const active = useMotion((state) => state.active ?? state.playing);
  const editingLimits = useJointTool((state) => (state.editing && state.editing === active ? state.limits : null));
  const jointOpen = useApp((state) => state.tool === 'joint');
  return <>{!bare && <JointGlyph draftLimits={jointOpen ? editingLimits : null} />}<ClashLayer /><CableLayer /><TrailLayer />{!bare && <ExplodeGizmo />}</>;
}
