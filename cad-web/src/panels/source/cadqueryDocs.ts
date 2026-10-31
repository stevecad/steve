/*
 * CadQuery API reference (2.8 API; the runtime runs Steve's 2.9 fork) used by completion, hover and signature help.
 * Signatures were checked against the runtime image (inspect.signature); types
 * are simplified for reading (VectorLike = Vector | tuple of 2 or 3 floats).
 */

export type MemberKind = 'method' | 'function' | 'property' | 'class' | 'module' | 'constant';

export interface Param {
  readonly name: string;
  readonly type?: string;
  readonly default?: string;
  readonly star?: '*' | '**';
}

export interface MemberDoc {
  readonly name: string;
  readonly kind: MemberKind;
  /** Display owner, e.g. `Workplane` or `cq`. */
  readonly owner: string;
  /** Overloads; empty for properties, constants and modules. */
  readonly signatures: readonly (readonly Param[])[];
  readonly returns?: string;
  readonly doc: string;
  readonly group?: string;
  /** Popularity, used to order otherwise-equal completions. */
  readonly rank: number;
}

type Sig = string | readonly string[] | null;
type Row = readonly [name: string, sig: Sig, returns: string, doc: string, group?: string, rank?: number];

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const PARAM = /^(\*{0,2})([A-Za-z_]\w*)?(?:\s*:\s*(.+?))?(?:\s*=\s*(.+))?$/;

export function parseParams(text: string): Param[] {
  return splitTopLevel(text).map((part) => {
    const m = PARAM.exec(part);
    if (!m) return { name: part };
    const star = m[1] === '*' || m[1] === '**' ? m[1] : undefined;
    return { name: m[2] ?? '', type: m[3], default: m[4], star };
  });
}

function table(owner: string, kind: 'method' | 'function', rows: readonly Row[]): MemberDoc[] {
  return rows.map(([name, sig, returns, doc, group, rank = 1]) => ({
    name,
    kind: sig === null ? 'property' : kind,
    owner,
    signatures: sig === null ? [] : (typeof sig === 'string' ? [sig] : sig).map(parseParams),
    returns,
    doc,
    group,
    rank,
  }));
}

const COMBINE = 'bool | "cut" | "a" | "s"';
const CENTERED3 = 'bool | tuple[bool, bool, bool] = True';
const UNIT = '"MM" | "CM" | "M" | "KM" | "INCH" | "FT" | "MI" | "UM" | "NM"';
const SELECT = 'selector: str | Selector | None = None, tag: str | None = None';
const KIND = '"Vertex" | "Edge" | "Wire" | "Face" | "Shell" | "Solid" | "CompSolid" | "Compound"';
const MODE = 'mode: "a" | "s" | "i" | "c" | "r" = "a", tag: str | None = None';
const UNTIL = 'until: float | "next" | "last" | Face';
const PLANES = '"XY" | "YX" | "XZ" | "ZX" | "YZ" | "ZY"';

