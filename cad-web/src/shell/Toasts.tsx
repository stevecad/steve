import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { Check, CircleAlert, CircleCheck, Copy, Info, TriangleAlert, X } from 'lucide-react';
import { dismissToast, holdToast, useApp, type Toast } from '@/state/store';
import { copyText } from '@/lib/clipboard';
import { openBugReport, useFeedback } from '@/feedback/feedback';
import { usePresent } from '@/present/state';
import styles from './Toasts.module.css';

const ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert };

export default function Toasts() {
  const all = useApp((state) => state.toasts);
  const reporting = useFeedback((state) => state.enabled);
  // Presentation view keeps the picture clear: only errors show, over the full window.
  const presenting = usePresent((state) => state.active);
  const toasts = presenting ? all.filter((toast) => toast.tone === 'danger') : all;
  const docked = useApp((state) => (state.dockOpen && window.innerWidth > 900 ? state.dockWidth : 0));
  const offset = presenting ? 0 : docked;
  return (
    <div className={styles.stack} style={{ right: offset + 16 }} aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => {
          const Icon = ICONS[toast.tone];
          return (
            <motion.div
              key={toast.id}
              layout
              className={styles.toast}
              data-tone={toast.tone}
              role={toast.tone === 'danger' ? 'alert' : 'status'}
              initial={{ opacity: 0, y: 14, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 24, transition: { duration: 0.16 } }}
              transition={{ type: 'spring', stiffness: 460, damping: 34 }}
              onMouseEnter={() => holdToast(toast.id, true)}
              onMouseLeave={() => holdToast(toast.id, false)}
            >
              <Icon size={16} className={styles.icon} />
              <div className={styles.text}>
                <div className={styles.title}>{toast.title}</div>
                {toast.detail && <div className={styles.detail}>{toast.detail}</div>}
                {toast.action && <button type="button" className={styles.action} onClick={() => { toast.action!.run(); dismissToast(toast.id); }}>{toast.action.label}</button>}
                {toast.link && <button type="button" className={styles.action} data-toast-link onClick={() => toast.link!.run()}>{toast.link.label}</button>}
                {reporting && toast.tone === 'danger' && (
                  <button type="button" className={styles.action} data-report-toast onClick={() => { openBugReport(toast.report ?? `${toast.title}${toast.detail ? `\n${toast.detail}` : ''}`); dismissToast(toast.id); }}>Report this</button>
                )}
              </div>
              {(toast.tone === 'danger' || toast.tone === 'warning') && <CopyToast toast={toast} />}
              <button type="button" className={styles.close} aria-label="Dismiss" onClick={() => dismissToast(toast.id)}><X size={13} /></button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

function CopyToast({ toast }: { toast: Toast }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText([toast.title, toast.detail].filter(Boolean).join('\n'))) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
  };
  return <button type="button" className={`${styles.close} ${styles.copy}`} aria-label={copied ? 'Copied' : 'Copy message'} title={copied ? 'Copied' : 'Copy message'} onClick={() => void copy()}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>;
}
