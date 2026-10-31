/**
 * Where the code-rewrite tools (workspaces/electronics/{inspector,palette}, docs/ELECTRONICS.md "Human tools") plug
 * into the workspace, without the shell importing files that may not exist yet:
 *
 *   inspector/index.tsx   default export: a component taking PartInspectorProps. It shows in Properties under the
 *                         selection's facts (or the board's, with nothing selected) and edits the TSX.
 *   palette/commands.ts   exports `placeCommands: Command[]` (category 'Electronics') and `placeRibbon: RibbonGroup[]`;
 *                         the groups go into the Electronics ribbon after the views.
 */
import { lazy, type ComponentType } from 'react';
import type { Command, RibbonGroup } from '@/commands';
import type { CircuitModel, CircuitPart } from './circuit';

export interface PartInspectorProps {
  /** The selected parts (empty: the board itself). */
  parts: CircuitPart[];
  model: CircuitModel;
}

const inspectors = import.meta.glob<{ default: ComponentType<PartInspectorProps> }>('./inspector/index.tsx');
const inspectorLoader = Object.values(inspectors)[0];
export const PartInspector = inspectorLoader ? lazy(inspectorLoader) : null;

const palettes = import.meta.glob<{ placeCommands?: Command[]; placeRibbon?: RibbonGroup[] }>('./palette/commands.ts', { eager: true });
const palette = Object.values(palettes)[0];
export const placeCommands: Command[] = palette?.placeCommands ?? [];
export const placeRibbon: RibbonGroup[] = palette?.placeRibbon ?? [];
