"""Drawing sheets as one PDF: drawings.pdf, every sheet a page at its paper size, drawn from the same paper-space
primitives as the SVG (drawing.Sheet: mm, y up from the bottom-left corner), in the same order, so the PDF is the sheet
the Drawing tab shows: shaded faces, lines by kind (weights and dash patterns), circles, arrowheads, text, logos.

Text is embedded, never left to the viewer: Liberation Sans (Arial's and Helvetica's character widths, so text sits
where it does in the app, which draws "Helvetica, Arial"), each character it lacks (⌀, for one) from DejaVu Sans, bold
from their bold faces. Fonts are subset to the characters used (fontTools) and carry a ToUnicode map, so text copies
and searches. Logos: JPEG as is, PNG as pixels with their alpha as a soft mask (Pillow).

What it never writes: scripts, actions, links, forms, attachments, encryption, object streams (the build's checks,
app/worker.py, refuse a PDF that has any). Standard library plus fontTools and Pillow, both in the runtime image.
"""
from __future__ import annotations

import io
import math
import os
import zlib

MM = 72 / 25.4  # PDF points per millimetre
KAPPA = 0.5522847498  # a quarter circle as one cubic Bézier
# Liberation Sans from a folder of its own (runtime/Dockerfile: never the system font folders, where OCCT would take it
# for Arial in Workplane.text); DejaVu Sans from the system fills in characters Liberation lacks.
FONT_DIRS = ("/opt/steve/pdf-fonts", "/usr/share/fonts/truetype/liberation2", "/usr/share/fonts/truetype/liberation",
             "/usr/share/fonts/truetype/dejavu")
FACES = {  # (bold): the fonts tried for each character, in order
    False: ("LiberationSans-Regular.ttf", "DejaVuSans.ttf"),
    True: ("LiberationSans-Bold.ttf", "DejaVuSans-Bold.ttf"),
}


def _find(name: str) -> str | None:
    for folder in (os.environ.get("STEVE_PDF_FONTS", ""), *FONT_DIRS):
        path = os.path.join(folder, name) if folder else ""
        if path and os.path.exists(path):
            return path
    return None


class _Font:
    """One TrueType face: its character map, advances, and (once every page is drawn) its subset for embedding."""

    def __init__(self, path: str):
        from fontTools.ttLib import TTFont
        self.path = path
        self.tt = TTFont(path, lazy=True)
        self.cmap = self.tt.getBestCmap() or {}
        self.order = self.tt.getGlyphOrder()
        self.gid = {name: index for index, name in enumerate(self.order)}
        self.metrics = self.tt["hmtx"].metrics
        self.em = self.tt["head"].unitsPerEm
        self.used: dict[int, str] = {}  # glyph id → the text it stands for (ToUnicode)

    def glyph(self, char: str) -> int | None:
        name = self.cmap.get(ord(char))
        return None if name is None else self.gid[name]

    def advance(self, gid: int) -> float:
        """In 1/1000 em (PDF glyph space)."""
        return self.metrics[self.order[gid]][0] * 1000 / self.em


class _Fonts:
    def __init__(self):
        self.faces: dict[bool, list[_Font]] = {}
        for bold, names in FACES.items():
            paths = [path for path in map(_find, names) if path]
            if not paths:
                raise RuntimeError("No font for drawing PDFs: Liberation Sans in /opt/steve/pdf-fonts, or DejaVu Sans (runtime/Dockerfile).")
            self.faces[bold] = [_Font(path) for path in paths]

    def runs(self, text: str, bold: bool) -> list[tuple[_Font, list[int]]]:
        """The text as runs of glyphs, each in the first face that has its characters (else the first face's .notdef)."""
        faces = self.faces[bold]
        out: list[tuple[_Font, list[int]]] = []
        for char in text:
            font, gid = next(((face, face.glyph(char)) for face in faces if face.glyph(char) is not None), (faces[0], 0))
            font.used.setdefault(gid, char)
            if out and out[-1][0] is font:
                out[-1][1].append(gid)
            else:
                out.append((font, [gid]))
        return out


def _number(value: float) -> str:
    text = f"{value:.4f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