const WORKPLANE = table('Workplane', 'method', [
  // 2D
  ['rect', 'xLen: float, yLen: float, centered: bool | tuple[bool, bool] = True, forConstruction: bool = False', 'Workplane', 'Draw a rectangle at each point on the stack (centred by default).', '2D', 3],
  ['circle', 'radius: float, forConstruction: bool = False', 'Workplane', 'Draw a circle of the given radius at each point on the stack.', '2D', 3],
  ['ellipse', 'x_radius: float, y_radius: float, rotation_angle: float = 0.0, forConstruction: bool = False', 'Workplane', 'Draw an ellipse at each point on the stack.', '2D'],
  ['ellipseArc', 'x_radius: float, y_radius: float, angle1: float = 360, angle2: float = 360, rotation_angle: float = 0.0, sense: -1 | 1 = 1, forConstruction: bool = False, startAtCurrent: bool = True, makeWire: bool = False', 'Workplane', 'Draw an elliptical arc starting at, or centred on, the current point.', '2D', 0],
  ['polygon', 'nSides: int, diameter: float, forConstruction: bool = False, circumscribed: bool = False', 'Workplane', 'Draw a regular polygon inscribed in (or circumscribing) a circle of the given diameter.', '2D', 2],
  ['polyline', 'listOfXYTuple: Sequence[VectorLike], forConstruction: bool = False, includeCurrent: bool = False', 'Workplane', 'Draw straight segments through a list of points; follow with close() for a profile.', '2D', 2],
  ['spline', 'listOfXYTuple: Iterable[VectorLike], tangents: Sequence[VectorLike] | None = None, periodic: bool = False, parameters: Sequence[float] | None = None, scale: bool = True, tol: float | None = None, forConstruction: bool = False, includeCurrent: bool = False, makeWire: bool = False', 'Workplane', 'Draw a spline interpolated through the given points (2D or 3D).', '2D'],
  ['splineApprox', 'points: Iterable[VectorLike], tol: float | None = 1e-06, minDeg: int = 1, maxDeg: int = 6, smoothing: tuple[float, float, float] | None = (1, 1, 1), forConstruction: bool = False, includeCurrent: bool = False, makeWire: bool = False', 'Workplane', 'Draw a smoothing spline approximating the given points.', '2D', 0],
  ['bezier', 'listOfXYTuple: Iterable[VectorLike], forConstruction: bool = False, includeCurrent: bool = False, makeWire: bool = False', 'Workplane', 'Draw a Bézier curve using the points as control points.', '2D', 0],
  ['parametricCurve', 'func: Callable[[float], VectorLike], N: int = 400, start: float = 0, stop: float = 1, tol: float = 1e-06, minDeg: int = 1, maxDeg: int = 6, smoothing: tuple[float, float, float] | None = (1, 1, 1), makeWire: bool = True', 'Workplane', 'Draw a spline approximating func(t) for t from start to stop.', '2D', 0],
  ['slot2D', 'length: float, diameter: float, angle: float = 0', 'Workplane', 'Draw a rounded slot centred on each point on the stack.', '2D'],
  ['offset2D', 'd: float, kind: "arc" | "intersection" | "tangent" = "arc", forConstruction: bool = False', 'Workplane', 'Offset the pending wires by d; negative values shrink them.', '2D'],
  ['moveTo', 'x: float = 0, y: float = 0', 'Workplane', 'Move the current point to (x, y) without drawing.', '2D', 2],
  ['move', 'xDist: float = 0, yDist: float = 0', 'Workplane', 'Move the current point by (xDist, yDist) without drawing.', '2D'],
  ['lineTo', 'x: float, y: float, forConstruction: bool = False', 'Workplane', 'Draw a line from the current point to (x, y).', '2D', 2],
  ['line', 'xDist: float, yDist: float, forConstruction: bool = False', 'Workplane', 'Draw a line relative to the current point.', '2D'],
  ['hLine', 'distance: float, forConstruction: bool = False', 'Workplane', 'Draw a horizontal line of the given length.', '2D'],
  ['vLine', 'distance: float, forConstruction: bool = False', 'Workplane', 'Draw a vertical line of the given length.', '2D'],
  ['hLineTo', 'xCoord: float, forConstruction: bool = False', 'Workplane', 'Draw a horizontal line to the given x coordinate.', '2D', 0],
  ['vLineTo', 'yCoord: float, forConstruction: bool = False', 'Workplane', 'Draw a vertical line to the given y coordinate.', '2D', 0],
  ['polarLine', 'distance: float, angle: float, forConstruction: bool = False', 'Workplane', 'Draw a line of the given length at an angle (degrees) from the current point.', '2D', 0],
  ['polarLineTo', 'distance: float, angle: float, forConstruction: bool = False', 'Workplane', 'Draw a line to the point at polar coordinates (distance, angle).', '2D', 0],
  ['threePointArc', 'point1: VectorLike, point2: VectorLike, forConstruction: bool = False', 'Workplane', 'Draw an arc from the current point through point1, ending at point2.', '2D'],
  ['sagittaArc', 'endPoint: VectorLike, sag: float, forConstruction: bool = False', 'Workplane', 'Draw an arc to endPoint whose height at the midpoint is sag.', '2D', 0],
  ['radiusArc', 'endPoint: VectorLike, radius: float, forConstruction: bool = False', 'Workplane', 'Draw an arc of the given radius to endPoint; the sign picks the side.', '2D'],
  ['tangentArcPoint', 'endpoint: VectorLike, forConstruction: bool = False, relative: bool = True', 'Workplane', 'Draw an arc tangent to the previous edge, ending at endpoint.', '2D', 0],
  ['close', '', 'Workplane', 'Close the current wire back to its start point.', '2D', 2],
  ['mirrorX', '', 'Workplane', 'Mirror the pending edges about the workplane X axis and join them into a wire.', '2D', 0],
  ['mirrorY', '', 'Workplane', 'Mirror the pending edges about the workplane Y axis and join them into a wire.', '2D', 0],
  // 3D
  ['box', `length: float, width: float, height: float, centered: ${CENTERED3}, combine: ${COMBINE} = True, clean: bool = True`, 'Workplane', 'Create a box at each point on the stack (centred by default).', '3D', 3],
  ['sphere', `radius: float, direct: VectorLike = (0, 0, 1), angle1: float = -90, angle2: float = 90, angle3: float = 360, centered: ${CENTERED3}, combine: ${COMBINE} = True, clean: bool = True`, 'Workplane', 'Create a sphere at each point on the stack.', '3D', 2],
  ['cylinder', `height: float, radius: float, direct: VectorLike = (0, 0, 1), angle: float = 360, centered: ${CENTERED3}, combine: ${COMBINE} = True, clean: bool = True`, 'Workplane', 'Create a cylinder at each point on the stack.', '3D', 2],
  ['wedge', `dx: float, dy: float, dz: float, xmin: float, zmin: float, xmax: float, zmax: float, pnt: VectorLike = (0, 0, 0), dir: VectorLike = (0, 0, 1), centered: ${CENTERED3}, combine: ${COMBINE} = True, clean: bool = True`, 'Workplane', 'Create a wedge at each point on the stack.', '3D', 0],
  ['extrude', `${UNTIL}, combine: ${COMBINE} = True, clean: bool = True, both: bool = False, taper: float | None = None`, 'Workplane', 'Extrude the pending wires by a distance, or up to the "next"/"last" face.', '3D', 3],
  ['twistExtrude', `distance: float, angleDegrees: float, combine: ${COMBINE} = True, clean: bool = True`, 'Workplane', 'Extrude the pending wires while twisting them by angleDegrees.', '3D', 0],
  ['revolve', `angleDegrees: float = 360.0, axisStart: VectorLike | None = None, axisEnd: VectorLike | None = None, combine: ${COMBINE} = True, clean: bool = True`, 'Workplane', 'Revolve the pending wires about an axis given in workplane coordinates.', '3D', 2],
  ['sweep', `path: Workplane | Wire | Edge, multisection: bool = False, sweepAlongWires: bool | None = None, makeSolid: bool = True, isFrenet: bool = False, combine: ${COMBINE} = True, clean: bool = True, transition: "right" | "round" | "transformed" = "right", normal: VectorLike | None = None, auxSpine: Workplane | None = None`, 'Workplane', 'Sweep the pending wires along a path.', '3D', 2],
  ['loft', `ruled: bool = False, combine: ${COMBINE} = True, clean: bool = True`, 'Workplane', 'Loft a solid through the pending wires, e.g. profiles on offset workplanes.', '3D', 2],
  ['text', `txt: str, fontsize: float, distance: float, combine: ${COMBINE} = "cut", clean: bool = True, font: str = "Arial", fontPath: str | None = None, kind: "regular" | "bold" | "italic" = "regular", halign: "center" | "left" | "right" = "center", valign: "center" | "top" | "bottom" = "center"`, 'Workplane', 'Create 3D text extruded by distance; it cuts into the solid by default.', '3D'],
  ['interpPlate', `surf_edges: Sequence[VectorLike] | Sequence[Edge | Wire] | Workplane, surf_pts: Sequence[VectorLike] = [], thickness: float = 0, combine: ${COMBINE} = False, clean: bool = True, degree: int = 3, nbPtsOnCur: int = 15, nbIter: int = 2, anisotropy: bool = False, tol2d: float = 1e-05, tol3d: float = 0.0001, tolAng: float = 0.01, tolCurv: float = 0.1, maxDeg: int = 8, maxSegments: int = 9`, 'Workplane', 'Create a (thickened) surface bounded by edges and passing through points.', '3D', -1],
  ['parametricSurface', 'func: Callable[[float, float], VectorLike], N: int = 20, start: float = 0, stop: float = 1, tol: float = 0.01, minDeg: int = 1, maxDeg: int = 6, smoothing: tuple[float, float, float] | None = (1, 1, 1)', 'Workplane', 'Create a spline surface approximating func(u, v).', '3D', -1],
  // Features
  ['hole', 'diameter: float, depth: float | None = None, clean: bool = True', 'Workplane', 'Drill a hole at each point on the stack; through all when depth is None.', 'Feature', 3],
  ['cboreHole', 'diameter: float, cboreDiameter: float, cboreDepth: float, depth: float | None = None, clean: bool = True', 'Workplane', 'Drill a counterbored hole at each point on the stack.', 'Feature', 2],
  ['cskHole', 'diameter: float, cskDiameter: float, cskAngle: float, depth: float | None = None, clean: bool = True', 'Workplane', 'Drill a countersunk hole at each point on the stack.', 'Feature', 2],
  ['cutBlind', `${UNTIL}, clean: bool = True, both: bool = False, taper: float | None = None`, 'Workplane', 'Cut the pending wires into the solid; negative depths cut against the normal.', 'Feature', 2],
  ['cutThruAll', 'clean: bool = True, taper: float = 0', 'Workplane', 'Cut the pending wires through the entire solid.', 'Feature', 2],
  ['fillet', 'radius: float', 'Workplane', 'Round the selected edges with the given radius.', 'Feature', 3],
  ['chamfer', 'length: float, length2: float | None = None', 'Workplane', 'Bevel the selected edges; asymmetric when length2 is given.', 'Feature', 2],
  ['shell', 'thickness: float, kind: "arc" | "intersection" = "arc"', 'Workplane', 'Hollow the solid, removing the selected faces; negative thickness shells inward.', 'Feature', 2],
  ['split', ['keepTop: bool = False, keepBottom: bool = False', 'splitter: Workplane | Shape'], 'Workplane', 'Split the solid with the current workplane (keeping top and/or bottom) or with a splitter.', 'Feature'],
  ['section', 'height: float = 0.0', 'Workplane', 'Slice the solid at the given height, returning the section faces.', 'Feature', 0],
  // Booleans
  ['union', 'toUnion: Workplane | Solid | Compound | None = None, clean: bool = True, glue: bool = False, tol: float | None = None', 'Workplane', 'Fuse another solid with the current solid.', 'Boolean', 2],
  ['cut', 'toCut: Workplane | Solid | Compound, clean: bool = True, tol: float | None = None', 'Workplane', 'Subtract another solid from the current solid.', 'Boolean', 2],
  ['intersect', 'toIntersect: Workplane | Solid | Compound, clean: bool = True, tol: float | None = None', 'Workplane', 'Keep only the volume shared with another solid.', 'Boolean'],
  ['combine', 'clean: bool = True, glue: bool = False, tol: float | None = None', 'Workplane', 'Fuse all items on the stack into a single solid.', 'Boolean'],
  // Transforms
  ['translate', 'vec: VectorLike', 'Workplane', 'Return a copy of the stack moved by vec.', 'Transform', 2],
  ['rotate', 'axisStartPoint: VectorLike, axisEndPoint: VectorLike, angleDegrees: float', 'Workplane', 'Return a copy of the stack rotated about the axis through two points.', 'Transform', 2],
  ['rotateAboutCenter', 'axisEndPoint: VectorLike, angleDegrees: float', 'Workplane', 'Rotate each item on the stack about its own centre.', 'Transform', 0],
  ['mirror', `mirrorPlane: ${PLANES} | VectorLike | Face | Workplane = "XY", basePointVector: VectorLike | None = None, union: bool = False`, 'Workplane', 'Mirror about a plane; union=True fuses the mirror with the original.', 'Transform', 2],
  // Selection
  ['faces', SELECT, 'Workplane', 'Select faces of the objects on the stack, optionally filtered by a selector.', 'Select', 3],
  ['edges', SELECT, 'Workplane', 'Select edges of the objects on the stack, optionally filtered by a selector.', 'Select', 3],
  ['vertices', SELECT, 'Workplane', 'Select vertices of the objects on the stack, optionally filtered by a selector.', 'Select', 3],
  ['solids', SELECT, 'Workplane', 'Select solids of the objects on the stack, optionally filtered by a selector.', 'Select'],
  ['wires', SELECT, 'Workplane', 'Select wires of the objects on the stack, optionally filtered by a selector.', 'Select'],
  ['shells', SELECT, 'Workplane', 'Select shells of the objects on the stack, optionally filtered by a selector.', 'Select', 0],
  ['compounds', SELECT, 'Workplane', 'Select compounds on the stack, optionally filtered by a selector.', 'Select', -1],
  ['ancestors', `kind: ${KIND}, tag: str | None = None`, 'Workplane', 'Select topological ancestors, e.g. the faces that contain the selected edges.', 'Select', 0],
  ['siblings', `kind: ${KIND}, level: int = 1, tag: str | None = None`, 'Workplane', 'Select neighbours that share a sub-shape of the given kind.', 'Select', 0],
  ['filter', 'f: Callable[[Shape], bool]', 'Workplane', 'Keep the items for which f returns True.', 'Select', 0],
  ['sort', 'key: Callable[[Shape], Any]', 'Workplane', 'Sort the items on the stack by key.', 'Select', 0],
  ['map', 'f: Callable[[Shape], Shape]', 'Workplane', 'Apply f to every item separately.', 'Select', -1],
  ['apply', 'f: Callable[[Iterable[Shape]], Iterable[Shape]]', 'Workplane', 'Apply f to all items at once.', 'Select', -1],
  // Workplanes
  ['workplane', 'offset: float = 0.0, invert: bool = False, centerOption: "CenterOfMass" | "ProjectedOrigin" | "CenterOfBoundBox" = "ProjectedOrigin", origin: VectorLike | None = None', 'Workplane', 'Create a workplane on the selected planar face, or offset from the current one.', 'Workplane', 3],
  ['workplaneFromTagged', 'name: str', 'Workplane', 'Return to the workplane of a tagged object.', 'Workplane'],
  ['copyWorkplane', 'obj: Workplane', 'Workplane', 'Adopt the workplane (plane and origin) of another object.', 'Workplane', 0],
  ['transformed', 'rotate: VectorLike = (0, 0, 0), offset: VectorLike = (0, 0, 0)', 'Workplane', 'Create a workplane rotated (degrees) and offset from the current one.', 'Workplane'],
  ['center', 'x: float, y: float', 'Workplane', 'Shift the workplane origin to (x, y) in local coordinates.', 'Workplane'],
  ['tag', 'name: str', 'Workplane', 'Tag this object so it can be selected or returned to later.', 'Workplane'],
  ['end', 'n: int = 1', 'Workplane', 'Return to the n-th parent in the chain, undoing selections.', 'Workplane'],
  // Points
  ['pushPoints', 'pntList: Iterable[VectorLike | Location]', 'Workplane', 'Push points (workplane coordinates) or locations onto the stack.', 'Points', 2],
  ['rarray', 'xSpacing: float, ySpacing: float, xCount: int, yCount: int, center: bool | tuple[bool, bool] = True', 'Workplane', 'Push a rectangular grid of points onto the stack.', 'Points', 2],
  ['polarArray', 'radius: float, startAngle: float, angle: float, count: int, fill: bool = True, rotate: bool = True', 'Workplane', 'Push points spaced around a circle onto the stack.', 'Points', 2],
  // Stack
  ['val', '', 'Shape', 'Return the first object on the stack.', 'Stack'],
  ['vals', '', 'list[Shape]', 'Return every object on the stack.', 'Stack'],
  ['first', '', 'Workplane', 'Keep only the first item on the stack.', 'Stack', 0],
  ['last', '', 'Workplane', 'Keep only the last item on the stack.', 'Stack', 0],
  ['item', 'i: int', 'Workplane', 'Keep only the i-th item on the stack.', 'Stack', 0],
  ['size', '', 'int', 'Number of items on the stack.', 'Stack', 0],
  ['all', '', 'list[Workplane]', 'Split the stack into one Workplane per item.', 'Stack', -1],
  ['add', 'obj: Workplane | Shape | Vector | Location | Iterable', 'Workplane', 'Add objects to the stack.', 'Stack', 0],
  ['newObject', 'objlist: Iterable[Shape | Vector | Location]', 'Workplane', 'Create a child Workplane holding the given objects.', 'Stack', -1],
  ['each', `callback: Callable[[Shape], Shape], useLocalCoordinates: bool = False, combine: ${COMBINE} = True, clean: bool = True`, 'Workplane', 'Call callback for each item and collect the returned shapes.', 'Stack', 0],
  ['eachpoint', `arg: Shape | Workplane | Callable[[Location], Shape], useLocalCoordinates: bool = False, combine: ${COMBINE} = False, clean: bool = True`, 'Workplane', 'Place a shape (or a callback result) at every point on the stack.', 'Stack'],
  ['toPending', '', 'Workplane', 'Add the selected wires/edges to the pending wires, ready to extrude.', 'Stack', 0],
  ['invoke', 'f: Callable[[Workplane], Workplane | None]', 'Workplane', 'Call f with this Workplane and continue with its result (or self if None).', 'Stack', -1],
  ['findSolid', 'searchStack: bool = True, searchParents: bool = True', 'Shape', 'Find the first solid in the chain.', 'Stack', 0],
  ['clean', '', 'Workplane', 'Remove redundant edges and faces left by boolean operations.', 'Stack', 0],
  ['largestDimension', '', 'float', 'Largest bounding-box dimension of the stack.', 'Stack', -1],
  ['sketch', '', 'Sketch', 'Start a face-based Sketch on this workplane; call .finalize() to return.', 'Sketch'],
  ['placeSketch', '*sketches: Sketch', 'Workplane', 'Place sketches at each location on the stack, ready to extrude.', 'Sketch'],
  ['export', `fname: str, tolerance: float = 0.1, angularTolerance: float = 0.1, unit: ${UNIT} = "MM", outputUnit: str | None = None, opt: dict | None = None`, 'Workplane', 'Export to a file; the format is inferred from the extension.', 'Export', -1],
]);

