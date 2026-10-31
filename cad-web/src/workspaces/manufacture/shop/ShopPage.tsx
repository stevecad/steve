/**
 * The shop in the Manufacturing library: the workspace's machines (with their controllers), tool setups and the shop's
 * code, and Steve's read-only catalogue to start from. Everything shown comes from the shop document's build; every
 * form edits the shop's code (shopCode.ts) and saves it through the document save and build (state.ts changeShop).
 */
import { useEffect, useId, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Factory, Link2, Pencil, Plus, RefreshCw, X } from 'lucide-react';
import { Button, Menu, MenuContent, MenuItem, MenuTrigger, Select, Spinner } from '@/ui';
import { SectionPane } from '@/ui/SectionedDialog';
import { useShopTarget } from '@/state/codeTargets';
import TargetEditor from '@/panels/source/TargetEditor';
import { useMfg } from '../state';
import DraftNumber from '../TextNumber';
import type { CatalogueEntry } from '../api';
import {
  allFiles, importOf, pyNumber, pyString, setCallArgument, shopView, withCatalogueController, withCatalogueMachine, withFile, withMachineController,
  withCatalogueHolder, withMachineSpec, withNewToolSetup, withShopLink, withTool, withToolInSetup, withoutToolInSetup, freeToolNumber, type CutterSpec, type ControllerInfo, type MachineCard, type MachineSpec, type ShopSource, type ToolTable,
} from './shopCode';
import { changeShop, createShop, loadCatalogue, loadShop, shopRecords, showShop, sourceOf, useShop } from './state';
import styles from './Shop.module.css';

type Tab = 'machines' | 'tools' | 'code';
const rpm = (value: number) => `${value.toLocaleString()} rpm`;
const mm = (value: number) => `${Number(value.toFixed(1)).toLocaleString()}`;
const changerText = (changer: { mode: string; pockets: number }) => (changer.mode === 'manual' || !changer.pockets ? 'Manual tool changes' : `${changer.pockets}-pocket ${changer.mode === 'magazine' ? 'magazine' : changer.mode}`);
/** "Tormach 1100MX (10k BT30, manual changes)" → "Tormach 1100MX": the name a machine starts with. */
const shortName = (name: string) => name.replace(/\s*\(.*\)\s*$/, '').trim() || name;

function Status({ executable }: { executable: boolean }) {
  return executable
    ? <span className={styles.status} data-tone="ok" title="Steve writes and checks G-code for this controller">Executable</span>
    : <span className={styles.status} data-tone="saved" title="Set up, plan and simulate; posting waits until Steve supports this controller">Saved only</span>;
}

/** Where a shop item comes from, for the "change it in the code" path. */
const where = (item: { file: string; line: number }) => `${item.file}, line ${item.line}`;

/** The controllers a machine can be fitted with: the shop's own (that another file can import) and the catalogue's. */
function controllerChoices(source: ShopSource | null, controllers: ControllerInfo[], catalogue: CatalogueEntry[], executable: string[], forFile: string) {
  const own = controllers.flatMap((item) => {
    const found = source ? importOf(source, item) : null;
    return found && (found.module || forFile === 'main.py') ? [{ value: `shop:${item.key}`, label: item.name, hint: item.executable ? undefined : 'saved only', found }] : [];
  });
  const ownKeys = new Set(controllers.map((item) => item.key));
  const listed = catalogue.filter((item) => item.kind === 'controller' && !ownKeys.has(item.key)).map((item) => ({
    value: `catalogue:${item.key}`, label: item.name, hint: executable.includes(item.dialect ?? '') || item.status === 'executable' ? 'catalogue' : 'catalogue · saved only', item,
  }));
  return { own, listed, options: [...own.map(({ value, label, hint }) => ({ value, label, hint })), ...listed.map(({ value, label, hint }) => ({ value, label, hint }))] };
}

/** Fits a controller chosen in a form into the source (cloning a catalogue one), for `file`'s machine. */
function fitted(source: ShopSource, choice: string, choices: ReturnType<typeof controllerChoices>, taken: string[]):
  { source: ShopSource; controller: { module: string | null; variable: string } } | string {
  const own = choices.own.find((item) => item.value === choice);
  if (own) return { source, controller: own.found };
  const listed = choices.listed.find((item) => item.value === choice);
  if (!listed) return 'Choose the controller fitted to this machine.';
  const catalogue = useShop.getState().catalogue;
  if (!catalogue?.document_id || !catalogue.revision) return 'Steve’s catalogue isn’t published on this server yet.';
  const linked = withShopLink(source, catalogue.document_id, catalogue.name, catalogue.revision, 'catalogue');
  return withCatalogueController(linked.source, linked.alias, { key: listed.item.key, name: listed.item.name }, taken);
}

// ── Machines ──────────────────────────────────────────────────────────────

