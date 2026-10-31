"""A circuit board placed in a CAD design (docs/ELECTRONICS.md, "Circuits in CAD designs").

`from links import led_board` gives a link to a circuit document; `design.add(led_board, at=(0, 0, 3))` places its board.
The board is an exact solid built from the circuit's data: its outline extruded by its thickness, with its holes and cutouts.
The parts are bodies sewn from the circuit's STEP, one per part, named like the circuit's parts (R1, U1, J1…).

Frame: the circuit's own millimetres (x, y as in Electronics), with the board's bottom face at z = 0 and its top at its
thickness. Top-side parts stand on z = thickness; through-hole pins and bottom-side parts reach below z = 0.
"""
from __future__ import annotations

import math

import cadquery as cq

BOARD_COLOR = cq.Color(0.13, 0.42, 0.24)
PART_COLOR = cq.Color(0.18, 0.18, 0.2)
_BUILT: dict[str, cq.Assembly] = {}  # STEP sha256 + board → assembly, once per process (full builds execute twice)


class CircuitBoardError(ValueError):
    pass


def board_solid(board: dict) -> cq.Workplane:
    """The board: its outline extruded from z = 0 by its thickness, minus its holes and cutouts."""
    thickness = float(board.get("thickness") or 1.6)
    outline = [(float(x), float(y)) for x, y in board["outline"]]
    deduped = [p for i, p in enumerate(outline) if i == 0 or math.dist(p, outline[i - 1]) > 1e-6]
    if len(deduped) > 3 and math.dist(deduped[0], deduped[-1]) < 1e-6:
        deduped.pop()
    if len(deduped) < 3:
        raise CircuitBoardError("The circuit's board outline has fewer than three points.")
    solid = cq.Workplane("XY").polyline(deduped).close().extrude(thickness)
    tools = []
    for hole in board.get("holes") or []:
        if hole.get("diameter"):
            tools.append(cq.Workplane("XY").center(hole["x"], hole["y"]).circle(hole["diameter"] / 2).extrude(thickness))
        elif hole.get("width") and hole.get("height"):
            w, h = hole["width"], hole["height"]
            angle = (hole.get("rotation") or 0) + (90 if h > w else 0)
            tools.append(cq.Workplane("XY").center(hole["x"], hole["y"]).slot2D(max(w, h), min(w, h), angle).extrude(thickness))
    for cutout in board.get("cutouts") or []:
        if cutout["shape"] == "rect":
            tools.append(cq.Workplane("XY").center(cutout["x"], cutout["y"]).transformed(rotate=(0, 0, cutout.get("rotation") or 0))
                         .rect(cutout["width"], cutout["height"]).extrude(thickness))
        elif cutout["shape"] == "circle":
            tools.append(cq.Workplane("XY").center(cutout["x"], cutout["y"]).circle(cutout["diameter"] / 2).extrude(thickness))
        elif cutout["shape"] == "polygon":
            tools.append(cq.Workplane("XY").polyline([tuple(p) for p in cutout["points"]]).close().extrude(thickness))
    if tools:
        cutter = tools[0]
        for tool in tools[1:]:
            cutter = cutter.union(tool)
        solid = solid.cut(cutter)
    if not solid.val().isValid():
        raise CircuitBoardError("The circuit's board outline doesn't make a valid solid (does it cross itself?).")
    return solid


def _srgb(color) -> tuple[float, float, float]:
    from OCP.Quantity import Quantity_TOC_sRGB
    r, g, b = color.Values(Quantity_TOC_sRGB)
    return (r, g, b)