const CONSTRAINT_KIND = '"Plane" | "Point" | "Axis" | "PointInPlane" | "Fixed" | "FixedPoint" | "FixedAxis" | "PointOnLine" | "FixedRotation"';
const ASSEMBLY_EXPORT = '"STEP" | "XML" | "XBF" | "GLTF" | "VTKJS" | "VRML" | "STL" | None = None, mode: "default" | "fused" = "default", tolerance: float = 0.1, angularTolerance: float = 0.1';

const ASSEMBLY = table('Assembly', 'method', [
  ['add', [
    'obj: Shape | Workplane | None, loc: Location | None = None, name: str | None = None, color: Color | None = None, material: Material | None = None, metadata: dict | None = None',
    'obj: Assembly, loc: Location | None = None, name: str | None = None, color: Color | None = None',
  ], 'Assembly', 'Add a part or sub-assembly with an optional placement, name and color.', 'Assembly', 3],
  ['constrain', [
    `q1: str, q2: str, kind: ${CONSTRAINT_KIND}, param: Any = None`,
    'q1: str, kind: "Fixed" | "FixedPoint" | "FixedAxis" | "FixedRotation", param: Any = None',
    `id1: str, s1: Shape, id2: str, s2: Shape, kind: ${CONSTRAINT_KIND}, param: Any = None`,
  ], 'Assembly', 'Constrain named parts, e.g. constrain("base@faces@>Z", "lid@faces@<Z", "Plane").', 'Constraint', 2],
  ['solve', 'verbosity: int = 0', 'Assembly', 'Solve the constraints and update part locations.', 'Constraint', 2],
  ['toCompound', '', 'Compound', 'Merge all parts, with their locations applied, into one Compound.', 'Assembly'],
  ['export', `path: str, exportType: ${ASSEMBLY_EXPORT}, unit: ${UNIT} = "MM", outputUnit: str | None = None`, 'Assembly', 'Export the assembly; the format is inferred from the extension.', 'Export', 0],
  ['save', `path: str, exportType: ${ASSEMBLY_EXPORT}`, 'Assembly', 'Save the assembly to a file (older alias of export).', 'Export', -1],
  ['traverse', '', 'Iterator[tuple[str, Assembly]]', 'Iterate over (name, child) pairs, children first.', 'Assembly', 0],
  ['remove', 'name: str', 'Assembly', 'Remove a part or sub-assembly by name.', 'Assembly', 0],
  ['addSubshape', 's: Shape, name: str | None = None, color: Color | None = None, layer: str | None = None', 'Assembly', 'Attach a name, color or layer to a sub-shape (e.g. a face) of this part.', 'Assembly', -1],
  ['name', null, 'str', 'Name of this node; unique among its siblings.', 'Property'],
  ['loc', null, 'Location', 'Placement of this node relative to its parent.', 'Property'],
  ['color', null, 'Color | None', 'Display color of this node.', 'Property'],
  ['obj', null, 'Shape | Workplane | None', 'The geometry held by this node.', 'Property', 0],
  ['children', null, 'list[Assembly]', 'Direct sub-assemblies.', 'Property', 0],
  ['objects', null, 'dict[str, Assembly]', 'Every node in this assembly, by name.', 'Property', 0],
  ['parent', null, 'Assembly | None', 'The parent assembly, if any.', 'Property', -1],
  ['shapes', null, 'list[Shape]', 'Shapes held directly by this node.', 'Property', -1],
  ['metadata', null, 'dict', 'User metadata attached to this node.', 'Property', -1],
  ['material', null, 'Material | None', 'Material assigned to this node.', 'Property', -1],
]);

