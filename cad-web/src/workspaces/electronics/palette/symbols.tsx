/**
 * Part glyphs: schematic symbols drawn on lucide's 24px grid with its stroke weight (as `@/icons/cad` draws CAD
 * glyphs), so the gallery and inspector read like an EDA tool. Elements without a symbol use their lucide icon.
 */
import type { ReactNode, SVGProps } from 'react';
import {
  BatteryMedium, Box, Boxes, Circle, CircleDot, Cpu, Crosshair, Diamond, Disc, GitFork, GripVertical, Group, Lightbulb, Link, Link2, Minus, PaintBucket, Pause, Plug, RadioTower, RectangleHorizontal, Scissors, Share2, SlidersHorizontal, StickyNote, Tag, Target, ToggleLeft, Triangle, Type, Waves, Zap,
  type LucideIcon,
} from 'lucide-react';
import { partFor } from '../parts/catalog';

type GlyphProps = SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number };

const glyph = (paths: ReactNode) => function Glyph({ size = 24, strokeWidth = 1.6, ...props }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      {paths}
    </svg>
  );
};

const zigzag = 'M2 12h3l1.4-3.5 2.4 7 2.4-7 2.4 7 2.4-7 2.4 7 1.4-3.5H22';
const diode = <><path d="M2 12h6.5M15.5 12H22" /><path d="M8.5 7v10l7-5Z" fill="currentColor" fillOpacity={0.18} /><path d="M15.5 7v10" /></>;

