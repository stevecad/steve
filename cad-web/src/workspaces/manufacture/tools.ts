import type { CamTool } from '@/state/store';

export const DEFAULT_TOOLS: CamTool[] = [
  { id: 't1', name: '#1 Ø12 flat end mill', kind: 'flat', diameter: 12, flutes: 3, fluteLength: 30 },
  { id: 't2', name: '#2 Ø6 flat end mill', kind: 'flat', diameter: 6, flutes: 3, fluteLength: 18 },
  { id: 't3', name: '#3 Ø6 ball end mill', kind: 'ball', diameter: 6, flutes: 2, fluteLength: 15 },
  { id: 't4', name: '#4 Ø10 bull nose R1', kind: 'bull', diameter: 10, flutes: 4, fluteLength: 22, cornerRadius: 1 },
  { id: 't5', name: '#5 Ø6.0 drill', kind: 'drill', diameter: 6, flutes: 2, fluteLength: 40 },
  { id: 't6', name: '#6 Ø10 90° chamfer', kind: 'chamfer', diameter: 10, flutes: 4, fluteLength: 6 },
  { id: 't7', name: '#7 Ø50 face mill', kind: 'face', diameter: 50, flutes: 5, fluteLength: 8 },
];
