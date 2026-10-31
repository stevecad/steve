/** Local project transfer: unchanged Studio source plus its pinned documents and binary assets. */
import { get, toast } from './store';
import { stored } from './design';
import { openTab } from './tabs';
import { refreshOwnMaterials } from '@/lib/materials';

async function checked(response: Response): Promise<Response> {
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { detail?: string } | null;
    throw new Error(error?.detail || `Project transfer failed (${response.status}).`);
  }
  return response;
}

export async function downloadProjectArchive() {
  const { doc } = get();
  if (!doc.open || !['part', 'design'].includes(doc.kind)) return;
  const document = { name: doc.name || 'Untitled project', kind: doc.kind, ...stored(doc) };
  try {
    const response = await checked(await fetch('/v1/local/project-archive', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document, document_id: doc.saved?.id, revision: doc.saved?.revision }),
    }));
    const url = URL.createObjectURL(await response.blob());
    const link = window.document.createElement('a');
    link.href = url; link.download = `${document.name.replace(/[^\w.-]+/g, '_')}.steve.zip`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('success', 'Project archive ready', 'Includes source, pinned linked documents, custom materials, decals and imported STEP files.');
  } catch (error) { toast('danger', 'Couldn’t export the project', (error as Error).message); }
}

let importing = false;
export function chooseProjectArchive() {
  if (importing || get().busy) return;
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.zip'; input.hidden = true; input.id = 'project-archive-input';
  const remove = () => input.remove();
  input.addEventListener('cancel', remove, { once: true });
  input.addEventListener('change', () => {
    const file = input.files?.[0]; remove();
    if (!file) return;
    importing = true;
    toast('info', 'Importing project', file.name);
    void fetch('/v1/local/import-project', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file })
      .then(checked).then((response) => response.json() as Promise<{ root: { id: string }; imported: number; assets: number; remapped_materials?: number }>)
      .then(async (result) => {
        await refreshOwnMaterials();
        openTab({ id: result.root.id });
        const copied = result.remapped_materials ?? 0;
        toast('success', 'Project imported', `${result.imported} document${result.imported === 1 ? '' : 's'} and ${result.assets} asset${result.assets === 1 ? '' : 's'} restored locally.${copied ? ` ${copied} custom material${copied === 1 ? ' was' : 's were'} copied to preserve existing definitions.` : ''} Your original documents are unchanged.`);
      }).catch((error: Error) => toast('danger', 'Couldn’t import the project', error.message))
      .finally(() => { importing = false; });
  }, { once: true });
  document.body.append(input); input.click();
}
