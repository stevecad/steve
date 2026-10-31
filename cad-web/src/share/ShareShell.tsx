/**
 * The share page's chrome, built from the app's own pieces so a shared design looks and works like STEVE itself.
 * Desktops and tablets get the app's layout (docs/UI_LAYOUT.md): a slim top bar, the parts in a Browser on the left
 * (shell/TreeRow), the canvas in the centre and an Inspector in a Dock on the right, both collapsing to rails. Phones
 * (phone/detect.ts) get the phone shell's: the model fills the screen, thumb-sized buttons under it open sheets
 * (phone/Sheet), and a tap selects a part. Only presentational pieces and CSS modules are reused: the app's panels
 * reach the /v1 API, and this page never does.
 */
import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Box, Download as DownloadIcon, Expand, Eye, EyeOff, FileDown, Focus, Grid3x3, Layers3, ListTree, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Pause, Play, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import { Button, IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Section, Slider, Tip } from '@/ui';
import { set, useApp, type DisplayStyle, type StandardView } from '@/state/store';
import { viewer, VIEW_LABELS } from '@/viewport/viewer';
import { FitIcon, HiddenLineIcon, PerspectiveIcon, ShadedEdgesIcon, ShadedIcon, ViewCubeIcon, WireframeIcon, XrayIcon } from '@/icons/cad';
import { pauseClip, play, playClip, stop, useMotion } from '@/motion/state';
import { unitOf } from '@/motion/kinematics';
import ModeSelect from '@/motion/ModeSelect';
import { modKey, num } from '@/lib/format';
import TreeRow from '@/shell/TreeRow';
import Resizer from '@/shell/Resizer';
import Sheet from '@/phone/Sheet';
import ExplodeStrip from '@/phone/ExplodeStrip';
import mark from '@/steve/mark.svg';
import { choose, effective, factsOf, requestDownload, useAsked, isolate, resetMotion, setExplode, showAll, toggleHidden, useJointOf, usePartSize, useParts, useSelectedPart, type Download, type Info } from './model';
import '@/phone/phone.css';
import app from '@/shell/App.module.css';
import top from '@/shell/TopBar.module.css';
import dock from '@/shell/Dock.module.css';
import rail from '@/shell/PanelRail.module.css';
import browser from '@/shell/Browser.module.css';
import panels from '@/panels/Panels.module.css';
import phone from '@/phone/Phone.module.css';

const AXIS = [['X', 'var(--axis-x)'], ['Y', 'var(--axis-y)'], ['Z', 'var(--axis-z)']] as const;
const STYLES: { value: DisplayStyle; label: string; icon: typeof ShadedIcon }[] = [
  { value: 'shaded-edges', label: 'Shaded with edges', icon: ShadedEdgesIcon },
  { value: 'shaded', label: 'Shaded', icon: ShadedIcon },
  { value: 'hidden-line', label: 'Hidden line', icon: HiddenLineIcon },
  { value: 'wireframe', label: 'Wireframe', icon: WireframeIcon },
  { value: 'xray', label: 'X-ray', icon: XrayIcon },
];
const VIEWS: StandardView[] = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom'];

interface ShellProps { info: Info | null; loading: boolean; viewport: ReactNode }

const sharedOn = (info: Info) => new Date(info.shared_at).toLocaleDateString();
const ready = (item: Download) => !item.status || item.status === 'ready';
const pending = (item: Download) => item.message || (item.status === 'preparing' ? 'Being prepared…' : 'Not available');
/** The downloads as the visitor sees them now: one they asked for may be being made (requestDownload). */
const useDownloads = (downloads: Download[]) => {
  const items = useAsked((state) => state.items);
  return downloads.map((item) => effective(item, items));
};

