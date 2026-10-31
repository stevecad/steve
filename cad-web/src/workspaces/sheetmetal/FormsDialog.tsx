/**
 * Form tools: the reusable `SheetMetalForm(kind, ...)` declarations in the open file (docs/SHEET_METAL_RIP_FORMS.md).
 * A tool is defined once and placed with `sheet_form` as often as needed; editing the tool changes every
 * placement. Edits rewrite the declaration in the code.
 */
import { useEffect, useState } from 'react';
import { Code2, Plus, Stamp } from 'lucide-react';
import { Button, Dialog } from '@/ui';
import { get, set, useApp } from '@/state/store';
import { setCode, updateModel } from '@/state/actions';
import { openFeature, setValue } from '@/modeling/dialog';
import { pyString, type ArgValue, type ModelDoc, type SheetRuleDecl } from '@/lib/modeling';
import { withImport } from './RulesDialog';
import styles from './Sheet.module.css';

type Kind = 'lance' | 'louver' | 'emboss' | 'dimple';
type Draft = Record<string, string>;

const DIMENSIONS: Record<string, [label: string, unit: string, hint: string]> = {
  width: ['Width', 'mm', ''],
  length: ['Length', 'mm', ''],
  gap: ['Cut gap', 'mm', 'Clearance cut around the formed material.'],
  diameter: ['Diameter', 'mm', 'The raised land, not the larger footprint.'],
  height: ['Height', 'mm', ''],
  hole_diameter: ['Formed hole Ø', 'mm', 'The hole’s diameter after forming.'],
  flat_hole_diameter: ['Pre-pierce Ø', 'mm', 'The hole cut in the blank before forming; 0 means pierce after forming.'],
  angle: ['Angle', '°', ''],
  radius: ['Radius', 'mm', 'Empty uses the sheet’s bend radius.'],
};

const KINDS: Record<Kind, { label: string; about: string; dims: string[]; defaults: Draft; angle: string }> = {
  lance: { label: 'Lance', dims: ['width', 'length', 'gap'], defaults: { width: '10', length: '20', gap: '0.5' }, angle: '30',
    about: 'A U-cut tab bent out of the panel. Length is the tab’s developed blank, bend included; the angle is the tab’s bend.' },
  louver: { label: 'Louver', dims: ['width', 'length', 'gap'], defaults: { width: '10', length: '20', gap: '0.5' }, angle: '30',
    about: 'An inclined roof with closed, drawn ends and an open front. Width is the clear roof; length the straight roof after its bend.' },
  emboss: { label: 'Emboss', dims: ['diameter', 'height'], defaults: { diameter: '12', height: '3' }, angle: '45',
    about: 'A round raised land with smooth transitions, for stiffness. The angle is the wall slope.' },
  dimple: { label: 'Dimple', dims: ['diameter', 'height', 'hole_diameter', 'flat_hole_diameter'], defaults: { diameter: '16', height: '4', hole_diameter: '8', flat_hole_diameter: '6' }, angle: '45',
    about: 'A round raised land with a formed hole, e.g. for a countersunk fastener. The angle is the wall slope.' },
};
const OPTIONAL = ['angle', 'radius'];
const TEXTS = [['name', 'Name'], ['source', 'Source']] as const;
const EDITED = new Set([...Object.keys(DIMENSIONS), 'name', 'source']);

const unquote = (arg: ArgValue | undefined) => (arg ? (typeof arg.value === 'string' && arg.kind === 'reference' ? arg.value : arg.source) : '');
const kindOf = (tool: SheetRuleDecl) => (typeof tool.args?.[0]?.value === 'string' ? tool.args[0].value : unquote(tool.kwargs?.kind)) as Kind;

function draftOf(tool: SheetRuleDecl): Draft {
  const draft: Draft = {};
  for (const key of Object.keys(DIMENSIONS)) draft[key] = tool.kwargs?.[key]?.source ?? '';
  for (const [key] of TEXTS) draft[key] = unquote(tool.kwargs?.[key]);
  return draft;
}

/** The declaration rewritten as `SheetMetalForm("kind", dims…, name=…, source=…)`; arguments the dialog doesn't edit keep their source. */
function callFor(kind: Kind, draft: Draft, tool?: SheetRuleDecl): string {
  const parts = [pyString(kind)];
  for (const key of [...KINDS[kind].dims, ...OPTIONAL]) if (draft[key]?.trim()) parts.push(`${key}=${draft[key].trim()}`);
  for (const [key] of TEXTS) if (draft[key]?.trim()) parts.push(`${key}=${pyString(draft[key].trim())}`);
  for (const [key, arg] of Object.entries(tool?.kwargs ?? {})) if (!EDITED.has(key) && key !== 'kind') parts.push(`${key}=${arg.source}`);
  return `SheetMetalForm(${parts.join(', ')})`;
}

const nextVariable = (doc: ModelDoc | null, kind: Kind) => {
  const used = new Set([...(doc?.sheet_forms ?? []), ...(doc?.sheet_rules ?? [])].map((decl) => decl.variable));
  let n = 1;
  while (used.has(`${kind}_${n}`)) n++;
  return `${kind}_${n}`;
};

/** Opens the Form dialog with this tool chosen. */
async function place(variable: string) {
  set({ dialog: null });
  await openFeature('sheet_form');
  setValue('tool', variable);
}

