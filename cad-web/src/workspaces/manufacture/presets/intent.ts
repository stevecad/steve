/**
 * "New cutting preset" from somewhere else (an operation's preset picker, a cutter's details): the library opens on
 * cutting presets and starts a new one with what's already known — the cutter, the material, the operation.
 */
import { create } from 'zustand';
import type { Pin } from '../api';
import { openLibrary } from '../state';

export interface PresetDraft { cutter?: Pin | null; material?: Pin | null; operations?: string[]; maximum_stickout_mm?: number | null }

export const usePresetIntent = create<{ draft: PresetDraft | null }>(() => ({ draft: null }));

export function newPresetFor(draft: PresetDraft) {
  usePresetIntent.setState({ draft });
  openLibrary('cutting_preset');
}