const ASSEMBLY_STATIC = table('Assembly', 'function', [
  ['importStep', `path: str, unit: ${UNIT} = "MM"`, 'Assembly', 'Import a STEP file as an assembly.', 'Import'],
  ['load', `path: str, importType: "STEP" | "XML" | "XBF" | None = None, unit: ${UNIT} = "MM"`, 'Assembly', 'Load an assembly from a STEP, XML or XBF file.', 'Import', 0],
]);

const SKETCH = table('Sketch', 'method', [
  ['rect', `w: float, h: float, angle: float = 0, ${MODE}`, 'Sketch', 'Add a rectangle face centred at each location.', 'Face', 3],
  ['circle', `r: float, ${MODE}`, 'Sketch', 'Add a circular face at each location.', 'Face', 3],
  ['ellipse', `a1: float, a2: float, angle: float = 0, ${MODE}`, 'Sketch', 'Add an elliptical face at each location.', 'Face'],
  ['trapezoid', `w: float, h: float, a1: float, a2: float | None = None, angle: float = 0, ${MODE}`, 'Sketch', 'Add a trapezoid face with base angles a1 (and a2).', 'Face'],
  ['slot', `w: float, h: float, angle: float = 0, ${MODE}`, 'Sketch', 'Add a slot face of centre distance w and width h.', 'Face'],
  ['regularPolygon', `r: float, n: int, angle: float = 0, ${MODE}`, 'Sketch', 'Add a regular n-gon face with circumradius r.', 'Face'],
  ['polygon', `pts: Iterable[VectorLike], angle: float = 0, ${MODE}`, 'Sketch', 'Add a polygon face through the given points.', 'Face'],
  ['face', `b: Wire | Iterable[Edge] | Shape | Sketch, angle: float = 0, ${MODE}, ignore_selection: bool = False`, 'Sketch', 'Add a face built from a wire, edges or another shape.', 'Face', 0],
  ['importDXF', `filename: str, tol: float = 1e-06, exclude: list[str] = [], include: list[str] = [], angle: float = 0, ${MODE}`, 'Sketch', 'Add faces from a DXF file.', 'Face', -1],
  ['rarray', 'xs: float, ys: float, nx: int, ny: int', 'Sketch', 'Set a rectangular grid of locations.', 'Locations', 2],
  ['parray', 'r: float, a1: float, da: float, n: int, rotate: bool = True', 'Sketch', 'Set a polar array of n locations on radius r.', 'Locations', 2],
  ['distribute', 'n: int, start: float = 0, stop: float = 1, rotate: bool = True', 'Sketch', 'Distribute n locations along the selected edges.', 'Locations', 0],
  ['push', 'locs: Iterable[Location | VectorLike], tag: str | None = None', 'Sketch', 'Set the current locations to the given points.', 'Locations'],
  ['each', `callback: Callable[[Location], Face | Sketch | Compound], ${MODE}, ignore_selection: bool = False`, 'Sketch', 'Apply a callback at every location.', 'Locations', 0],
  ['faces', 's: str | Selector | None = None, tag: str | None = None', 'Sketch', 'Select faces.', 'Select', 2],
  ['edges', 's: str | Selector | None = None, tag: str | None = None', 'Sketch', 'Select edges.', 'Select', 2],
  ['vertices', 's: str | Selector | None = None, tag: str | None = None', 'Sketch', 'Select vertices, e.g. to fillet or chamfer them.', 'Select', 3],
  ['wires', 's: str | Selector | None = None, tag: str | None = None', 'Sketch', 'Select wires.', 'Select'],
  ['reset', '', 'Sketch', 'Clear the current selection.', 'Select', 2],
  ['tag', 'tag: str', 'Sketch', 'Tag the current selection.', 'Select'],
  ['select', '*tags: str', 'Sketch', 'Select previously tagged objects.', 'Select', 0],
  ['delete', '', 'Sketch', 'Delete the selected objects.', 'Select', 0],
  ['fillet', 'd: float', 'Sketch', 'Fillet the selected vertices with radius d.', 'Modify', 3],
  ['chamfer', 'd: float', 'Sketch', 'Chamfer the selected vertices by d.', 'Modify', 2],
  ['offset', `d: float, ${MODE}`, 'Sketch', 'Offset the selected wires or edges by d.', 'Modify'],
  ['hull', MODE, 'Sketch', 'Add the convex hull of the selection (or all edges).', 'Modify', 0],
  ['clean', '', 'Sketch', 'Remove internal wires left by boolean modes.', 'Modify'],
  ['segment', 'p1: VectorLike, p2: VectorLike, tag: str | None = None, forConstruction: bool = False', 'Sketch', 'Add a line segment (edge-based sketching).', 'Edge'],
  ['arc', 'p1: VectorLike, p2: VectorLike, p3: VectorLike, tag: str | None = None, forConstruction: bool = False', 'Sketch', 'Add a three-point arc (edge-based sketching).', 'Edge'],
  ['spline', 'pts: Iterable[VectorLike], tangents: Iterable[VectorLike] | None = None, periodic: bool = False, tag: str | None = None, forConstruction: bool = False', 'Sketch', 'Add a spline through the points (edge-based sketching).', 'Edge', 0],
  ['bezier', 'pts: Iterable[VectorLike], tag: str | None = None, forConstruction: bool = False', 'Sketch', 'Add a Bézier curve (edge-based sketching).', 'Edge', 0],
  ['close', 'tag: str | None = None', 'Sketch', 'Connect the last edge back to the first.', 'Edge'],
  ['assemble', MODE, 'Sketch', 'Assemble the drawn edges into a face.', 'Edge'],
  ['constrain', 'tag: str, constraint: "Fixed" | "FixedPoint" | "Coincident" | "Angle" | "Length" | "Distance" | "Radius" | "Orientation" | "ArcAngle", arg: Any', 'Sketch', 'Constrain tagged edges before solve().', 'Edge', 0],
  ['solve', '', 'Sketch', 'Solve the edge constraints.', 'Edge', 0],
  ['finalize', '', 'Workplane', 'Finish the sketch and return to the parent Workplane.', 'Sketch', 3],
  ['located', 'loc: Location', 'Sketch', 'Copy of the sketch moved to a new location.', 'Sketch', 0],
  ['moved', 'loc: Location', 'Sketch', 'Copy of the sketch with its faces moved.', 'Sketch', 0],
  ['copy', '', 'Sketch', 'Partial copy of the sketch.', 'Sketch', 0],
  ['val', '', 'Shape', 'First selected item, or the underlying faces.', 'Sketch', 0],
  ['vals', '', 'list[Shape]', 'All selected items.', 'Sketch', 0],
]);

