import type { SVGProps } from 'react';

/** CAD glyphs drawn on lucide's 24px grid with matching stroke weight. */
export type CadIconProps = SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number };

const make = (paths: React.ReactNode, displayName: string) => {
  const Icon = ({ size = 24, strokeWidth = 1.6, ...props }: CadIconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...props}>
      {paths}
    </svg>
  );
  Icon.displayName = displayName;
  return Icon;
};

const cube = <><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" /><path d="M4 7.5 12 12l8-4.5M12 12v9" /></>;

export const ShadedEdgesIcon = make(<><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" fill="currentColor" fillOpacity={0.22} /><path d="M4 7.5 12 12l8-4.5M12 12v9" /></>, 'ShadedEdges');
export const ShadedIcon = make(<><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" fill="currentColor" fillOpacity={0.45} stroke="none" /><path d="M4 7.5 12 12l8-4.5v9L12 21Z" fill="currentColor" fillOpacity={0.25} stroke="none" /></>, 'Shaded');
export const WireframeIcon = make(<>{cube}<path d="M4 16.5 12 12M20 16.5 12 12M12 3v9" strokeDasharray="1.6 1.9" opacity={0.7} /></>, 'Wireframe');
export const HiddenLineIcon = make(<>{cube}<path d="M4 16.5 12 12M12 3v9" strokeDasharray="1.2 2.2" opacity={0.55} /></>, 'HiddenLine');
export const XrayIcon = make(<><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" fill="currentColor" fillOpacity={0.1} /><path d="M4 7.5 12 12l8-4.5M12 12v9M4 16.5 12 12l8 4.5M12 3v9" opacity={0.6} /></>, 'Xray');

export const SectionIcon = make(<><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" opacity={0.45} /><path d="M2.5 13.5 12 9l9.5 4.5L12 18Z" fill="currentColor" fillOpacity={0.2} /></>, 'Section');
// A weld symbol: the arrow to the joint, the reference line and a fillet's triangle under it (AWS A2.4's arrow side).
export const WeldIcon = make(<><path d="M3 20 9 12h12" /><path d="M5.6 18.6 3 20l.6-2.9" /><path d="M12 12v5l5-5" fill="currentColor" fillOpacity={0.3} /></>, 'Weld');
export const MeasureIcon =make(<><path d="M3 17 17 3l4 4L7 21Z" /><path d="m7 13 2 2M10 10l1.5 1.5M13 7l2 2" /></>, 'Measure');
export const ViewCubeIcon = make(<>{cube}<path d="M8 9.8v4.4M16 9.8v4.4" opacity={0.5} /></>, 'ViewCube');
export const FitIcon = make(<><path d="M3 8V4a1 1 0 0 1 1-1h4M16 3h4a1 1 0 0 1 1 1v4M21 16v4a1 1 0 0 1-1 1h-4M8 21H4a1 1 0 0 1-1-1v-4" /><path d="m12 7 4.5 2.5v5L12 17l-4.5-2.5v-5Z" /></>, 'Fit');
export const OrthoIcon = make(<><path d="M5 5h14v14H5z" /><path d="M9 9h10M9 9v10" opacity={0.5} /></>, 'Ortho');
export const PerspectiveIcon = make(<><path d="M4 4h16l-3 16H7Z" /><path d="M9 10h6" opacity={0.5} /></>, 'Perspective');
export const OriginIcon = make(<><path d="M12 12V3M12 12l8 5M12 12l-8 5" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /></>, 'Origin');
export const AxesIcon = make(<><path d="M5 19V5M5 19h14M5 19l6-6" /><path d="m3.5 6.5 1.5-1.5 1.5 1.5M17.5 17.5 19 19l-1.5 1.5" /></>, 'Axes');

/* Simulation */
export const StudyIcon = make(<><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" /><path d="M4 12h3l2-3 3 6 2-3h6" /></>, 'Study');
export const FixedIcon = make(<><path d="M4 18h16" /><path d="M6 21l2-3M10 21l2-3M14 21l2-3M18 21l2-3" /><path d="m12 6-4 12h8Z" /></>, 'Fixed');
// Sheet metal: a sheet seen edge-on, bent; flat outline for patterns.
export const SheetRulesIcon = make(<><path d="M4 7h16M4 12h16M4 17h10" opacity={0.5} /><path d="M17 15.5 19.5 18 22 14" /></>, 'SheetRules');
export const BaseFlangeIcon = make(<><path d="M3 15 12 19 21 15 12 11Z" fill="currentColor" fillOpacity={0.18} /><path d="M3 15v1.6L12 20.6l9-4V15" /></>, 'BaseFlange');
export const EdgeFlangeIcon = make(<><path d="M3 16 12 20 21 16 12 12Z" fill="currentColor" fillOpacity={0.15} /><path d="M12 12 21 16V6l-9-4Z" fill="currentColor" fillOpacity={0.3} /></>, 'EdgeFlange');
export const ContourFlangeIcon = make(<><path d="M4 6v9a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4V9" /><path d="M7 6v8.5A1.5 1.5 0 0 0 8.5 16h7a1.5 1.5 0 0 0 1.5-1.5V9" opacity={0.5} /></>, 'ContourFlange');
export const HemIcon = make(<><path d="M3 9h13a4 4 0 0 1 0 8H8" /><path d="M3 12h13a1 1 0 0 1 0 2H8" opacity={0.55} /></>, 'Hem');
export const JogIcon = make(<><path d="M3 8h7l4 8h7" /><path d="M3 11h5.5l4 8H21" opacity={0.55} /></>, 'Jog');
export const SketchedBendIcon = make(<><path d="M3 17h9" /><path d="M12 17a4 4 0 0 0 4-4V5" /><path d="M12 3v18" strokeDasharray="2 2.2" opacity={0.6} /></>, 'SketchedBend');
export const UnfoldIcon = make(<><path d="M3 17h18" /><path d="M8 17V8l-4-3" opacity={0.45} strokeDasharray="2 2" /><path d="m15 12 3 3-3 3" /></>, 'Unfold');
export const RefoldIcon = make(<><path d="M3 17h10" /><path d="M13 17a3 3 0 0 0 3-3V6" /><path d="m19 9-3-3-3 3" /></>, 'Refold');
export const RipIcon = make(<><path d="M3 18h7" /><path d="M10 18a1.5 1.5 0 0 0 .6-.1" opacity={0.5} /><path d="M14.6 14a1.5 1.5 0 0 0 .4-1V5" /><path d="m11.5 16.5 2-2" strokeDasharray="1.2 1.6" /><path d="M18 9.5h3M18 12.5h3" opacity={0.45} /></>, 'Rip');
export const CornerIcon = make(<><path d="M5 19V8a3 3 0 0 1 3-3h11" /><path d="M8 19v-9a2 2 0 0 1 2-2h9" opacity={0.5} /><circle cx="6.5" cy="6.5" r="1.4" fill="currentColor" /></>, 'Corner');
export const FlatPatternIcon = make(<><path d="M8 4h8v5h5v6h-5v5H8v-5H3V9h5Z" fill="currentColor" fillOpacity={0.12} /><path d="M8 9h8M8 15h8M8 9v6M16 9v6" strokeDasharray="1.6 1.6" opacity={0.7} /></>, 'FlatPattern');
export const DxfIcon = make(<><path d="M6 3h9l4 4v14H6Z" /><path d="M15 3v4h4" /><path d="M9 13h6M9 16h6M12 10v9" opacity={0.6} /></>, 'Dxf');
export const ConvertSheetIcon = make(<><path d="M4 8 12 4l8 4v8l-8 4-8-4Z" opacity={0.45} /><path d="M4 8l8 4 8-4M12 12v8" opacity={0.45} /><path d="M14 15h6m-2-2 2 2-2 2" /></>, 'ConvertSheet');
export const SheetCutIcon = make(<><path d="M3 16 12 20 21 16 12 12Z" fill="currentColor" fillOpacity={0.15} /><path d="M12 12 21 16V6l-9-4Z" /><ellipse cx="16.5" cy="9" rx="1.8" ry="2.2" /></>, 'SheetCut');
export const BendTableIcon = make(<><rect x="3" y="4" width="18" height="16" rx="1.5" /><path d="M3 9h18M3 14.5h18M9 9v11" opacity={0.6} /></>, 'BendTable');
export const TabIcon = make(<><path d="M3 17 12 21l9-4-9-4Z" fill="currentColor" fillOpacity={0.12} /><path d="M9 15.6 13.5 17.6 13.5 9 9 7Z" fill="currentColor" fillOpacity={0.3} /></>, 'Tab');
export const ReliefIcon = make(<><path d="M4 20V4h16v16Z" fill="currentColor" fillOpacity={0.12} /><path d="M20 9h-4a2 2 0 0 1-2-2V4" /></>, 'Relief');
export const RollIcon = make(<><path d="M17 6.5A7 7 0 1 0 19 12" /><path d="M14.5 8.5A4 4 0 1 0 16 12" opacity={0.5} /></>, 'Roll');
export const FormToolIcon = make(<><path d="M3 15h5l2-4h4l2 4h5" /><path d="M3 18h18" opacity={0.5} /></>, 'FormTool');
export const FormLibraryIcon = make(<><path d="M3 10h3.5l1.5-3h3l1.5 3H16" /><path d="M8 17h3.5l1.5-3h3l1.5 3H21" /><path d="M3 20h18" opacity={0.5} /></>, 'FormLibrary');
export const JointIcon = make(<><circle cx="7" cy="17" r="3" /><circle cx="7" cy="17" r="0.9" fill="currentColor" /><path d="M9.2 15 18 6.5" /><path d="M15 4.5 20 9.5" /><path d="M4 21h6" opacity={0.6} /></>, 'Joint');
export const PinIcon = make(<><circle cx="12" cy="9" r="4" /><circle cx="12" cy="9" r="1" fill="currentColor" /><path d="M12 13v7M8 20h8" /></>, 'Pin');
export const ForceIcon = make(<><path d="M12 3v14" /><path d="m7 12 5 5 5-5" /><path d="M5 21h14" /></>, 'Force');
export const PressureIcon = make(<><path d="M6 3v10M12 3v10M18 3v10" /><path d="m4 11 2 2 2-2M10 11l2 2 2-2M16 11l2 2 2-2" /><path d="M3 18h18" /></>, 'Pressure');
export const MomentIcon = make(<><path d="M19 12a7 7 0 1 1-2.05-4.95" /><path d="M17 3v4.5h-4.5" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /></>, 'Moment');
export const GravityIcon = make(<><path d="M12 3v12" /><path d="m8 11 4 4 4-4" /><path d="M6 19c2 1.5 10 1.5 12 0" /></>, 'Gravity');
export const MeshIcon = make(<><path d="M3 20 12 4l9 16Z" /><path d="M7.5 12h9M12 20l-4.5-8M12 20l4.5-8M7.5 12 12 4l4.5 8" opacity={0.7} /></>, 'Mesh');
export const SolveIcon = make(<><circle cx="12" cy="12" r="9" /><path d="m10 8 6 4-6 4Z" fill="currentColor" /></>, 'Solve');
export const StressIcon = make(<><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" /><path d="M4 7.5 12 12l8-4.5" /><path d="M8 5.2 16 9.8M6 10.5l6 3.4" opacity={0.55} /></>, 'Stress');
export const DisplacementIcon = make(<><path d="M4 16c4 0 4-8 8-8s4 8 8 8" /><path d="M4 20h16" opacity={0.5} strokeDasharray="2 2" /></>, 'Displacement');
export const ModalIcon = make(<><path d="M3 12c2-6 4-6 6 0s4 6 6 0 4-6 6 0" /></>, 'Modal');
export const ThermalIcon = make(<><path d="M10 13.5V5a2 2 0 1 1 4 0v8.5a4 4 0 1 1-4 0Z" /><path d="M12 9v6" /></>, 'Thermal');
export const MaterialIcon = make(<><circle cx="12" cy="12" r="8.5" /><path d="M5 9c3 2 11 2 14 0M5 15c3-2 11-2 14 0" opacity={0.6} /></>, 'Material');
export const ContactIcon = make(<><rect x="3" y="4" width="8" height="16" rx="1" /><rect x="13" y="4" width="8" height="16" rx="1" /><path d="M11 9h2M11 12h2M11 15h2" /></>, 'Contact');
export const SafetyIcon = make(<><path d="M12 3 5 6v5c0 5 3.5 8.5 7 10 3.5-1.5 7-5 7-10V6Z" /><path d="m9 12 2 2 4-4" /></>, 'Safety');

/* Manufacturing */
export const SetupIcon = make(<><path d="M3 17h18v3H3z" /><path d="M6 17V9h12v8" /><path d="M9 9V5h6v4" /></>, 'Setup');
export const StockIcon = make(<><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" strokeDasharray="2.2 1.8" /><path d="m12 8 4 2.2v4.6L12 17l-4-2.2v-4.6Z" /></>, 'Stock');
export const WcsIcon = make(<><path d="M6 18V6M6 18h12M6 18l-3 3" /><circle cx="6" cy="18" r="1.4" fill="currentColor" /><path d="M4.5 7.5 6 6l1.5 1.5M16.5 16.5 18 18l-1.5 1.5" /></>, 'Wcs');
export const ToolIcon = make(<><path d="M10 3h4v5h-4z" /><path d="M10.5 8v7l1.5 6 1.5-6V8" /><path d="M10.5 11l3 1.5M10.5 14l3-1" opacity={0.6} /></>, 'Tool');
export const FaceMillIcon = make(<><path d="M4 18h16" /><path d="M7 14h10l-1 4H8Z" /><path d="M12 3v11" /></>, 'FaceMill');
export const AdaptiveIcon = make(<><path d="M4 18c0-7 4-12 8-12s8 5 8 12" /><path d="M8 18c0-4 2-7 4-7s4 3 4 7" /><path d="M12 18v-2" /></>, 'Adaptive');
export const RoughIcon = make(<><rect x="2.5" y="3.5" width="19" height="17" rx="1.5" strokeDasharray="2.2 1.8" opacity={0.6} /><rect x="9" y="9.5" width="6" height="5" rx="0.8" /><rect x="6" y="6.5" width="12" height="11" rx="2.5" opacity={0.7} /></>, 'Rough');
export const PocketIcon = make(<><rect x="3" y="5" width="18" height="14" rx="1.5" /><rect x="7" y="9" width="10" height="6" rx="1" /><path d="M9.5 12h5" opacity={0.6} /></>, 'Pocket');
export const ContourIcon = make(<><path d="M5 7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Z" /><path d="M2.5 6.5v11a4 4 0 0 0 4 4h11" strokeDasharray="2 2" opacity={0.7} /></>, 'Contour');
export const DrillOpIcon = make(<><path d="M12 3v10" /><path d="m9 13 3 8 3-8Z" /><path d="M6 7h2M16 7h2" opacity={0.5} /></>, 'DrillOp');
export const BoreIcon = make(<><circle cx="12" cy="12" r="7.5" /><path d="M12 8.5a3.5 3.5 0 1 1-3.5 3.5" opacity={0.6} /><path d="m8.5 12-1.2-1.6M8.5 12l1.7-1" opacity={0.6} /></>, 'Bore');
export const RestIcon = make(<><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M7 15V9h10v6Z" opacity={0.45} /><path d="M7 11.5V9h2.5M17 11.5V9h-2.5M7 12.5V15h2.5M17 12.5V15h-2.5" /></>, 'Rest');
export const SlotIcon = make(<><rect x="3" y="5" width="18" height="14" rx="1.5" /><rect x="6" y="10" width="12" height="4" rx="2" /><path d="M8 12h8" opacity={0.5} strokeDasharray="1.5 1.5" /></>, 'Slot');
export const EngraveIcon = make(<><path d="M3 19c2.5-4 5 1 7.5-3.5S15 12 17 10" /><path d="M15 3h5l-2.5 5.5Z" /><path d="M17.5 8.5v1.5" opacity={0.6} /></>, 'Engrave');
export const ChamferOpIcon = make(<><path d="M3 21V12l6-6h12v15Z" /><path d="M9 6 3 12" strokeWidth={2.2} opacity={0.55} /><path d="m13.5 1.5 2 2-3.5 3.5-2-2Z" opacity={0.6} /></>, 'ChamferOp');
export const ParallelFinishIcon = make(<><path d="M3 19h18" opacity={0.45} /><path d="M4 19c1.5-7.5 14.5-7.5 16 0" /><path d="M8 6v8M12 4.5v8.5M16 6v8" opacity={0.65} strokeDasharray="1.6 1.4" /></>, 'ParallelFinish');
export const WaterlineIcon = make(<><path d="M3 20h18" opacity={0.45} /><path d="M5 20c0-8.5 3-13.5 7-13.5s7 5 7 13.5" /><path d="M7 16h10M8.2 12.5h7.6M9.8 9.5h4.4" opacity={0.65} /></>, 'Waterline');
export const ToolpathIcon = make(<><path d="M4 6h14a2 2 0 0 1 0 4H6a2 2 0 0 0 0 4h12a2 2 0 0 1 0 4H4" /></>, 'Toolpath');
export const SimulateToolIcon = make(<><path d="M4 18h16" /><path d="M9 4h6v6l-3 4-3-4Z" /><path d="M5 18c1-3 3-4 7-4s6 1 7 4" opacity={0.6} /></>, 'SimulateTool');
export const PostIcon = make(<><path d="M6 3h9l4 4v14H6Z" /><path d="M9 11h2M13 11h2M9 14h6M9 17h4" /></>, 'Post');
export const AdditiveIcon = make(<><path d="M4 20h16" /><path d="M6 17h12M7 14h10M8 11h8" /><path d="M10 3h4v4h-4zM12 7v2" /></>, 'Additive');
export const TurningIcon = make(<><path d="M3 12h18" opacity={0.4} strokeDasharray="2 2" /><path d="M6 7h8l3 2v6l-3 2H6Z" /><path d="M19 4 15 8" /></>, 'Turning');
export const SpaceMouseIcon = make(<><path d="M4 17c0-2 1.5-3 4-3.3h8c2.5.3 4 1.3 4 3.3v1.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5Z" /><path d="M8 13.7c-.3-1.3-.4-2.6-.4-3.7a4.4 4.4 0 0 1 8.8 0c0 1.1-.1 2.4-.4 3.7" /><path d="M10 7.5h4" opacity={0.6} /></>, 'SpaceMouse');

/* Sketch */
const dot = (cx: number, cy: number) => <circle cx={cx} cy={cy} r="1.6" fill="currentColor" stroke="none" />;
export const SketchIcon = make(<><path d="M3 20h18" opacity={0.35} /><path d="M5 16 16.5 4.5a2.1 2.1 0 0 1 3 3L8 19H5Z" /><path d="m14.5 6.5 3 3" /></>, 'Sketch');
export const LineToolIcon = make(<><path d="M5 19 19 5" />{dot(5, 19)}{dot(19, 5)}</>, 'LineTool');
export const RectToolIcon = make(<><rect x="4" y="6" width="16" height="12" rx="0.5" />{dot(4, 18)}{dot(20, 6)}</>, 'RectTool');
export const CenterRectIcon = make(<><rect x="4" y="6" width="16" height="12" rx="0.5" />{dot(12, 12)}{dot(20, 6)}</>, 'CenterRect');
export const CircleToolIcon = make(<><circle cx="12" cy="12" r="8" />{dot(12, 12)}<path d="M12 12h8" opacity={0.5} strokeDasharray="1.6 1.6" /></>, 'CircleTool');
export const Circle3Icon = make(<><circle cx="12" cy="12" r="8" />{dot(4.7, 9)}{dot(17, 18.2)}{dot(18, 7)}</>, 'Circle3');
export const Arc3Icon = make(<><path d="M4 18A9 9 0 0 1 20 18" />{dot(4, 18)}{dot(20, 18)}{dot(12, 9.1)}</>, 'Arc3');
export const ArcCenterIcon = make(<><path d="M19 12A7 7 0 0 1 5 12" />{dot(12, 12)}{dot(19, 12)}{dot(5, 12)}</>, 'ArcCenter');
export const PolygonToolIcon = make(<><path d="M12 3.5 19.4 7.8v8.4L12 20.5l-7.4-4.3V7.8Z" />{dot(12, 12)}</>, 'PolygonTool');
export const SlotToolIcon = make(<><path d="M8 7h8a5 5 0 0 1 0 10H8A5 5 0 0 1 8 7Z" />{dot(8, 12)}{dot(16, 12)}</>, 'SlotTool');
export const EllipseToolIcon = make(<><ellipse cx="12" cy="12" rx="9" ry="5.5" />{dot(12, 12)}</>, 'EllipseTool');
export const SplineToolIcon = make(<><path d="M3 17c3-9 6-9 9-4s6 4 9-6" /><path d="M3 17 7 8M12 13l4 4 5-10" opacity={0.35} strokeDasharray="1.4 1.6" />{dot(3, 17)}{dot(21, 7)}</>, 'SplineTool');
export const PointToolIcon = make(<><path d="M12 4v5M12 15v5M4 12h5M15 12h5" opacity={0.6} />{dot(12, 12)}</>, 'PointTool');
export const ProjectToolIcon = make(<><path d="M7 4h10l3 5H4z" opacity={0.55} /><path d="M12 9v7" strokeDasharray="2 2" /><path d="M4 20h16" /><path d="m9.5 14 2.5 3 2.5-3" /></>, 'ProjectTool');
export const TrimToolIcon = make(<><path d="M4 9h8" /><path d="M12 9h8" strokeDasharray="1.6 1.9" opacity={0.5} /><path d="M12 4v16" />{dot(12, 9)}<path d="m15.5 12.5 4 4M19.5 12.5l-4 4" /></>, 'TrimTool');
export const DimensionIcon = make(<><path d="M4 8v8M20 8v8M4 12h16" /><path d="m7 9.5-3 2.5 3 2.5M17 9.5l3 2.5-3 2.5" /></>, 'Dimension');
export const ConstructionIcon = make(<><path d="M4 20 20 4" strokeDasharray="2.4 2.2" /><circle cx="12" cy="12" r="5" strokeDasharray="2 2" opacity={0.6} /></>, 'Construction');
export const CoincidentIcon = make(<><path d="M4 18 12 12M12 12l8-6" /><circle cx="12" cy="12" r="2.6" /></>, 'Coincident');
export const HorizontalIcon = make(<><path d="M4 12h16" /><path d="M4 8v8M20 8v8" opacity={0.4} /></>, 'Horizontal');
export const VerticalIcon = make(<><path d="M12 4v16" /><path d="M8 4h8M8 20h8" opacity={0.4} /></>, 'Vertical');
export const ParallelIcon = make(<><path d="M8 20 14 4M12 20l6-16" /></>, 'Parallel');
export const PerpendicularIcon = make(<><path d="M5 19h14M12 19V5" /><path d="M12 15h4v4" opacity={0.6} /></>, 'Perpendicular');
export const TangentIcon = make(<><circle cx="12" cy="13" r="5" /><path d="M3 8h18" /></>, 'Tangent');
export const EqualIcon = make(<><path d="M5 9h14M5 15h14" /></>, 'Equal');
export const SymmetricIcon = make(<><path d="M12 3v18" strokeDasharray="2 2" opacity={0.6} /><path d="m9 8-5 4 5 4M15 8l5 4-5 4" /></>, 'Symmetric');
export const MidpointIcon = make(<><path d="M4 16 20 8" /><path d="M12 7v10" opacity={0.4} />{dot(12, 12)}</>, 'Midpoint');
export const ConcentricIcon = make(<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" />{dot(12, 12)}</>, 'Concentric');
export const CollinearIcon = make(<><path d="M3 15 10 11.5M14 9.5 21 6" /><path d="M10 11.5 14 9.5" opacity={0.35} strokeDasharray="1.2 1.4" /></>, 'Collinear');
export const FixConstraintIcon = make(<><path d="M9 3h6l-1 6 3 3H7l3-3Z" /><path d="M12 12v9" /></>, 'FixConstraint');
export const FinishSketchIcon = make(<><path d="M5 20h14" opacity={0.35} /><path d="m5 12 4.5 4.5L19 7" /></>, 'FinishSketch');

/* Features */
export const ExtrudeIcon = make(<><path d="M5 17 12 21l7-4-7-4Z" /><path d="M5 17V9l7-4 7 4v8" opacity={0.55} /><path d="M12 13V3M9.5 5.5 12 3l2.5 2.5" /></>, 'Extrude');
export const RevolveIcon = make(<><path d="M12 3v18" strokeDasharray="2 2" opacity={0.6} /><path d="M12 6h4v12h-4" /><path d="M5 8.5A6.5 3 0 0 1 12 5.5" /><path d="m5.4 6.2-.4 2.3 2.2.6" /></>, 'Revolve');
export const SweepIcon = make(<><path d="M4 19c4 0 5-4 8-8s5-6 8-6" strokeDasharray="2 2" opacity={0.6} /><path d="M2.5 15.5h4v7h-4z" transform="rotate(-10 4.5 19)" /><path d="M17.5 3h4v5h-4z" /></>, 'Sweep');
export const LoftIcon = make(<><rect x="4" y="16" width="16" height="4" rx="0.5" /><ellipse cx="12" cy="5" rx="4" ry="1.5" /><path d="M4 16 8 5M20 16 16 5" /></>, 'Loft');
export const FillIcon = make(<><path d="M4 16c2-6 6-9 8-9s6 3 8 9" opacity={0.55} /><path d="M4 16c3 2 13 2 16 0" /><path d="M8 12.5c2.5 1 5.5 1 8 0" opacity={0.55} /><path d="M4 16 4 20M20 16v4" opacity={0.35} /></>, 'Fill');
export const BoundarySurfaceIcon = make(<><path d="M4 18c3-2 5-2 8 0s5 2 8 0" /><path d="M4 6c3-2 5-2 8 0s5 2 8 0" /><path d="M4 6v12M20 6v12" opacity={0.55} /><path d="M12 6v12" opacity={0.35} strokeDasharray="1.6 1.6" /></>, 'BoundarySurface');
export const ThickenIcon = make(<><path d="M4 9c3-3 13-3 16 0" /><path d="M4 15c3-3 13-3 16 0" opacity={0.55} /><path d="M4 9v6M20 9v6" /><path d="M12 8v5" opacity={0.35} strokeDasharray="1.6 1.6" /></>, 'Thicken');
export const SolidifyIcon = make(<><path d="M5 8 12 4l7 4v8l-7 4-7-4z" /><path d="M5 8l7 4 7-4M12 12v8" opacity={0.55} strokeDasharray="1.6 1.6" /></>, 'Solidify');
export const HoleIcon = make(<><path d="M3 9 12 4l9 5-9 5Z" /><ellipse cx="12" cy="9" rx="3" ry="1.6" /><path d="M9 9v8a3 1.6 0 0 0 6 0V9" opacity={0.6} /></>, 'Hole');
export const FilletIcon = make(<><path d="M4 20V10a6 6 0 0 1 6-6h10" /><path d="M4 4h6M4 4v6" opacity={0.35} strokeDasharray="1.6 1.6" /></>, 'Fillet');
export const ChamferIcon = make(<><path d="M4 20V10l6-6h10" /><path d="M4 4h6M4 4v6" opacity={0.35} strokeDasharray="1.6 1.6" /></>, 'Chamfer');
export const ShellIcon = make(<><path d="M3 8h18v12H3z" /><path d="M6 8v9h12V8" opacity={0.7} /></>, 'Shell');
export const DraftIcon = make(<><path d="M6 20 8 6h8l2 14Z" /><path d="M8 6V20" opacity={0.35} strokeDasharray="1.6 1.6" /></>, 'Draft');
export const LinearPatternIcon = make(<><rect x="3" y="9" width="5" height="6" rx="1" /><rect x="10" y="9" width="5" height="6" rx="1" opacity={0.75} /><rect x="17" y="9" width="4" height="6" rx="1" opacity={0.5} /><path d="M3 19h18" opacity={0.4} /></>, 'LinearPattern');
export const CircularPatternIcon = make(<><circle cx="12" cy="12" r="7" strokeDasharray="1.6 2" opacity={0.5} /><circle cx="12" cy="5" r="2" /><circle cx="18.1" cy="15.5" r="2" opacity={0.75} /><circle cx="5.9" cy="15.5" r="2" opacity={0.5} /></>, 'CircularPattern');
export const TablePatternIcon = make(<><path d="M3 4h8v9H3zM3 7h8M3 10h8M7 4v9" opacity={0.6} /><circle cx="15" cy="7" r="2" /><circle cx="19.5" cy="13" r="2" opacity={0.75} /><circle cx="13.5" cy="18.5" r="2" opacity={0.5} /></>, 'TablePattern');
export const MirrorIcon = make(<><path d="M12 3v18" strokeDasharray="2 2" /><path d="M9 7 4 17h5ZM15 7l5 10h-5Z" /></>, 'Mirror');
export const CombineIcon = make(<><rect x="3" y="7" width="11" height="11" rx="1" /><rect x="10" y="4" width="11" height="11" rx="1" fill="currentColor" fillOpacity={0.18} /></>, 'Combine');
// Boundary fill: the region under a bridge, closed off by a plane, filled.
export const BoundaryFillIcon = make(<><path d="M3 18V7h18v11h-4v-3a5 5 0 0 0-10 0v3Z" /><path d="M7 18v-3a5 5 0 0 1 10 0v3Z" fill="currentColor" fillOpacity={0.25} stroke="none" /><path d="M2 18h20" strokeDasharray="2 1.8" opacity={0.6} /></>, 'BoundaryFill');
export const SplitIcon =make(<><path d="M4 7h7v11H4zM13 7h7v11h-7z" /><path d="M12 3v18" strokeDasharray="2 2" opacity={0.6} /></>, 'Split');
export const MoveIcon = make(<><path d="M3.5 13.5h7v7h-7z" /><path d="M13.5 3.5h7v7h-7z" strokeDasharray="2 1.8" opacity={0.65} /><path d="M9 15l6.5-6.5M11 8.5h4.5V13" /></>, 'Move');
export const BoxIcon = make(<>{cube}</>, 'Box');
export const CylinderIcon = make(<><ellipse cx="12" cy="6" rx="7" ry="2.5" /><path d="M5 6v12a7 2.5 0 0 0 14 0V6" /></>, 'Cylinder');
export const SphereIcon = make(<><circle cx="12" cy="12" r="8" /><ellipse cx="12" cy="12" rx="8" ry="3" opacity={0.5} /></>, 'Sphere');
export const ConeIcon = make(<><path d="M12 3 5 18M12 3l7 15" /><ellipse cx="12" cy="18" rx="7" ry="2.5" /></>, 'Cone');
export const TorusIcon = make(<><ellipse cx="12" cy="12" rx="9" ry="5" /><ellipse cx="12" cy="11.5" rx="3.5" ry="1.6" /></>, 'Torus');
export const TextToolIcon = make(<><path d="M5 6V4h14v2M12 4v16M9 20h6" /></>, 'TextTool');
export const AxisIcon = make(<><path d="M4 20 20 4" /><path d="M4 20l2.5-.5L4.5 17.5Z" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /></>, 'Axis');

/* Electronics (docs/ELECTRONICS.md) */
// A circuit: a chip on its pins, the document glyph.
export const CircuitIcon = make(<><rect x="6.5" y="6.5" width="11" height="11" rx="1.6" /><path d="M9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5h3.5M3 14.5h3.5M17.5 9.5H21M17.5 14.5H21" /><circle cx="9.6" cy="9.6" r="0.9" fill="currentColor" stroke="none" /></>, 'Circuit');
// Schematic: a resistor zigzag between two wires and a node.
export const SchematicIcon = make(<><path d="M2.5 12h4l1.5-3 2 6 2-6 2 6 1.5-3h6" /><circle cx="21" cy="12" r="0.4" fill="currentColor" /></>, 'Schematic');
// Board: a PCB outline with two pads and a trace.
export const BoardIcon = make(<><rect x="3" y="5" width="18" height="14" rx="1.8" /><path d="M8 10h4.5l3.5 4" /><circle cx="7.5" cy="10" r="1.3" /><circle cx="16.5" cy="14.4" r="1.3" /></>, 'Board');
export const SplitViewIcon = make(<><rect x="3" y="5" width="18" height="14" rx="1.8" /><path d="M12 5v14" /><path d="M5.5 12h1.5l1-1.6 1 3.2 1-1.6M14.5 10h2.5l1.8 2.4" opacity={0.7} /></>, 'SplitView');
export const ResistorIcon = make(<><path d="M2.5 12h4l1.5-3.5 2.5 7 2.5-7 2.5 7 1.5-3.5h4.5" /></>, 'Resistor');
export const CapacitorIcon = make(<><path d="M2.5 12h7.5M14 12h7.5M10 6v12M14 6v12" /></>, 'Capacitor');
export const InductorIcon = make(<><path d="M2.5 13h3a2.6 2.6 0 0 1 5.2 0 2.6 2.6 0 0 1 5.2 0 2.6 2.6 0 0 1 5.2 0h.4" /></>, 'Inductor');
export const DiodeIcon = make(<><path d="M2.5 12h6.5M15 12h6.5M9 7l6 5-6 5Z" /><path d="M15 7v10" /></>, 'Diode');
export const LedIcon = make(<><path d="M2.5 13h6.5M15 13h6.5M9 8l6 5-6 5Z" /><path d="M15 8v10M15.5 5.5l2.5-2.5M18.5 7l2.5-2.5" /><path d="m17 3 1 0 0 1M20 4.5h1v1" /></>, 'Led');
export const ConnectorIcon = make(<><rect x="4" y="7" width="16" height="10" rx="1.5" /><circle cx="8" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="16" cy="12" r="1.3" /></>, 'Connector');
export const NetIcon = make(<><path d="M3 12h5l3-5h10M8 12l3 5h10" /><circle cx="8" cy="12" r="1.2" fill="currentColor" stroke="none" /></>, 'Net');
// Wire: a connection drawn between two pins.
export const WireIcon = make(<><circle cx="5" cy="17" r="2" /><circle cx="19" cy="7" r="2" /><path d="M7 17h5V7h5" /></>, 'Wire');
