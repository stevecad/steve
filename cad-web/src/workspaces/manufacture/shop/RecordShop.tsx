/**
 * A library record's footer in the read-only records view: the library is written by the shop. A record a shop holds
 * opens there ("Edit in your shop": the shop's Code tab at the item's file and line); one no shop holds yet (older
 * libraries, imports, the reference examples) is written into your shop as code ("Add to your shop"), keeping the
 * same record.
 */
import { useEffect } from 'react';
import { Factory, FileCode } from 'lucide-react';
import { Button } from '@/ui';
import { PaneSpacer } from '@/ui/SectionedDialog';
import { useMfg } from '../state';
import type { LibraryRecord } from '../api';
import { addToShop, focusItem, loadHolders, useShop } from './state';
import styles from '../Manufacture.module.css';

export default function RecordShop({ record }: { record: LibraryRecord }) {
  const holder = useShop((state) => state.holders[record.id]);
  const busy = useShop((state) => state.busy);
  useEffect(() => { void loadHolders(); }, [record.id]);
  const open = () => useMfg.setState({ libraryKind: 'shop', librarySelect: null });
  return (
    <>
      <span className={styles.muted} id="record-shop">{holder ? <>In <b>{holder.document_name ?? 'your shop'}</b> as <code>{holder.key}</code></> : 'Not in a shop yet'}</span>
      <PaneSpacer />
      {holder ? (
        <Button size="sm" variant="primary" icon={<FileCode />} id="edit-in-shop" disabled={!!busy}
          onClick={() => { void focusItem(holder).then(() => open()); }}>Edit in your shop</Button>
      ) : (
        <Button size="sm" variant="primary" icon={<Factory />} id="add-to-shop" disabled={!!busy}
          onClick={() => { void addToShop([record.id], String(record.definition.name)).then((added) => {
            const held = useShop.getState().holders[record.id];
            if (added && held) void focusItem(held).then(open); else if (added) open();
          }); }}>
          {busy ? `${busy}…` : 'Add to your shop'}
        </Button>
      )}
    </>
  );
}
