/**
 * "Can I order this board?" (docs/ELECTRONICS.md, "Readiness"), answered where the board is: a chip under the views
 * (green "Ready to order", else how many issues stand in the way) that opens the list of them. Each issue says what's
 * wrong in plain words, how to fix it, the measured value against the limit, and why (its source); it selects what it's
 * about, jumps to the code, or goes to STEVE. Stock is the nightly catalogue snapshot for the order quantity, not live.
 */
import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, AlertTriangle, Check, Clock3, Code2, Crosshair, ExternalLink, Info, Sparkles, Wand2, X } from 'lucide-react';
import { useApp } from '@/state/store';
import { Button, Dialog, IconButton, NumberField, Spinner, Tip } from '@/ui';
import { focusSelection, selectParts, useCircuit } from './state';
import {
  checkName, directFix, fixWithSteve, issueParts, measuredText, openReadiness, profileName, setOrderQuantity, useExportGuard, useReadiness, useReadinessView,
  type ReadinessIssue,
} from './readiness';
import { plainMessage } from './circuit';
import { revealLine } from './reveal';
import { RouteIssueAction } from '@/workspaces/electronics/RoutingView';
import styles from './Electronics.module.css';
import { safeHref } from '@/lib/safeUrl';

const ICONS = { blocking: AlertCircle, advisory: AlertTriangle, info: Info };

/** The verdict, always under the views: what stands between this board and an order. */
export function VerdictChip() {
  const view = useReadinessView();
  const open = useReadiness((state) => state.open);
  if (!view.available) return null;
  const count = view.blocking.length;
  // A board with no parts yet isn't a problem to fix, just a start.
  const empty = count === 1 && view.blocking[0].rule === 'board.empty';
  const tone = empty ? 'empty' : view.verdict === 'ready' ? 'ready' : view.verdict === 'checking' ? 'checking' : 'blocked';
  const label = tone === 'empty' ? 'Empty board' : tone === 'ready' ? 'Ready to order' : tone === 'checking' ? 'Checking stock…' : `${count} ${count === 1 ? 'issue' : 'issues'} before ordering`;
  return (
    <Tip label={tone === 'empty' ? 'Nothing to order yet' : tone === 'ready' ? 'Ready to order' : tone === 'checking' ? 'Checking stock' : 'Not ready to order yet'}
      description={tone === 'empty' ? 'Place parts, or ask STEVE to design the circuit; the checks start once there’s something on the board.'
        : tone === 'ready' ? `Meets ${profileName(view.readiness?.fab_profile)} limits, the electrical checks and parts in stock.${view.advisories.length ? ` ${view.advisories.length} notes to look at.` : ''}`
        : tone === 'checking' ? 'Checking parts against JLCPCB’s stock for your order.' : 'Open the list to see what to fix, or hand it to STEVE.'}>
      <button type="button" className={styles.verdict} data-tone={tone} data-open={open || undefined} id="readiness-chip" onClick={() => openReadiness(!open)} aria-expanded={open}>
        {tone === 'ready' ? <Check size={13} strokeWidth={2.4} /> : tone === 'checking' ? <Spinner size={11} /> : tone === 'empty' ? <Info size={13} /> : <AlertCircle size={13} />}
        <span>{label}</span>
        {tone === 'ready' && view.advisories.length > 0 && <small>{view.advisories.length} {view.advisories.length === 1 ? 'note' : 'notes'}</small>}
      </button>
    </Tip>
  );
}

function IssueRow({ issue, index }: { issue: ReadinessIssue; index: number }) {
  const model = useCircuit((state) => state.model);
  const json = useCircuit((state) => state.json);
  const code = useApp((state) => state.doc.code);
  const quick = directFix(issue, code, json);
  const Icon = ICONS[issue.severity] ?? Info;
  const parts = issueParts(issue, model?.partOf);
  const net = issue.net ? model?.nets.find((item) => item.name === issue.net) : null;
  const measured = measuredText(issue);
  const select = () => {
    if (net) useCircuit.setState({ net: net.key, selection: [...new Set(net.ports.map((port) => port.part))] });
    else if (parts.length) selectParts(parts);
    focusSelection();
  };
  return (
    <motion.li className={styles.issue} data-severity={issue.severity} data-rule={issue.rule} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, delay: Math.min(index, 8) * 0.012 }}>
      <span className={styles.issueIcon}><Icon size={15} /></span>
      <div className={styles.issueBody}>
        <p className={styles.issueMessage}>{plainMessage(issue.message)}</p>
        {issue.fix && <p className={styles.issueFix}><b>Fix</b> {issue.fix}</p>}
        {measured && <p className={styles.issueMeasured}>{measured}</p>}
        <div className={styles.issueActions}>
          {issue.rule === 'routing.not_routed' && <RouteIssueAction />}
          {quick && <button type="button" className={styles.issueQuick} data-fix onClick={quick.apply}><Wand2 size={12} />{quick.label}</button>}
          {(parts.length > 0 || net) && <button type="button" onClick={select}><Crosshair size={12} />{net ? net.name : parts.slice(0, 3).join(', ')}{parts.length > 3 ? '…' : ''}</button>}
          {(issue.source_line || parts.length > 0) && !issue.file && (
            <button type="button" onClick={() => revealLine(issue.source_line ?? null)}><Code2 size={12} />{issue.source_line ? `Line ${issue.source_line}` : 'Code'}</button>
          )}
          {issue.source && safeHref(issue.source.url) && (
            <a href={safeHref(issue.source.url)} target="_blank" rel="noopener noreferrer" title={[issue.source.name, issue.source.detail].filter(Boolean).join(' · ')}><ExternalLink size={12} />Why?</a>
          )}
          {issue.severity !== 'info' && <button type="button" className={styles.issueSteve} onClick={() => { void fixWithSteve([issue]); }}><Sparkles size={12} />Fix with STEVE</button>}
        </div>
      </div>
    </motion.li>
  );
}

