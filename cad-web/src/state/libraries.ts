/**
 * Libraries: folders the person marked (Open → right-click a folder → Use as library) to keep their own reusable parts
 * in. File → Libraries lists them and opens the Link dialog inside one, so choosing a part links it and opens Place,
 * as Link does. Only a flag on the folder (app/folders.py): the list comes from the same /v1/folders the Open dialog
 * reads, fetched when the File menu or the command asks for it.
 */
import { create } from 'zustand';
import { Api, type Folder } from '@/lib/api';
import { folderPath } from '@/lib/library';
import { get, set, toast, type AppState } from '@/state/store';

export interface LibraryFolder { id: string; name: string }

/** null until first read. */
export const useLibraries = create<{ list: LibraryFolder[] | null }>(() => ({ list: null }));

/** How to make one, where there are none yet. */
export const NO_LIBRARIES = 'Right-click a folder in Open and choose Use as library.';

/** Links belong to designs: the reason Libraries is off anywhere else (true in a design). */
export const librariesUsable = (state: AppState): true | string => state.doc.kind === 'design' || 'Libraries are linked into designs.';

/** The library folders among a workspace's folders, each named by its path (a library may be inside another folder). */
export function libraryFolders(folders: Folder[]): LibraryFolder[] {
  return folders.filter((folder) => folder.library)
    .map((folder) => ({ id: folder.id, name: folderPath(folders, folder.id) ?? folder.name }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Keeps the list in step with a folder list just read (the Open dialog's). */
export const adoptFolders = (folders: Folder[]) => useLibraries.setState({ list: libraryFolders(folders) });

export async function refreshLibraries(): Promise<LibraryFolder[] | null> {
  try {
    const { folders } = await Api.folders();
    adoptFolders(folders);
  } catch { /* The last list stays; the next open reads it again. */ }
  return useLibraries.getState().list;
}

/** The Link dialog, already inside the library (and its subfolders). */
export function openLibrary(id: string) {
  if (librariesUsable(get()) !== true || get().busy) return;
  set({ dialog: 'insert', linkFolder: id });
}

/** The command palette's Libraries…: the only library, or the first with the others marked in the folder tree. */
export async function openLibraries() {
  const list = await refreshLibraries();
  if (!list?.length) { toast('info', 'No libraries yet', NO_LIBRARIES); return; }
  openLibrary(list[0].id);
}