const SHAPE = table('Shape', 'method', [
  ['Volume', 'tol: float | None = None', 'float', 'Volume of the shape (mm³).', 'Measure', 2],
  ['Area', '', 'float', 'Total surface area of all faces (mm²).', 'Measure', 2],
  ['BoundingBox', 'tolerance: float | None = None', 'BoundBox', 'Axis-aligned bounding box.', 'Measure', 2],
  ['Center', '', 'Vector', 'Centre of mass.', 'Measure', 2],
  ['CenterOfBoundBox', 'tolerance: float | None = None', 'Vector', 'Centre of the bounding box.', 'Measure', 0],
  ['isValid', '', 'bool', 'True if OCCT finds no defects in the shape.', 'Measure'],
  ['ShapeType', '', 'str', 'Topological type, e.g. "Solid" or "Face".', 'Measure', 0],
  ['geomType', '', 'str', 'Geometry type, e.g. "PLANE", "CYLINDER", "LINE" or "CIRCLE".', 'Measure', 0],
  ['distance', 'other: Shape', 'float', 'Minimal distance to another shape.', 'Measure', 0],
  ['Solids', '', 'list[Solid]', 'All solids in the shape.', 'Topology'],
  ['Faces', '', 'list[Face]', 'All faces in the shape.', 'Topology'],
  ['Edges', '', 'list[Edge]', 'All edges in the shape.', 'Topology'],
  ['Wires', '', 'list[Wire]', 'All wires in the shape.', 'Topology', 0],
  ['Vertices', '', 'list[Vertex]', 'All vertices in the shape.', 'Topology', 0],
  ['Shells', '', 'list[Shell]', 'All shells in the shape.', 'Topology', 0],
  ['faces', 'selector: str | Selector | None = None', 'Shape', 'Select faces, optionally filtered by a selector.', 'Topology'],
  ['edges', 'selector: str | Selector | None = None', 'Shape', 'Select edges, optionally filtered by a selector.', 'Topology'],
  ['vertices', 'selector: str | Selector | None = None', 'Shape', 'Select vertices, optionally filtered by a selector.', 'Topology', 0],
  ['face', 'selector: str | Selector | None = None', 'Face', 'Select exactly one face.', 'Topology', 0],
  ['edge', 'selector: str | Selector | None = None', 'Edge', 'Select exactly one edge.', 'Topology', 0],
  ['translate', 'vector: VectorLike', 'Shape', 'Copy of the shape moved by vector.', 'Transform', 2],
  ['rotate', 'startVector: VectorLike, endVector: VectorLike, angleDegrees: float', 'Shape', 'Copy of the shape rotated about an axis.', 'Transform', 2],
  ['mirror', `mirrorPlane: ${PLANES} | VectorLike = "XY", basePointVector: VectorLike = (0, 0, 0)`, 'Shape', 'Mirrored copy of the shape.', 'Transform'],
  ['scale', 'factor: float', 'Shape', 'Uniformly scaled copy of the shape.', 'Transform'],
  ['located', 'loc: Location', 'Shape', 'Copy placed at an absolute location.', 'Transform'],
  ['moved', 'loc: Location', 'Shape', 'Copy moved by a relative location.', 'Transform'],
  ['location', '', 'Location', 'Current location of the shape.', 'Transform', 0],
  ['fuse', '*toFuse: Shape, glue: bool = False, tol: float | None = None', 'Shape', 'Boolean union with other shapes.', 'Boolean', 2],
  ['cut', '*toCut: Shape, tol: float | None = None', 'Shape', 'Boolean subtraction of other shapes.', 'Boolean', 2],
  ['intersect', '*toIntersect: Shape, tol: float | None = None', 'Shape', 'Boolean intersection with other shapes.', 'Boolean'],
  ['split', '*splitters: Shape', 'Shape', 'Split the shape with other shapes.', 'Boolean', 0],
  ['fillet', 'radius: float, edgeList: Iterable[Edge]', 'Shape', 'Fillet the given edges of a solid.', 'Feature'],
  ['chamfer', 'length: float, length2: float | None, edgeList: Iterable[Edge]', 'Shape', 'Chamfer the given edges of a solid.', 'Feature', 0],
  ['isInside', 'point: VectorLike, tolerance: float = 1e-06', 'bool', 'True if the point lies inside the solid.', 'Measure', 0],
  ['copy', 'mesh: bool = False', 'Shape', 'Deep copy of the shape.', 'Shape', 0],
  ['clean', '', 'Shape', 'Remove redundant edges and faces.', 'Shape', 0],
  ['fix', '', 'Shape', 'Try to repair an invalid shape.', 'Shape', 0],
  ['exportStep', `fileName: str, unit: ${UNIT} = "MM"`, 'int', 'Write the shape to a STEP file.', 'Export', -1],
  ['exportStl', 'fileName: str, tolerance: float = 0.001, angularTolerance: float = 0.1, ascii: bool = False', 'bool', 'Write the shape to an STL file.', 'Export', -1],
]);

const SHAPE_STATIC = table('Shape', 'function', [
  ['importBrep', 'f: str', 'Shape', 'Read a shape from a BREP file.', 'Import', 0],
  ['CombinedCenter', 'objects: Iterable[Shape]', 'Vector', 'Centre of mass of several shapes.', 'Measure', 0],
  ['centerOfMass', 'obj: Shape', 'Vector', 'Centre of mass of a shape.', 'Measure', 0],
  ['computeMass', 'obj: Shape', 'float', 'Mass (volume for solids) of a shape.', 'Measure', 0],
]);

const V3 = 'pnt: VectorLike = (0, 0, 0), dir: VectorLike = (0, 0, 1)';
const SOLID_STATIC = table('Solid', 'function', [
  ['makeBox', `length: float, width: float, height: float, ${V3}`, 'Solid', 'Box with a corner at pnt.', 'Primitive', 3],
  ['makeCylinder', `radius: float, height: float, ${V3}, angleDegrees: float = 360`, 'Solid', 'Cylinder with its base centred at pnt.', 'Primitive', 3],
  ['makeCone', `radius1: float, radius2: float, height: float, ${V3}, angleDegrees: float = 360`, 'Solid', 'Cone or frustum along dir.', 'Primitive', 2],
  ['makeSphere', `radius: float, ${V3}, angleDegrees1: float = 0, angleDegrees2: float = 90, angleDegrees3: float = 360`, 'Shape', 'Sphere (or segment) centred at pnt.', 'Primitive', 2],
  ['makeTorus', `radius1: float, radius2: float, ${V3}, angleDegrees1: float = 0, angleDegrees2: float = 360`, 'Solid', 'Torus centred at pnt.', 'Primitive', 2],
  ['makeWedge', `dx: float, dy: float, dz: float, xmin: float, zmin: float, xmax: float, zmax: float, ${V3}`, 'Solid', 'Wedge located at pnt.', 'Primitive'],
  ['makeLoft', 'listOfWire: list[Wire], ruled: bool = False', 'Solid', 'Loft through a list of wires.', 'Build'],
  ['extrudeLinear', 'outerWire: Wire, innerWires: list[Wire], vecNormal: VectorLike, taper: float = 0', 'Solid', 'Extrude a wire (with holes) along vecNormal.', 'Build'],
  ['revolve', 'outerWire: Wire, innerWires: list[Wire], angleDegrees: float, axisStart: VectorLike, axisEnd: VectorLike', 'Solid', 'Revolve a wire (with holes) about an axis.', 'Build'],
  ['sweep', 'outerWire: Wire, innerWires: list[Wire], path: Wire | Edge, makeSolid: bool = True, isFrenet: bool = False, mode: Vector | Wire | Edge | None = None, transitionMode: "transformed" | "round" | "right" = "transformed"', 'Shape', 'Sweep a wire (with holes) along a path.', 'Build', 0],
  ['makeSolid', 'shell: Shell', 'Solid', 'Make a solid from a closed shell.', 'Build', 0],
]);

const EDGE_STATIC = table('Edge', 'function', [
  ['makeLine', 'v1: VectorLike, v2: VectorLike', 'Edge', 'Straight edge between two points.', 'Edge', 3],
  ['makeCircle', 'radius: float, pnt: VectorLike = (0, 0, 0), dir: VectorLike = (0, 0, 1), angle1: float = 360.0, angle2: float = 360, orientation: bool = True', 'Edge', 'Circle or arc edge.', 'Edge', 2],
  ['makeEllipse', 'x_radius: float, y_radius: float, pnt: VectorLike = (0, 0, 0), dir: VectorLike = (0, 0, 1), xdir: VectorLike = (1, 0, 0), angle1: float = 360.0, angle2: float = 360.0, sense: -1 | 1 = 1', 'Edge', 'Ellipse or elliptical arc edge.', 'Edge'],
  ['makeSpline', 'listOfVector: list[Vector], tangents: Sequence[Vector] | None = None, periodic: bool = False, parameters: Sequence[float] | None = None, scale: bool = True, tol: float = 1e-06', 'Edge', 'Spline interpolating the points.', 'Edge'],
  ['makeSplineApprox', 'listOfVector: list[Vector], tol: float = 0.001, smoothing: tuple[float, float, float] | None = None, minDeg: int = 1, maxDeg: int = 6', 'Edge', 'Spline approximating the points.', 'Edge', 0],
  ['makeThreePointArc', 'v1: VectorLike, v2: VectorLike, v3: VectorLike', 'Edge', 'Arc through three points.', 'Edge', 2],
  ['makeTangentArc', 'v1: VectorLike, v2: VectorLike, v3: VectorLike', 'Edge', 'Arc from v1, tangent to v2, ending at v3.', 'Edge'],
  ['makeBezier', 'points: list[Vector]', 'Edge', 'Bézier curve through the control points.', 'Edge', 0],
]);

const WIRE_STATIC = table('Wire', 'function', [
  ['makePolygon', 'listOfVertices: Iterable[VectorLike], forConstruction: bool = False, close: bool = False', 'Wire', 'Polyline wire through the points.', 'Wire', 3],
  ['makeCircle', 'radius: float, center: VectorLike, normal: VectorLike', 'Wire', 'Circular wire.', 'Wire', 2],
  ['makeEllipse', 'x_radius: float, y_radius: float, center: VectorLike, normal: VectorLike, xDir: VectorLike, angle1: float = 360.0, angle2: float = 360.0, rotation_angle: float = 0.0, closed: bool = True', 'Wire', 'Elliptical wire.', 'Wire'],
  ['makeHelix', 'pitch: float, height: float, radius: float, center: VectorLike = (0, 0, 0), dir: VectorLike = (0, 0, 1), angle: float = 360.0, lefthand: bool = False', 'Wire', 'Helix, e.g. a sweep path for threads and springs.', 'Wire', 2],
  ['assembleEdges', 'listOfEdges: Iterable[Edge]', 'Wire', 'Join edges into a wire.', 'Wire', 2],
  ['combine', 'listOfWires: Iterable[Wire | Edge], tol: float = 1e-09', 'list[Wire]', 'Merge wires and edges into as few wires as possible.', 'Wire', 0],
]);

