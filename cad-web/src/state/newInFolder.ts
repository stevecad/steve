/** A new document started from the Open dialog while a folder was open goes into that folder when it's first saved
 *  (POST /v1/documents folder_id). Keyed by the new tab, so another new document never takes it. */

const pending = new Map<string, string>();

export const fileNewTab = (tabKey: string, folderId: string) => { pending.set(tabKey, folderId); };

/** The folder the unsaved document in this tab goes into, if any. */
export const folderForNew = (tabKey: string | null) => (tabKey ? pending.get(tabKey) ?? null : null);

export const filedNew = (tabKey: string | null) => { if (tabKey) pending.delete(tabKey); };