/** A form field: its label wired to its control (`htmlFor`), so it reads (and finds) by its name. */
function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return <div className={styles.field}><label htmlFor={id}>{label}</label>{children}</div>;
}

/** A number in a form's text draft (blank allowed), scrubbable; the label says its unit. */
const TextNumber = (props: React.ComponentProps<typeof DraftNumber>) => <DraftNumber className={styles.input} {...props} />;

const TAPERS = ['bt30', 'bt40', 'cat40', 'iso30', 'iso40', 'sk40', 'hsk63a', 'r8', 'er20', 'er32'];

function MachineEditor({ card, onDone }: { card: MachineCard; onDone: () => void }) {
  const { doc, build, catalogue, executable } = useShop();
  const view = useMemo(() => shopView(shopRecords(build), executable), [build, executable]);
  const source = doc ? sourceOf(doc) : null;
  const choices = controllerChoices(source, view.controllers, catalogue?.items ?? [], executable, card.file);
  const id = useId();
  const [name, setName] = useState(card.name);
  const [controller, setController] = useState(card.controller ? `shop:${card.controller.key}` : '');
  const [maxRpm, setMaxRpm] = useState(card.spindle ? String(card.spindle.maxRpm) : '');
  const [taper, setTaper] = useState(card.spindle?.interface ?? '');
  const magazine = card.changer.mode !== 'manual' && card.changer.pockets > 0;
  const [changer, setChanger] = useState<'manual' | 'magazine'>(magazine ? 'magazine' : 'manual');
  const [pockets, setPockets] = useState(String(magazine ? card.changer.pockets : 12));
  const save = async () => {
    const renamed = name.trim() && name.trim() !== card.name;
    const refit = controller && controller !== `shop:${card.controller?.key}`;
    const spec: MachineSpec = {};
    const rpmValue = Number(maxRpm);
    if (card.spindle && maxRpm.trim() && Number.isFinite(rpmValue) && rpmValue > 0 && rpmValue !== card.spindle.maxRpm) spec.maxRpm = rpmValue;
    if (card.spindle && taper.trim() && taper.trim().toLowerCase() !== card.spindle.interface.toLowerCase()) spec.interface = taper.trim().toLowerCase();
    const pocketCount = Math.round(Number(pockets));
    if (changer !== (magazine ? 'magazine' : 'manual') || (changer === 'magazine' && pocketCount !== card.changer.pockets)) {
      if (changer === 'magazine' && !(pocketCount >= 1)) return;
      spec.changer = changer === 'manual' ? { mode: 'manual' } : { mode: 'magazine', pockets: pocketCount };
    }
    const respec = Object.keys(spec).length > 0;
    if (!renamed && !refit && !respec) { onDone(); return; }
    const ok = await changeShop(`${card.name} changed`, (latest, records) => {
      let next = latest;
      if (refit) {
        const chosen = fitted(next, controller, choices, records.map((item) => item.key));
        if (typeof chosen === 'string') return chosen;
        const changed = withMachineController(chosen.source, card, chosen.controller);
        if (typeof changed === 'string') return changed;
        next = changed;
      }
      if (respec) {
        if (!card.model) return `Change it in the code: ${where(card)}.`;
        const changed = withMachineSpec(next, card.model, spec, {
          interface: card.spindle?.interface ?? '', changer: magazine ? { mode: 'magazine', pockets: card.changer.pockets } : { mode: 'manual' },
        });
        if (typeof changed === 'string') return changed;
        next = changed;
      }
      if (renamed) {
        const content = allFiles(next)[card.file];
        const line = content === undefined ? null : setCallArgument(content, card.key, card.line, { position: 1 }, pyString(name.trim()));
        if (!line) return `Rename it in the code: ${where(card)}.`;
        next = withFile(next, card.file, line);
      }
      return next;
    });
    if (ok) onDone();
  };
  return (
    <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Field id={`${id}-name`} label="Name"><input id={`${id}-name`} className={styles.input} value={name} onChange={(event) => setName(event.target.value)} /></Field>
      <Field id={`${id}-controller`} label="Controller">
        <Select id={`${id}-controller`} ariaLabel="Controller" value={controller || '__none__'} onChange={setController}
          options={[...(controller ? [] : [{ value: '__none__', label: 'Choose the controller fitted…' }]), ...choices.options]} />
      </Field>
      {card.spindle && (
        <div className={styles.fieldRow}>
          <Field id={`${id}-rpm`} label="Spindle max rpm"><TextNumber id={`${id}-rpm`} min={1} step={100} value={maxRpm} onChange={setMaxRpm} /></Field>
          <Field id={`${id}-taper`} label="Spindle taper">
            <input id={`${id}-taper`} className={styles.input} list={`${id}-tapers`} value={taper} onChange={(event) => setTaper(event.target.value)} />
            <datalist id={`${id}-tapers`}>{TAPERS.map((item) => <option key={item} value={item} />)}</datalist>
          </Field>
        </div>
      )}
      <div className={styles.fieldRow}>
        <Field id={`${id}-changer`} label="Tool changer">
          <select id={`${id}-changer`} className={styles.input} value={changer} onChange={(event) => setChanger(event.target.value as 'manual' | 'magazine')}>
            <option value="manual">Manual</option>
            <option value="magazine">Magazine</option>
          </select>
        </Field>
        {changer === 'magazine' && (
          <Field id={`${id}-pockets`} label="Pockets"><TextNumber id={`${id}-pockets`} min={1} integer value={pockets} onChange={setPockets} /></Field>
        )}
      </div>
      <div className={styles.formActions}>
        <Button size="sm" type="button" onClick={onDone}>Cancel</Button>
        <Button size="sm" variant="primary" type="submit" id="shop-machine-save">Save</Button>
      </div>
    </form>
  );
}