def part_bodies(step_path: str, board: dict) -> dict[str, list[tuple[cq.Solid, tuple | None]]]:
    """The parts' bodies from the circuit's STEP, by part name, each with its colour there (sRGB, or None). tscircuit writes
    each part as faces without shared edges: they're sewn into closed solids, moved so the board's bottom face is at z = 0,
    and given to the nearest part."""
    from collections import Counter
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Quantity import Quantity_Color
    from OCP.ShapeFix import ShapeFix_Solid
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.collections import Sequence_TDF_Label
    from OCP.TDocStd import TDocStd_Document
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SHELL, TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS
    from OCP.XCAFDoc import XCAFDoc_ColorGen, XCAFDoc_ColorSurf, XCAFDoc_DocumentTool

    document = TDocStd_Document(TCollection_ExtendedString("circuit"))
    reader = STEPCAFControl_Reader()
    reader.SetColorMode(True)
    if reader.ReadFile(step_path) != IFSelect_RetDone or not reader.Transfer(document):
        raise CircuitBoardError("The circuit's STEP file can't be read.")
    shapes, colors = XCAFDoc_DocumentTool.ShapeTool_s(document.Main()), XCAFDoc_DocumentTool.ColorTool_s(document.Main())
    roots = Sequence_TDF_Label()
    shapes.GetFreeShapes(roots)
    if not roots.Length():
        return {}
    shape = shapes.GetShape_s(roots.Value(1))

    def each(of, kind):
        explorer = TopExp_Explorer(of, kind)
        while explorer.More():
            yield explorer.Current()
            explorer.Next()

    # The board itself is the STEP's one real solid; it's rebuilt exactly from the circuit's data instead.
    board_faces = {face.__hash__() for solid in each(shape, TopAbs_SOLID) for face in each(solid, TopAbs_FACE)}
    sewing = BRepBuilderAPI_Sewing(1e-3)
    face_color: dict[int, tuple] = {}
    found = Quantity_Color()
    originals = []
    for face in each(shape, TopAbs_FACE):
        if face.__hash__() in board_faces:
            continue
        if colors.GetColor(face, XCAFDoc_ColorSurf, found) or colors.GetColor(face, XCAFDoc_ColorGen, found):
            face_color[face.__hash__()] = _srgb(found)
        sewing.Add(face)
        originals.append(face)
    if not originals:
        return {}
    sewing.Perform()
    sewn_color = {}
    for face in originals:  # Colours follow their faces through sewing.
        if face.__hash__() in face_color:
            for sewn in each(sewing.Modified(face), TopAbs_FACE):
                sewn_color[sewn.__hash__()] = face_color[face.__hash__()]
    offset = float(board.get("thickness") or 1.6) / 2  # tscircuit's STEP centres the board on z = 0.
    parts = board.get("parts") or []
    bodies: dict[str, list[tuple[cq.Solid, tuple | None]]] = {}
    for shell in each(sewing.SewedShape(), TopAbs_SHELL):
        tally = Counter(sewn_color.get(face.__hash__()) for face in each(shell, TopAbs_FACE))
        color = next((c for c, _ in tally.most_common() if c is not None), None)
        try:
            made = BRepBuilderAPI_MakeSolid(TopoDS.Shell(shell)).Solid()
            fix = ShapeFix_Solid(made)
            fix.Perform()
            solid = cq.Solid(fix.Solid())
        except Exception:  # noqa: BLE001  A piece that doesn't close is left out (it would only be a decoration).
            continue
        if not BRepCheck_Analyzer(solid.wrapped).IsValid() or abs(solid.Volume()) < 1e-6:
            continue
        solid = solid.translate(cq.Vector(0, 0, offset))
        center = solid.BoundingBox().center
        bodies.setdefault(_owner(parts, center.x, center.y), []).append((solid, color))
    return bodies


# Appearance (docs/ELECTRONICS.md, "Circuits in CAD designs"): solder mask by its colour, metal for leads, near-black
# plastic for chips and connectors, the usual body colours for passives, LEDs in their own colour.
MASK = {"green": (0.08, 0.36, 0.17), "red": (0.62, 0.1, 0.1), "blue": (0.08, 0.2, 0.55), "black": (0.06, 0.06, 0.07),
        "white": (0.9, 0.9, 0.88), "yellow": (0.85, 0.72, 0.1), "purple": (0.33, 0.13, 0.45)}
METAL = (0.78, 0.78, 0.76)
PLASTIC = (0.09, 0.09, 0.1)
PASSIVE = {"simple_capacitor": (0.74, 0.6, 0.38), "simple_resistor": (0.16, 0.16, 0.17), "simple_inductor": (0.2, 0.2, 0.22),
           "simple_fuse": (0.16, 0.16, 0.17), "simple_diode": (0.12, 0.12, 0.13)}
LED = {"red": (0.95, 0.15, 0.12), "green": (0.2, 0.85, 0.3), "blue": (0.2, 0.4, 1.0), "yellow": (1.0, 0.85, 0.15),
       "orange": (1.0, 0.55, 0.1), "white": (0.95, 0.95, 0.92), "amber": (1.0, 0.7, 0.1), "pink": (1.0, 0.5, 0.7)}