const FACE_STATIC = table('Face', 'function', [
  ['makePlane', 'length: float | None = None, width: float | None = None, basePnt: VectorLike = (0, 0, 0), dir: VectorLike = (0, 0, 1)', 'Face', 'Planar rectangular face (infinite when sizes are None).', 'Face', 2],
  ['makeFromWires', 'outerWire: Wire, innerWires: list[Wire] = []', 'Face', 'Planar face bounded by wires.', 'Face', 2],
  ['makeRuledSurface', 'edgeOrWire1: Edge | Wire, edgeOrWire2: Edge | Wire', 'Face', 'Ruled surface between two edges or wires.', 'Face'],
  ['makeSplineApprox', 'points: list[list[Vector]], tol: float = 0.01, smoothing: tuple[float, float, float] | None = None, minDeg: int = 1, maxDeg: int = 3', 'Face', 'Spline surface approximating a grid of points.', 'Face', 0],
  ['makeNSidedSurface', 'edges: Iterable[Edge | Wire], constraints: Iterable[Edge | Wire | VectorLike]', 'Face', 'Surface filling a closed boundary, through constraint points.', 'Face', 0],
]);

const COMPOUND_STATIC = table('Compound', 'function', [
  ['makeCompound', 'listOfShapes: Iterable[Shape]', 'Compound', 'Group shapes into a compound without fusing them.', 'Compound', 3],
  ['makeText', 'text: str, size: float, height: float, font: str = "Arial", fontPath: str | None = None, kind: "regular" | "bold" | "italic" = "regular", halign: "center" | "left" | "right" = "center", valign: "center" | "top" | "bottom" = "center", position: Plane = Plane.XY()', 'Compound', '3D text as a compound of solids.', 'Compound'],
]);

const VECTOR = table('Vector', 'method', [
  ['x', null, 'float', 'X component.', 'Component', 2],
  ['y', null, 'float', 'Y component.', 'Component', 2],
  ['z', null, 'float', 'Z component.', 'Component', 2],
  ['Length', null, 'float', 'Euclidean length.', 'Component', 2],
  ['add', 'v: Vector', 'Vector', 'Vector sum (also available as +).', 'Math'],
  ['sub', 'v: Vector', 'Vector', 'Vector difference (also available as -).', 'Math'],
  ['multiply', 'scale: float', 'Vector', 'Scaled copy (also available as *).', 'Math'],
  ['normalized', '', 'Vector', 'Unit vector in the same direction.', 'Math'],
  ['cross', 'v: Vector', 'Vector', 'Cross product.', 'Math'],
  ['dot', 'v: Vector', 'float', 'Dot product.', 'Math'],
  ['getAngle', 'v: Vector', 'float', 'Angle to v, in radians.', 'Math', 0],
  ['projectToPlane', 'plane: Plane', 'Vector', 'Projection onto a plane.', 'Math', 0],
  ['projectToLine', 'line: Vector', 'Vector', 'Projection onto a line direction.', 'Math', 0],
  ['toTuple', '', 'tuple[float, float, float]', 'Components as a tuple.', 'Convert'],
]);

const LOCATION = table('Location', 'method', [
  ['toTuple', '', 'tuple[tuple[float, float, float], tuple[float, float, float]]', 'Translation and rotation angles (degrees) as tuples.', 'Convert'],
  ['inverse', null, 'Location', 'The inverse placement.', 'Property'],
  ['plane', null, 'Plane', 'The plane with this location’s origin and orientation.', 'Property', 0],
]);

const PLANE = table('Plane', 'method', [
  ['origin', null, 'Vector', 'Origin of the plane in global coordinates.', 'Property', 2],
  ['xDir', null, 'Vector', 'Local X direction.', 'Property'],
  ['yDir', null, 'Vector', 'Local Y direction.', 'Property'],
  ['zDir', null, 'Vector', 'Normal (local Z) direction.', 'Property'],
  ['location', null, 'Location', 'Location corresponding to the plane.', 'Property', 0],
  ['rotated', 'rotate: VectorLike = (0, 0, 0)', 'Plane', 'Copy rotated about the local axes (degrees).', 'Plane'],
  ['toWorldCoords', 'tuplePoint: VectorLike', 'Vector', 'Convert local coordinates to global.', 'Plane'],
  ['toLocalCoords', 'obj: Vector | Shape', 'Vector', 'Convert global coordinates to local.', 'Plane'],
  ['setOrigin2d', 'x: float, y: float', 'None', 'Move the origin within the plane.', 'Plane', 0],
]);

const NAMED_PLANE = 'origin: VectorLike = (0, 0, 0), xDir: VectorLike | None = None';
const PLANE_STATIC = table('Plane', 'function', [
  ['named', 'stdName: str, origin: VectorLike = (0, 0, 0)', 'Plane', 'Standard plane by name, e.g. Plane.named("XZ").', 'Plane', 2],
  ...(['XY', 'YZ', 'ZX', 'XZ', 'YX', 'ZY', 'front', 'back', 'left', 'right', 'top', 'bottom'] as const).map(
    (name): Row => [name, NAMED_PLANE, 'Plane', `The standard "${name}" plane.`, 'Plane', name.length === 2 ? 1 : 0],
  ),
]);

const COLOR = table('Color', 'method', [
  ['toTuple', '', 'tuple[float, float, float, float]', 'RGBA components from 0 to 1.', 'Convert'],
]);

const BOUNDBOX = table('BoundBox', 'method', [
  ...(['x', 'y', 'z'] as const).flatMap((a): Row[] => [
    [`${a}min`, null, 'float', `Minimum ${a.toUpperCase()}.`, 'Extent'],
    [`${a}max`, null, 'float', `Maximum ${a.toUpperCase()}.`, 'Extent'],
    [`${a}len`, null, 'float', `Size along ${a.toUpperCase()}.`, 'Extent', 2],
  ]),
  ['center', null, 'Vector', 'Centre of the box.', 'Extent', 2],
  ['DiagonalLength', null, 'float', 'Length of the box diagonal.', 'Extent'],
  ['add', 'obj: VectorLike | BoundBox, tol: float | None = None', 'BoundBox', 'Box expanded to include obj.', 'BoundBox', 0],
  ['enlarge', 'tol: float', 'BoundBox', 'Box grown in every direction by tol.', 'BoundBox', 0],
  ['isInside', 'b2: BoundBox', 'bool', 'True if b2 lies inside this box.', 'BoundBox', 0],
]);

function cls(name: string, sig: Sig, returns: string, doc: string, rank = 1): MemberDoc {
  return {
    name,
    kind: 'class',
    owner: 'cq',
    signatures: sig === null ? [] : (typeof sig === 'string' ? [sig] : sig).map(parseParams),
    returns,
    doc,
    group: 'Class',
    rank,
  };
}

function mod(name: string, owner: string, doc: string, rank = 1): MemberDoc {
  return { name, kind: 'module', owner, signatures: [], returns: `module:${name}`, doc, group: 'Module', rank };
}

const SELECTOR_CLASSES: readonly MemberDoc[] = [
  cls('StringSyntaxSelector', 'selectorString: str', 'Selector', 'Selector from a string such as ">Z" or "|X and >Y".', 0),
  cls('NearestToPointSelector', 'pnt: VectorLike', 'Selector', 'Select the object nearest to a point.', 0),
  cls('DirectionMinMaxSelector', 'vector: Vector, directionMax: bool = True, tolerance: float = 0.0001', 'Selector', 'Select objects farthest along (or against) a direction.', 0),
  cls('ParallelDirSelector', 'vector: Vector, tolerance: float = 0.0001', 'Selector', 'Select objects parallel to a direction.', 0),
  cls('PerpendicularDirSelector', 'vector: Vector, tolerance: float = 0.0001', 'Selector', 'Select objects perpendicular to a direction.', 0),
  cls('DirectionSelector', 'vector: Vector, tolerance: float = 0.0001', 'Selector', 'Select objects aligned with a direction.', 0),
  cls('TypeSelector', 'typeString: str', 'Selector', 'Select objects by geometry type, e.g. "PLANE".', 0),
];

