import { Fragment, useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type WheelEvent } from 'react';
import { flushSync } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tip } from '@/ui';
import { useApp, type AppState, type DesignTab, type Workspace } from '@/state/store';
import { availability, command, RIBBONS, SKETCH_RIBBON, drawingRibbon, motionRibbon, sceneRibbon, sheetMetalRibbon, surfaceRibbon, type Command, type IconType, type RibbonGroup } from '@/commands';
import { shownTab } from '@/state/designTab';
import { displayShortcut } from '@/lib/format';
import { useCommandEpoch } from '@/commandEpoch';
import styles from './Ribbon.module.css';
import ExportMenuItems from './ExportMenu';

function useCommandState(cmd: Command) {
  useCommandEpoch((epoch) => epoch.n);   // Availability that reads a workspace's own store (commandEpoch.ts).
  return useApp((state: AppState) => {
    const available = availability(cmd, state);
    return `${available === true ? '1' : available}|${cmd.active?.(state) ? 1 : 0}`;
  });
}

function RibbonButton({ id }: { id: string }) {
  const cmd = command(id);
  const [available, active] = useCommandState(cmd).split('|');
  const enabled = available === '1';
  const Icon = cmd.icon;
  return (
    <Tip label={cmd.label} description={cmd.description} shortcut={displayShortcut(cmd.shortcut)} reason={enabled ? undefined : available}>
      <button
        type="button"
        className={styles.button}
        data-command={cmd.id}
        data-active={active === '1' || undefined}
        data-soon={cmd.soon ? true : undefined}
        aria-disabled={!enabled}
        aria-pressed={cmd.active ? active === '1' : undefined}
        onClick={() => enabled && cmd.run()}
      >
        <span className={styles.icon}>
          <Icon size={20} strokeWidth={1.55} />
          {cmd.soon && <span className={styles.soonDot} />}
        </span>
        <span className={styles.label}>{cmd.short ?? cmd.label}</span>
      </button>
    </Tip>
  );
}

function RibbonMenu({ menu, label, icon: Icon, items }: { menu: string; label: string; icon: IconType; items: string[] }) {
  useCommandEpoch((epoch) => epoch.n);
  const states = useApp((state) => items.map((id) => availability(command(id), state)).join('|'));
  const availabilities = states.split('|');
  const anyEnabled = availabilities.some((value) => value === 'true');
  return (
    <Menu>
      <Tip label={label} description={anyEnabled ? undefined : availabilities[0]}>
        <MenuTrigger asChild>
          <button type="button" className={clsx(styles.button, styles.menuButton)} aria-disabled={!anyEnabled}>
            <span className={styles.icon}><Icon size={20} strokeWidth={1.55} /></span>
            <span className={styles.label}>{label}<ChevronDown size={10} strokeWidth={2.2} /></span>
          </button>
        </MenuTrigger>
      </Tip>
      <MenuContent>
        {menu === 'export' ? <ExportMenuItems /> : items.map((id, index) => {
          const cmd = command(id);
          const ItemIcon = cmd.icon;
          const available = availabilities[index];
          return (
            <MenuItem key={id} icon={<ItemIcon size={15} />} disabled={available !== 'true'} hint={cmd.soon ? 'Soon' : undefined} onSelect={cmd.run}>
              {cmd.label}
            </MenuItem>
          );
        })}
      </MenuContent>
    </Menu>
  );
}

type GroupItem = RibbonGroup['items'][number];

/** The group's buttons, without those its per-button mask hides. */
const shownItems = (group: RibbonGroup, hidden: string) => group.items.filter((_, i) => hidden[i] !== '0');
const commandIds = (items: GroupItem[]) => items.flatMap((item) => (typeof item === 'string' ? [item] : item.items));
const groupIcon = (group: RibbonGroup): IconType => {
  if (group.icon) return group.icon;
  const first = group.items[0];
  return typeof first === 'string' ? command(first).icon : first.icon;
};

/**
 * A group folded into one button (its title and icon) that opens a menu of the group's commands: icons, labels,
 * shortcuts, "Soon" hints, why a command is unavailable, and a check on the active ones. The button is marked active
 * while one of them is (e.g. Section on), and tagged data-group / data-collapsed.
 */