class _Writer:
    """PDF objects, written in order with a cross-reference table (no object streams)."""

    def __init__(self):
        self.objects: list[bytes | None] = []

    def reserve(self) -> int:
        self.objects.append(None)
        return len(self.objects)

    def put(self, number: int, body: bytes) -> int:
        self.objects[number - 1] = body
        return number

    def add(self, body: bytes) -> int:
        return self.put(self.reserve(), body)

    def stream(self, data: bytes, extra: str = "", compress: bool = True) -> int:
        if compress:
            data, extra = zlib.compress(data, 9), extra + " /Filter /FlateDecode"
        return self.add(f"<< /Length {len(data)}{extra} >>\nstream\n".encode() + data + b"\nendstream")

    def finish(self, root: int, info: int) -> bytes:
        out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for number, body in enumerate(self.objects, 1):
            offsets.append(len(out))
            out += f"{number} 0 obj\n".encode() + (body or b"null") + b"\nendobj\n"
        start = len(out)
        out += f"xref\n0 {len(self.objects) + 1}\n0000000000 65535 f \n".encode()
        out += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
        out += f"trailer\n<< /Size {len(self.objects) + 1} /Root {root} 0 R /Info {info} 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()
        return bytes(out)


def _text_string(text: str) -> str:
    """A PDF text string (UTF-16BE with BOM): the document's title."""
    return "<FEFF" + text.encode("utf-16-be").hex().upper() + ">"


class _Page:
    """One sheet's content stream, in mm (the page matrix scales mm to points)."""

    def __init__(self, sheet, fonts: _Fonts, font_names: dict, images: dict):
        self.sheet, self.fonts, self.font_names, self.images = sheet, fonts, font_names, images
        self.ops: list[str] = [f"{_number(MM)} 0 0 {_number(MM)} 0 0 cm", "1 1 1 rg",
                               f"0 0 {_number(sheet.width)} {_number(sheet.height)} re f"]
        self.used_fonts: set = set()
        self.used_images: set = set()

    def _path(self, points) -> str:
        first, *rest = points
        return " ".join([f"{_number(first[0])} {_number(first[1])} m", *(f"{_number(x)} {_number(y)} l" for x, y in rest)])

    def strokes(self, lines) -> None:
        width = self.sheet._widths()
        for kind in ("frame", "visible", "hidden", "thin", "chain", "hatch"):
            paths = [self._path(points) for points, k in lines if k == kind and len(points) >= 2]
            if not paths:
                continue
            dash = {"hidden": "[3 1.5] 0 d", "chain": "[8 1.5 0.5 1.5] 0 d"}.get(kind, "[] 0 d")
            self.ops += ["q", "0 0 0 RG 1 J 1 j", f"{_number(width[kind])} w", dash, *paths, "S", "Q"]

    def circles(self, circles) -> None:
        width = self.sheet._widths()
        for x, y, r, kind in circles:
            k = KAPPA * r
            self.ops += ["q", "0 0 0 RG 1 J 1 j [] 0 d", f"{_number(width[kind])} w",
                         f"{_number(x + r)} {_number(y)} m",
                         f"{_number(x + r)} {_number(y + k)} {_number(x + k)} {_number(y + r)} {_number(x)} {_number(y + r)} c",
                         f"{_number(x - k)} {_number(y + r)} {_number(x - r)} {_number(y + k)} {_number(x - r)} {_number(y)} c",
                         f"{_number(x - r)} {_number(y - k)} {_number(x - k)} {_number(y - r)} {_number(x)} {_number(y - r)} c",
                         f"{_number(x + k)} {_number(y - r)} {_number(x + r)} {_number(y - k)} {_number(x + r)} {_number(y)} c",
                         "S", "Q"]

    def fills(self, fills) -> None:
        if fills:
            self.ops += ["q", "0 0 0 rg", *(self._path(polygon) + " h" for polygon in fills), "f", "Q"]

    def shades(self, shades) -> None:
        from .drawing import SHADE_DARK, SHADE_LIGHT, SHADES
        for polygon, level in shades:
            grey = round(SHADE_LIGHT - (SHADE_LIGHT - SHADE_DARK) * level / max(SHADES - 1, 1)) / 255
            self.ops += ["q", f"{_number(grey)} g {_number(grey)} G 0.06 w 1 j", self._path(polygon) + " h", "B", "Q"]

    def texts(self, texts) -> None:
        for x, y, text, size, anchor, rotation, bold in texts:
            runs = self.fonts.runs(text, bold)
            width = sum(font.advance(gid) for font, gids in runs for gid in gids) * size / 1000
            shift = {"start": 0.0, "middle": 0.5, "end": 1.0}[anchor] * width
            angle = math.radians(rotation)
            cos, sin = math.cos(angle), math.sin(angle)
            ops = ["BT", "0 g", f"{_number(cos)} {_number(sin)} {_number(-sin)} {_number(cos)} "
                               f"{_number(x - shift * cos)} {_number(y - shift * sin)} Tm"]
            for font, gids in runs:
                self.used_fonts.add(id(font))
                ops += [f"/{self.font_names[id(font)]} {_number(size)} Tf", "<" + "".join(f"{gid:04X}" for gid in gids) + "> Tj"]
            self.ops += [*ops, "ET"]

    def image(self, x, y, w, h, image) -> None:
        name = self.images[image["name"]][0]
        self.used_images.add(image["name"])
        self.ops += ["q", f"{_number(w)} 0 0 {_number(h)} {_number(x)} {_number(y)} cm", f"/{name} Do", "Q"]

    def drawn(self, shades, lines, circles, fills, texts) -> None:
        """One layer as the SVG draws it (drawing.Sheet.svg drawn()): shades, lines, circles, then arrowheads and text."""
        self.shades(shades)
        self.strokes(lines)
        self.circles(circles)
        self.fills(fills)
        self.texts(texts)


