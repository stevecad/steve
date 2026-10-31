/**
 * A command as a phone control: a tile in a grid (Tools, View) or a row in a list (All commands, search, menus).
 * Availability, the active state and the reason something can't run all come from the command registry. Touch has no
 * tooltips, so tapping an unavailable command says why instead of doing nothing.
 */
import type { ReactNode } from 'react';
import { availability, command, type Command } from '@/commands';
import { toast, useApp, type AppState } from '@/state/store';
import styles from './Phone.module.css';

function useCommandState(cmd: Command) {
  const value = useApp((state: AppState) => {
    const available = availability(cmd, state);
    return `${cmd.active?.(state) ? 1 : 0}${available === true ? '' : available}`;
  });
  return { active: value[0] === '1', reason: value.slice(1) || null };
}

export function runOrExplain(cmd: Command, reason: string | null, after?: () => void) {
  if (reason) { toast('info', cmd.label, reason); return; }
  after?.();
  cmd.run();
}

export function CommandTile({ id, after }: { id: string; after?: () => void }) {
  const cmd = command(id);
  const { active, reason } = useCommandState(cmd);
  const Icon = cmd.icon;
  return (
    <button type="button" className={styles.tile} data-command={cmd.id} data-active={active || undefined} aria-disabled={!!reason} aria-pressed={cmd.active ? active : undefined}
      aria-label={cmd.label} onClick={() => runOrExplain(cmd, reason, after)}>
      <Icon size={22} strokeWidth={1.55} />
      <span>{cmd.short ?? cmd.label}</span>
    </button>
  );
}

export function CommandRow({ cmd, after, hint }: { cmd: Command; after?: () => void; hint?: ReactNode }) {
  const { active, reason } = useCommandState(cmd);
  const Icon = cmd.icon;
  return (
    <button type="button" className={styles.row} data-command={cmd.id} data-active={active || undefined} aria-disabled={!!reason} onClick={() => runOrExplain(cmd, reason, after)}>
      <Icon size={19} strokeWidth={1.6} />
      <span className={styles.rowText}>
        <span>{cmd.label}</span>
        {(hint || (reason ?? cmd.description)) && <small>{hint ?? reason ?? cmd.description}</small>}
      </span>
    </button>
  );
}

/** A plain action row (not a registry command): the same look as CommandRow. */
export function ActionRow({ icon, label, detail, onClick, id, danger }: { icon: ReactNode; label: ReactNode; detail?: ReactNode; onClick: () => void; id?: string; danger?: boolean }) {
  return (
    <button type="button" className={styles.row} id={id} data-danger={danger || undefined} onClick={onClick}>
      {icon}
      <span className={styles.rowText}><span>{label}</span>{detail && <small>{detail}</small>}</span>
    </button>
  );
}
