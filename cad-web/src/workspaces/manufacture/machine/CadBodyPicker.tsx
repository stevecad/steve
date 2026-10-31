/**
 * Choose a machine body from a saved STEVE part or design: the document, its revision (the latest by default; the
 * machine pins exactly that one) and one solid body in it.
 */
import { useEffect, useMemo, useState } from 'react';
import { Box, Search } from 'lucide-react';
import { Button, Dialog, Spinner } from '@/ui';
import { Api, type DocumentSummary } from '@/lib/api';
import { cadRevision, instancesOf, type BodySource, type CadRevision } from './bodyGeometry';
import styles from './Machine.module.css';

export interface PickedBody { source: BodySource; name: string; documentName: string }

const size = (extent: number[]) => [extent[3] - extent[0], extent[4] - extent[1], extent[5] - extent[2]].map((value) => value.toLocaleString(undefined, { maximumFractionDigits: 1 })).join(' × ');

export default function CadBodyPicker({ open, current, onPick, onClose }: { open: boolean; current?: BodySource | null; onPick: (picked: PickedBody) => void; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(current?.document_id ?? null);
  const [revisions, setRevisions] = useState<number[]>([]);
  const [revision, setRevision] = useState<number | null>(current?.revision ?? null);
  const [loaded, setLoaded] = useState<CadRevision | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = setTimeout(() => {
      Api.documents({ search: search.trim() || undefined, limit: 60 }).then((value) => { if (live) setDocuments(value.documents); }).catch((error) => { if (live) setProblem((error as Error).message); });
    }, search ? 200 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [open, search]);
  const chosen = useMemo(() => documents?.find((item) => item.id === documentId) ?? null, [documents, documentId]);
  // The document's revisions (newest first); the latest unless the body being changed pins another.
  useEffect(() => {
    if (!documentId) return;
    let live = true;
    setRevisions([]); setLoaded(null); setProblem(null);
    fetch(`/v1/documents/${documentId}/history?limit=100`).then((response) => response.json()).then((value: { revisions?: { revision: number }[] }) => {
      if (!live) return;
      const list = [...new Set((value.revisions ?? []).map((item) => item.revision))];
      setRevisions(list);
      setRevision((current_) => (current_ && list.includes(current_) && documentId === current?.document_id ? current_ : list[0] ?? null));
    }).catch(() => { if (live) setRevisions([]); });
    return () => { live = false; };
  }, [documentId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!documentId || !revision) return;
    let live = true;
    setLoading(true); setLoaded(null); setProblem(null);
    cadRevision(documentId, revision).then((value) => { if (live) setLoaded(value); }).catch((error) => { if (live) setProblem((error as Error).message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [documentId, revision]);

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }} width={760} icon={<Box size={18} />} title="Machine body from a part"
      description="Pick a saved part or design and one solid in it. The machine pins that exact revision; place it on its axis afterwards.">
      <div className={styles.picker} id="cad-body-picker">
        <div className={styles.pickerDocs}>
          <label className={styles.searchBox}><Search size={13} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search parts and designs" aria-label="Search parts and designs" /></label>
          <ul className={styles.docList} data-documents>
            {documents === null && <li className={styles.muted}><Spinner size={12} /> Loading…</li>}
            {documents?.length === 0 && <li className={styles.muted}>No saved parts match.</li>}
            {documents?.map((item) => (
              <li key={item.id}>
                <button type="button" data-on={item.id === documentId || undefined} data-document={item.name} onClick={() => setDocumentId(item.id)}>
                  <span>{item.name}</span><small>{item.kind === 'design' ? 'Design' : 'Part'} · rev {item.revision}</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className={styles.pickerBodies}>
          {!documentId && <p className={styles.muted}>Choose a part or design on the left.</p>}
          {documentId && (
            <label className={styles.inline}>Revision
              <select className={styles.select} value={revision ?? ''} onChange={(event) => setRevision(Number(event.target.value))} aria-label="Revision">
                {revisions.map((item, index) => <option key={item} value={item}>Revision {item}{index === 0 ? ' (latest)' : ''}</option>)}
              </select>
            </label>
          )}
          {loading && <p className={styles.muted}><Spinner size={12} /> Reading {chosen?.name ?? 'the part'}’s bodies (building it if needed)…</p>}
          {problem && <p className={styles.note} data-tone="danger" role="alert">{problem}</p>}
          {loaded && (
            <ul className={styles.bodyChoices} data-bodies>
              {loaded.bodies.map((body) => (
                <li key={`${body.instance}/${body.body}`}>
                  <button type="button" data-body={body.body} onClick={() => onPick({
                    source: { document_id: loaded.documentId, revision: loaded.revision, branch: 'main', instances: instancesOf(body), body: body.body },
                    name: body.name || body.body, documentName: loaded.name,
                  })}>
                    <span>{body.name || body.body}{body.instance !== 'part' ? <small> in {body.instance}</small> : null}</span>
                    <small>{size(body.extent_mm)} mm · {body.triangles.toLocaleString()} triangles</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className={styles.pickerFoot}><Button size="sm" onClick={onClose}>Cancel</Button></div>
    </Dialog>
  );
}
