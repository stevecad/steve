import { useEffect } from 'react';
import { set, useApp } from '@/state/store';
import { useMaterialLibrary } from '@/lib/materials';
import { closeAppearance, materialDialogOpened, syncMaterialState } from './actions';

/**
 * The editing side of materials: keeps the material panel's state in step with the displayed build and the code.
 * The bodies themselves are drawn by MaterialAppearance (part of the viewer, SceneCore).
 */
export default function MaterialsLayer() {
  useEffect(() => {
    syncMaterialState();
    const stops = [
      useApp.subscribe((state) => state.modeling, syncMaterialState),
      useApp.subscribe((state) => state.displayed, syncMaterialState),
      useApp.subscribe((state) => state.dialog, (dialog, previous) => { if (dialog === 'material' && previous !== 'material') materialDialogOpened(); }),
      // The Appearance tool edits the open file: another tab, file or document closes it.
      useApp.subscribe((state) => `${state.activeTab ?? ''}|${state.doc.open}|${state.doc.activeFile}`, closeAppearance),
      // Selectors over the library (materialById) re-run once it arrives.
      useMaterialLibrary.subscribe(() => set((s) => ({ materials: { ...s.materials } }))),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);
  return null;
}