const CQ: readonly MemberDoc[] = [
  cls('Workplane', 'inPlane: str | Plane = "XY", origin: VectorLike = (0, 0, 0), obj: Shape | None = None', 'Workplane', 'The core CadQuery object: a stack of geometry and a 2D workplane to sketch on.', 3),
  cls('Assembly', 'obj: Shape | Workplane | None = None, loc: Location | None = None, name: str | None = None, color: Color | None = None, material: Material | None = None, metadata: dict | None = None', 'Assembly', 'A tree of named, placed and colored parts; add parts with .add().', 3),
  cls('Location', [
    '',
    't: VectorLike',
    'x: float = 0, y: float = 0, z: float = 0, rx: float = 0, ry: float = 0, rz: float = 0',
    't: VectorLike, angles: tuple[float, float, float]',
    't: VectorLike, ax: VectorLike, angle: float',
    't: Plane',
    't: Plane, v: VectorLike',
  ], 'Location', 'A placement: translation plus rotation (degrees). Compose with *, e.g. a * b.', 3),
  cls('Vector', ['x: float, y: float, z: float', 'x: float, y: float', 'v: VectorLike', ''], 'Vector', 'A 3D point or direction.', 3),
  cls('Color', ['name: str', 'r: float, g: float, b: float, a: float = 1', ''], 'Color', 'RGBA color from 0–1 components, or a named color such as "steelblue".', 3),
  cls('Sketch', 'parent: Any = None, locs: Iterable[Location] = (Location(),), obj: Compound | None = None', 'Sketch', 'Face-based 2D sketch: combine shapes with modes, then place it on a workplane.', 2),
  cls('Plane', 'origin: VectorLike, xDir: VectorLike | None = None, normal: VectorLike = (0, 0, 1)', 'Plane', 'A 2D coordinate system in 3D space. See also Plane.named("XZ").', 2),
  cls('Solid', null, 'Solid', 'A solid body. Build one with cq.Solid.makeBox(…), makeCylinder(…) and friends.', 2),
  cls('Face', null, 'Face', 'A bounded surface. Build one with cq.Face.makeFromWires(…) or makePlane(…).', 1),
  cls('Edge', null, 'Edge', 'A curve segment. Build one with cq.Edge.makeLine(…), makeCircle(…) and friends.', 1),
  cls('Wire', null, 'Wire', 'Connected edges. Build one with cq.Wire.makePolygon(…) or makeHelix(…).', 1),
  cls('Compound', null, 'Compound', 'A group of shapes. Build one with cq.Compound.makeCompound([...]).', 1),
  cls('Shape', null, 'Shape', 'Base class of every topological shape.', 0),
  cls('Shell', null, 'Shell', 'A set of connected faces.', 0),
  cls('Vertex', null, 'Vertex', 'A single point.', 0),
  cls('BoundBox', null, 'BoundBox', 'Axis-aligned bounding box; get one with shape.BoundingBox().', 0),
  cls('Matrix', null, 'Matrix', 'A 4×4 transformation matrix.', -1),
  cls('Material', 'name: str | None = None, description: str | None = None, density: float | None = None, densityUnit: str = "kg/m³"', 'Material', 'Material metadata for assembly parts.', -1),
  mod('exporters', 'cq', 'Export shapes: cq.exporters.export(shape, "part.step").'),
  mod('importers', 'cq', 'Import STEP, DXF and BREP files.'),
  mod('selectors', 'cq', 'Selector classes for filtering faces, edges and vertices.', 0),
  ...SELECTOR_CLASSES,
];

const EXPORTERS = table('exporters', 'function', [
  ['export', `w: Shape | Workplane | Iterable[Shape], fname: str, exportType: "STL" | "STEP" | "AMF" | "SVG" | "TJS" | "DXF" | "VRML" | "VTP" | "3MF" | "BREP" | "BIN" | None = None, tolerance: float = 0.1, angularTolerance: float = 0.1, unit: ${UNIT} = "MM", outputUnit: str | None = None, opt: dict | None = None`, 'None', 'Export a shape; the format is inferred from the file extension.', 'Export', 2],
]);

const IMPORTERS = table('importers', 'function', [
  ['importStep', `fileName: str, unit: ${UNIT} = "MM"`, 'Workplane', 'Import a STEP file as a Workplane.', 'Import', 2],
  ['importDXF', 'filename: str, tol: float = 1e-06, exclude: list[str] = [], include: list[str] = []', 'Workplane', 'Import a DXF file as faces on a Workplane.', 'Import', 2],
  ['importBrep', 'fileName: str', 'Workplane', 'Import a BREP file as a Workplane.', 'Import'],
]);

const NTH = 'directionMax: bool = True, tolerance: float = 0.0001';
const SELECTORS: readonly MemberDoc[] = [
  ...SELECTOR_CLASSES.map((c) => ({ ...c, owner: 'selectors' })),
  cls('BoxSelector', 'point0: VectorLike, point1: VectorLike, boundingbox: bool = False', 'Selector', 'Select objects inside the box between two corners.', 1),
  cls('DirectionNthSelector', `vector: Vector, n: int, ${NTH}`, 'Selector', 'Select the n-th objects along a direction.', 1),
  cls('CenterNthSelector', `vector: Vector, n: int, ${NTH}`, 'Selector', 'Select the n-th objects by centre along a direction.', 0),
  cls('RadiusNthSelector', `n: int, ${NTH}`, 'Selector', 'Select the object with the n-th radius.', 0),
  cls('AreaNthSelector', `n: int, ${NTH}`, 'Selector', 'Select the object with the n-th area.', 0),
  cls('LengthNthSelector', `n: int, ${NTH}`, 'Selector', 'Select the object with the n-th length.', 0),
].map((c) => ({ ...c, owner: 'selectors' }));

const MATH = [
  ...table('math', 'function', [
    ['sqrt', 'x: float', 'float', 'Square root of x.', 'Math', 2],
    ['sin', 'x: float', 'float', 'Sine of x (radians).', 'Trig', 2],
    ['cos', 'x: float', 'float', 'Cosine of x (radians).', 'Trig', 2],
    ['tan', 'x: float', 'float', 'Tangent of x (radians).', 'Trig', 2],
    ['asin', 'x: float', 'float', 'Arc sine, in radians.', 'Trig'],
    ['acos', 'x: float', 'float', 'Arc cosine, in radians.', 'Trig'],
    ['atan', 'x: float', 'float', 'Arc tangent, in radians.', 'Trig'],
    ['atan2', 'y: float, x: float', 'float', 'Angle of the point (x, y), in radians.', 'Trig', 2],
    ['radians', 'x: float', 'float', 'Convert degrees to radians.', 'Trig', 2],
    ['degrees', 'x: float', 'float', 'Convert radians to degrees.', 'Trig', 2],
    ['hypot', '*coordinates: float', 'float', 'Euclidean norm, sqrt(sum of squares).', 'Math'],
    ['dist', 'p: Iterable[float], q: Iterable[float]', 'float', 'Euclidean distance between two points.', 'Math'],
    ['floor', 'x: float', 'int', 'Largest integer ≤ x.', 'Math'],
    ['ceil', 'x: float', 'int', 'Smallest integer ≥ x.', 'Math'],
    ['trunc', 'x: float', 'int', 'x with the fractional part removed.', 'Math', 0],
    ['fabs', 'x: float', 'float', 'Absolute value as a float.', 'Math', 0],
    ['copysign', 'x: float, y: float', 'float', 'x with the sign of y.', 'Math', 0],
    ['fmod', 'x: float, y: float', 'float', 'Floating-point remainder of x / y.', 'Math', 0],
    ['pow', 'x: float, y: float', 'float', 'x raised to the power y.', 'Math', 0],
    ['exp', 'x: float', 'float', 'e raised to the power x.', 'Math', 0],
    ['log', 'x: float, base: float = e', 'float', 'Logarithm of x (natural by default).', 'Math', 0],
    ['log10', 'x: float', 'float', 'Base-10 logarithm.', 'Math', 0],
    ['cbrt', 'x: float', 'float', 'Cube root of x.', 'Math', 0],
    ['isclose', 'a: float, b: float, *, rel_tol: float = 1e-09, abs_tol: float = 0.0', 'bool', 'True if a and b are approximately equal.', 'Math'],
    ['gcd', '*integers: int', 'int', 'Greatest common divisor.', 'Math', 0],
    ['prod', 'iterable: Iterable[float], *, start: float = 1', 'float', 'Product of the values.', 'Math', 0],
    ['comb', 'n: int, k: int', 'int', 'Number of ways to choose k of n items.', 'Math', -1],
    ['factorial', 'n: int', 'int', 'n factorial.', 'Math', -1],
  ]),
  ...(['pi', 'tau', 'e', 'inf'] as const).map((name): MemberDoc => ({
    name,
    kind: 'constant',
    owner: 'math',
    signatures: [],
    returns: 'float',
    doc: { pi: 'π = 3.14159…', tau: 'τ = 2π = 6.28318…', e: 'e = 2.71828…', inf: 'Positive infinity.' }[name],
    group: 'Constant',
    rank: name === 'pi' ? 3 : 1,
  })),
];

const PART: readonly MemberDoc[] = [{
  name: 'result',
  kind: 'property',
  owner: 'part',
  signatures: [],
  returns: 'Workplane',
  doc: 'The saved part’s final geometry, i.e. the value its code assigns to result.',
  group: 'Part',
  rank: 3,
}];