def _hex(text: str | None) -> tuple | None:
    if isinstance(text, str) and len(text) == 7 and text.startswith("#"):
        try:
            return tuple(int(text[i:i + 2], 16) / 255 for i in (1, 3, 5))
        except ValueError:
            return None
    return None


def _body_color(part: dict | None, step_color: tuple | None) -> tuple:
    """A part's body colour from what it is: tscircuit's STEP colours are generic (passives plain grey), so only a clearly
    coloured body keeps its own."""
    ftype = (part or {}).get("ftype") or ""
    if ftype in ("simple_test_point", "simple_fiducial"):
        return METAL
    if ftype == "simple_led":
        return LED.get(((part or {}).get("color") or "").lower()) or _hex((part or {}).get("color")) or step_color or LED["red"]
    if ftype in PASSIVE:
        return PASSIVE[ftype]
    if step_color is not None and max(step_color) - min(step_color) > 0.25:  # A coloured body (a button cap…): keep it.
        return step_color
    return PLASTIC


def _owner(parts: list[dict], x: float, y: float) -> str:
    """The part whose footprint contains (x, y), else the nearest one."""
    best, distance = None, math.inf
    for part in parts:
        angle = math.radians(part.get("rotation") or 0)
        dx, dy = x - part["x"], y - part["y"]
        local_x, local_y = dx * math.cos(angle) + dy * math.sin(angle), -dx * math.sin(angle) + dy * math.cos(angle)
        if abs(local_x) <= part["width"] / 2 + 0.05 and abs(local_y) <= part["height"] / 2 + 0.05:
            return part["name"]
        d = math.hypot(dx, dy)
        if d < distance:
            best, distance = part["name"], d
    return best or "parts"


def board_color(board: dict) -> tuple:
    mask = board.get("solder_mask_color")
    return MASK.get(str(mask).lower()) or _hex(mask) or MASK["green"]


def assembly(source: dict, step_path: str | None) -> cq.Assembly:
    """The circuit as a sub-assembly: `board`, then a node per part: its body, with a `pins` node for metal leads."""
    key = f"{source.get('step')}:{source.get('build_id')}"
    if key in _BUILT:
        return _BUILT[key]
    board = source.get("board") or {}
    result = cq.Assembly(name=source.get("name") or "board")
    result.add(board_solid(board).val(), name="board", color=cq.Color(*board_color(board)))
    parts = {part["name"]: part for part in board.get("parts") or []}
    if step_path:
        for name, solids in sorted(part_bodies(step_path, board).items()):
            node = name if name != "board" else "board_part"
            # The largest piece is the part's body; pieces in another colour are its pins and leads (metal).
            main_color = max(solids, key=lambda item: abs(item[0].Volume()))[1]
            body = [solid for solid, color in solids if color == main_color]
            metal = [solid for solid, color in solids if color != main_color]
            color = cq.Color(*_body_color(parts.get(name), main_color))
            if not metal:
                result.add(_compound(body), name=node, color=color)
                continue
            part = cq.Assembly(name=node)
            part.add(_compound(body), name="body", color=color)
            part.add(_compound(metal), name="pins", color=cq.Color(*METAL))
            result.add(part, name=node)
    _BUILT[key] = result
    return result


def _compound(solids: list[cq.Solid]) -> cq.Shape:
    return solids[0] if len(solids) == 1 else cq.Compound.makeCompound(solids)


def appearance(result: cq.Assembly) -> dict:
    """{node path under the link: {"color": "#rrggbb", "metal": bool}}: for viewers that show a linked circuit in its own colours."""
    out = {}
    def walk(node, prefix):
        for child in node.children:
            path = f"{prefix}{child.name}"
            if child.obj is not None and child.color is not None:
                r, g, b, _ = child.color.toTuple()
                metal = child.name == "pins" or all(abs(a - b) < 1e-3 for a, b in zip((r, g, b), METAL))
                out[path] = {"color": "#%02x%02x%02x" % tuple(round(v * 255) for v in (r, g, b)), "metal": metal}
            walk(child, f"{path}/")
    walk(result, "")
    return out
