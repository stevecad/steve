/**
 * Mounted with the Manufacture workspace: while the program editor picks (the pocket floor, hole walls, contour faces
 * or edges, fixture bodies), each face or edge the person clicks goes to it instead of the selection. Esc ends picking.
 * The design is shown as it sits in the edited (or simulated) setup: a re-clamped setup turns it over. It also loads what
 * the workspace shows wherever its panels are (the tree, the Inspector, a phone's sheets): the document's programs, the
 * library their pins name, what the engine runs, and named geometry for picking.
 */
import { useEffect } from 'react';
import { set, useApp } from '@/state/store';
import { currentPlacement, loadCapabilities, loadJobs, pickFace, placePart, stopPicking, useCam, usePlayer } from './state';
import { loadLibrary, loadPrograms, prepareGeometry, useMfg } from '../state';
import { onTrashChange } from '@/state/trash';

export default function CamSync() {
  const documentId = useApp((state) => state.doc.saved?.id ?? null);
  const saved = useApp((state) => !!state.doc.saved);
  const displayed = useApp((state) => state.displayed?.id ?? null);
  const programs = useMfg((state) => state.programs);
  useEffect(() => { void loadPrograms(); void loadLibrary(); }, [documentId]);
  // A program deleted (to the Trash) or brought back: the list follows.
  useEffect(() => onTrashChange(() => { void loadPrograms(); }), []);
  // Which operations the engine runs: the ribbon's operations and the menus follow it.
  useEffect(() => { if (useCam.getState().capabilities === null) void loadCapabilities(); }, []);
  // Each program's runs, for the status beside its operations.
  useEffect(() => { for (const program of programs) if (!useCam.getState().jobs[program.id]) void loadJobs(program.id); }, [programs]);
  // Named faces and bodies for picking: a saved part shown from its preview gets its full build.
  useEffect(() => { prepareGeometry(); }, [displayed, saved]);
  useEffect(() => {
    const unsubscribe = useApp.subscribe((state) => state.selection, (selection) => {
      if (!useCam.getState().picking) return;
      const picks = selection.filter((pick) => pick.kind === 'face' || pick.kind === 'edge');
      if (!picks.length) return;
      picks.forEach(pickFace);
      set({ selection: [] });
    });
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && useCam.getState().picking) { event.preventDefault(); stopPicking(); } };
    window.addEventListener('keydown', onKey);
    return () => { unsubscribe(); window.removeEventListener('keydown', onKey); stopPicking(); };
  }, []);
  useEffect(() => {
    const place = () => placePart(currentPlacement());
    place();
    const unsubscribe = [useCam.subscribe(place), usePlayer.subscribe(place), useApp.subscribe((state) => state.modelVersion, place)];
    return () => { unsubscribe.forEach((stop) => stop()); placePart(null); };
  }, []);
  return null;
}