function MachineCardView({ card }: { card: MachineCard }) {
  const [editing, setEditing] = useState(false);
  const busy = useShop((state) => !!state.busy);
  const linked = card.file.startsWith('links/');
  return (
    <article className={styles.card} data-machine={card.key}>
      <div className={styles.cardHead}>
        <div className={styles.cardTitle}>
          <h4>{card.name}</h4>
          {card.model && <p>{card.model.name}</p>}
        </div>
        {!editing && !linked && <Button size="sm" variant="ghost" icon={<Pencil />} aria-label={`Edit ${card.name}`} disabled={busy} onClick={() => setEditing(true)} />}
      </div>
      <dl className={styles.facts}>
        <dt>Controller</dt>
        <dd>{card.controller ? <>{card.controller.name}<Status executable={card.controller.executable} /></> : '—'}</dd>
        {card.spindle && <><dt>Spindle</dt><dd>{rpm(card.spindle.maxRpm)}{card.spindle.interface ? ` · ${card.spindle.interface.toUpperCase()}` : ''}</dd></>}
        <dt>Changer</dt><dd>{changerText(card.changer)}</dd>
        {card.travel && <><dt>Travel</dt><dd>{card.travel.map(mm).join(' × ')} mm</dd></>}
      </dl>
      {editing && <MachineEditor card={card} onDone={() => setEditing(false)} />}
    </article>
  );
}

