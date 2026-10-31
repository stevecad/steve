/**
 * A machine instance's snapshot in 3D: its model's collision bodies where the instance mounts them, at rest or at the
 * pose the server computed (POST /machines/{id}/kinematics: the backend's own forward kinematics).
 */
import { useMemo, useState } from 'react';
import type { CollisionBody } from './bodyGeometry';
import { depthOf, forwardKinematics, frameOf, type Frame, type MachineNode } from './kinematics';
import MachineView, { PALETTE } from './MachineView';

export default function InstanceView({ model, instance, pose }: {
  model: { nodes?: MachineNode[]; collision_geometry?: CollisionBody[]; attachments?: { id: string; node: string; role: string; frame?: Partial<Frame> | null }[] };
  instance: { mounting?: Partial<Frame> | null } | undefined;
  /** The server's node frames at a computed pose (machine coordinates), or null for rest. */
  pose: [string, Frame][] | null;
}) {
  const nodes = useMemo(() => model.nodes ?? [], [model.nodes]);
  const rest = useMemo(() => forwardKinematics(nodes, {}, frameOf(instance?.mounting)), [nodes, instance?.mounting]);
  const frames = useMemo(() => (pose ? Object.fromEntries(pose) : rest), [pose, rest]);
  const nodeColors = useMemo(() => Object.fromEntries([...nodes].sort((a, b) => depthOf(nodes, a.id) - depthOf(nodes, b.id)).map((node, index) => [node.id, PALETTE[index % PALETTE.length]])), [nodes]);
  const [selected, setSelected] = useState<string | null>(null);
  const bodies = model.collision_geometry ?? [];
  if (!bodies.length) return null;
  return <MachineView id="instance-preview" bodies={bodies} frames={frames} rest={rest} attachments={model.attachments ?? []} nodeColors={nodeColors} selected={selected} onSelect={setSelected} />;
}
