import { useEffect, useState } from 'react';
import { CircuitIcon } from '@/icons/cad';
import { Command as Cmdk } from 'cmdk';
import { motion } from 'motion/react';
import { Dialog as RDialog } from 'radix-ui';
import { Box, CornerDownLeft, Factory, Layers3, Search } from 'lucide-react';
import { Shortcut } from '@/ui';
import { get, set, useApp } from '@/state/store';
import { availability, commands, switchedOff } from '@/commands';
import { displayShortcut, relativeTime } from '@/lib/format';
import { openTab } from '@/state/tabs';
import { kindLabel, loadDocuments } from '@/lib/library';
import type { DocumentSummary } from '@/lib/api';
import styles from './Dialogs.module.css';
import ui from '@/ui/ui.module.css';

/** Ranks by how directly the query names the item; loose letter matches never outrank real words. */
function score(query: string, label: string, extra = ''): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const text = label.toLowerCase();
  if (text === q) return 100;
  if (text.startsWith(q)) return 90;
  if (text.split(/[\s/·.-]+/).some((word) => word.startsWith(q))) return 70;
  if (text.includes(q)) return 50;
  if (extra.toLowerCase().includes(q)) return 25;
  // Every word of the query must start a word of the label ("new des" → "New design").
  const words = q.split(/\s+/);
  const labelWords = text.split(/[\s/·.-]+/);
  if (words.length > 1 && words.every((word) => labelWords.some((candidate) => candidate.startsWith(word)))) return 40;
  return 0;
}