function Rows({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return <dl className={panels.rows}>{rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>;
}

/** The selected part (or, with none, the design), as the app's Inspector shows a selection. */
function Inspector({ info, touch }: { info: Info | null; touch?: boolean }) {
  const parts = useParts();
  const selected = useSelectedPart();
  const explode = useApp((state) => state.explode);
  const movable = useMotion((state) => !!state.kinematics);
  const facts = selected ? factsOf(info, selected.name) : null;
  const size = usePartSize(selected);
  const joint = useJointOf(selected?.id);
  const jointValue = useMotion((state) => (joint ? state.pose[joint.name] : undefined));
  return (
    <div className={panels.scroll} id="share-inspector">
      <div className={panels.hero}>
        <div className={panels.heroIcon} data-tone={selected ? 'sel' : undefined}>{selected ? <Box size={20} /> : <Layers3 size={20} />}</div>
        <div className={panels.heroText}>
          <div className={panels.heroTitle} title={selected?.name ?? info?.name}>{selected?.name ?? info?.name ?? 'Loading…'}</div>
          <div className={panels.heroSub}>
            {selected ? <span>Part</span> : info && <><span>Revision {info.revision}</span><span>· read-only</span></>}
          </div>
        </div>
        {selected && <IconButton small label="Clear selection" shortcut="Esc" onClick={() => set({ selection: [] })}><X /></IconButton>}
      </div>
      {selected ? (
        <>
          {size && (
            <Section title="Size">
              <div className={panels.axes}>
                {AXIS.map(([name, color], i) => (
                  <div key={name} className={panels.axis} style={{ ['--c' as string]: color }}>
                    <span className={panels.axisName}>{name}</span>
                    <span className={panels.axisValue}>{num(size.getComponent(i))}<span className={panels.axisUnit}>mm</span></span>
                  </div>
                ))}
              </div>
            </Section>
          )}
          <Section title="Part">
            <Rows rows={[
              { label: 'Name', value: selected.name },
              ...(facts?.component && facts.component !== selected.name ? [{ label: 'Component', value: facts.component }] : []),
              ...(facts && facts.materials.length > 0 ? [{ label: 'Material', value: facts.materials.join(', ') }] : []),
              ...(joint && jointValue ? [{ label: 'Joint', value: `${joint.name} (${joint.type}) · ${jointValue.value.toFixed(1)}${unitOf(joint) === 'mm' ? ' mm' : unitOf(joint)}${joint.type === 'cylindrical' ? ` · ${jointValue.slide.toFixed(1)} mm` : ''}` }] : []),
            ]} />
          </Section>
        </>
      ) : info && (
        <Section title="Shared design">
          <div className={panels.stack}>
            <Rows rows={[
              { label: 'Revision', value: info.revision },
              { label: 'Shared', value: sharedOn(info) },
              ...(parts.length ? [{ label: 'Parts', value: parts.length }] : []),
              { label: 'Access', value: 'Read-only' },
            ]} />
            <p className={panels.muted} style={{ fontSize: 11.5, lineHeight: 1.5 }}>
              {touch ? 'Tap' : 'Click'} a part on the model or in the parts list to inspect it.{touch ? '' : ' Space hides or shows it.'} The owner can revoke this link at any time.
            </p>
          </div>
        </Section>
      )}
      {!touch && parts.length > 1 && <Section title="Explode"><Slider value={explode} onChange={setExplode} label="Explode" /></Section>}
      {movable && (
        <Section title="Move">
          <div className={panels.stack}>
            <p className={panels.muted} style={{ fontSize: 11.5, lineHeight: 1.5 }}>
              Drag a moving part to turn or slide it along its joint.{touch ? '' : ' Alt slides a part that can also turn.'}
            </p>
            <MotionControls />
          </div>
        </Section>
      )}
    </div>
  );
}

/** The owner's motors, animations and explodes, as the Motion tab plays them (only on shares that allow it), and Reset pose. */
function MotionControls() {
  const kinematics = useMotion((state) => state.kinematics);
  const playing = useMotion((state) => state.playing);
  const clip = useMotion((state) => (state.clipStart ? state.clip : null));   // The animation playing now.
  const drives = kinematics?.drives ?? [];
  const animations = kinematics?.animations ?? [];
  const explodes = kinematics?.explodes ?? [];
  const item = (key: string, name: string, kind: string, on: boolean, toggle: () => void) => (
    <button key={key} type="button" className={`${panels.listItem} share-play`} aria-pressed={on} title={`${on ? 'Pause' : 'Play'} ${kind} ${name}`} onClick={toggle}>
      {on ? <Pause size={14} /> : <Play size={14} />}<span className={panels.grow}>{name}</span><span className={panels.muted}>{kind}</span>
    </button>
  );
  return (
    <>
      <ModeSelect />
      {(drives.length > 0 || animations.length > 0 || explodes.length > 0) && (
        <div className={panels.list} id="share-play">
          {drives.map((drive) => item(`drive:${drive.joint}`, drive.joint, 'motor', playing === drive.joint, () => (playing === drive.joint ? stop() : play(drive.joint))))}
          {animations.map((animation) => item(`animation:${animation.name}`, animation.name, 'animation', clip === animation.name, () => (clip === animation.name ? pauseClip() : playClip(animation.name))))}
          {explodes.map((explode) => item(`explode:${explode.name}`, explode.name, 'explode', clip === explode.name, () => (clip === explode.name ? pauseClip() : playClip(explode.name))))}
        </div>
      )}
      <div className={panels.actions}><Button size="sm" icon={<RotateCcw size={13} />} onClick={resetMotion}>Reset pose</Button></div>
    </>
  );
}

/* ───────── Desktops and tablets ───────── */

function DownloadsMenu({ downloads: listed }: { downloads: Download[] }) {
  const downloads = useDownloads(listed);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className={top.mcp} id="share-downloads" aria-label="Downloads"><DownloadIcon size={14} /><span>Downloads</span></button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuLabel>Downloads</MenuLabel>
        {downloads.map((item) => (ready(item)
          ? <MenuItem key={item.url} icon={<FileDown size={15} />} onSelect={() => { void requestDownload(item.url); }}>{item.name}</MenuItem>
          : <MenuItem key={item.url} icon={<FileDown size={15} />} disabled reason={pending(item)}>{item.name}</MenuItem>))}
      </MenuContent>
    </Menu>
  );
}

function TopBar({ info }: { info: Info | null }) {
  return (
    <header className={top.topbar}>
      <a className={top.brand} href="/" rel="noopener" aria-label="STEVE Studio">
        <img src={mark} alt="" />
        <span className={top.wordmark}>STEVE</span>
      </a>
      <span className={top.divider} />
      <div className={top.title}>
        <span className={`${top.name} share-name`} title={info?.name}>{info?.name ?? 'Loading…'}</span>
        <span className={top.kind}>Read-only</span>
        {info && <span className="share-meta">Revision {info.revision} · shared {sharedOn(info)}</span>}
      </div>
      <div className={top.right}>
        {info && info.downloads.length > 0 && <DownloadsMenu downloads={info.downloads} />}
        <Tip label="Shared from STEVE Studio" description="A read-only link. The owner can revoke it at any time.">
          <a className="share-credit" href="/" rel="noopener">Shared from STEVE Studio</a>
        </Tip>
      </div>
    </header>
  );
}

/** A side panel's tab strip, as the app's Browser and Dock: the one tab, its actions and Hide panel. */
function PanelTabs({ side, label, icon, actions }: { side: 'left' | 'right'; label: string; icon: ReactNode; actions?: ReactNode }) {
  const left = side === 'left';
  return (
    <div className={dock.tabs} role="tablist" aria-label={left ? 'Browser panels' : 'Inspector panels'}>
      <button type="button" role="tab" aria-selected className={dock.tab} data-active>
        <span className={dock.tabThumb} />{icon}<span>{label}</span>
      </button>
      <span className={dock.close}>
        {actions}
        <IconButton small label="Hide panel" shortcut={left ? `${modKey}+B` : `${modKey}+.`} onClick={() => set(left ? { browserOpen: false } : { dockOpen: false })}>
          {left ? <PanelLeftClose /> : <PanelRightClose />}
        </IconButton>
      </span>
    </div>
  );
}

/** The parts, as rows of the app's model browser: an eye per part, the selection highlighted, hover linked to the model. */
function PartsPanel({ loading }: { loading: boolean }) {
  const parts = useParts();
  const selected = useSelectedPart();
  return (
    <div className={dock.dock}>
      <PanelTabs side="left" label="Parts" icon={<ListTree size={14} strokeWidth={1.7} />}
        actions={<>
          <IconButton small label="Show all" shortcut="Shift+H" disabled={loading} onClick={showAll}><Eye /></IconButton>
          <IconButton small label="Isolate selected" shortcut="I" description="Hide every other part." disabled={!selected} onClick={() => selected && isolate(selected.id)}><Focus /></IconButton>
        </>} />
      <div className={dock.body}>
        <div className={dock.pane}>
          <div className={browser.browser}>
            <div className={browser.scroll} id="share-parts">
              {loading ? <div className={browser.empty}>Loading parts…</div> : parts.map((part) => (
                <TreeRow key={part.id} depth={0} item={`part:${part.id}`} icon={<Box size={14} />} label={part.name} title={part.name}
                  selected={selected?.id === part.id} dimmed={part.hidden} onClick={() => choose(part.id)}
                  onHover={(hovering) => set({ hover: hovering ? { kind: 'component', node: part.id } : null })}
                  actions={
                    <button type="button" className={browser.eye} data-hidden={part.hidden || undefined} aria-label={`${part.hidden ? 'Show' : 'Hide'} ${part.name}`} aria-pressed={!part.hidden} onClick={() => toggleHidden(part.id)}>
                      {part.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  } />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function InspectorPanel({ info }: { info: Info | null }) {
  return (
    <div className={dock.dock}>
      <PanelTabs side="right" label="Inspector" icon={<SlidersHorizontal size={14} strokeWidth={1.7} />} />
      <div className={dock.body}><div className={dock.pane}><Inspector info={info} /></div></div>
    </div>
  );
}

/** The slim strip a collapsed side panel leaves behind (shell/PanelRail). */
function Rail({ side, transition }: { side: 'left' | 'right'; transition: object }) {
  const left = side === 'left';
  const open = () => set(left ? { browserOpen: true } : { dockOpen: true });
  const tipSide = left ? 'right' : 'left';
  const Show = left ? PanelLeftOpen : PanelRightOpen;
  const Icon = left ? ListTree : SlidersHorizontal;
  return (
    <motion.nav className={rail.rail} data-side={side} aria-label={left ? 'Browser panels' : 'Inspector panels'}
      initial={{ width: 0, opacity: 0 }} animate={{ width: 40, opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={transition}>
      <div className={rail.inner}>
        <Tip label="Show panel" shortcut={left ? `${modKey}+B` : `${modKey}+.`} side={tipSide}>
          <button type="button" className={rail.button} data-rail-open={side} aria-label="Show panel" onClick={open}><Show /></button>
        </Tip>
        <span className={rail.rule} />
        <Tip label={left ? 'Parts' : 'Inspector'} description={left ? 'Show, hide and isolate the parts.' : 'The selected part: its size, material and joint.'} side={tipSide}>
          <button type="button" className={rail.button} data-last aria-label={left ? 'Parts' : 'Inspector'} onClick={open}><Icon /></button>
        </Tip>
      </div>
    </motion.nav>
  );
}

export function DesktopShell({ info, loading, viewport }: ShellProps) {
  const browserOpen = useApp((state) => state.browserOpen);
  const dockOpen = useApp((state) => state.dockOpen);
  const browserWidth = useApp((state) => state.browserWidth);
  const dockWidth = useApp((state) => state.dockWidth);
  const resizing = useApp((state) => state.resizing);
  const transition = resizing ? { duration: 0 } : { type: 'spring' as const, stiffness: 420, damping: 42 };
  const panel = (width: number) => ({ style: { width }, initial: { width: 0, opacity: 0 }, animate: { width, opacity: 1 }, exit: { width: 0, opacity: 0 }, transition });
  return (
    <div className="share">
      <TopBar info={info} />
      <main className={app.main}>
        {/* Narrow windows only (CSS): a tap beside an open drawer closes it. */}
        {(browserOpen || dockOpen) && <div className={app.scrim} aria-hidden onClick={() => set({ browserOpen: false, dockOpen: false })} />}
        <AnimatePresence initial={false}>
          {browserOpen ? (
            <motion.aside key="browser" className={app.sidePanel} {...panel(browserWidth)}>
              <div className={app.sideInner} style={{ width: browserWidth }}><PartsPanel loading={loading} /></div>
              <Resizer side="left" />
            </motion.aside>
          ) : <Rail key="browser-rail" side="left" transition={transition} />}
        </AnimatePresence>
        <section className={app.center}>{viewport}</section>
        <AnimatePresence initial={false}>
          {dockOpen ? (
            <motion.aside key="dock" className={`${app.sidePanel} ${app.dockPanel}`} {...panel(dockWidth)}>
              <Resizer side="right" />
              <div className={app.sideInner} style={{ width: dockWidth }}><InspectorPanel info={info} /></div>
            </motion.aside>
          ) : <Rail key="dock-rail" side="right" transition={transition} />}
        </AnimatePresence>
      </main>
    </div>
  );
}

/* ───────── Phones ───────── */

type PhoneSheet = 'parts' | 'view' | 'inspector' | 'play' | 'downloads' | null;

function BarButton({ label, icon, onClick, active, id }: { label: string; icon: ReactNode; onClick: () => void; active?: boolean; id: string }) {
  return (
    <button type="button" className={phone.barButton} id={id} data-active={active || undefined} aria-pressed={active} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Tile({ label, icon, onClick, active }: { label: string; icon: ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button type="button" className={phone.tile} data-active={active || undefined} aria-pressed={active} aria-label={label} onClick={onClick}>
      {icon}<span>{label}</span>
    </button>
  );
}

/** The View sheet: the nav bar's views, display style, projection and grid as tiles. Explode has its own bar button. */
function ViewControls() {
  const style = useApp((state) => state.style);
  const projection = useApp((state) => state.projection);
  const grid = useApp((state) => state.showGrid);
  return (
    <>
      <section className={phone.group} aria-label="Views">
        <h3>Views</h3>
        <div className={phone.grid}>
          <Tile label="Fit all" icon={<FitIcon size={22} />} onClick={() => viewer.fit()} />
          {VIEWS.map((view) => <Tile key={view} label={VIEW_LABELS[view]} icon={<ViewCubeIcon size={22} />} onClick={() => viewer.setView(view)} />)}
        </div>
      </section>
      <section className={phone.group} aria-label="Display">
        <h3>Display</h3>
        <div className={phone.grid}>
          {STYLES.map((item) => { const Icon = item.icon; return <Tile key={item.value} label={item.label} icon={<Icon size={22} />} active={item.value === style} onClick={() => set({ style: item.value })} />; })}
          <Tile label="Perspective" icon={<PerspectiveIcon size={22} />} active={projection === 'perspective'}
            onClick={() => set({ projection: projection === 'orthographic' ? 'perspective' : 'orthographic' })} />
          <Tile label="Ground grid" icon={<Grid3x3 size={22} strokeWidth={1.55} />} active={grid} onClick={() => set({ showGrid: !grid })} />
        </div>
      </section>
    </>
  );
}

function PartsList() {
  const parts = useParts();
  const selected = useSelectedPart();
  if (!parts.length) return <p className={phone.empty}>Loading parts…</p>;
  return (
    <div className={phone.list} id="share-parts">
      {parts.map((part) => (
        <div key={part.id} className={phone.tabRow}>
          <button type="button" className={phone.row} aria-current={selected?.id === part.id || undefined} onClick={() => choose(part.id)}>
            <Box size={19} strokeWidth={1.6} />
            <span className={phone.rowText} style={{ opacity: part.hidden ? 0.45 : undefined }}><span>{part.name}</span>{part.hidden && <small>Hidden</small>}</span>
          </button>
          <button type="button" className={phone.iconButton} aria-label={`${part.hidden ? 'Show' : 'Hide'} ${part.name}`} aria-pressed={!part.hidden} onClick={() => toggleHidden(part.id)}>
            {part.hidden ? <EyeOff size={19} /> : <Eye size={19} />}
          </button>
        </div>
      ))}
    </div>
  );
}

/** What a tap selected, over the model: its name, the Inspector for it, and clear. */
function SelectionChip({ onInspect }: { onInspect: () => void }) {
  const selected = useSelectedPart();
  if (!selected) return null;
  return (
    <div className={phone.chip} id="share-selection" role="status">
      <span className={phone.chipLabel}>{selected.name}</span>
      <button type="button" className={phone.chipButton} aria-label="Inspect selection" onClick={onInspect}><SlidersHorizontal size={18} /></button>
      <button type="button" className={phone.chipButton} aria-label="Clear selection" onClick={() => set({ selection: [] })}><X size={18} /></button>
    </div>
  );
}

export function PhoneShell({ info, loading, viewport }: ShellProps) {
  const [sheet, setSheet] = useState<PhoneSheet>(null);
  // Explode is a strip under the model (phone/ExplodeStrip.tsx), not a sheet: it leaves the sheets as they are.
  const [exploding, setExploding] = useState(false);
  const toggle = (next: PhoneSheet) => setSheet((current) => (current === next ? null : next));
  const close = () => setSheet(null);
  const parts = useParts();
  const selected = useSelectedPart();
  const moves = useMotion((state) => !!(state.kinematics?.drives.length || state.kinematics?.animations?.length || state.kinematics?.explodes?.length));
  const playing = useMotion((state) => !!state.playing || !!state.clipStart);
  const explode = useApp((state) => state.explode);
  const explodable = parts.length > 1;
  const downloads = useDownloads(info?.downloads ?? []);
  const buttons = 3 + (explodable ? 1 : 0) + (moves ? 1 : 0) + (downloads.length ? 1 : 0);
  return (
    <div className={phone.shell} data-share-phone style={{ ['--share-buttons' as string]: buttons }}>
      <header className={phone.topbar}>
        <a className={phone.iconButton} href="/" rel="noopener" aria-label="STEVE Studio"><img className="share-mark" src={mark} alt="" /></a>
        <div className={phone.title}>
          <span className={phone.titleLine}><span className={phone.name}>{info?.name ?? 'Loading…'}</span></span>
          {info && <small>Revision {info.revision} · read-only</small>}
        </div>
      </header>
      <main className={phone.main}>
        {viewport}
        {explodable && exploding && <ExplodeStrip id="share-explode" value={explode} onChange={setExplode} onClose={() => setExploding(false)} />}
        {!sheet && <SelectionChip onInspect={() => setSheet('inspector')} />}
      </main>
      <nav className={phone.bar} aria-label="Share toolbar" id="share-bar" data-share-bar>
        <BarButton id="share-parts-button" label="Parts" active={sheet === 'parts'} icon={<ListTree size={22} strokeWidth={1.6} />} onClick={() => toggle('parts')} />
        <BarButton id="share-view-button" label="View" active={sheet === 'view'} icon={<Eye size={22} strokeWidth={1.6} />} onClick={() => toggle('view')} />
        {explodable && <BarButton id="share-explode-button" label="Explode" active={exploding || explode > 0} icon={<Expand size={22} strokeWidth={1.6} />} onClick={() => setExploding(!exploding)} />}
        <BarButton id="share-inspector-button" label="Inspector" active={sheet === 'inspector'} icon={<SlidersHorizontal size={22} strokeWidth={1.6} />} onClick={() => toggle('inspector')} />
        {moves && <BarButton id="share-play-button" label={playing ? 'Playing' : 'Play'} active={sheet === 'play' || playing} icon={playing ? <Pause size={22} /> : <Play size={22} />} onClick={() => toggle('play')} />}
        {downloads.length > 0 && <BarButton id="share-downloads-button" label="Downloads" active={sheet === 'downloads'} icon={<DownloadIcon size={22} strokeWidth={1.6} />} onClick={() => toggle('downloads')} />}
      </nav>
      <Sheet open={sheet === 'parts'} onClose={close} label="Parts" title={<>Parts{!loading && <small>{parts.length}</small>}</>} id="share-parts-sheet"
        actions={<>
          <button type="button" className={phone.iconButton} aria-label="Show all" disabled={loading} onClick={showAll}><Eye size={20} /></button>
          <button type="button" className={phone.iconButton} aria-label="Isolate selected" aria-disabled={!selected || undefined} onClick={() => selected && isolate(selected.id)}><Focus size={20} /></button>
        </>}>
        <PartsList />
      </Sheet>
      <Sheet open={sheet === 'view'} onClose={close} label="View" title="View" size="peek" id="share-view-sheet"><ViewControls /></Sheet>
      <Sheet open={sheet === 'inspector'} onClose={close} label="Inspector" title="Inspector" id="share-inspector-sheet">
        <div className="share-touch"><Inspector info={info} touch /></div>
      </Sheet>
      <Sheet open={sheet === 'play'} onClose={close} label="Play" title="Play" size="peek" id="share-play-sheet">
        <div className={`${panels.stack} share-touch`}><MotionControls /></div>
      </Sheet>
      <Sheet open={sheet === 'downloads'} onClose={close} label="Downloads" title="Downloads" size="peek" id="share-downloads-sheet">
        <div className={phone.list}>
          {downloads.map((item) => (ready(item)
            ? <button type="button" key={item.url} className={phone.row} onClick={() => { void requestDownload(item.url); }}><FileDown size={19} strokeWidth={1.6} /><span className={phone.rowText}><span>{item.name}</span></span></button>
            : <div key={item.url} className={phone.row} aria-disabled="true"><FileDown size={19} strokeWidth={1.6} /><span className={phone.rowText}><span>{item.name}</span><small>{pending(item)}</small></span></div>))}
        </div>
      </Sheet>
    </div>
  );
}
