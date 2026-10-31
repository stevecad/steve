/**
 * Sheet metal rules: the named `SheetMetalRule(...)` declarations in the open file (docs/SHEET_METAL.md),
 * which several sheets can share through `rule=`. Edits rewrite the declaration in the code; gauge and
 * bend tables are shown, and edited in Source (they are tables of shop data).
 */
import { useEffect, useRef, useState } from 'react';
import { Code2, Plus, Ruler } from 'lucide-react';
import { Button, Dialog } from '@/ui';
import { get, set, useApp } from '@/state/store';
import { holdPreview, previewCode, releasePreview, setCode, showPreview, updateModel } from '@/state/actions';
import { modelingReport, parseModel, pyString, type ArgValue, type ModelDoc, type SheetRuleDecl } from '@/lib/modeling';
import { loadLibrary, materialRecord } from '@/lib/materials';
import styles from './Sheet.module.css';

const FIELDS = [
  ['thickness', 'Thickness', 'mm'],
  ['radius', 'Bend radius', 'mm'],
  ['k_factor', 'K-factor', ''],
] as const;
const TEXTS = [['name', 'Name'], ['material', 'Material ID'], ['source', 'Source']] as const;
type Draft = Record<string, string>;

const unquote = (arg: ArgValue | undefined) => (arg ? (typeof arg.value === 'string' && arg.kind === 'reference' ? arg.value : arg.source) : '');

/** The rule's values as the dialog edits them: numbers as Python sources, texts unquoted. */
function draftOf(rule: SheetRuleDecl): Draft {
  const positional = ['thickness', 'radius', 'k_factor'];
  const draft: Draft = {};
  positional.forEach((key, index) => { draft[key] = rule.kwargs?.[key]?.source ?? rule.args?.[index]?.source ?? ''; });
  for (const [key] of TEXTS) draft[key] = unquote(rule.kwargs?.[key]);
  return draft;
}

/** The declaration rewritten as keywords; arguments the dialog doesn't edit (gauge, bend_table) keep their source. */
function callFor(rule: SheetRuleDecl, draft: Draft): string {
  const parts: string[] = [];
  for (const [key] of FIELDS) if (draft[key]?.trim()) parts.push(`${key}=${draft[key].trim()}`);
  for (const [key] of TEXTS) if (draft[key]?.trim()) parts.push(`${key}=${pyString(draft[key].trim())}`);
  for (const [key, arg] of Object.entries(rule.kwargs ?? {})) if (!['thickness', 'radius', 'k_factor', 'name', 'material', 'source'].includes(key)) parts.push(`${key}=${arg.source}`);
  return `SheetMetalRule(${parts.join(', ')})`;
}

/** Adds `name` (e.g. `SheetMetalRule`) to the file's `from steve import …` line (or adds the line). */
export function withImport(code: string, name = 'SheetMetalRule'): string {
  if (new RegExp(`^from\\s+steve\\s+import\\b[^\\n]*\\b${name}\\b`, 'm').test(code)) return code;
  const line = /^from\s+steve\s+import\s+([^\n(]+)$/m.exec(code);
  if (line) return code.slice(0, line.index) + `from steve import ${line[1].trim()}, ${name}` + code.slice(line.index + line[0].length);
  return `from steve import ${name}\n${code}`;
}

const nextVariable = (code: string, added: SheetRuleDecl[]) => {
  const used = new Set([...code.matchAll(/\b[A-Za-z_]\w*\b/g)].map((match) => match[0]));
  for (const rule of added) used.add(rule.variable);
  let n = 1;
  while (used.has(`rule_${n}`)) n++;
  return `rule_${n}`;
};

function newRule(variable: string): SheetRuleDecl {
  const values = { thickness: 1.5, radius: 1.5, k_factor: 0.44, name: `Rule ${variable.slice(5)}`, source: "Estimate: replace with your shop's values" };
  return { variable, kind: 'sheet_rule', constructor: 'SheetMetalRule', editable: true, args: [], span: [0, 0], call_span: [0, 0], line: 0,
    kwargs: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { source: typeof value === 'string' ? pyString(value) : String(value), value, kind: typeof value === 'string' ? 'reference' : 'literal', span: [0, 0] }])) };
}

