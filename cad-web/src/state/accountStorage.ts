import { useAccount } from '@/auth/auth';

/**
 * The localStorage key for what belongs to the signed-in account (open tabs, unsaved edits): another account signing
 * in on this browser neither sees them nor tries to open documents and models it can't reach.
 */
export function accountKey(key: string): string {
  const workspace = useAccount.getState().account?.workspace;
  return workspace ? `${key}:${workspace}` : key;
}

/** Drops what older versions kept under the shared key, which could be another account's. */
export function forgetShared(key: string) {
  if (accountKey(key) === key) return;
  try { localStorage.removeItem(key); } catch { /* Optional. */ }
}