const SYMBOLS: Record<string, (props: GlyphProps) => ReactNode> = {
  resistor: glyph(<path d={zigzag} />),
  potentiometer: glyph(<><path d={zigzag} /><path d="M12 2.5v5.5M10 6.2 12 8.4l2-2.2" /></>),
  capacitor: glyph(<path d="M2 12h8.2M13.8 12H22M10.2 6v12M13.8 6v12" />),
  inductor: glyph(<path d="M2 14h2.2a2.6 2.6 0 0 1 5.2 0 2.6 2.6 0 0 1 5.2 0 2.6 2.6 0 0 1 5.2 0H22" />),
  fuse: glyph(<><path d="M2 12h4M18 12h4" /><rect x="6" y="9" width="12" height="6" rx="1" /><path d="M6 12h12" /></>),
  crystal: glyph(<><path d="M2 12h4.5M17.5 12H22M6.5 7.5v9M17.5 7.5v9" /><rect x="9" y="6" width="6" height="12" rx="0.8" /></>),
  resonator: glyph(<><path d="M2 12h4.5M17.5 12H22M6.5 7.5v9M17.5 7.5v9M12 18v3.5" /><rect x="9" y="6" width="6" height="10" rx="0.8" /></>),
  diode: glyph(diode),
  led: glyph(<>{diode}<path d="m14.5 5 2.8-2.8M16.2 6.6 19 3.8M15.4 2.2h1.9v1.9M17.1 3.8H19v1.9" /></>),
  transistor: glyph(<><circle cx="13" cy="12" r="8.2" opacity={0.35} /><path d="M3 12h7M10 7.5v9M10 10l6-4.5V2M10 14l6 4.5V22" /><path d="m14.6 16.1 1.4 2.4-2.7.4" /></>),
  mosfet: glyph(<><path d="M3 16h5M8 8v8M10.5 7v2.4M10.5 10.8v2.4M10.5 14.6V17M10.5 8.2H16V3M10.5 15.8H16V21M10.5 12H16v3.8" /><path d="m12.4 10.6-1.9 1.4 1.9 1.4" /></>),
  chip: glyph(<><rect x="7" y="4" width="10" height="16" rx="1.2" fill="currentColor" fillOpacity={0.1} /><path d="M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4" /><circle cx="9.6" cy="6.6" r="0.7" fill="currentColor" stroke="none" /></>),
  opamp: glyph(<><path d="M6 4v16l14-8Z" fill="currentColor" fillOpacity={0.1} /><path d="M2 9h4M2 15h4M20 12h2M8 9h2.4M9.2 7.8v2.4M8 15h2.4" /></>),
  pinheader: glyph(<><rect x="7.5" y="2.5" width="9" height="19" rx="1.2" /><circle cx="12" cy="6.5" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="12" cy="17.5" r="1.4" /></>),
  connector: glyph(<><rect x="4" y="7" width="16" height="10" rx="5" /><rect x="8" y="10.5" width="8" height="3" rx="1.5" fill="currentColor" fillOpacity={0.25} /></>),
  jumper: glyph(<><circle cx="7" cy="12" r="2.2" /><circle cx="17" cy="12" r="2.2" /><path d="M7 9.8V7.5h10v2.3" /></>),
  solderjumper: glyph(<><path d="M4 8h6.5v8H4ZM13.5 8H20v8h-6.5Z" /><path d="M10.5 12h3" strokeDasharray="1 1.4" /></>),
  testpoint: glyph(<><circle cx="12" cy="8" r="4.5" /><path d="M12 12.5V22" /></>),
  pushbutton: glyph(<><path d="M2 17h5M17 17h5M7 17h.01M17 17h.01M5.5 13.5h13M12 13.5V8M9 8h6" /><circle cx="7" cy="17" r="1.2" /><circle cx="17" cy="17" r="1.2" /></>),
  switch: glyph(<><path d="M2 15h4M18 15h4M7.2 14.4 16.5 8.5" /><circle cx="6.5" cy="15" r="1.2" /><circle cx="17.5" cy="15" r="1.2" /></>),
  battery: glyph(<path d="M2 12h7M15 12h7M9 6v12M15 9.5v5M12 7.5v9" strokeWidth={1.6} />),
  antenna: glyph(<path d="M12 22V9M12 9 5 3h14Z" />),
  net: glyph(<path d="M12 3v8.5M5 11.5h14M8 15h8M10.5 18.5h3" />),
  netlabel: glyph(<path d="M3 8h12l5 4-5 4H3Z" />),
  powersource: glyph(<><circle cx="12" cy="12" r="7.5" /><path d="M12 2v2.5M12 19.5V22M12 8v4M10 10h4M10 15h4" /></>),
  voltagesource: glyph(<><circle cx="12" cy="12" r="7.5" /><path d="M12 2v2.5M12 19.5V22M12 8v4M10 10h4M10 15h4" /></>),
  currentsource: glyph(<><circle cx="12" cy="12" r="7.5" /><path d="M12 2v2.5M12 19.5V22M12 16V8M9.5 10.5 12 8l2.5 2.5" /></>),
  hole: glyph(<><circle cx="12" cy="12" r="7.5" /><path d="M12 7v10M7 12h10" opacity={0.5} /></>),
  platedhole: glyph(<><circle cx="12" cy="12" r="8" fill="currentColor" fillOpacity={0.2} /><circle cx="12" cy="12" r="3.5" /></>),
  via: glyph(<><circle cx="12" cy="12" r="6" fill="currentColor" fillOpacity={0.2} /><circle cx="12" cy="12" r="2.2" /></>),
  fiducial: glyph(<><circle cx="12" cy="12" r="8" strokeDasharray="2 2" /><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /></>),
  copperpour: glyph(<path d="M4 6h10l6 6v6H4Z" fill="currentColor" fillOpacity={0.22} />),
  cutout: glyph(<rect x="5" y="7" width="14" height="10" rx="1.5" strokeDasharray="2.4 2" />),
  group: glyph(<><rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="2.4 2" /><rect x="7" y="7" width="4" height="4" rx="0.6" /><rect x="13" y="13" width="4" height="4" rx="0.6" /></>),
  board: glyph(<><rect x="3" y="5" width="18" height="14" rx="1.6" fill="currentColor" fillOpacity={0.12} /><circle cx="6" cy="8" r="0.9" /><circle cx="18" cy="8" r="0.9" /><circle cx="6" cy="16" r="0.9" /><circle cx="18" cy="16" r="0.9" /><path d="M9 12h3l2-2h2" /></>),
  subcircuit: glyph(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /><rect x="7" y="12" width="4" height="4" rx="0.6" /><rect x="13" y="12" width="4" height="4" rx="0.6" /></>),
};

/** The catalog's fallback icons, imported by name so the bundle keeps only these. */
const lucide: Record<string, LucideIcon> = { BatteryMedium, Box, Boxes, Circle, CircleDot, Cpu, Crosshair, Diamond, Disc, GitFork, GripVertical, Group, Lightbulb, Link, Link2, Minus, PaintBucket, Pause, Plug, RadioTower, RectangleHorizontal, Scissors, Share2, SlidersHorizontal, StickyNote, Tag, Target, ToggleLeft, Triangle, Type, Waves, Zap };

/** The glyph for a tscircuit element (its symbol, else its catalog icon, else a box). */
export function PartIcon({ tag, size = 20, ...props }: GlyphProps & { tag: string }) {
  const drawn = SYMBOLS[tag];
  if (drawn) return <>{drawn({ size, ...props })}</>;
  const Icon = lucide[partFor(tag)?.icon ?? 'Box'] ?? lucide.Box;
  return <Icon size={size} strokeWidth={1.6} aria-hidden {...(props as Record<string, unknown>)} />;
}