function GroupMenu({ group, hidden }: { group: RibbonGroup; hidden: string }) {
  const items = shownItems(group, hidden);
  const ids = commandIds(items);
  useCommandEpoch((epoch) => epoch.n);
  // One string per state change: "1" or the reason, then the active flag, per command.
  const states = useApp((state) => ids.map((id) => {
    const cmd = command(id);
    const available = availability(cmd, state);
    return `${available === true ? '1' : available}\u0001${cmd.active?.(state) ? 1 : 0}`;
  }).join('\u0002')).split('\u0002').map((value) => value.split('\u0001'));
  const stateOf = new Map(ids.map((id, index) => [id, { enabled: states[index][0] === '1', reason: states[index][0], active: states[index][1] === '1' }]));
  const anyEnabled = items.some((item) => (typeof item === 'string' ? stateOf.get(item)!.enabled : item.menu === 'export' || item.items.some((id) => stateOf.get(id)!.enabled)));
  const anyActive = ids.some((id) => stateOf.get(id)!.active);
  const Icon = groupIcon(group);
  const entry = (id: string) => {
    const cmd = command(id);
    const ItemIcon = cmd.icon;
    const { enabled, reason, active } = stateOf.get(id)!;
    return (
      <MenuItem key={id} command={id} icon={<ItemIcon size={15} />} disabled={!enabled} reason={enabled ? undefined : reason} checked={active}
        shortcut={displayShortcut(cmd.shortcut)} hint={cmd.soon ? 'Soon' : undefined} onSelect={() => { if (availability(cmd, useApp.getState()) === true) cmd.run(); }}>
        {cmd.label}
      </MenuItem>
    );
  };
  const summary = items.map((item) => (typeof item === 'string' ? command(item).short ?? command(item).label : item.label)).join(' · ');
  return (
    <Menu>
      <Tip label={group.title} description={summary}>
        <MenuTrigger asChild>
          <button type="button" className={clsx(styles.button, styles.menuButton)} data-group={group.title} data-collapsed=""
            data-active={anyActive || undefined} aria-disabled={!anyEnabled}>
            <span className={styles.icon}><Icon size={20} strokeWidth={1.55} /></span>
            <span className={styles.label}>{group.title}<ChevronDown size={10} strokeWidth={2.2} /></span>
          </button>
        </MenuTrigger>
      </Tip>
      <MenuContent className={styles.groupMenu}>
        {items.map((item, index) => {
          if (typeof item === 'string') return entry(item);
          const separator = index > 0 && <MenuSeparator />;
          if (item.menu === 'export') return <Fragment key={item.menu}>{separator}<ExportMenuItems label={item.label} /></Fragment>;
          return (
            <Fragment key={item.menu}>
              {separator}
              <MenuLabel>{item.label}</MenuLabel>
              {item.items.map(entry)}
              {index < items.length - 1 && typeof items[index + 1] === 'string' && <MenuSeparator />}
            </Fragment>
          );
        })}
      </MenuContent>
    </Menu>
  );
}

function Group({ group, index, hidden, collapsed }: { group: RibbonGroup; index: number; hidden: string; collapsed: boolean }) {
  return (
    <motion.div
      className={styles.group}
      data-group={group.title}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.028, duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className={styles.items}>
        {collapsed ? <GroupMenu group={group} hidden={hidden} /> : shownItems(group, hidden).map((item) => typeof item === 'string'
          ? <RibbonButton key={item} id={item} />
          : <RibbonMenu key={item.menu} menu={item.menu} label={item.label} icon={item.icon} items={item.items} />)}
      </div>
      {/* A folded group's button already carries its title. */}
      <div className={styles.groupTitle}>{collapsed ? '' : group.title}</div>
    </motion.div>
  );
}

/** A ribbon button's footprint without its behaviour, for measuring (same classes, icon box and label). */
function Footprint({ label, chevron }: { label: string; chevron?: boolean }) {
  return (
    <span className={clsx(styles.button, chevron && styles.menuButton)}>
      <span className={styles.icon} />
      <span className={styles.label}>{label}{chevron && <ChevronDown size={10} strokeWidth={2.2} />}</span>
    </span>
  );
}

/** A group as it would draw, expanded or folded, so its width can be read without drawing it in the ribbon. */
function GroupFootprint({ group, hidden, collapsed }: { group: RibbonGroup; hidden: string; collapsed: boolean }) {
  return (
    <div className={styles.group} data-footprint={collapsed ? 'collapsed' : 'expanded'}>
      <div className={styles.items}>
        {collapsed ? <Footprint label={group.title} chevron /> : shownItems(group, hidden).map((item) => (typeof item === 'string'
          ? <Footprint key={item} label={command(item).short ?? command(item).label} />
          : <Footprint key={item.menu} label={item.label} chevron />))}
      </div>
      <div className={styles.groupTitle}>{collapsed ? '' : group.title}</div>
    </div>
  );
}

