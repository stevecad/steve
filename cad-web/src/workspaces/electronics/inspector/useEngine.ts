/** Loads the TSX parser and tscircuit's prop schemas once (both lazy chunks); true when both are ready. */
import { useEffect, useState } from 'react';
import { ensureParser, parserReady } from '../code/parser';
import { loadSchemas, schemasReady } from '../parts/schema';

export function useCircuitEngine(): { ready: boolean; error: string | null } {
  const [ready, setReady] = useState(() => parserReady() && schemasReady());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (ready) return;
    let live = true;
    Promise.all([ensureParser(), loadSchemas()])
      .then(() => { if (live) setReady(true); })
      .catch((failure: unknown) => { if (live) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { live = false; };
  }, [ready]);
  return { ready, error };
}
