import {openSettings} from '@/settings/registry';
import { Box, FilePlus2, Layers3, Shapes } from 'lucide-react';
import { Dialog } from '@/ui';
import { set, useApp } from '@/state/store';
import { openTab } from '@/state/tabs';
import { CircuitIcon } from '@/icons/cad';
import type { Kind } from '@/lib/api';
import styles from './Dialogs.module.css';

export default function NewDialog({ open }: { open: boolean }) {
  const electronics = useApp((state) => state.workspaces.includes('electronics'));
  const blender = useApp((state) => state.blenderInstalled);
  const create = (kind: Kind) => { set({ dialog: null }); openTab({ kind }); };
  // Three choices side by side; two in two columns. Shops and CAM programs aren't made here: they live in Manufacture.
  const choices = 3 + (electronics ? 1 : 0);
  return (
    <Dialog open={open} onOpenChange={(value) => !value && set({ dialog: null })} title="New" description="Choose the document type. It can’t be changed after saving." icon={<div className={styles.itemIcon} style={{ color: 'var(--ws)' }}><FilePlus2 size={17} /></div>} width={choices === 3 ? 700 : choices === 4 ? 560 : 500}>
      <div className={styles.choices} style={choices === 3 ? { gridTemplateColumns: 'repeat(3, 1fr)' } : undefined}>
        <button type="button" className={styles.choice} data-kind="part" onClick={() => create('part')}><Box size={24} /><b>Part</b><span>One solid body defined by code. Designs link saved parts and place them.</span></button>
        <button type="button" className={styles.choice} data-kind="design" onClick={() => create('design')}><Layers3 size={24} /><b>Design</b><span>Several components designed together, like a codebase: shared parameters, one file per component, linked parts and designs placed together.</span></button>
        {electronics && <button type="button" className={styles.choice} data-kind="circuit" onClick={() => create('circuit')}><CircuitIcon size={24} /><b>Circuit</b><span>A circuit board as TSX, with tscircuit: schematic, routed board and 3D from one file, edited by code, STEVE or hand.</span></button>}
        {<button type="button" className={styles.choice} data-kind="blender" onClick={() => blender ? create('blender') : (set({dialog:null}),openSettings('local-blender'))}><Shapes size={24} /><b>{blender?'Blender scene':'Set up Blender'}</b><span>Meshes made with Blender Python (bpy): organic and sculpted forms, modifiers and renders, with a .blend download.</span></button>}
      </div>
    </Dialog>
  );
}
