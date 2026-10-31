import { create } from 'zustand';
import type { Build } from '@/lib/api';
import { sheetMarkup } from './sheets';

export const useDrawingPreview = create<{
  open: boolean; title: string; sheets: string[]; names: string[]; pdf?: string; archive?: string;
}>(() => ({ open: false, title: '', sheets: [], names: [] }));

export async function showDrawingPreview(build: Build, title: string) {
  const sheets = await sheetMarkup(build);
  if (!sheets.length) throw new Error('This build has no drawing sheets.');
  const expected = build.metadata?.drawings?.sheets ?? [];
  if (expected.length > sheets.length) throw new Error('Some drawing sheets could not be loaded. Try opening the drawing again.');
  useDrawingPreview.setState({ open: true, title, sheets,
    names: expected.map((sheet) => sheet.title),
    pdf: build.artifacts.drawings_pdf, archive: build.artifacts.drawings });
}

export function downloadDrawing(url: string, name: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = name.replace(/[^\w.-]+/g, '_');
  link.click();
}