function Machines({ onCatalogue }: { onCatalogue: () => void }) {
  const build = useShop((state) => state.build);
  const executable = useShop((state) => state.executable);
  const view = useMemo(() => shopView(shopRecords(build), executable), [build, executable]);
  return (
    <>
      <div className={styles.heading}><h4>Machines</h4><Button size="sm" icon={<Plus />} id="shop-add-machine" onClick={onCatalogue}>Add a machine</Button></div>
      {view.machines.length ? (
        <div className={styles.cards}>{view.machines.map((card) => <MachineCardView key={card.key} card={card} />)}</div>
      ) : <p className={styles.empty}>No machines yet. Add one from Steve’s catalogue and change what yours has.</p>}
      {view.controllers.length > 0 && (
        <>
          <div className={styles.heading}><h4>Controllers</h4></div>
          <div className={styles.list} id="shop-controllers">
            {view.controllers.map((item) => (
              <div key={item.key} className={styles.listRow} data-controller={item.key}>
                <b>{item.name}</b><code>{item.dialect}</code><span><Status executable={item.executable} /></span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

// ── Tools ─────────────────────────────────────────────────────────────────

function Stickout({ row }: { row: ToolTable['rows'][number] }) {
  const busy = useShop((state) => !!state.busy);
  const [value, setValue] = useState(row.tool?.stickout === null || row.tool?.stickout === undefined ? '' : String(row.tool.stickout));
  useEffect(() => { setValue(row.tool?.stickout === null || row.tool?.stickout === undefined ? '' : String(row.tool.stickout)); }, [row.tool?.stickout]);
  const tool = row.tool;
  if (!tool) return <>—</>;
  const commit = () => {
    const next = Number(value);
    if (!value.trim() || !Number.isFinite(next) || next <= 0) { setValue(String(tool.stickout ?? '')); return; }
    if (next === tool.stickout) return;
    void changeShop(`${tool.name}: stick-out ${pyNumber(next)} mm`, (source) => {
      if (tool.file.startsWith('links/')) return 'This tool comes from a linked shop: clone it into your shop to change it.';
      const content = allFiles(source)[tool.file];
      const changed = content === undefined ? null : setCallArgument(content, tool.key, tool.line, { keyword: 'stickout' }, pyNumber(next));
      return changed === null ? `Change it in the code: ${where(tool)}.` : withFile(source, tool.file, changed);
    }).then((ok) => { if (!ok) setValue(String(tool.stickout ?? '')); });
  };
  return (
    <input className={styles.stickout} inputMode="decimal" value={value} disabled={busy || tool.file.startsWith('links/')} aria-label={`Stick-out of ${tool.name}, mm`}
      onChange={(event) => setValue(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }} />
  );
}

const cutterWord = (type: string | undefined) => (type === 'drill' ? 'drill' : type === 'chamfer_mill' ? 'chamfer mill' : type === 'ball_end_mill' ? 'ball end mill' : 'end mill');

/**
 * Add a tool: a cutter (one of the catalogue's, its diameter changed if yours differs, or a new end mill or drill by its
 * sizes) in a holder (the shop's own, or the catalogue's cloned once) at a stick-out, loaded as a T number in a tool
 * setup (a new one on first use). Written as tools/<key>.py and the tool setup's file.
 */
function AddTool({ setupKey, onDone }: { setupKey: string | null; onDone: () => void }) {
  const { doc, build, catalogue } = useShop();
  const records = useMemo(() => shopRecords(build), [build]);
  const view = useMemo(() => shopView(records, []), [records]);
  const source = doc ? sourceOf(doc) : null;
  const id = useId();
  const cutters = (catalogue?.items ?? []).filter((item) => item.kind === 'rotary_cutter');
  const keys = new Set(records.map((item) => item.key));
  const ownHolders = records.filter((item) => item.kind === 'tool_holder').flatMap((item) => {
    const found = source ? importOf(source, item) : null;
    return found?.module ? [{ value: `shop:${item.key}`, label: String(item.definition.name ?? item.key), found }] : [];
  });
  const listedHolders = (catalogue?.items ?? []).filter((item) => item.kind === 'tool_holder' && !keys.has(item.key))
    .map((item) => ({ value: `catalogue:${item.key}`, label: item.name, item }));
  const [cutter, setCutter] = useState('');
  const [diameter, setDiameter] = useState('');
  const [flutes, setFlutes] = useState('3');
  const [fluteLength, setFluteLength] = useState('');
  const [overall, setOverall] = useState('');
  const [holder, setHolder] = useState(ownHolders[0]?.value ?? listedHolders[0]?.value ?? '');
  const [stickout, setStickout] = useState('');
  const [setup, setSetup] = useState(setupKey ?? view.toolSetups[0]?.key ?? 'new');
  const [setupName, setSetupName] = useState(view.toolSetups.length ? `Tool setup ${view.toolSetups.length + 1}` : 'Everyday tools');
  const table = view.toolSetups.find((item) => item.key === setup) ?? null;
  const [number, setNumber] = useState(String(freeToolNumber(table?.rows.map((row) => row.number) ?? [])));
  useEffect(() => { setNumber(String(freeToolNumber(table?.rows.map((row) => row.number) ?? []))); }, [setup]); // eslint-disable-line react-hooks/exhaustive-deps
  const listed = cutters.find((item) => `catalogue:${item.key}` === cutter);
  const fresh = cutter === 'new:end_mill' || cutter === 'new:drill';
  const size = Number(diameter || listed?.diameter_mm || 0);
  const autoName = listed || fresh ? `${pyNumber(size)} mm ${cutterWord(listed?.cutter_type ?? (cutter === 'new:drill' ? 'drill' : 'flat_end_mill'))}` : '';
  const [name, setName] = useState('');
  const numberValue = Math.round(Number(number));
  const ready = !!(listed || (fresh && Number(diameter) > 0 && Number(fluteLength) > 0 && Number(overall) > 0 && Number(flutes) >= 1))
    && !!holder && Number(stickout) > 0 && numberValue >= 1 && (setup !== 'new' || !!setupName.trim());
  const add = async () => {
    if (!ready) return;
    const toolName = name.trim() || autoName;
    const ok = await changeShop(`${toolName} added as T${numberValue}`, (latest, current) => {
      const taken = current.map((item) => item.key);
      let next = latest;
      let alias: string | null = null;
      const listing = useShop.getState().catalogue;
      if (listed || holder.startsWith('catalogue:')) {
        if (!listing?.document_id || !listing.revision) return 'Steve’s catalogue isn’t published on this server yet.';
        const linked = withShopLink(next, listing.document_id, listing.name, listing.revision, 'catalogue');
        next = linked.source; alias = linked.alias;
      }
      let held: { module: string | null; variable: string };
      const own = ownHolders.find((item) => item.value === holder);
      if (own) held = own.found;
      else {
        const item = listedHolders.find((entry) => entry.value === holder);
        if (!item) return 'Choose a holder.';
        const cloned = withCatalogueHolder(next, alias!, { key: item.item.key, name: item.item.name }, taken);
        next = cloned.source; held = cloned.holder;
      }
      const spec: CutterSpec = listed
        ? { catalogue: { key: listed.key, name: listed.name }, ...(diameter.trim() && Number(diameter) !== listed.diameter_mm ? { diameter: Number(diameter) } : {}) }
        : { type: cutter === 'new:drill' ? 'drill' : 'end_mill', name: `${pyNumber(size)} mm ${cutter === 'new:drill' ? 'drill' : 'end mill'}`, diameter: Number(diameter),
            flutes: Number(flutes), fluteLength: Number(fluteLength), overallLength: Number(overall) };
      const made = withTool(next, { alias, name: toolName, taken, cutter: spec, holder: held, stickout: Number(stickout) });
      next = made.source;
      if (setup === 'new') return withNewToolSetup(next, { name: setupName.trim(), taken: [...taken, made.key, `${made.key}_cutter`], number: numberValue, tool: made.tool }).source;
      const target = view.toolSetups.find((item) => item.key === setup);
      return target ? withToolInSetup(next, target, numberValue, made.tool) : 'That tool setup is gone: reload the shop.';
    });
    if (ok) onDone();
  };
  const cutterOptions = [
    ...(cutter ? [] : [{ value: '', label: 'Choose a cutter…' }]),
    ...cutters.map((item) => ({ value: `catalogue:${item.key}`, label: item.name, hint: 'catalogue' })),
    { value: 'new:end_mill', label: 'New end mill…' }, { value: 'new:drill', label: 'New drill…' },
  ];
  return (
    <form className={clsx(styles.card, styles.addTool)} id="shop-add-tool" onSubmit={(event) => { event.preventDefault(); void add(); }}>
      <div className={styles.cardTitle}><h4>Add a tool</h4></div>
      <div className={styles.fieldRow}>
        <Field id={`${id}-cutter`} label="Cutter">
          <Select id={`${id}-cutter`} ariaLabel="Cutter" value={cutter || '__none__'} onChange={(value) => { setCutter(value === '__none__' ? '' : value); setDiameter(''); }}
            options={cutterOptions.map((option) => (option.value ? option : { ...option, value: '__none__' }))} />
        </Field>
        <Field id={`${id}-diameter`} label={fresh ? 'Diameter (mm)' : 'Diameter (mm), if yours differs'}>
          <TextNumber id={`${id}-diameter`} min={0} step={0.1} placeholder={listed?.diameter_mm !== undefined ? String(listed.diameter_mm) : ''}
            value={diameter} onChange={setDiameter} disabled={!listed && !fresh} />
        </Field>
      </div>
      {fresh && (
        <div className={styles.fieldRow}>
          <Field id={`${id}-flutes`} label="Flutes"><TextNumber id={`${id}-flutes`} min={1} integer value={flutes} onChange={setFlutes} /></Field>
          <Field id={`${id}-flute-length`} label="Flute length (mm)"><TextNumber id={`${id}-flute-length`} min={0} value={fluteLength} onChange={setFluteLength} /></Field>
          <Field id={`${id}-overall`} label="Overall length (mm)"><TextNumber id={`${id}-overall`} min={0} value={overall} onChange={setOverall} /></Field>
        </div>
      )}
      <div className={styles.fieldRow}>
        <Field id={`${id}-holder`} label="Holder">
          <Select id={`${id}-holder`} ariaLabel="Holder" value={holder || '__none__'} onChange={setHolder}
            options={[...(holder ? [] : [{ value: '__none__', label: 'Choose a holder…' }]), ...ownHolders.map(({ value, label }) => ({ value, label })),
              ...listedHolders.map(({ value, label }) => ({ value, label, hint: 'catalogue' }))]} />
        </Field>
        <Field id={`${id}-stickout`} label="Stick-out (mm)"><TextNumber id={`${id}-stickout`} min={0} value={stickout} onChange={setStickout} /></Field>
      </div>
      <div className={styles.fieldRow}>
        <Field id={`${id}-setup`} label="Tool setup">
          <Select id={`${id}-setup`} ariaLabel="Tool setup" value={setup} onChange={setSetup}
            options={[...view.toolSetups.map((item) => ({ value: item.key, label: item.name })), { value: 'new', label: 'New tool setup…' }]} />
        </Field>
        {setup === 'new' && <Field id={`${id}-setup-name`} label="New tool setup's name"><input id={`${id}-setup-name`} className={styles.input} value={setupName} onChange={(event) => setSetupName(event.target.value)} /></Field>}
        <Field id={`${id}-number`} label="T number"><TextNumber id={`${id}-number`} min={1} integer value={number} onChange={setNumber} /></Field>
      </div>
      <Field id={`${id}-name`} label="Tool name"><input id={`${id}-name`} className={styles.input} placeholder={autoName} value={name} onChange={(event) => setName(event.target.value)} /></Field>
      <div className={styles.formActions}>
        <Button size="sm" type="button" onClick={onDone}>Cancel</Button>
        <Button size="sm" variant="primary" type="submit" disabled={!ready} id="shop-add-tool-save">Add tool</Button>
      </div>
    </form>
  );
}

function Tools() {
  const build = useShop((state) => state.build);
  const busy = useShop((state) => !!state.busy);
  const view = useMemo(() => shopView(shopRecords(build), []), [build]);
  // The Add a tool form, for a tool setup (its key) or a new one ('new').
  const [adding, setAdding] = useState<string | null>(null);
  const unload = (table: ToolTable, number: number) => void changeShop(`T${number} unloaded from ${table.name}`, (source) => withoutToolInSetup(source, table, number));
  return (
    <>
      <div className={styles.heading}>
        <h4>Tool setups</h4>
        <Button size="sm" icon={<Plus />} id="shop-new-tool-setup" disabled={busy} onClick={() => setAdding('new')}>New tool setup</Button>
        <Button size="sm" icon={<Plus />} id="shop-add-tool-open" disabled={busy} onClick={() => setAdding(view.toolSetups[0]?.key ?? 'new')}>Add a tool</Button>
      </div>
      {adding && <AddTool key={adding} setupKey={adding} onDone={() => setAdding(null)} />}
      {!view.toolSetups.length && !adding && <p className={styles.empty}>No tool setups yet. Add a tool: it goes into a new tool setup with its T number.</p>}
      {view.toolSetups.map((table) => (
        <div key={table.key} className={styles.tableWrap} data-tool-setup={table.key}>
          <div className={styles.tableTitle}><h4>{table.name}</h4><span>{table.rows.length} {table.rows.length === 1 ? 'tool' : 'tools'}</span></div>
          <table className={styles.table}>
            <thead><tr><th>T</th><th>Tool</th><th>Holder</th><th data-numeric>Ø mm</th><th data-numeric>Stick-out mm</th><th><span className={styles.hidden}>Unload</span></th></tr></thead>
            <tbody>
              {table.rows.map((row, index) => (
                <tr key={`${row.number}-${index}`} data-tool-number={row.number}>
                  <td>T{row.number}</td>
                  <td>{row.tool?.name ?? '—'}{row.cutter && row.cutter !== row.tool?.name ? <span className={styles.description} style={{ display: 'block' }}>{row.cutter}</span> : null}</td>
                  <td>{row.holder || '—'}</td>
                  <td data-numeric>{row.diameter === null ? '—' : mm(row.diameter)}</td>
                  <td data-numeric><Stickout row={row} /></td>
                  <td data-numeric>{table.rows.length > 1 && !table.file.startsWith('links/') && (
                    <button type="button" className={styles.unload} aria-label={`Unload T${row.number}`} title="Unload from this tool setup (the tool stays in your shop)" disabled={busy}
                      onClick={() => unload(table, row.number)}><X size={13} /></button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}

// ── Code and links ────────────────────────────────────────────────────────

function Links() {
  const doc = useShop((state) => state.doc);
  const shops = useShop((state) => state.shops);
  const catalogue = useShop((state) => state.catalogue);
  const busy = useShop((state) => !!state.busy);
  if (!doc) return null;
  const links = Object.entries(doc.links ?? {});
  const linkedIds = new Set(links.map(([, pin]) => pin.document_id));
  const candidates = [
    ...(catalogue?.document_id && catalogue.revision && !linkedIds.has(catalogue.document_id) ? [{ id: catalogue.document_id, name: catalogue.name, revision: catalogue.revision, alias: 'catalogue' }] : []),
    ...(shops ?? []).filter((shop) => shop.id !== doc.id && !linkedIds.has(shop.id)).map((shop) => ({ id: shop.id, name: shop.name, revision: shop.revision, alias: undefined as string | undefined })),
  ];
  const link = (target: typeof candidates[number]) => void changeShop(`Linked ${target.name}`, (source) => withShopLink(source, target.id, target.name, target.revision, target.alias).source);
  const update = (alias: string, latest: number) => void changeShop(`${alias} updated to revision ${latest}`, (source) => (
    source.links[alias] ? { ...source, links: { ...source.links, [alias]: { ...source.links[alias], revision: latest } } } : `${alias} isn’t linked any more.`));
  return (
    <>
      <div className={styles.heading}>
        <h4>Linked shops</h4>
        <Menu>
          <MenuTrigger asChild><Button size="sm" icon={<Link2 />} id="shop-link" disabled={busy || !candidates.length}>Link a shop</Button></MenuTrigger>
          <MenuContent align="end">
            {candidates.map((target) => <MenuItem key={target.id} onSelect={() => link(target)} hint={`revision ${target.revision}`}>{target.name}</MenuItem>)}
          </MenuContent>
        </Menu>
      </div>
      {links.length > 0 && (
        <div className={styles.list} id="shop-links">
          {links.map(([alias, pin]) => {
            const status = doc.link_status?.[alias];
            const latest = status?.latest ?? null;
            return (
              <div key={alias} className={styles.listRow} data-link={alias}>
                <b>{status?.name ?? alias}</b><code>from links import {alias}</code>
                <span>revision {pin.revision ?? status?.revision ?? '?'}{latest && pin.revision && latest > pin.revision
                  ? <> · <Button size="sm" variant="ghost" icon={<RefreshCw />} disabled={busy} onClick={() => update(alias, latest)}>Use revision {latest}</Button></> : null}</span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function Code() {
  const target = useShopTarget();
  const focus = useShop((state) => state.focus);
  if (!target) return null;
  return (
    <div className={styles.code}>
      <Links />
      <div style={{ flex: 1, minHeight: 360, border: '1px solid var(--line-2)', borderRadius: 8, overflow: 'hidden' }}><TargetEditor target={target} inline focus={focus} /></div>
    </div>
  );
}

// ── Catalogue ─────────────────────────────────────────────────────────────

function UseMachine({ model, onDone, onAdded }: { model: CatalogueEntry; onDone: () => void; onAdded: () => void }) {
  const { doc, build, catalogue, executable, busy } = useShop();
  const view = useMemo(() => shopView(shopRecords(build), executable), [build, executable]);
  const source = doc ? sourceOf(doc) : null;
  const choices = controllerChoices(source, view.controllers, catalogue?.items ?? [], executable, 'machines/new.py');
  const [name, setName] = useState(shortName(model.name));
  // The shop's only controller, when it has one; otherwise the person says which control is fitted.
  const [controller, setController] = useState(choices.own.length === 1 ? choices.own[0].value : '');
  const id = useId();
  const [maxRpm, setMaxRpm] = useState(model.spindle ? String(model.spindle.max_rpm) : '');
  const add = async () => {
    if (!controller) return;
    if (!useShop.getState().doc) await createShop();
    if (!useShop.getState().doc) return;
    const ok = await changeShop(`${name.trim() || model.name} added`, (latest, records) => {
      const listing = useShop.getState().catalogue;
      if (!listing?.document_id || !listing.revision) return 'Steve’s catalogue isn’t published on this server yet.';
      const taken = records.map((item) => item.key);
      const linked = withShopLink(latest, listing.document_id, listing.name, listing.revision, 'catalogue');
      const own = choices.own.find((item) => item.value === controller);
      const listed = choices.listed.find((item) => item.value === controller);
      if (!own && !listed) return 'Choose the controller fitted to this machine.';
      const made = withCatalogueMachine(linked.source, {
        alias: linked.alias, name: name.trim() || shortName(model.name), taken, model: { key: model.key, name: model.name },
        controller: own ? { shop: own.found } : { catalogue: { key: listed!.item.key, name: listed!.item.name } },
      });
      // Its spindle, when yours runs at another speed: written in the clone (spindle={"max_rpm": …}).
      const rpm = Number(maxRpm);
      if (!model.spindle || !maxRpm.trim() || !(rpm > 0) || rpm === model.spindle.max_rpm) return made.source;
      return withMachineSpec(made.source, { key: `${made.key}_model`, file: `machines/${made.key}.py`, line: 0 }, { maxRpm: rpm },
        { interface: model.spindle.interface, changer: { mode: 'manual' } });
    });
    if (ok) { onDone(); onAdded(); }
  };
  return (
    <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void add(); }}>
      <Field id={`${id}-name`} label="Name in your shop"><input id={`${id}-name`} className={styles.input} value={name} onChange={(event) => setName(event.target.value)} /></Field>
      <Field id={`${id}-controller`} label="Controller fitted">
        <Select id={`${id}-controller`} ariaLabel="Controller fitted" value={controller || '__none__'} onChange={(value) => setController(value === '__none__' ? '' : value)}
          options={[...(controller ? [] : [{ value: '__none__', label: 'Choose the controller…' }]), ...choices.options]} />
      </Field>
      {model.spindle && (
        <Field id={`${id}-rpm`} label="Spindle max rpm">
          <TextNumber id={`${id}-rpm`} min={1} step={100} value={maxRpm} onChange={setMaxRpm} />
        </Field>
      )}
      <div className={styles.formActions}>
        <Button size="sm" type="button" onClick={onDone}>Cancel</Button>
        <Button size="sm" variant="primary" type="submit" disabled={!controller || !!busy} id="shop-use-machine-add">Add to my shop</Button>
      </div>
    </form>
  );
}

function CataloguePage() {
  const catalogue = useShop((state) => state.catalogue);
  const executable = useShop((state) => state.executable);
  const busy = useShop((state) => !!state.busy);
  const [using, setUsing] = useState<string | null>(null);
  if (!catalogue) return <p className={styles.empty}><Spinner size={14} /> Reading Steve’s catalogue…</p>;
  const machines = catalogue.items.filter((item) => item.kind === 'machine_model');
  const controllers = catalogue.items.filter((item) => item.kind === 'controller');
  const runs = (item: CatalogueEntry) => item.status === 'executable' || executable.includes(item.dialect ?? '');
  return (
    <>
      <div className={styles.heading}><h4>Machines</h4></div>
      <div className={styles.cards} id="catalogue-machines">
        {machines.map((item) => (
          <article key={item.key} className={styles.card} data-catalogue-machine={item.key}>
            <div className={styles.cardTitle}><h4>{item.name}</h4></div>
            <dl className={styles.facts}>
              {item.spindle && <><dt>Spindle</dt><dd>{rpm(item.spindle.max_rpm)} · {item.spindle.interface.toUpperCase()}</dd></>}
              {item.changer && <><dt>Changer</dt><dd>{changerText(item.changer)}</dd></>}
              {item.travel_mm && ['X', 'Y', 'Z'].every((axis) => axis in item.travel_mm!) && <><dt>Travel</dt><dd>{['X', 'Y', 'Z'].map((axis) => mm(item.travel_mm![axis])).join(' × ')} mm</dd></>}
            </dl>
            {item.description && <p className={styles.description} title={item.description}>{item.description}</p>}
            {using === item.key ? <UseMachine model={item} onDone={() => setUsing(null)} onAdded={() => useMfg.setState({ libraryKind: 'shop', librarySelect: null })} /> : (
              <div className={styles.cardFoot}><Button size="sm" variant="primary" disabled={busy} data-use-machine={item.key} onClick={() => setUsing(item.key)}>Use this machine</Button></div>
            )}
          </article>
        ))}
      </div>
      <div className={styles.heading}><h4>Controllers</h4></div>
      <div className={styles.list} id="catalogue-controllers">
        {controllers.map((item) => (
          <div key={item.key} className={styles.listRow} data-catalogue-controller={item.key} title={item.description}>
            <b>{item.name}</b><code>{item.dialect}</code><span><Status executable={runs(item)} /></span>
          </div>
        ))}
      </div>
      <p className={styles.description} style={{ display: 'block' }}>Not listed? Ask STEVE to request your machine or controller for the catalogue; meanwhile it can describe your machine in your shop’s code.</p>
    </>
  );
}

// ── The page ──────────────────────────────────────────────────────────────

export default function ShopPage({ page }: { page: 'shop' | 'catalogue' }) {
  const { shops, doc, build, error, busy } = useShop();
  const [tab, setTab] = useState<Tab>(() => (useShop.getState().focus ? 'code' : 'machines'));
  const focus = useShop((state) => state.focus);
  useEffect(() => { if (focus) setTab('code'); }, [focus]);
  const open = (next: 'shop' | 'catalogue') => useMfg.setState({ libraryKind: next, librarySelect: null });
  // The shop as saved now (it may have changed in the code editor or by STEVE since): read again on every visit.
  useEffect(() => { void loadCatalogue(); if (!useShop.getState().busy) void loadShop(); }, []);
  const records = shopRecords(build);
  const status = busy ? <span className={styles.busy} id="shop-busy" role="status"><Spinner size={12} />{busy}…</span> : null;
  if (page === 'catalogue') {
    return (
      <SectionPane label="Steve's catalogue" icon={<Factory size={16} />} title="Steve’s catalogue" id="shop-catalogue"
        subtitle="Shared and read-only. Use a machine to add your own copy to your shop, then change what yours has." actions={status}>
        <CataloguePage />
      </SectionPane>
    );
  }
  if (shops && !shops.length && !doc) {
    return (
      <SectionPane label="Your shop" id="shop-page">
        <div className={styles.empty}>
          <Factory size={28} />
          <p>Your machines, controllers and tools live in your shop, written as code. Start from Steve’s catalogue: pick your machine and its controller.</p>
          <Button variant="primary" icon={<Plus />} id="shop-start" disabled={!!busy} onClick={() => open('catalogue')}>Add your first machine</Button>
        </div>
      </SectionPane>
    );
  }
  return (
    <SectionPane label="Your shop" icon={<Factory size={16} />} id="shop-page"
      title={shops && shops.length > 1 && doc
        ? <Select ariaLabel="Shop" value={doc.id} onChange={(id) => void showShop(id)} options={shops.map((shop) => ({ value: shop.id, label: shop.name }))} />
        : doc?.name ?? 'Your shop'}
      subtitle={doc ? `Revision ${doc.revision} · ${records.length} ${records.length === 1 ? 'item' : 'items'} in the library` : undefined}
      actions={status}
      tabs={[{ id: 'machines', label: 'Machines' }, { id: 'tools', label: 'Tools' }, { id: 'code', label: 'Code' }]} tab={tab} onTab={(id) => setTab(id as Tab)}>
      {!doc ? <p className={styles.empty}><Spinner size={14} /> Reading your shop…</p> : <>
        {error && <p className={styles.error} role="alert" id="shop-error">The saved shop doesn’t build: {error} Fix it in the code.</p>}
        {tab === 'machines' && <Machines onCatalogue={() => open('catalogue')} />}
        {tab === 'tools' && <Tools />}
        {tab === 'code' && <Code />}
      </>}
    </SectionPane>
  );
}