function asOf(iso: string | undefined) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function ReadinessPanel() {
  const open = useReadiness((state) => state.open);
  const view = useReadinessView();
  const quantity = useReadiness((state) => state.quantity);
  const circuitView = useCircuit((state) => state.view);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !(event.target as HTMLElement | null)?.closest('input, textarea, .cm-editor')) { openReadiness(false); event.stopPropagation(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  const stock = view.stock;
  const overlay = stock?.status === 'ready' ? stock.overlay : null;
  return (
    <AnimatePresence>
      {open && view.available && (
        <motion.div ref={panel} className={styles.readiness} id="readiness-panel" role="dialog" aria-label="Ready to order?" data-view={circuitView}
          initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.12 } }}
          transition={{ type: 'spring', stiffness: 420, damping: 34 }}>
          <header className={styles.readinessHead} data-tone={view.verdict}>
            <div>
              <h3>{view.verdict === 'ready' ? 'Ready to order' : view.verdict === 'checking' ? 'Checking…' : `${view.blocking.length} ${view.blocking.length === 1 ? 'issue' : 'issues'} before ordering`}</h3>
              <p>{profileName(view.readiness?.fab_profile)}{view.readiness?.assembly ? ' · with assembly' : ''} · {view.readiness?.checked?.length ?? 0} checks{view.readiness?.after_routing?.length ? ` · ${view.readiness.after_routing.length} after routing` : ''}</p>
            </div>
            <IconButton small label="Close" shortcut="Esc" onClick={() => openReadiness(false)}><X /></IconButton>
          </header>
          <div className={styles.readinessBar}>
            <label className={styles.quantity}>
              <span>Order</span>
              <NumberField unit="" integer min={1} max={100000} ariaLabel="Order quantity" id="order-quantity" value={quantity} onChange={setOrderQuantity} />
              <span>boards</span>
            </label>
            <span className={styles.stockNote} id="stock-as-of">
              {stock?.status === 'loading' ? <><Spinner size={10} /> Checking stock…</>
                : overlay ? <>Stock as of {asOf(overlay.stock_as_of)} · not live</>
                : stock?.status === 'failed' ? 'Stock couldn’t be checked'
                : stock?.status === 'missing' ? 'Stock isn’t checked on this server' : ''}
            </span>
          </div>
          <div className={styles.readinessBody}>
            {view.blocking.length > 0 && (
              <>
                <div className={styles.readinessSection}>
                  <span>Before ordering</span>
                  <Button size="sm" variant="primary" icon={<Sparkles />} id="fix-all" onClick={() => { void fixWithSteve(view.blocking); }}>Fix all with STEVE</Button>
                </div>
                <ul className={styles.issues} id="readiness-blocking">{view.blocking.map((issue, index) => <IssueRow key={`${issue.rule}:${index}`} issue={issue} index={index} />)}</ul>
              </>
            )}
            {view.blocking.length === 0 && view.verdict === 'ready' && (
              <div className={styles.readinessOk}>
                <span className={styles.readinessOkIcon}><Check size={18} strokeWidth={2.4} /></span>
                <p>Nothing stands in the way: the board meets {profileName(view.readiness?.fab_profile)}’s limits and the electrical checks, and every part is in stock for {quantity} {quantity === 1 ? 'board' : 'boards'}. Export the fabrication files to order it.</p>
              </div>
            )}
            {view.advisories.length > 0 && (
              <>
                <div className={styles.readinessSection}><span>Worth a look</span></div>
                <ul className={styles.issues} id="readiness-advisories">{view.advisories.map((issue, index) => <IssueRow key={`${issue.rule}:${index}`} issue={issue} index={index + view.blocking.length} />)}</ul>
              </>
            )}
            {!!view.readiness?.after_routing?.length && (
              <>
                <div className={styles.readinessSection}><span>Checked after routing</span></div>
                <ul className={styles.afterRouting} id="readiness-after-routing">
                  {view.readiness.after_routing.map((rule) => (
                    <li key={rule} data-rule={rule}><Clock3 size={13} />{checkName(rule, view.readiness?.after_routing_titles)}<small>waits for the copper</small></li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Exporting the fabrication files of a board that isn't ready to order: say so, and let the person choose. */
export function ExportGuard() {
  const pending = useExportGuard((state) => state.pending);
  const count = useExportGuard((state) => state.count);
  const close = () => useExportGuard.setState({ pending: null });
  return (
    <Dialog open={!!pending} onOpenChange={(open) => { if (!open) close(); }} width={460}
      title="This board isn’t ready to order" icon={<AlertCircle size={18} style={{ color: 'var(--danger)' }} />}
      description={`${count} ${count === 1 ? 'issue stands' : 'issues stand'} in the way. A board house would reject these files, or the boards wouldn’t work as drawn.`}
      footer={(
        <>
          <Button variant="ghost" id="export-anyway" onClick={() => { const run = pending; close(); run?.(); }}>Export anyway</Button>
          <Button variant="primary" id="export-show-issues" onClick={() => { close(); openReadiness(true); }}>Show the issues</Button>
        </>
      )}>
      <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-2)', lineHeight: 1.55 }}>Fix them first, or hand them to STEVE from the list. Export anyway is for checking the files themselves.</p>
    </Dialog>
  );
}
