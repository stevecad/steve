/** A small player over the viewport while a drive plays: the joint or coupling, its live value, pause. */
import { AnimatePresence, motion } from 'motion/react';
import { Pause, Square } from 'lucide-react';
import { IconButton } from '@/ui';
import { num } from '@/lib/format';
import { collisionsAt, couplingUnit, unitOf } from './kinematics';
import { resetPose, stop, useMotion } from './state';
import styles from './Motion.module.css';

export default function MotionHud() {
  const playing = useMotion((state) => state.playing);
  const kinematics = useMotion((state) => state.kinematics);
  const joint = kinematics?.joints.find((item) => item.name === playing);
  const coupling = kinematics?.couplings?.find((item) => item.name === playing);
  const value = useMotion((state) => (!state.playing ? undefined : coupling ? state.coupled[state.playing] : state.pose[state.playing]?.value));
  const drive = kinematics?.drives.find((item) => item.joint === playing);
  const hits = collisionsAt(drive, value ?? 0);
  const unit = joint ? unitOf(joint) : coupling && kinematics ? couplingUnit(kinematics, coupling) : '';
  return (
    <AnimatePresence>
      {playing && (joint || coupling) && (
        <motion.div className={styles.hud} data-motion-hud={playing} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.16 }}>
          <span>{playing}</span>
          <span className={styles.hudValue}>{num(value ?? 0, 1)}{unit ? ` ${unit}` : ''}</span>
          {hits.length > 0 && <span className={styles.hudHit} data-collision>{hits.map((hit) => `${hit.a} ↔ ${hit.b}`).join(', ')}</span>}
          <IconButton small label="Pause" onClick={stop}><Pause size={13} /></IconButton>
          <IconButton small label="Stop and return to rest" onClick={resetPose}><Square size={12} /></IconButton>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