def _layers(sheet):
    """The sheet's layers in the SVG's order: the sheet's own drawing, each view's, then each feature dimension (balloon,
    table tags…) on top. Each: (shades, lines, circles, fills, texts)."""
    owners = sheet._owners()
    spans = {(key, i): name for name, start, end in sheet.spans
             for key, a, b in zip(("lines", "circles", "texts", "fills", "shades"), start, end) for i in range(a, b)}

    def mine(key, items, name=None):
        return [item for i, item in enumerate(items) if (key, i) not in owners and spans.get((key, i)) == name]

    def layer(name=None):
        return (mine("shades", sheet.shades, name), mine("lines", sheet.lines, name), mine("circles", sheet.circles, name),
                mine("fills", sheet.fills, name), mine("texts", sheet.texts, name))

    yield layer()
    for name in dict.fromkeys(name for name, _, _ in sheet.spans):
        yield layer(name)
    for _, (l0, f0, t0), (l1, f1, t1), _ in sheet.groups:
        yield [], sheet.lines[l0:l1], [], sheet.fills[f0:f1], sheet.texts[t0:t1]


def _jpeg_channels(data: bytes) -> int | None:
    """A JPEG's colour components, from its start-of-frame header (images.SOF), without decoding it."""
    from .images import SOF
    at = 2
    while at + 4 <= len(data) and data[at] == 0xFF:
        marker, length = data[at + 1], int.from_bytes(data[at + 2:at + 4], "big")
        if marker in SOF and at + 9 < len(data):
            return data[at + 9]
        at += 2 + length
    return None


def _image_objects(writer: _Writer, image: dict) -> int | None:
    """A logo as an image XObject: a JPEG as is (DCT: the viewer decodes it, nothing re-compressed), else pixels (Flate)
    with alpha as a soft mask. None for one that can't be read (left out, as a browser shows a broken image)."""
    width, height = image["pixels"]
    if image["kind"] == "jpeg":
        channels = _jpeg_channels(image["data"])
        space = {1: "/DeviceGray", 3: "/DeviceRGB", 4: "/DeviceCMYK"}.get(channels)
        if space is None:
            return None
        invert = " /Decode [1 0 1 0 1 0 1 0]" if channels == 4 and b"Adobe" in image["data"][:4096] else ""
        return writer.stream(image["data"], f" /Type /XObject /Subtype /Image /Width {width} /Height {height} "
                                            f"/ColorSpace {space} /BitsPerComponent 8{invert} /Filter /DCTDecode", compress=False)
    try:
        from PIL import Image
        picture = Image.open(io.BytesIO(image["data"]))
        picture.load()
        picture = picture.convert("RGBA")
    except Exception:  # noqa: BLE001 - a damaged file the header check let through
        return None
    width, height = picture.size
    rgb = picture.convert("RGB").tobytes()
    alpha = picture.getchannel("A")
    mask = ""
    if alpha.getextrema() != (255, 255):
        soft = writer.stream(alpha.tobytes(), f" /Type /XObject /Subtype /Image /Width {width} /Height {height} "
                                              "/ColorSpace /DeviceGray /BitsPerComponent 8")
        mask = f" /SMask {soft} 0 R"
    return writer.stream(rgb, f" /Type /XObject /Subtype /Image /Width {width} /Height {height} "
                              f"/ColorSpace /DeviceRGB /BitsPerComponent 8{mask}")