export default function FormsDialog({ open }: { open: boolean }) {
  const doc = useApp((state) => state.modeling);
  const tools = doc?.sheet_forms ?? [];
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  useEffect(() => { if (open) setDrafts(Object.fromEntries(tools.map((tool) => [tool.variable, draftOf(tool)]))); }, [open, doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => set({ dialog: null });
  const usedBy = (variable: string) => (doc?.features ?? []).filter((f) => f.kind === 'sheet_form' && f.args?.[0]?.source === variable).map((f) => f.id);
  const changed = tools.filter((tool) => tool.editable && JSON.stringify(drafts[tool.variable]) !== JSON.stringify(draftOf(tool)));
  const edit = (variable: string, key: string, value: string) => setDrafts((all) => ({ ...all, [variable]: { ...all[variable], [key]: value } }));

  const apply = () => {
    let code = get().doc.code;
    // Last first, so earlier spans stay valid.
    for (const tool of [...changed].sort((a, b) => b.call_span[0] - a.call_span[0])) {
      code = code.slice(0, tool.call_span[0]) + callFor(kindOf(tool), drafts[tool.variable], tool) + code.slice(tool.call_span[1]);
    }
    setCode(withImport(code, 'SheetMetalForm'));
    void updateModel();
  };
  const add = (kind: Kind) => {
    if (!doc?.model) return;
    const variable = nextVariable(doc, kind);
    const code = get().doc.code;
    const at = doc.model.span[0];
    const statement = `${variable} = ${callFor(kind, { ...KINDS[kind].defaults, name: `${KINDS[kind].label} ${variable.split('_').at(-1)}` })}\n`;
    setCode(withImport(code.slice(0, at) + statement + code.slice(at), 'SheetMetalForm'));
  };
  const reveal = (tool: SheetRuleDecl) => {
    close();
    set({ sourceReveal: { from: tool.span[0], to: tool.span[1], nonce: Date.now() }, dockOpen: true, dockTab: 'source' });
  };

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) close(); }} width={600} icon={<Stamp size={18} />} title="Form tools"
      description="Reusable lances, louvers, embosses and dimples. Define a tool once, place it with Form as often as you need; changing the tool changes every placement."
      footer={<>
        <span className={styles.addForms}>
          <Plus size={13} />New
          {(Object.keys(KINDS) as Kind[]).map((kind) => (
            <Button key={kind} size="sm" variant="ghost" onClick={() => add(kind)} disabled={!doc?.model} id={`add-form-${kind}`}>{KINDS[kind].label}</Button>
          ))}
        </span>
        <span style={{ flex: 1 }} />
        <Button size="sm" onClick={close}>Close</Button>
        <Button size="sm" variant="primary" onClick={() => { apply(); close(); }} disabled={!changed.length} id="apply-form-tools">Apply</Button>
      </>}>
      <div className={styles.rules} id="form-tools">
        {!tools.length && <p className={styles.muted}>No form tools yet. Add one below, then place it on a flat panel with Form.</p>}
        {tools.map((tool) => {
          const kind = kindOf(tool);
          const spec = KINDS[kind];
          const draft = drafts[tool.variable] ?? draftOf(tool);
          const users = usedBy(tool.variable);
          return (
            <div key={tool.variable} className={styles.rule} data-form-tool={tool.variable} data-readonly={!tool.editable || !spec || undefined}>
              <div className={styles.ruleHead}>
                <code>{tool.variable}</code>
                <span>{spec ? spec.label : kind}{users.length ? ` · placed as ${users.join(', ')}` : ' · not placed yet'}</span>
                {tool.editable && spec && <button type="button" className={styles.linkButton} onClick={() => { void place(tool.variable); }} data-place-form={tool.variable}><Plus size={12} />Place</button>}
              </div>
              {!tool.editable || !spec ? <p className={styles.muted}>Written as custom code. <button type="button" className={styles.linkButton} onClick={() => reveal(tool)}><Code2 size={12} />Edit in Source</button></p> : <>
                <p className={styles.formAbout}>{spec.about}</p>
                <div className={`${styles.ruleGrid} ${styles.formGrid}`}>
                  {[...spec.dims, ...OPTIONAL].map((key) => {
                    const [label, unit, hint] = DIMENSIONS[key];
                    return (
                      <label key={key} title={hint || undefined}><span>{label}{spec.dims.includes(key) && <sup>•</sup>}</span>
                        <span className={styles.ruleInput}><input value={draft[key] ?? ''} aria-label={`${tool.variable} ${label}`}
                          placeholder={key === 'angle' ? spec.angle : key === 'radius' ? 'sheet' : ''} onChange={(event) => edit(tool.variable, key, event.target.value)} /><em>{unit}</em></span>
                      </label>
                    );
                  })}
                  {TEXTS.map(([key, label]) => (
                    <label key={key} data-wide><span>{label}</span><span className={styles.ruleInput}><input value={draft[key] ?? ''} aria-label={`${tool.variable} ${label}`}
                      placeholder={key === 'source' ? 'e.g. Supplier tool catalogue, punch 4471' : ''} onChange={(event) => edit(tool.variable, key, event.target.value)} /></span></label>
                  ))}
                </div>
              </>}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
