/** Each Drawing tool's icon: its ribbon button, its Dock tab and its menu entries show the same one. */
import { CircleDot, Crosshair, FilePlus2, Flag, History, LayoutTemplate, PanelBottom, RectangleHorizontal, Ruler, SquareArrowOutUpRight, Table2, Type, ZoomIn } from 'lucide-react';
import { SectionIcon, WeldIcon } from '@/icons/cad';
import type { IconType } from '@/commands';
import type { ToolKind } from './tools';

export const TOOL_ICONS: Record<ToolKind, IconType> = {
  'new-sheet': FilePlus2, 'sheet-format': LayoutTemplate, 'title-block': PanelBottom, base: RectangleHorizontal, projected: SquareArrowOutUpRight, section: SectionIcon as IconType,
  detail: ZoomIn, dimension: Ruler, note: Type, balloon: CircleDot, frame: Crosshair, datum: Flag, weld: WeldIcon as IconType, 'hole-table': Table2, revision: History,
};