const TABLES: Record<string, readonly MemberDoc[]> = {
  Workplane: WORKPLANE,
  Assembly: ASSEMBLY,
  Sketch: SKETCH,
  Shape: SHAPE,
  Vector: VECTOR,
  Location: LOCATION,
  Plane: PLANE,
  Color: COLOR,
  BoundBox: BOUNDBOX,
  part: PART,
  'module:cq': CQ,
  'module:math': MATH,
  'module:exporters': EXPORTERS,
  'module:importers': IMPORTERS,
  'module:selectors': SELECTORS,
  'class:Assembly': ASSEMBLY_STATIC,
  'class:Plane': PLANE_STATIC,
  'class:Shape': SHAPE_STATIC,
  'class:Solid': [...SOLID_STATIC, ...SHAPE_STATIC],
  'class:Edge': [...EDGE_STATIC, ...SHAPE_STATIC],
  'class:Wire': [...WIRE_STATIC, ...SHAPE_STATIC],
  'class:Face': [...FACE_STATIC, ...SHAPE_STATIC],
  'class:Compound': [...COMPOUND_STATIC, ...SHAPE_STATIC],
};

const INDEX = new Map<string, Map<string, MemberDoc>>(
  Object.entries(TABLES).map(([key, members]) => [key, new Map(members.map((m) => [m.name, m]))]),
);

const SHAPE_TYPES = new Set(['Shape', 'Solid', 'Face', 'Edge', 'Wire', 'Shell', 'Vertex', 'Compound', 'CompSolid']);

/**
 * Normalize a documented type (e.g. `list[Face]`, `Solid`, `module:cq`) to a
 * key in the member tables, or null when it has no completable members.
 */
export function typeKey(type: string | undefined): string | null {
  if (!type) return null;
  if (/^(module|class|list|literal):/.test(type)) return type;
  const list = /^list\[(\w+)\]$/.exec(type);
  if (list) {
    const inner = typeKey(list[1]);
    return inner ? `list:${inner}` : null;
  }
  if (SHAPE_TYPES.has(type)) return 'Shape';
  return type in TABLES ? type : null;
}

export function membersOf(type: string | null): readonly MemberDoc[] {
  return type ? TABLES[type] ?? [] : [];
}

export function memberOf(type: string | null, name: string): MemberDoc | undefined {
  return type ? INDEX.get(type)?.get(name) : undefined;
}

/** Best guess for a method called on an expression of unknown type. */
export function guessMember(name: string): { member: MemberDoc; owner: string } | undefined {
  for (const owner of ['Workplane', 'Assembly', 'Sketch']) {
    const member = INDEX.get(owner)?.get(name);
    if (member && member.kind === 'method') return { member, owner };
  }
  return undefined;
}

/** Instance type produced by calling a class member (e.g. `Solid` → `Shape`). */
export function instanceKey(className: string): string | null {
  return typeKey(INDEX.get('module:cq')?.get(className)?.returns ?? className);
}

export function cadqueryClass(name: string): MemberDoc | undefined {
  const member = INDEX.get('module:cq')?.get(name);
  return member?.kind === 'class' ? member : undefined;
}

// ---------------------------------------------------------------------------
// Selector strings

export type SelectorEntity = 'faces' | 'edges' | 'vertices' | 'solids' | 'wires' | 'shells';

export interface SelectorDoc {
  readonly value: string;
  readonly doc: string;
}

const ENTITY_NAME: Record<SelectorEntity, string> = {
  faces: 'Faces', edges: 'Edges', vertices: 'Vertices', solids: 'Solids', wires: 'Wires', shells: 'Shells',
};

const FACE_TYPES = ['PLANE', 'CYLINDER', 'CONE', 'SPHERE', 'TORUS', 'BSPLINE', 'REVOLUTION', 'EXTRUSION', 'OFFSET'];
const EDGE_TYPES = ['LINE', 'CIRCLE', 'ELLIPSE', 'BSPLINE', 'BEZIER', 'HYPERBOLA', 'PARABOLA'];
const NAMED_VIEWS: readonly (readonly [string, string])[] = [
  ['front', '+Z'], ['back', '−Z'], ['top', '+Y'], ['bottom', '−Y'], ['right', '+X'], ['left', '−X'],
];

export function selectorDocs(entity: SelectorEntity): SelectorDoc[] {
  const e = ENTITY_NAME[entity];
  const out: SelectorDoc[] = [];
  const axes = ['Z', 'X', 'Y'];
  for (const a of axes) {
    out.push({ value: `>${a}`, doc: `${e} farthest in +${a}` });
    out.push({ value: `<${a}`, doc: `${e} farthest in −${a}` });
  }
  const oriented = entity === 'faces'
    ? { par: (a: string) => `Faces perpendicular to ${a} (normal ∥ ${a})`, perp: (a: string) => `Faces parallel to ${a} (normal ⟂ ${a})` }
    : { par: (a: string) => `${e} parallel to ${a}`, perp: (a: string) => `${e} perpendicular to ${a}` };
  if (entity === 'faces' || entity === 'edges') {
    for (const a of axes) {
      out.push({ value: `|${a}`, doc: oriented.par(a) });
      out.push({ value: `#${a}`, doc: oriented.perp(a) });
    }
  }
  if (entity === 'faces' || entity === 'edges') {
    for (const a of axes) {
      out.push({ value: `+${a}`, doc: `${e} ${entity === 'faces' ? 'facing' : 'pointing'} +${a}` });
      out.push({ value: `-${a}`, doc: `${e} ${entity === 'faces' ? 'facing' : 'pointing'} −${a}` });
    }
  }
  const types = entity === 'faces' ? FACE_TYPES : entity === 'edges' ? EDGE_TYPES : [];
  for (const t of types) out.push({ value: `%${t}`, doc: `${e} of type ${t.toLowerCase()}` });
  out.push({ value: '>Z[-2]', doc: `Second-farthest ${e.toLowerCase()} in +Z` });
  out.push({ value: '<Z[1]', doc: `Second-farthest ${e.toLowerCase()} in −Z` });
  out.push({ value: '>>Z[1]', doc: `${e} with the second-highest centre in Z` });
  if (entity === 'faces') for (const [name, dir] of NAMED_VIEWS) out.push({ value: name, doc: `Faces facing ${dir} (${name} view)` });
  out.push({ value: '>(1, 0, 1)', doc: `${e} farthest along a custom direction` });
  return out;
}

export const SELECTOR_OPERATORS: readonly SelectorDoc[] = [
  { value: 'and', doc: 'Both selectors match' },
  { value: 'or', doc: 'Either selector matches' },
  { value: 'exc', doc: 'Exclude the next selector' },
  { value: 'not', doc: 'Invert the next selector' },
];

export function selectorDoc(value: string, entity: SelectorEntity): string | undefined {
  const v = value.trim();
  return selectorDocs(entity).find((s) => s.value === v)?.doc
    ?? SELECTOR_OPERATORS.find((s) => s.value === v)?.doc;
}

export const PLANE_NAMES: readonly SelectorDoc[] = [
  { value: 'XY', doc: 'Normal +Z, x along +X' },
  { value: 'YZ', doc: 'Normal +X, x along +Y' },
  { value: 'ZX', doc: 'Normal +Y, x along +Z' },
  { value: 'XZ', doc: 'Normal −Y, x along +X' },
  { value: 'YX', doc: 'Normal −Z, x along +Y' },
  { value: 'ZY', doc: 'Normal −X, x along +Z' },
  { value: 'front', doc: 'Same as XY' },
  { value: 'back', doc: 'Normal −Z, x along −X' },
  { value: 'left', doc: 'Normal −X, x along +Z' },
  { value: 'right', doc: 'Normal +X, x along −Z' },
  { value: 'top', doc: 'Normal +Y, x along +X' },
  { value: 'bottom', doc: 'Normal −Y, x along +X' },
];

export const COLOR_NAMES: readonly string[] = [
  'steelblue', 'lightblue', 'skyblue', 'turquoise', 'teal', 'darkgreen', 'green', 'gold', 'goldenrod', 'orange',
  'coral', 'tomato', 'salmon', 'red', 'maroon', 'pink', 'violet', 'magenta', 'purple', 'brown', 'lightgray',
  'gray', 'black', 'white', 'yellow', 'cyan', 'blue',
];

export const CONSTRAINT_KINDS: readonly SelectorDoc[] = [
  { value: 'Plane', doc: 'Faces coplanar, normals opposed' },
  { value: 'Point', doc: 'Centres coincide (param: distance)' },
  { value: 'Axis', doc: 'Normals/axes opposed (param: angle)' },
  { value: 'PointInPlane', doc: 'Point lies in plane (param: offset)' },
  { value: 'PointOnLine', doc: 'Point lies on a line' },
  { value: 'Fixed', doc: 'Part is fixed in place' },
  { value: 'FixedPoint', doc: 'Point fixed at a location (param)' },
  { value: 'FixedAxis', doc: 'Axis fixed to a direction (param)' },
  { value: 'FixedRotation', doc: 'Rotation fixed (param: angles)' },
];