/**
 * A ribbon at least 1024 px wide folds groups, whatever the pointer (a touchscreen laptop's coarse one too); a narrower
 * one scrolls sideways, with its hidden ends faded. Phones have their own shell and no ribbon (phone/detect.ts).
 */
const DESKTOP = '(min-width: 1024px)';
const subscribeDesktop = (onChange: () => void) => {
  if (typeof matchMedia === 'undefined') return () => {};
  const query = matchMedia(DESKTOP);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};
const isDesktop = () => typeof matchMedia !== 'undefined' && matchMedia(DESKTOP).matches;
const useDesktop = () => useSyncExternalStore(subscribeDesktop, isDesktop, () => false);

/** Groups unfold again only once there is this much more room than they need, so resizing near an edge doesn't flicker. */
const HYSTERESIS = 32;

/** The ribbon for the current context: the sketch's while sketching; in Design, the top bar's tab (Solid, Sheet metal, Surface, Motion, Drawing or Animation). */
const blenderSceneRibbon: RibbonGroup[] = [
  {title:'Scene',priority:100,items:['create.source','blender.open','view.fit']},
  {title:'Render',priority:100,items:['blender.render']},
  {title:'Export',priority:100,items:['export.blend','export.source']},
];
const ribbonFor = (state: { workspace: Workspace; designTab: DesignTab; blender:boolean }, sketching: boolean) => {
  if (sketching) return SKETCH_RIBBON;
  if (state.workspace !== 'design') return RIBBONS[state.workspace];
  if (state.blender && state.designTab !== 'animation') return blenderSceneRibbon;
  return state.designTab === 'sheet' ? sheetMetalRibbon : state.designTab === 'surface' ? surfaceRibbon : state.designTab === 'motion' ? motionRibbon : state.designTab === 'drawing' ? drawingRibbon : state.designTab === 'animation' ? sceneRibbon : RIBBONS.design;
};