export default function RulesDialog({ open }: { open: boolean }) {
  const busy = useApp((state) => state.busy);
  const [base, setBase] = useState<{ code: string; doc: ModelDoc | null }>(() => ({ code: get().doc.code, doc: get().modeling }));
  const [added, setAdded] = useState<SheetRuleDecl[]>([]);
  const doc = base.doc;
  const declarations = [...(doc?.sheet_rules ?? []), ...added];
  const rules = declarations.filter((rule) => rule.constructor === 'SheetMetalRule');
  const others = declarations.filter((rule) => rule.constructor !== 'SheetMetalRule');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    if (open) {
      const state = get();
      setBase({ code: state.doc.code, doc: state.modeling }); setAdded([]); setError('');
      setDrafts(Object.fromEntries((state.modeling?.sheet_rules ?? []).map((rule) => [rule.variable, draftOf(rule)])));
    }
  }, [open]);
  useEffect(() => () => {
    ++request.current;
    if (inFlight.current) void releasePreview(holdPreview(), null);
  }, []);
  const close = () => {
    ++request.current;
    if (inFlight.current) { inFlight.current = false; void releasePreview(holdPreview(), null); }
    setChecking(false);
    set({ dialog: null });
  };
  const usedBy = (variable: string) => (doc?.features ?? []).filter((f) => f.kwargs?.rule?.kind === 'sheet_rule' && f.kwargs.rule.value === variable).map((f) => f.id);
  const changed = (doc?.sheet_rules ?? []).filter((rule) => rule.editable && JSON.stringify(drafts[rule.variable] ?? draftOf(rule)) !== JSON.stringify(draftOf(rule)));
  const edit = (variable: string, key: string, value: string) => { setError(''); setDrafts((all) => ({ ...all, [variable]: { ...all[variable], [key]: value } })); };

  const apply = async () => {
    if (checking || busy) return;
    if (get().doc.code !== base.code) { setError('The source changed while this dialog was open. Close and reopen Rules to edit the latest version.'); return; }
    const run = ++request.current;
    inFlight.current = true; setChecking(true); setError('');
    try {
      const materials = [...changed, ...added].map((rule) => ({ rule: rule.variable, id: drafts[rule.variable]?.material?.trim() })).filter((item) => item.id);
      if (materials.length) {
        await loadLibrary();
        if (run !== request.current) return;
        const missing = materials.find((item) => !materialRecord(item.id));
        if (missing) throw new Error(`${missing.rule}: material ID “${missing.id}” is not in the material library. Use a library ID, or leave Material ID empty.`);
      }
      // Stage every edit before touching the source, including newly added declarations.
      const edits = changed.map((rule) => ({ span: rule.call_span, text: callFor(rule, drafts[rule.variable]) }));
      if (added.length && doc?.model) edits.push({ span: [doc.model.span[0], doc.model.span[0]], text: added.map((rule) => `${rule.variable} = ${callFor(rule, drafts[rule.variable] ?? draftOf(rule))}\n`).join('') });
      let code = base.code;
      for (const edit of edits.sort((a, b) => b.span[0] - a.span[0])) code = code.slice(0, edit.span[0]) + edit.text + code.slice(edit.span[1]);
      code = withImport(code);
      const parsed = await parseModel(code);
      if (run !== request.current) return;
      const syntax = parsed.diagnostics.find((item) => item.severity === 'error');
      if (syntax) throw new Error(syntax.message);
      // Use the actual CAD runtime: rule expressions, bend tables and downstream
      // geometry must all succeed. Keep the last good geometry on screen meanwhile.
      const build = await previewCode(code, { show: false });
      if (run !== request.current) return;
      if (!build) throw new Error('Validation was interrupted. Apply again when the model is idle.');
      if (build.status === 'failed') throw new Error((build.error ?? 'The rule could not be built.').trim().split('\n').filter(Boolean).at(-1));
      const failed = modelingReport(build.metadata, get().doc.activeFile)?.features.find((feature) => feature.status === 'error');
      if (failed) throw new Error(failed.error ?? `${failed.id} could not be built with this rule.`);
      if (get().doc.code !== base.code) throw new Error('The source changed during validation. Close and reopen Rules to edit the latest version.');
      inFlight.current = false; close();
      setCode(code);
      const shown = await showPreview(build);
      if (shown) set({ error: '', phase: 'succeeded', phaseLabel: 'Model ready' });
      if (!shown) void updateModel();
    } catch (caught) {
      if (run === request.current) setError((caught as Error).message);
    } finally {
      if (run === request.current) { inFlight.current = false; setChecking(false); }
    }
  };
  const add = () => {
    if (!doc?.model) return;
    const rule = newRule(nextVariable(base.code, added));
    setAdded((all) => [...all, rule]); setDrafts((all) => ({ ...all, [rule.variable]: draftOf(rule) })); setError('');
  };
  const reveal = (rule: SheetRuleDecl) => {
    close();
    set({ sourceReveal: { from: rule.span[0], to: rule.span[1], nonce: Date.now() }, dockOpen: true, dockTab: 'source' });
  };

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) close(); }} width={560} icon={<Ruler size={18} />} title="Sheet metal rules"
      description="Named rules your sheets can share with rule=…: thickness, inside radius and K-factor (or a bend table), and where the numbers come from."
      footer={<>
        <Button size="sm" icon={<Plus />} onClick={add} disabled={!doc?.model || checking} id="add-sheet-rule">New rule</Button>
        <span style={{ flex: 1 }} />
        <Button size="sm" onClick={close}>Cancel</Button>
        <Button size="sm" variant="primary" onClick={() => void apply()} disabled={checking || busy || (!changed.length && !added.length)} id="apply-sheet-rules">{checking ? 'Checking…' : 'Apply'}</Button>
      </>}>
      <div className={styles.rules} id="sheet-rules">
        {error && <p role="alert" className={styles.ruleError}>{error}<small>Your changes have not been applied.</small></p>}
        {!declarations.length && <p className={styles.muted}>No named rules yet. A base flange can carry its own values; add a rule when several sheets should share one, or to record where the numbers come from.</p>}
        {rules.map((rule) => {
          const draft = drafts[rule.variable] ?? draftOf(rule);
          const users = usedBy(rule.variable);
          return (
            <div key={rule.variable} className={styles.rule} data-rule={rule.variable}>
              <div className={styles.ruleHead}><code>{rule.variable}</code><span>{users.length ? `Used by ${users.join(', ')}` : 'Not used yet'}</span></div>
              {!rule.editable ? <p className={styles.muted}>Written as custom code. <button type="button" className={styles.linkButton} onClick={() => reveal(rule)}>Edit in Source</button></p> : (
                <div className={styles.ruleGrid}>
                  {FIELDS.map(([key, label, unit]) => (
                    <label key={key}><span>{label}</span><span className={styles.ruleInput}><input disabled={checking} value={draft[key] ?? ''} aria-label={`${rule.variable} ${label}`} placeholder={key === 'k_factor' ? 'from table' : ''}
                      onChange={(event) => edit(rule.variable, key, event.target.value)} />{unit && <em>{unit}</em>}</span></label>
                  ))}
                  {TEXTS.map(([key, label]) => (
                    <label key={key} data-wide={key !== 'material' || undefined}><span>{label}</span><span className={styles.ruleInput}><input disabled={checking} value={draft[key] ?? ''} aria-label={`${rule.variable} ${label}`}
                      placeholder={key === 'source' ? 'e.g. Shop calibration, Oct 2026' : key === 'material' ? 'e.g. steel-1c22 (optional)' : ''} onChange={(event) => edit(rule.variable, key, event.target.value)} /></span></label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {others.map((rule) => (
          <div key={rule.variable} className={styles.rule} data-rule={rule.variable} data-readonly>
            <div className={styles.ruleHead}>
              <code>{rule.variable}</code>
              <span>{rule.constructor === 'GaugeTable.rule' ? 'A rule from a gauge table' : rule.kind === 'gauge_table' ? 'Gauge table' : 'Bend table'}
                {typeof rule.kwargs?.name?.value === 'string' ? ` · ${rule.kwargs.name.value}` : ''}</span>
              <button type="button" className={styles.linkButton} onClick={() => reveal(rule)}><Code2 size={12} />Edit in Source</button>
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