def _embed(writer: _Writer, font: _Font, tag: str) -> int:
    """A Type 0 font over the face's subset (glyph ids kept, Identity-H), with widths and a ToUnicode map."""
    import logging
    from fontTools import subset
    logging.getLogger("fontTools.subset").setLevel(logging.ERROR)   # tables it drops (FFTM…) aren't news
    options = subset.Options()
    options.retain_gids = True
    options.notdef_outline = True
    options.name_IDs, options.name_languages, options.layout_features = ["*"], ["*"], []
    options.drop_tables += ["GSUB", "GPOS", "GDEF", "kern", "DSIG"]
    face = __import__("fontTools.ttLib", fromlist=["TTFont"]).TTFont(font.path)
    subsetter = subset.Subsetter(options)
    subsetter.populate(gids=sorted({0, *font.used}))
    subsetter.subset(face)
    data = io.BytesIO()
    face.save(data)
    program = data.getvalue()
    file = writer.stream(program, f" /Length1 {len(program)}")
    head, hhea = font.tt["head"], font.tt["hhea"]
    scale = 1000 / font.em
    os2 = font.tt["OS/2"] if "OS/2" in font.tt else None
    cap = getattr(os2, "sCapHeight", 0) or hhea.ascent
    name = f"{tag}+" + font.tt["name"].getDebugName(6).replace(" ", "")
    bbox = " ".join(_number(v * scale) for v in (head.xMin, head.yMin, head.xMax, head.yMax))
    descriptor = writer.add(f"<< /Type /FontDescriptor /FontName /{name} /Flags 32 /FontBBox [{bbox}] /ItalicAngle 0 "
                            f"/Ascent {_number(hhea.ascent * scale)} /Descent {_number(hhea.descent * scale)} "
                            f"/CapHeight {_number(cap * scale)} /StemV 80 /FontFile2 {file} 0 R >>".encode())
    widths = " ".join(f"{gid} [{_number(font.advance(gid))}]" for gid in sorted(font.used))
    cid = writer.add(f"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{name} "
                     f"/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
                     f"/FontDescriptor {descriptor} 0 R /W [{widths}] /CIDToGIDMap /Identity >>".encode())
    mapping = "\n".join(f"<{gid:04X}> <{''.join(f'{unit:04X}' for unit in _utf16(text))}>" for gid, text in sorted(font.used.items()))
    cmap = ("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) "
            "/Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\n"
            f"endcodespacerange\n{len(font.used)} beginbfchar\n{mapping}\nendbfchar\nendcmap\n"
            "CMapName currentdict /CMap defineresource pop\nend\nend\n")
    unicode = writer.stream(cmap.encode())
    return writer.add(f"<< /Type /Font /Subtype /Type0 /BaseFont /{name} /Encoding /Identity-H "
                      f"/DescendantFonts [{cid} 0 R] /ToUnicode {unicode} 0 R >>".encode())


def _utf16(text: str) -> list[int]:
    data = text.encode("utf-16-be")
    return [int.from_bytes(data[i:i + 2], "big") for i in range(0, len(data), 2)]


def pdf(sheets, title: str = "") -> bytes:
    """Every sheet (drawing.Sheet) as a page of one PDF."""
    fonts = _Fonts()
    faces = [face for bold in (False, True) for face in fonts.faces[bold]]
    font_names = {id(face): f"F{index}" for index, face in enumerate(faces)}
    writer = _Writer()
    images: dict[str, tuple[str, int]] = {}
    pages = []
    for sheet in sheets:
        for *_, image in sheet.images:
            if image["name"] not in images:
                images[image["name"]] = (f"Im{len(images)}", _image_objects(writer, image))
        page = _Page(sheet, fonts, font_names, images)
        for x, y, w, h, image in sheet.images:
            if images[image["name"]][1] is not None:
                page.image(x, y, w, h, image)
        for layer in _layers(sheet):
            page.drawn(*layer)
        pages.append(page)
    # Fonts last: only now is every glyph the pages use known (each face is subset to those).
    embedded = {}
    for index, face in enumerate(faces):
        if face.used:
            tag = "".join(chr(ord("A") + (index * 7 + i * 3) % 26) for i in range(6))
            embedded[id(face)] = _embed(writer, face, tag)
    tree = writer.reserve()
    kids = []
    for page in pages:
        content = writer.stream("\n".join(page.ops).encode())
        # In the faces' order: used_fonts holds id()s, memory addresses, so its own order changed from build to build.
        font_refs = " ".join(f"/{name} {embedded[key]} 0 R" for key, name in font_names.items() if key in page.used_fonts)
        image_refs = " ".join(f"/{images[name][0]} {images[name][1]} 0 R" for name in sorted(page.used_images))
        resources = f"<< /Font << {font_refs} >> /XObject << {image_refs} >> >>"
        box = f"[0 0 {_number(page.sheet.width * MM)} {_number(page.sheet.height * MM)}]"
        kids.append(writer.add(f"<< /Type /Page /Parent {tree} 0 R /MediaBox {box} /Resources {resources} "
                               f"/Contents {content} 0 R >>".encode()))
    writer.put(tree, f"<< /Type /Pages /Kids [{' '.join(f'{kid} 0 R' for kid in kids)}] /Count {len(kids)} >>".encode())
    root = writer.add(f"<< /Type /Catalog /Pages {tree} 0 R >>".encode())
    info = writer.add(f"<< /Producer {_text_string('STEVE')}{(' /Title ' + _text_string(title[:200])) if title else ''} >>".encode())
    return writer.finish(root, info)