export default function Ribbon() {
  const workspace = useApp((state) => state.workspace);
  const blender = useApp((state)=>state.doc.kind==='blender');
  const designTab = useApp(shownTab);
  const sketching = useApp((state) => !!state.sketching && !state.sketching.choosing);
  const visibility = useApp((state) => ribbonFor({ workspace: state.workspace, designTab: shownTab(state), blender:state.doc.kind==='blender' }, sketching).map((group) => (group.visible ? (group.visible(state) ? 1 : 0) : 1)).join(''));
  // Per-button visibility, one mask per group ("1" shown, "0" hidden), so the ribbon re-renders only when it changes.
  const items = useApp((state) => ribbonFor({ workspace: state.workspace, designTab: shownTab(state), blender:state.doc.kind==='blender' }, sketching).map((group) => group.items.map((item) =>
    (group.show && typeof item === 'string' ? (group.show(item, state) ? '1' : '0') : '1')).join('')).join('|'));
  const masks = items.split('|');
  const all = ribbonFor({ workspace, designTab, blender }, sketching);
  const groups = all.map((group, index) => ({ group, mask: masks[index] ?? '' })).filter(({ group, mask }, index) => visibility[index] === '1' && (!group.show || mask.includes('1')));
  const context = sketching ? 'sketch' : workspace === 'design' ? `design-${blender?'blender-':''}${designTab}` : workspace;

  // Desktop: fold whole groups (lowest priority first) until the rest fit. Widths come from the hidden footprints, never
  // from the drawn ribbon, so folding can't feed back into the measurement.
  const desktop = useDesktop();
  const ribbonRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState<{ layout: string; titles: string[] }>({ layout: '', titles: [] });
  const layout = `${context}|${visibility}|${items}`;
  const titles = groups.map(({ group }) => group.title);
  const order = groups.map(({ group }, index) => ({ group, index }))
    .filter(({ group }) => !group.compact)
    .sort((a, b) => (a.group.priority ?? 0) - (b.group.priority ?? 0) || b.index - a.index)
    .map(({ index }) => index);
  const fit = useCallback((fresh: boolean) => {
    const ribbon = ribbonRef.current, measure = measureRef.current;
    if (!ribbon || !measure) return;
    const style = getComputedStyle(ribbon);
    const room = ribbon.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const width = (index: number, kind: 'expanded' | 'collapsed') => (measure.children[index]?.querySelector(`[data-footprint="${kind}"]`) as HTMLElement | null)?.getBoundingClientRect().width ?? 0;
    const full = titles.map((_, index) => width(index, groups[index].group.compact ? 'collapsed' : 'expanded'));
    const small = titles.map((_, index) => width(index, 'collapsed'));
    // Folding a group no wider than its folded button gains nothing.
    const foldable = order.filter((index) => small[index] < full[index] - 1);
    const widthWith = (fold: Set<number>) => full.reduce((sum, value, index) => sum + (fold.has(index) ? small[index] : value), 0);
    // Fold lowest priority first until the rest fit; then unfold, highest priority first, any folded group that
    // fits again (a small group folded on the way to a big one gains nothing).
    const solve = (space: number) => {
      const fold = new Set<number>();
      for (const index of foldable) {
        if (widthWith(fold) <= space) break;
        fold.add(index);
      }
      for (const index of [...foldable].reverse()) {
        if (!fold.has(index)) continue;
        fold.delete(index);
        if (widthWith(fold) > space) fold.add(index);
      }
      return fold;
    };
    setFolded((previous) => {
      const same = !fresh && previous.layout === layout;
      const current = new Set(same ? previous.titles.map((title) => titles.indexOf(title)).filter((index) => index >= 0) : []);
      let fold = solve(room);
      // Still fitting: keep the folds unless a wider ribbon is a margin past what unfolding needs (no flicker at an edge).
      if (same && widthWith(current) <= room) {
        const roomier = solve(room - HYSTERESIS);
        fold = widthWith(roomier) > widthWith(current) ? roomier : current;
      }
      const next = foldable.filter((index) => fold.has(index)).map((index) => titles[index]);
      return same && next.join('\n') === previous.titles.join('\n') ? previous : { layout, titles: next };
    });
  }, [layout]); // titles, groups and order follow from layout
  useLayoutEffect(() => {
    if (!desktop) return;
    fit(true);
    // Applied before the frame paints, so a resize never shows the ribbon overflowing.
    const observer = new ResizeObserver(() => flushSync(() => fit(false)));
    if (ribbonRef.current) observer.observe(ribbonRef.current);
    // Footprints change size when the font arrives.
    for (const child of Array.from(measureRef.current?.children ?? [])) observer.observe(child);
    return () => observer.disconnect();
  }, [desktop, fit]);
  const collapsed = (group: RibbonGroup) => desktop && (!!group.compact || (folded.layout === layout && folded.titles.includes(group.title)));

  // Whatever still doesn't fit (a narrow window, or every group folded) scrolls sideways: the hidden end fades, and a
  // mouse wheel scrolls it, so no command is ever out of reach.
  const [more, setMore] = useState('');
  const edges = useCallback(() => {
    const ribbon = ribbonRef.current;
    if (!ribbon) return;
    const start = ribbon.scrollLeft > 1, end = ribbon.scrollLeft + ribbon.clientWidth < ribbon.scrollWidth - 1;
    setMore(start && end ? 'both' : start ? 'start' : end ? 'end' : '');
  }, []);
  const edgesObserver = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    const ribbon = ribbonRef.current;
    if (!ribbon) return;
    const observer = new ResizeObserver(edges);
    edgesObserver.current = observer;
    observer.observe(ribbon);
    ribbon.addEventListener('scroll', edges, { passive: true });
    return () => { observer.disconnect(); ribbon.removeEventListener('scroll', edges); };
  }, [edges]);
  useLayoutEffect(() => {
    // The groups' row is replaced when the context changes and grows when the font arrives.
    for (const row of Array.from(ribbonRef.current?.children ?? [])) if (row.classList.contains(styles.groups)) edgesObserver.current?.observe(row);
    edges();
  });
  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    const ribbon = event.currentTarget;
    if (ribbon.scrollWidth <= ribbon.clientWidth + 1 || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    ribbon.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? ribbon.clientWidth : 1);
  };

  return (
    <div ref={ribbonRef} className={styles.ribbon} role="toolbar" aria-label="Commands" data-context={sketching ? 'sketch' : undefined}
      data-more={more || undefined} onWheel={wheel}
      data-folded={desktop ? groups.filter(({ group }) => collapsed(group)).map(({ group }) => group.title).join(',') : undefined}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={context}
          className={styles.groups}
          exit={{ opacity: 0, y: -4, transition: { duration: 0.1 } }}
        >
          {groups.map(({ group, mask }, index) => <Group key={group.title} group={group} index={index} hidden={mask} collapsed={collapsed(group)} />)}
        </motion.div>
      </AnimatePresence>
      {desktop && (
        <div ref={measureRef} className={styles.measure} aria-hidden inert>
          {groups.map(({ group, mask }) => (
            <div key={group.title} className={styles.footprints}>
              <GroupFootprint group={group} hidden={mask} collapsed={false} />
              <GroupFootprint group={group} hidden={mask} collapsed />
            </div>
          ))}
        </div>
      )}
      <div className={styles.accent} />
    </div>
  );
}