export default function CommandPalette({ open }: { open: boolean }) {
  const [library, setLibrary] = useState<DocumentSummary[]>([]);
  const [search, setSearch] = useState('');
  const workspace = useApp((state) => state.workspace);
  useEffect(() => {
    if (!open) return;
    setSearch(get().paletteQuery);
    loadDocuments().then(setLibrary).catch(() => setLibrary([]));
  }, [open]);
  const close = () => set({ dialog: null });
  const state = get();
  const visible = commands.filter((cmd) => !cmd.hidden?.(state) && !switchedOff(cmd, state));
  const ranked = search.trim() ? [
    ...visible.map((cmd) => ({ key: cmd.id, rank: score(search, cmd.label, `${cmd.category} ${cmd.description ?? ''}`) + (availability(cmd, state) === true ? 1 : 0), cmd, entry: null as DocumentSummary | null })),
    ...library.map((entry) => ({ key: `doc:${entry.id}`, rank: score(search, entry.name) - 5, cmd: null, entry })),
  ].filter((item) => item.rank > 1).sort((a, b) => b.rank - a.rank).slice(0, 30) : [];
  const [value, setValue] = useState('');
  const top = ranked[0]?.key ?? '';
  useEffect(() => { if (search.trim()) setValue(top); }, [search, top]);
  const categories = [...new Set(visible.map((cmd) => cmd.category))];
  // Put the active workspace's own commands first.
  const priority = workspace === 'simulate' ? 'Simulate' : workspace === 'manufacture' ? 'Manufacture' : 'Document';
  categories.sort((a, b) => (a === priority ? -1 : b === priority ? 1 : 0));

  return (
    <RDialog.Root open={open} onOpenChange={(value) => !value && close()}>
      {/* Unmount on selection: an exiting palette must not intercept CAD picks. */}
        {open && (
          <RDialog.Portal forceMount>
            <RDialog.Overlay asChild forceMount>
              <motion.div className={ui.overlay} style={{ backdropFilter: 'blur(2px)' }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} />
            </RDialog.Overlay>
            <RDialog.Content asChild forceMount aria-describedby={undefined}>
              <motion.div className={styles.palette} style={{ x: '-50%' }} initial={{ opacity: 0, scale: 0.97, y: -8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98, y: -4 }} transition={{ type: 'spring', stiffness: 520, damping: 38 }}>
                <RDialog.Title className="sr-only">Command palette</RDialog.Title>
                <Cmdk label="Command palette" loop shouldFilter={false} value={value} onValueChange={setValue}>
                  <Search size={18} className={styles.paletteIcon} />
                  {/* Escape is handled here too: Radix's dismiss can lose a keypress to another layer that's still closing. */}
                  <Cmdk.Input autoFocus value={search} onValueChange={setSearch} placeholder="Type a command or search designs…"
                    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }} />
                  <Cmdk.List>
                    <Cmdk.Empty>No results for “{search}”.</Cmdk.Empty>
                    {search.trim() ? (
                      <Cmdk.Group heading="Best matches">
                        {ranked.map((item) => {
                          if (item.cmd) {
                            const cmd = item.cmd;
                            const available = availability(cmd, state);
                            const Icon = cmd.icon;
                            return (
                              <Cmdk.Item key={item.key} value={item.key} disabled={available !== true} onSelect={() => { close(); requestAnimationFrame(() => cmd.run()); }}>
                                <Icon size={16} />
                                <span>{cmd.label}</span>
                                <span className={styles.paletteMeta}>
                                  {available !== true ? <span>{cmd.soon ? 'Soon' : available}</span> : <span>{cmd.category}</span>}
                                  {cmd.shortcut && available === true && <Shortcut keys={displayShortcut(cmd.shortcut)!} />}
                                </span>
                              </Cmdk.Item>
                            );
                          }
                          const entry = item.entry!;
                          const Icon = entry.kind === 'design' ? Layers3 : entry.kind === 'circuit' ? CircuitIcon as unknown as typeof Box : entry.kind === 'shop' ? Factory : Box;
                          return (
                            <Cmdk.Item key={item.key} value={item.key} onSelect={() => { close(); openTab({ id: entry.id }); }}>
                              <Icon size={16} />
                              <span>{entry.name}</span>
                              <span className={styles.paletteMeta}>Open · {kindLabel(entry.kind)}</span>
                            </Cmdk.Item>
                          );
                        })}
                      </Cmdk.Group>
                    ) : categories.map((category) => (
                      <Cmdk.Group key={category} heading={category}>
                        {visible.filter((cmd) => cmd.category === category).map((cmd) => {
                          const available = availability(cmd, state);
                          const Icon = cmd.icon;
                          return (
                            <Cmdk.Item key={cmd.id} value={`${cmd.label} ${cmd.category} ${cmd.description ?? ''}`} disabled={available !== true} onSelect={() => { close(); requestAnimationFrame(() => cmd.run()); }}>
                              <Icon size={16} />
                              <span>{cmd.label}</span>
                              <span className={styles.paletteMeta}>
                                {available !== true && <span>{cmd.soon ? 'Soon' : available}</span>}
                                {cmd.shortcut && available === true && <Shortcut keys={displayShortcut(cmd.shortcut)!} />}
                              </span>
                            </Cmdk.Item>
                          );
                        })}
                      </Cmdk.Group>
                    ))}
                    {!search.trim() && library.length > 0 && (
                      <Cmdk.Group heading="Designs">
                        {library.slice(0, 40).map((entry) => {
                          const Icon = entry.kind === 'design' ? Layers3 : entry.kind === 'circuit' ? CircuitIcon as unknown as typeof Box : entry.kind === 'shop' ? Factory : Box;
                          return (
                            <Cmdk.Item key={`doc:${entry.id}`} value={`open ${entry.name} ${entry.id}`} onSelect={() => { close(); openTab({ id: entry.id }); }}>
                              <Icon size={16} />
                              <span>{entry.name}</span>
                              <span className={styles.paletteMeta}>{kindLabel(entry.kind)} · {relativeTime(entry.updated_at)}</span>
                            </Cmdk.Item>
                          );
                        })}
                      </Cmdk.Group>
                    )}
                  </Cmdk.List>
                </Cmdk>
                <div className={styles.paletteFooter}>
                  <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
                  <span><kbd><CornerDownLeft size={10} /></kbd> run</span>
                  <span><kbd>Esc</kbd> close</span>
                </div>
              </motion.div>
            </RDialog.Content>
          </RDialog.Portal>
        )}

    </RDialog.Root>
  );
}
