"""Autodesk Fusion designs (.f3d) read as exact solids, inside the kernel only.

An .f3d is a ZIP (members stored, deflated or Zstandard, ZIP method 93). It holds the design's exact
geometry as ASM blobs (Autodesk's ACIS fork, binary "SAB" encoding) under `Breps.BlobParts/`, a display
mesh of the visible bodies (`OGS.BlobFolder/OGS/DefaultScene/world` + `Fusion_mesh_000`), and the design
stream (`FusionDesignSegmentType1/BulkStream.dat`: parameters, timeline features).

What is read, and how it was established from real files:
- The design's bodies are in the `.smbh` blobs: their records before `Begin-of-ASM-History-Data` are the
  current bodies, the rest is ASM history (delta states). The design stream names each `.smbh` blob next to
  its root component and the body's history id. The `.smb` blobs hold sketch and feature geometry (profiles,
  tool bodies) and are not part of the design's bodies.
- Lengths are in Fusion's internal unit, the centimetre: every coordinate, radius and spline control point is
  multiplied by 10 to millimetres.
- Every ACIS entity Fusion writes for solids is converted to OCCT: body, lump, shell, face, loop, coedge, edge,
  vertex, point, transform; plane, cone (cylinders included), sphere, torus and exact B-spline (`exactsur`)
  surfaces; straight, ellipse and exact B-spline (`exactcur`) curves. pcurves are recomputed by projection.
  Anything else fails the import naming the entity: never an approximation, never a mesh.
- The correctness gate: each solid is compared with the file's own display mesh (every mesh vertex lies on the
  solid's boundary, the enclosed volume and the bounds agree; tolerances below). A disagreement refuses the file.

The file is untrusted: member count, sizes and compression ratio, record and entity counts, string lengths,
pointers (index and entity type), linked-list lengths and cycles, nesting depth and the time spent are bounded,
and members are read into memory, never written to disk by name. Parameters and features from the design stream
are returned as plain data, bounded, never interpreted or logged.
"""
from __future__ import annotations

import io
import math
import re
import struct
import time
import zipfile
import zlib

# Archive limits.
MAX_FILE_BYTES = 1024 * 1024 * 1024         # the .f3d itself, read whole into memory (app/imports.py F3D_MAX_BYTES)
MAX_MEMBERS = 20000
MAX_MEMBER_BYTES = 512 * 1024 * 1024        # one member, decompressed
MAX_TOTAL_BYTES = 1024 * 1024 * 1024        # everything read from one file, decompressed
MAX_RATIO = 2000                            # decompressed / compressed, past the first MB of a member
# ASM limits.
MAX_RECORDS = 5_000_000
MAX_TOKENS_PER_RECORD = 4_000_000
MAX_STRING = 1 << 20
MAX_DEPTH = 64
MAX_LIST = 1_000_000                       # entities in one linked list (faces of a shell, coedges of a loop…)
MAX_COORD = 1.0e7                          # |coordinate| in file units (cm): 100 km
MAX_SOLIDS = 10000
# Said when a surface (sheet) body is left out of an import (steve.model.SURFACE_NOTE, for a Fusion file).
SHEET_NOTE = "surface bodies aren't solids; thicken or stitch them into solids in Fusion first"
MAX_SECONDS = 3600.0                       # a backstop far past a sane read, never a budget
# Display-mesh gate.
VOLUME_TOLERANCE = 0.005                   # 0.5 % of the solid's volume, after the mesh's own chordal slivers
BOUNDS_TOLERANCE = 0.005                   # 0.5 % of the solid's diagonal, plus the mesh's largest chordal gap
SURFACE_TOLERANCE_MM = 0.01                # mesh vertices must lie this close to the solid's boundary
SURFACE_SAMPLES = 600                      # mesh vertices (and triangles) sampled per solid
# Design-stream extras.
MAX_PARAMETERS = 2000
MAX_FEATURES = 2000
MAX_TEXT = 500
MAX_CANDIDATES = 1_000_000                 # places in the stream tried as a record, found or not
MAX_EXTRAS_BYTES = 160 * 1024              # parameters and features kept with a build, as JSON (imports.EXTRAS_PER_BUILD)
MAX_MESH_VALUES = 60_000_000               # display-mesh vertices plus indices read for the check

MM = 10.0  # Fusion's internal centimetres → millimetres.

ZIP_MAGIC = b"PK\x03\x04"
ASM_MAGIC = b"ASM BinaryFile4"
ACIS_MAGIC = b"ACIS BinaryFile"


class FusionImportError(ValueError):
    """The Fusion file can't be imported (unreadable, unsupported or failing its check); the message says why."""


def is_fusion(head: bytes) -> bool:
    return head.startswith(ZIP_MAGIC)


class _Clock:
    def __init__(self, seconds=MAX_SECONDS):
        self.deadline = time.monotonic() + seconds

    def check(self):
        if time.monotonic() > self.deadline:
            raise FusionImportError("Reading this Fusion file took too long.")


# ---------------------------------------------------------------- archive


class Archive:
    """The members of a Fusion ZIP, read into memory on request with every size bounded."""

    def __init__(self, data: bytes):
        self.data = data
        try:
            self.zip = zipfile.ZipFile(io.BytesIO(data))
            infos = self.zip.infolist()
        except (zipfile.BadZipFile, zipfile.LargeZipFile, NotImplementedError, OSError, ValueError, EOFError, struct.error,
                UnicodeDecodeError, IndexError, KeyError, OverflowError) as error:
            raise FusionImportError("This isn't a readable Fusion file (.f3d): its ZIP structure is damaged.") from error
        if len(infos) > MAX_MEMBERS:
            raise FusionImportError(f"This Fusion file has more than {MAX_MEMBERS} parts.")
        self.infos = {}
        for info in infos:
            if not info.filename.endswith("/"):
                self.infos.setdefault(info.filename, info)
        self.read_total = 0

    def names(self) -> list[str]:
        return list(self.infos)

    def find(self, pattern: str) -> list[str]:
        rx = re.compile(pattern)
        return sorted(name for name in self.infos if rx.search(name))

    def read(self, name: str, limit: int | None = None) -> bytes:
        limit = MAX_MEMBER_BYTES if limit is None else limit
        info = self.infos[name]
        if info.flag_bits & 0x1:
            raise FusionImportError("This Fusion file is encrypted.")
        raw = self._raw(info)
        method = info.compress_type
        if method == 0:
            out = raw
        elif method == 8:
            out = self._inflate(raw, limit)
        elif method == 93:
            out = self._unzstd(raw, limit)
        else:
            raise FusionImportError(f"This Fusion file uses a compression method STEVE can't read (ZIP method {method}).")
        if len(out) > limit:
            raise FusionImportError("A part of this Fusion file is too large to import.")
        if len(out) > (1 << 20) and len(out) > MAX_RATIO * max(1, len(raw)):
            raise FusionImportError("A part of this Fusion file expands far beyond its size (a ZIP bomb); it isn't imported.")
        self.read_total += len(out)
        if self.read_total > MAX_TOTAL_BYTES:
            raise FusionImportError("This Fusion file holds more data than STEVE imports from one file.")
        return out

    def _raw(self, info) -> bytes:
        offset = info.header_offset
        if offset < 0 or offset + 30 > len(self.data) or self.data[offset:offset + 4] != ZIP_MAGIC:
            raise FusionImportError("This Fusion file's ZIP structure is damaged.")
        name_len, extra_len = struct.unpack_from("<HH", self.data, offset + 26)
        start = offset + 30 + name_len + extra_len
        end = start + info.compress_size
        if info.compress_size < 0 or end > len(self.data):
            raise FusionImportError("This Fusion file is truncated.")
        return self.data[start:end]

    @staticmethod
    def _inflate(raw: bytes, limit: int) -> bytes:
        try:
            engine = zlib.decompressobj(-15)
            out = engine.decompress(raw, limit + 1)
        except zlib.error as error:
            raise FusionImportError("A part of this Fusion file can't be decompressed.") from error
        return out

    @staticmethod
    def _unzstd(raw: bytes, limit: int) -> bytes:
        try:
            import zstandard
        except ImportError as error:  # The runtime image pins it (runtime/Dockerfile).
            raise FusionImportError("This kernel can't read Zstandard-compressed Fusion files.") from error
        try:
            reader = zstandard.ZstdDecompressor(max_window_size=1 << 27).stream_reader(io.BytesIO(raw), read_across_frames=True)
            chunks, size = [], 0
            while True:
                chunk = reader.read(min(1 << 20, limit + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > limit:
                    break
            return b"".join(chunks)
        except zstandard.ZstdError as error:
            raise FusionImportError("A part of this Fusion file can't be decompressed.") from error


# ---------------------------------------------------------------- ASM (SAB) tokens

# Tag bytes of the binary encoding, worked out from Fusion's blobs (they match ACIS SAB).
T_CHAR, T_SHORT, T_INT, T_FLOAT, T_DOUBLE = 0x02, 0x03, 0x04, 0x05, 0x06
T_STR1, T_STR2, T_STR4 = 0x07, 0x08, 0x09
T_TRUE, T_FALSE = 0x0A, 0x0B
T_PTR, T_IDENT, T_SUBIDENT = 0x0C, 0x0D, 0x0E
T_BEGIN, T_END, T_TERM = 0x0F, 0x10, 0x11
T_STR1B = 0x12
T_POS, T_VEC = 0x13, 0x14
T_ENUM = 0x15
T_VEC2 = 0x16
T_INT64 = 0x17


class Ptr(int):
    """A pointer token: a record index, or -1."""


class Ident(str):
    """An identifier token (a keyword such as `exactsur` inside sub-type data)."""


class Enum(int):
    """An enumeration token."""


class Begin:
    """`{`: sub-type data starts."""


class End:
    """`}`: sub-type data ends."""


BEGIN, END = Begin(), End()
_D = struct.Struct("<d")
_I = struct.Struct("<i")
_Q = struct.Struct("<q")
_P3 = struct.Struct("<3d")
_P2 = struct.Struct("<2d")


class Record:
    __slots__ = ("index", "type", "fields")

    def __init__(self, index, type_, fields):
        self.index, self.type, self.fields = index, type_, fields

    def __repr__(self):
        return f"<{self.type} ${self.index}>"


class Blob:
    """One ASM blob: its header and its records (history and later sections cut off)."""

    def __init__(self, records, header):
        self.records, self.header = records, header


def _finite(*values):
    for v in values:
        if not math.isfinite(v):
            raise FusionImportError("The Fusion geometry holds a non-numeric value (NaN or infinity).")


def parse_asm(data: bytes, clock: _Clock | None = None, label: str = "geometry") -> Blob:
    """Decodes an ASM/ACIS binary blob into records. Each record is its type name (sub-identifiers joined with `-`,
    e.g. `plane-surface`) and its field tokens. Stops at the history section or the end mark."""
    clock = clock or _Clock()
    n = len(data)
    if data.startswith(ASM_MAGIC):
        pos = len(ASM_MAGIC)
    elif data.startswith(ACIS_MAGIC):
        pos = len(ACIS_MAGIC)
    else:
        raise FusionImportError(f"The Fusion {label} isn't in ASM binary form.")
    if pos + 16 > n:
        raise FusionImportError(f"The Fusion {label} is truncated.")
    version, _records, _bodies, _flags = struct.unpack_from("<4i", data, pos)
    pos += 16
    header = {"version": version}
    records: list[Record] = []
    tokens: list = []
    name_parts: list[str] = []
    type_name = None
    depth = 0
    header_strings = []
    # Before the first record: product, version and date strings, then three doubles (scale, resabs, resnor).
    for _ in range(3):
        if pos >= n or data[pos] not in (T_STR1, T_STR2, T_STR4):
            raise FusionImportError(f"The Fusion {label} has an unexpected header.")
        value, pos = _string(data, pos)
        header_strings.append(value)
    for _ in range(3):
        if pos + 9 > n or data[pos] != T_DOUBLE:
            raise FusionImportError(f"The Fusion {label} has an unexpected header.")
        pos += 9
    header["product"] = header_strings[0][:80]
    count = 0
    while pos < n:
        tag = data[pos]
        pos += 1
        if tag == T_TERM:
            if type_name is None:
                raise FusionImportError(f"The Fusion {label} has a record without a type.")
            if depth:
                raise FusionImportError(f"The Fusion {label} has unbalanced sub-type data.")
            if type_name.startswith("Begin-of-") or type_name.startswith("End-of-"):
                break
            records.append(Record(len(records), type_name, tokens))
            if len(records) > MAX_RECORDS:
                raise FusionImportError(f"The Fusion {label} has more than {MAX_RECORDS} entities.")
            tokens, name_parts, type_name = [], [], None
            count += 1
            if not count & 0x3FFF:
                clock.check()
            continue
        if tag == T_SUBIDENT or tag == T_IDENT:
            value, pos = _short_string(data, pos, label)
            if type_name is None:
                name_parts.append(value)
                if tag == T_IDENT:
                    type_name = "-".join(name_parts)
                    if len(type_name) > 256:
                        raise FusionImportError(f"The Fusion {label} has an invalid entity name.")
                    if type_name.startswith(("End-of-", "Begin-of-")):
                        break
                continue
            tokens.append(Ident(value))
        elif type_name is None:
            raise FusionImportError(f"The Fusion {label} has data outside a record.")
        elif tag == T_PTR or tag == T_INT or tag == T_ENUM:
            if pos + 4 > n:
                raise _truncated(label)
            value = _I.unpack_from(data, pos)[0]
            pos += 4
            tokens.append(Ptr(value) if tag == T_PTR else Enum(value) if tag == T_ENUM else value)
        elif tag == T_DOUBLE:
            if pos + 8 > n:
                raise _truncated(label)
            value = _D.unpack_from(data, pos)[0]
            pos += 8
            tokens.append(value)
        elif tag == T_POS or tag == T_VEC:
            if pos + 24 > n:
                raise _truncated(label)
            value = _P3.unpack_from(data, pos)
            pos += 24
            tokens.append(value)
        elif tag == T_VEC2:
            if pos + 16 > n:
                raise _truncated(label)
            value = _P2.unpack_from(data, pos)
            pos += 16
            tokens.append(value)
        elif tag == T_TRUE or tag == T_FALSE:
            tokens.append(tag == T_TRUE)
        elif tag in (T_STR1, T_STR2, T_STR4, T_STR1B):
            value, pos = _string(data, pos - 1)
            tokens.append(value)
        elif tag == T_BEGIN:
            depth += 1
            if depth > MAX_DEPTH:
                raise FusionImportError(f"The Fusion {label} nests sub-type data too deeply.")
            tokens.append(BEGIN)
        elif tag == T_END:
            depth -= 1
            if depth < 0:
                raise FusionImportError(f"The Fusion {label} has unbalanced sub-type data.")
            tokens.append(END)
        elif tag == T_CHAR:
            if pos + 1 > n:
                raise _truncated(label)
            tokens.append(data[pos])
            pos += 1
        elif tag == T_SHORT:
            if pos + 2 > n:
                raise _truncated(label)
            tokens.append(struct.unpack_from("<h", data, pos)[0])
            pos += 2
        elif tag == T_FLOAT:
            if pos + 4 > n:
                raise _truncated(label)
            tokens.append(struct.unpack_from("<f", data, pos)[0])
            pos += 4
        elif tag == T_INT64:
            if pos + 8 > n:
                raise _truncated(label)
            tokens.append(_Q.unpack_from(data, pos)[0])
            pos += 8
        else:
            raise FusionImportError(f"The Fusion {label} has an unknown data tag (0x{tag:02x}).")
        if len(tokens) > MAX_TOKENS_PER_RECORD:
            raise FusionImportError(f"The Fusion {label} has a record too large to import.")
    if records and records[0].type == "asmheader":
        header["asmheader"] = True
    return Blob(records, header)


def _truncated(label):
    return FusionImportError(f"The Fusion {label} is truncated.")


def _short_string(data, pos, label):
    if pos >= len(data):
        raise _truncated(label)
    length = data[pos]
    end = pos + 1 + length
    if end > len(data):
        raise _truncated(label)
    return data[pos + 1:end].decode("latin-1"), end


def _string(data, pos):
    tag = data[pos]
    pos += 1
    if tag in (T_STR1, T_STR1B):
        width = 1
    elif tag == T_STR2:
        width = 2
    else:
        width = 4
    if pos + width > len(data):
        raise FusionImportError("The Fusion geometry is truncated.")
    length = int.from_bytes(data[pos:pos + width], "little")
    pos += width
    if length > MAX_STRING or pos + length > len(data):
        raise FusionImportError("The Fusion geometry has a string that is too long or truncated.")
    return data[pos:pos + length].decode("utf-8", errors="replace"), pos + length


# ---------------------------------------------------------------- entities


class Entities:
    """Typed, bounds-checked access to a blob's records."""

    def __init__(self, blob: Blob, label: str):
        self.records = blob.records
        self.label = label

    def get(self, ptr, kind: str | tuple[str, ...], where: str):
        """The record a pointer names, which must be of `kind` (an entity class: the last part of the type)."""
        if not isinstance(ptr, int) or isinstance(ptr, bool):
            raise FusionImportError(f"The Fusion {self.label} has a {where} where a reference was expected.")
        if ptr < 0 or ptr >= len(self.records):
            raise FusionImportError(f"The Fusion {self.label} has a {where} reference out of range (${ptr}).")
        record = self.records[ptr]
        kinds = (kind,) if isinstance(kind, str) else kind
        if record.type.rsplit("-", 1)[-1] not in kinds:
            raise FusionImportError(f"The Fusion {self.label} has a {where} pointing at a {record.type} (${ptr}), not a {'/'.join(kinds)}.")
        return record

    def opt(self, ptr, kind, where):
        return None if ptr == -1 else self.get(ptr, kind, where)

    def chain(self, first, kind, where, next_field):
        """Follows a `next` linked list from `first`, bounded and cycle-safe."""
        out, seen = [], set()
        ptr = first
        while ptr != -1:
            if ptr in seen:
                break  # A loop's coedges are circular; other lists end with -1.
            seen.add(ptr)
            record = self.get(ptr, kind, where)
            out.append(record)
            if len(out) > MAX_LIST:
                raise FusionImportError(f"The Fusion {self.label} has a list of {where}s that is too long.")
            ptr = field(record, next_field, Ptr, where)
        return out


def field(record: Record, index: int, kind, where: str):
    """A record's field `index` (after the common attribute / history / owner fields), of a token class."""
    fields = record.fields
    if index >= len(fields):
        raise FusionImportError(f"The Fusion geometry's {record.type} (${record.index}) is missing data ({where}).")
    value = fields[index]
    if kind is Ptr:
        ok = isinstance(value, Ptr)
    elif kind is bool:
        ok = isinstance(value, bool)
    elif kind is float:
        ok = isinstance(value, float) or (isinstance(value, int) and not isinstance(value, (bool, Ptr)))
        if ok:
            value = float(value)
            _finite(value)
    elif kind is tuple:
        ok = isinstance(value, tuple) and len(value) == 3
        if ok:
            _finite(*value)
    elif kind is int:
        ok = isinstance(value, int) and not isinstance(value, bool)
    elif kind is str:
        ok = isinstance(value, str)
    else:
        ok = isinstance(value, kind)
    if not ok:
        raise FusionImportError(f"The Fusion geometry's {record.type} (${record.index}) has unexpected data ({where}).")
    return value


# Field layout (after the three common fields: attribute pointer, history id, owner pointer) — from Fusion's blobs.
COMMON = 3
BODY_LUMP, BODY_WIRE, BODY_TRANSFORM = 3, 4, 5
LUMP_NEXT, LUMP_SHELL, LUMP_BODY = 3, 4, 5
SHELL_NEXT, SHELL_SUBSHELL, SHELL_FACE, SHELL_WIRE, SHELL_LUMP = 3, 4, 5, 6, 7
FACE_NEXT, FACE_LOOP, FACE_SHELL, FACE_SUBSHELL, FACE_SURFACE, FACE_SENSE, FACE_SIDES = 3, 4, 5, 6, 7, 8, 9
LOOP_NEXT, LOOP_COEDGE, LOOP_FACE = 3, 4, 5
COEDGE_NEXT, COEDGE_PREV, COEDGE_PARTNER, COEDGE_EDGE, COEDGE_SENSE, COEDGE_LOOP = 3, 4, 5, 6, 7, 8
EDGE_START, EDGE_START_PARAM, EDGE_END, EDGE_END_PARAM, EDGE_COEDGE, EDGE_CURVE, EDGE_SENSE = 3, 4, 5, 6, 7, 8, 9
VERTEX_EDGE, VERTEX_POINT = 3, 5
POINT_POSITION = 3


def _vec(v, where):
    x, y, z = v
    if max(abs(x), abs(y), abs(z)) > MAX_COORD:
        raise FusionImportError(f"The Fusion geometry has a {where} far outside any part's size.")
    return v


def _unit(v, where):
    length = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    if not length > 1e-12 or length > MAX_COORD:
        raise FusionImportError(f"The Fusion geometry has an invalid {where} direction.")
    return (v[0] / length, v[1] / length, v[2] / length)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _scaled(p):
    return (p[0] * MM, p[1] * MM, p[2] * MM)


# ---------------------------------------------------------------- geometry → OCCT


def _gp():
    from OCP import gp
    return gp


def _ax3(origin, normal, xdir, left_handed=False):
    """An OCCT frame at `origin` with Z = normal and X = xdir made perpendicular; left-handed flips the surface normal."""
    gp = _gp()
    n = _unit(normal, "axis")
    x = (xdir[0] - _dot(xdir, n) * n[0], xdir[1] - _dot(xdir, n) * n[1], xdir[2] - _dot(xdir, n) * n[2])
    if math.sqrt(_dot(x, x)) < 1e-9:  # Reference direction along the axis: any perpendicular.
        x = _cross(n, (1.0, 0.0, 0.0) if abs(n[0]) < 0.9 else (0.0, 1.0, 0.0))
    x = _unit(x, "reference")
    ax = gp.gp_Ax3(gp.gp_Pnt(*_scaled(origin)), gp.gp_Dir(*n), gp.gp_Dir(*x))
    if left_handed:
        ax.YReverse()
    return ax


def _tail_intervals(fields, start):
    """Skips interval tokens (F, or T value) from `start`; returns the index after them (best effort)."""
    i = start
    while i < len(fields) and isinstance(fields[i], bool):
        i += 2 if fields[i] else 1
    return i


def surface(ents: Entities, record: Record):
    """The OCCT surface of an ACIS surface record, oriented so that its normal is the ACIS surface normal."""
    from OCP.Geom import Geom_ConicalSurface, Geom_CylindricalSurface, Geom_Plane, Geom_SphericalSurface, Geom_ToroidalSurface
    kind = record.type
    f = record.fields
    if kind == "plane-surface":
        root = _vec(field(record, COMMON, tuple, "plane origin"), "plane origin")
        normal = field(record, COMMON + 1, tuple, "plane normal")
        udir = field(record, COMMON + 2, tuple, "plane direction")
        return Geom_Plane(_ax3(root, normal, udir))
    if kind == "cone-surface":
        center = _vec(field(record, COMMON, tuple, "cone centre"), "cone centre")
        axis = field(record, COMMON + 1, tuple, "cone axis")
        major = _vec(field(record, COMMON + 2, tuple, "cone major axis"), "cone radius")
        ratio = field(record, COMMON + 3, float, "cone ratio")
        i = _tail_intervals(f, COMMON + 4)
        sine = field(record, i, float, "cone angle")
        cosine = field(record, i + 1, float, "cone angle")
        radius = math.sqrt(_dot(major, major))
        if abs(ratio - 1.0) > 1e-9:
            raise FusionImportError("The Fusion geometry has an elliptical cone or cylinder, which STEVE can't import exactly yet.")
        if not radius > 1e-12:
            raise FusionImportError("The Fusion geometry has a cone with no radius.")
        if abs(math.hypot(sine, cosine) - 1.0) > 1e-6 or abs(cosine) < 1e-9:
            raise FusionImportError("The Fusion geometry has a cone with an invalid angle.")
        inward = cosine < 0  # ACIS: a negative cosine points the surface normal toward the axis.
        frame = _ax3(center, axis, major, left_handed=inward)
        if abs(sine) < 1e-12:
            return Geom_CylindricalSurface(frame, radius * MM)
        angle = math.atan(sine / cosine)  # The radius grows by sine/cosine per unit along the axis.
        return Geom_ConicalSurface(frame, angle, radius * MM)
    if kind == "sphere-surface":
        center = _vec(field(record, COMMON, tuple, "sphere centre"), "sphere centre")
        radius = field(record, COMMON + 1, float, "sphere radius")
        origin = field(record, COMMON + 2, tuple, "sphere direction")
        pole = field(record, COMMON + 3, tuple, "sphere pole")
        if not 1e-12 < abs(radius) < MAX_COORD:
            raise FusionImportError("The Fusion geometry has a sphere with an invalid radius.")
        return Geom_SphericalSurface(_ax3(center, pole, origin, left_handed=radius < 0), abs(radius) * MM)
    if kind == "torus-surface":
        center = _vec(field(record, COMMON, tuple, "torus centre"), "torus centre")
        normal = field(record, COMMON + 1, tuple, "torus axis")
        major = field(record, COMMON + 2, float, "torus radius")
        minor = field(record, COMMON + 3, float, "torus radius")
        origin = field(record, COMMON + 4, tuple, "torus direction")
        if not (abs(major) < MAX_COORD and 1e-12 < abs(minor) < MAX_COORD):
            raise FusionImportError("The Fusion geometry has a torus with an invalid radius.")
        if major <= 0 or abs(minor) >= major:
            raise FusionImportError("The Fusion geometry has a self-intersecting (lemon or apple) torus, which STEVE can't import yet.")
        return Geom_ToroidalSurface(_ax3(center, normal, origin, left_handed=minor < 0), major * MM, abs(minor) * MM)
    if kind == "spline-surface":
        return _spline_surface(record)
    raise FusionImportError(f"The Fusion geometry has a {_entity_name(kind)}, which STEVE can't import yet.")


def curve(record: Record):
    """The OCCT curve of an ACIS curve record (parameterised in the curve's own direction)."""
    from OCP.Geom import Geom_Circle, Geom_Ellipse, Geom_Line
    gp = _gp()
    kind = record.type
    if kind == "straight-curve":
        root = _vec(field(record, COMMON, tuple, "line origin"), "line origin")
        direction = _unit(field(record, COMMON + 1, tuple, "line direction"), "line")
        return Geom_Line(gp.gp_Pnt(*_scaled(root)), gp.gp_Dir(*direction))
    if kind == "ellipse-curve":
        center = _vec(field(record, COMMON, tuple, "ellipse centre"), "ellipse centre")
        normal = field(record, COMMON + 1, tuple, "ellipse normal")
        major = _vec(field(record, COMMON + 2, tuple, "ellipse major axis"), "ellipse radius")
        ratio = field(record, COMMON + 3, float, "ellipse ratio")
        radius = math.sqrt(_dot(major, major))
        if not radius > 1e-12 or not 1e-9 < ratio < 1e6:
            raise FusionImportError("The Fusion geometry has an ellipse with an invalid size.")
        frame = _ax3(center, normal, major)
        ax2 = gp.gp_Ax2(frame.Location(), frame.Direction(), frame.XDirection())
        if abs(ratio - 1.0) < 1e-12:
            return Geom_Circle(ax2, radius * MM)
        if ratio <= 1.0:
            return Geom_Ellipse(ax2, radius * MM, radius * ratio * MM)
        # The minor axis is the longer one: OCCT wants the major first, a quarter turn on.
        y = frame.YDirection()
        swapped = gp.gp_Ax2(frame.Location(), frame.Direction(), y)
        return Geom_Ellipse(swapped, radius * ratio * MM, radius * MM)
    if kind == "intcurve-curve":
        return _spline_curve(record)
    raise FusionImportError(f"The Fusion geometry has a {_entity_name(kind)}, which STEVE can't import yet.")


def _entity_name(kind: str) -> str:
    return re.sub(r"[^\w\- ]", "", kind)[:60] + " entity"


# ----------------------------------------------------- exact B-splines (`exactsur`, `exactcur`)


class _Cursor:
    """Reads sub-type tokens in order."""

    def __init__(self, tokens, what):
        self.tokens, self.i, self.what = tokens, 0, what

    def fail(self, detail="unexpected data"):
        return FusionImportError(f"The Fusion geometry's {self.what} has {detail}; STEVE can't import it exactly.")

    def peek(self):
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def take(self):
        if self.i >= len(self.tokens):
            raise self.fail("missing data")
        value = self.tokens[self.i]
        self.i += 1
        return value

    def word(self):
        value = self.take()
        if isinstance(value, (str, Ident)):
            return str(value)
        if isinstance(value, bool):
            return "T" if value else "F"
        if isinstance(value, Enum):
            return int(value)
        raise self.fail()

    def integer(self, low, high):
        value = self.take()
        if isinstance(value, bool) or not isinstance(value, int) or isinstance(value, Ptr) or not low <= value <= high:
            raise self.fail("an invalid count")
        return int(value)

    def number(self):
        value = self.take()
        if isinstance(value, bool) or not isinstance(value, (int, float)) or isinstance(value, Ptr):
            raise self.fail()
        value = float(value)
        _finite(value)
        return value

    def point(self, rational):
        value = self.peek()
        if isinstance(value, tuple) and len(value) == 3:
            self.i += 1
            xyz = value
            _finite(*xyz)
        else:
            xyz = (self.number(), self.number(), self.number())
        _vec(xyz, "spline control point")
        weight = self.number() if rational else 1.0
        if rational and not 1e-12 < weight < 1e12:
            raise self.fail("an invalid weight")
        return xyz, weight


def _subtype(record: Record, start: int, keyword: str):
    """The tokens inside the record's `{ … }` that follow `keyword` (e.g. exactsur)."""
    fields = record.fields
    try:
        begin = next(i for i in range(start, len(fields)) if fields[i] is BEGIN)
    except StopIteration:
        raise FusionImportError(f"The Fusion geometry's {record.type} (${record.index}) has no spline data.") from None
    head = fields[begin + 1] if begin + 1 < len(fields) else None
    name = str(head) if isinstance(head, str) else ""
    if name != keyword:
        what = "surface" if record.type.endswith("surface") else "curve"
        raise FusionImportError(f"The Fusion geometry has a procedural {name or 'spline'} {what} without exact B-spline data, which STEVE "
                                "can't import exactly yet.")
    depth, end = 0, None
    for i in range(begin, len(fields)):
        if fields[i] is BEGIN:
            depth += 1
        elif fields[i] is END:
            depth -= 1
            if depth == 0:
                end = i
                break
    if end is None:
        raise FusionImportError(f"The Fusion geometry's {record.type} (${record.index}) has unbalanced spline data.")
    return fields[begin + 2:end]


def _knots(cursor, count, degree):
    from OCP.collections import Array1_double, Array1_int
    values, mults = [], []
    for _ in range(count):
        values.append(cursor.number())
        mults.append(cursor.integer(1, degree + 1))
    if any(b <= a for a, b in zip(values, values[1:])):
        raise cursor.fail("knots out of order")
    # ACIS writes end knots with multiplicity `degree`; OCCT clamps them with `degree + 1`.
    if mults[0] == degree:
        mults[0] = degree + 1
    if mults[-1] == degree:
        mults[-1] = degree + 1
    if mults[0] != degree + 1 or mults[-1] != degree + 1:
        raise cursor.fail("an unclamped knot vector")
    k = Array1_double(1, count)
    m = Array1_int(1, count)
    for i, (value, mult) in enumerate(zip(values, mults), 1):
        k.SetValue(i, value)
        m.SetValue(i, mult)
    return k, m, sum(mults) - degree - 1


def _bs_header(cursor, dims):
    """`full`? then `nubs`/`nurbs`, degrees, closures, singularities (surfaces), knot counts."""
    word = cursor.word()
    if word in ("full", "summary", "nullbs", "none"):
        if word in ("nullbs", "none"):
            raise cursor.fail("no B-spline data")
        word = cursor.word()
    if word not in ("nubs", "nurbs"):
        raise cursor.fail("an unknown spline form")
    rational = word == "nurbs"
    degrees = [cursor.integer(1, 25) for _ in range(dims)]
    closures = [cursor.word() for _ in range(dims)]
    if any(c not in ("open", "closed", "periodic") for c in closures):
        raise cursor.fail("an unknown closure")
    if "periodic" in closures:
        raise cursor.fail("periodic B-spline data")
    if dims == 2:
        for _ in range(2):
            if cursor.word() not in ("none", "singular", "both", "start", "end"):
                raise cursor.fail("an unknown singularity")
    counts = [cursor.integer(2, 100000) for _ in range(dims)]
    return rational, degrees, counts


def _spline_curve(record: Record):
    from OCP.Geom import Geom_BSplineCurve
    from OCP.collections import Array1_double, Array1_gp_Pnt
    gp = _gp()
    reversed_ = record.fields[COMMON] if len(record.fields) > COMMON and isinstance(record.fields[COMMON], bool) else False
    cursor = _Cursor(_subtype(record, COMMON, "exactcur"), "spline curve")
    rational, (degree,), (count,) = _bs_header(cursor, 1)
    knots, mults, poles = _knots(cursor, count, degree)
    if poles < degree + 1 or poles > 1_000_000:
        raise cursor.fail("an invalid number of control points")
    points = Array1_gp_Pnt(1, poles)
    weights = Array1_double(1, poles)
    for i in range(1, poles + 1):
        xyz, w = cursor.point(rational)
        points.SetValue(i, gp.gp_Pnt(*_scaled(xyz)))
        weights.SetValue(i, w)
    try:
        bs = Geom_BSplineCurve(points, weights, knots, mults, degree) if rational else Geom_BSplineCurve(points, knots, mults, degree)
    except Exception as error:
        raise cursor.fail("an invalid B-spline") from error
    if reversed_:
        bs.Reverse()
    return bs


def _spline_surface(record: Record):
    from OCP.Geom import Geom_BSplineSurface
    from OCP.collections import Array2_double, Array2_gp_Pnt
    gp = _gp()
    reversed_ = record.fields[COMMON] if len(record.fields) > COMMON and isinstance(record.fields[COMMON], bool) else False
    cursor = _Cursor(_subtype(record, COMMON, "exactsur"), "spline surface")
    rational, (du, dv), (cu, cv) = _bs_header(cursor, 2)
    uk, um, nu = _knots(cursor, cu, du)
    vk, vm, nv = _knots(cursor, cv, dv)
    if nu < du + 1 or nv < dv + 1 or nu * nv > 4_000_000:
        raise cursor.fail("an invalid number of control points")
    points = Array2_gp_Pnt(1, nu, 1, nv)
    weights = Array2_double(1, nu, 1, nv)
    for i in range(1, nu + 1):  # u slowest, v fastest
        for j in range(1, nv + 1):
            xyz, w = cursor.point(rational)
            points.SetValue(i, j, gp.gp_Pnt(*_scaled(xyz)))
            weights.SetValue(i, j, w)
    try:
        bs = (Geom_BSplineSurface(points, weights, uk, vk, um, vm, du, dv) if rational
              else Geom_BSplineSurface(points, uk, vk, um, vm, du, dv))
    except Exception as error:
        raise cursor.fail("an invalid B-spline") from error
    if reversed_:  # ACIS `reversed`: the surface normal is the opposite of the parametric one.
        bs.UReverse()
    return bs


# ---------------------------------------------------------------- topology


class _Builder:
    """Builds OCCT solids from one blob's bodies, sharing vertices and edges between faces."""

    def __init__(self, ents: Entities, clock: _Clock):
        self.ents, self.clock = ents, clock
        self.vertices, self.edges, self.curves, self.surfaces = {}, {}, {}, {}
        # Surface (sheet) bodies left out of the import: their faces, placed, so the display check can set their mesh
        # aside rather than take it for a solid's.
        self.sheets = []
        from OCP.BRep import BRep_Builder
        self.bb = BRep_Builder()

    def vertex(self, ptr):
        if ptr not in self.vertices:
            from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
            record = self.ents.get(ptr, "vertex", "edge vertex")
            point = self.ents.get(field(record, VERTEX_POINT, Ptr, "vertex point"), "point", "vertex point")
            xyz = _vec(field(point, POINT_POSITION, tuple, "point"), "point")
            self.vertices[ptr] = (BRepBuilderAPI_MakeVertex(_gp().gp_Pnt(*_scaled(xyz))).Vertex(), _scaled(xyz))
        return self.vertices[ptr]

    def curve(self, ptr):
        if ptr not in self.curves:
            self.curves[ptr] = curve(self.ents.get(ptr, "curve", "edge curve"))
        return self.curves[ptr]

    def edge(self, ptr):
        """The edge from its start vertex to its end vertex (TopoDS orientation carries ACIS's edge sense)."""
        if ptr in self.edges:
            return self.edges[ptr]
        from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
        from OCP.GeomAPI import GeomAPI_ProjectPointOnCurve
        record = self.ents.get(ptr, "edge", "coedge edge")
        start, p_start = self.vertex(field(record, EDGE_START, Ptr, "edge start"))
        end, p_end = self.vertex(field(record, EDGE_END, Ptr, "edge end"))
        reversed_ = field(record, EDGE_SENSE, bool, "edge sense")
        geom = self.curve(field(record, EDGE_CURVE, Ptr, "edge curve"))
        gp = _gp()

        def param(xyz):
            projector = GeomAPI_ProjectPointOnCurve(gp.gp_Pnt(*xyz), geom)
            if projector.NbPoints() < 1:
                raise FusionImportError(f"The Fusion geometry has an edge whose end isn't on its curve (${ptr}).")
            best = min(range(1, projector.NbPoints() + 1), key=lambda k: projector.Distance(k))
            if projector.Distance(best) > 1e-3 * max(1.0, _size(xyz)):
                raise FusionImportError(f"The Fusion geometry has an edge whose end isn't on its curve (${ptr}).")
            return projector.Parameter(best)

        # Along the curve's own direction: from a to b. A reversed edge runs from its end to its start on the curve.
        first, last = (end, start) if reversed_ else (start, end)
        p_first, p_last = (p_end, p_start) if reversed_ else (p_start, p_end)
        closed = start.IsSame(end)
        a = param(p_first)
        periodic = geom.IsPeriodic()
        if closed:
            if not periodic:
                b = None
                if geom.IsClosed():
                    a, b = geom.FirstParameter(), geom.LastParameter()
                else:
                    raise FusionImportError(f"The Fusion geometry has a closed edge on an open curve (${ptr}).")
            else:
                b = a + geom.Period()
        else:
            b = param(p_last)
            if periodic:
                period = geom.Period()
                while b <= a + 1e-12:
                    b += period
                while b - a > period + 1e-12:
                    b -= period
            elif b <= a:
                # Open splines and lines: the projection must already run forward.
                raise FusionImportError(f"The Fusion geometry has an edge running against its curve (${ptr}).")
        maker = BRepBuilderAPI_MakeEdge(geom, first, last, a, b)
        if not maker.IsDone():
            raise FusionImportError(f"The Fusion geometry has an edge STEVE can't rebuild (${ptr}).")
        shape = maker.Edge()
        if reversed_:
            shape = shape.Reversed()
        self.edges[ptr] = shape
        return shape

    def wire(self, loop):
        from OCP.TopoDS import TopoDS_Wire
        ents = self.ents
        first = ents.get(field(loop, LOOP_COEDGE, Ptr, "loop coedge"), "coedge", "loop coedge")
        wire = TopoDS_Wire()
        self.bb.MakeWire(wire)
        ptr, seen = first.index, set()
        while True:
            if ptr in seen:
                break
            seen.add(ptr)
            if len(seen) > MAX_LIST:
                raise FusionImportError("The Fusion geometry has a loop with too many edges.")
            coedge = ents.get(ptr, "coedge", "loop coedge")
            if field(coedge, COEDGE_LOOP, Ptr, "coedge loop") != loop.index:
                raise FusionImportError(f"The Fusion geometry has a loop whose edges belong elsewhere (${ptr}).")
            edge = self.edge(field(coedge, COEDGE_EDGE, Ptr, "coedge edge"))
            if field(coedge, COEDGE_SENSE, bool, "coedge sense"):
                edge = edge.Reversed()
            self.bb.Add(wire, edge)
            ptr = field(coedge, COEDGE_NEXT, Ptr, "coedge next")
            if ptr == -1:
                break
        if ptr != first.index:
            raise FusionImportError("The Fusion geometry has a loop that isn't closed.")
        return wire

    def face(self, record, sheet=False):
        from OCP.TopAbs import TopAbs_REVERSED
        from OCP.TopoDS import TopoDS_Face
        ents = self.ents
        if not sheet and field(record, FACE_SIDES, bool, "face sides"):
            raise FusionImportError("The Fusion body has a double-sided (sheet) face; only closed solids are imported.")
        sptr = field(record, FACE_SURFACE, Ptr, "face surface")
        if sptr not in self.surfaces:
            self.surfaces[sptr] = surface(ents, ents.get(sptr, "surface", "face surface"))
        geom = self.surfaces[sptr]
        face = TopoDS_Face()
        self.bb.MakeFace(face, geom, 1e-7)
        loops = ents.chain(field(record, FACE_LOOP, Ptr, "face loop"), "loop", "face loop", LOOP_NEXT)
        if not loops:
            raise FusionImportError("The Fusion geometry has a face without edges (an unbounded surface).")
        # ACIS orients a loop around the face's own normal (the surface normal, flipped by a reversed sense); OCCT
        # orients the wires of the face's forward (surface) side and reverses the whole face.
        reversed_ = field(record, FACE_SENSE, bool, "face sense")
        for loop in loops:
            wire = self.wire(loop)
            self.bb.Add(face, wire.Reversed() if reversed_ else wire)
        if reversed_:
            face.Orientation(TopAbs_REVERSED)
        self._pcurves(face)
        return face

    def _pcurves(self, face):
        """Adds each edge's 2-D curve on this face, projected from the exact 3-D curve, to the shared edge (a seam,
        an edge used twice by the face, gets both)."""
        from OCP.ShapeFix import ShapeFix_Edge
        from OCP.TopAbs import TopAbs_EDGE
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopoDS import TopoDS
        from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher
        seen = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()  # IsSame: the same edge, whatever its orientation
        uses = []
        explorer = TopExp_Explorer(face, TopAbs_EDGE)
        while explorer.More():
            index = seen.Add(explorer.Current())
            if index > len(uses):
                uses.append(0)
            uses[index - 1] += 1
            explorer.Next()
        fixer = ShapeFix_Edge()
        for index in range(1, seen.Extent() + 1):
            edge = TopoDS.Edge(seen.FindKey(index))
            fixer.FixAddPCurve(edge, face, uses[index - 1] > 1, 1e-7)
            if fixer.Status(_failed()):
                raise FusionImportError("The Fusion geometry has an edge STEVE couldn't place on its face.")

    def body(self, record):
        """[(cq.Solid, lump index)] for a body: one solid per lump."""
        ents = self.ents
        if field(record, BODY_WIRE, Ptr, "body wire") != -1 and field(record, BODY_LUMP, Ptr, "body lump") == -1:
            raise FusionImportError("The Fusion body is a wire body, not a solid.")
        transform = ents.opt(field(record, BODY_TRANSFORM, Ptr, "body transform"), "transform", "body transform")
        trsf = _transform(transform) if transform is not None else None
        solids = []
        for lump in ents.chain(field(record, BODY_LUMP, Ptr, "body lump"), "lump", "body lump", LUMP_NEXT):
            self.clock.check()
            shells = ents.chain(field(lump, LUMP_SHELL, Ptr, "lump shell"), "shell", "lump shell", SHELL_NEXT)
            if self._sheet(shells, trsf):  # A surface body: left out, with a note (Design.skipped).
                continue
            built = []
            for shell in shells:
                if field(shell, SHELL_SUBSHELL, Ptr, "subshell") != -1:
                    raise FusionImportError("The Fusion body uses subshells, which STEVE can't import yet.")
                faces = ents.chain(field(shell, SHELL_FACE, Ptr, "shell face"), "face", "shell face", FACE_NEXT)
                if not faces:
                    continue
                if field(shell, SHELL_WIRE, Ptr, "shell wire") != -1:
                    raise FusionImportError("The Fusion body has loose wire edges; only closed solids are imported.")
                built.append(_seamed([self.face(face) for face in faces]))
            if built:
                solids.append(_solid(built, trsf))
        return solids


    def _sheet(self, shells, trsf) -> bool:
        """Whether a lump is a surface (sheet) body: every face double-sided. Its faces are kept in `sheets` (placed),
        for the display check only; nothing of it is imported. A lump mixing sheet and solid faces is no sheet: the
        face check refuses it as before."""
        from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
        from OCP.TopoDS import TopoDS_Compound
        ents = self.ents
        faces = [face for shell in shells for face in ents.chain(field(shell, SHELL_FACE, Ptr, "shell face"), "face", "shell face", FACE_NEXT)]
        if not faces or not all(field(face, FACE_SIDES, bool, "face sides") for face in faces):
            return False
        try:
            compound = TopoDS_Compound()
            self.bb.MakeCompound(compound)
            for face in faces:
                self.bb.Add(compound, self.face(face, sheet=True))
            shape = BRepBuilderAPI_Transform(compound, trsf, False).Shape() if trsf is not None else compound
        except FusionImportError:
            raise FusionImportError("The Fusion file has a surface body STEVE couldn't read, so the import can't be checked "
                                    "against its display; thicken or delete it in Fusion and save the design again.") from None
        self.sheets.append(shape)
        return True


def _failed():
    from OCP.ShapeExtend import ShapeExtend_Status
    return ShapeExtend_Status.ShapeExtend_FAIL


def _seamed(faces):
    """Periodic faces bounded by loops alone (ACIS needs no seam; OCCT does) get their seam edge. One shared
    context records every edge a face replaces, so its neighbours take the same new edges."""
    from OCP.ShapeBuild import ShapeBuild_ReShape
    from OCP.ShapeFix import ShapeFix_Face
    from OCP.TopoDS import TopoDS
    context = ShapeBuild_ReShape()
    for face in faces:
        fixer = ShapeFix_Face(face)
        fixer.SetContext(context)
        fixer.FixOrientationMode = 0
        fixer.FixSplitFaceMode = 0
        fixer.FixMissingSeamMode = 1
        fixer.Perform()
    return [TopoDS.Face(context.Apply(face)) for face in faces]


def _size(xyz):
    return max(abs(xyz[0]), abs(xyz[1]), abs(xyz[2]))


def _transform(record: Record):
    """A body's placement (rotation and translation, in mm); reflections, shears and scales are refused."""
    gp = _gp()
    base = 2  # A transform has no owner field: attribute, history id, then the matrix.
    rows = [field(record, base + k, tuple, "transform") for k in range(3)]
    shift = _vec(field(record, base + 3, tuple, "transform translation"), "transform translation")
    scale = field(record, base + 4, float, "transform scale")
    flags = [field(record, base + 5 + k, bool, "transform flags") for k in range(3)]
    if abs(scale - 1.0) > 1e-9 or flags[1] or flags[2]:
        raise FusionImportError("The Fusion body has a scaled, mirrored or sheared placement, which STEVE can't import yet.")
    for i in range(3):
        for j in range(3):
            expected = 1.0 if i == j else 0.0
            if abs(_dot(rows[i], rows[j]) - expected) > 1e-6:
                raise FusionImportError("The Fusion body has a placement that isn't a rotation.")
    if _dot(_cross(rows[0], rows[1]), rows[2]) < 0:
        raise FusionImportError("The Fusion body has a mirrored placement, which STEVE can't import yet.")
    trsf = gp.gp_Trsf()
    # ACIS rows: p' = p · R + t (row vectors), so OCCT's matrix is the transpose.
    trsf.SetValues(rows[0][0], rows[1][0], rows[2][0], shift[0] * MM,
                   rows[0][1], rows[1][1], rows[2][1], shift[1] * MM,
                   rows[0][2], rows[1][2], rows[2][2], shift[2] * MM)
    return trsf


def _solid(shells_faces, trsf):
    """Shells of faces → one valid, closed, outward solid."""
    import cadquery as cq
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepLib import BRepLib
    from OCP.ShapeAnalysis import ShapeAnalysis_Shell
    from OCP.ShapeFix import ShapeFix_Shape
    from OCP.TopoDS import TopoDS, TopoDS_Shell, TopoDS_Solid
    from OCP.BRep import BRep_Builder
    bb = BRep_Builder()
    solid = TopoDS_Solid()
    bb.MakeSolid(solid)
    for faces in shells_faces:
        shell = TopoDS_Shell()
        bb.MakeShell(shell)
        for face in faces:
            bb.Add(shell, face)
        checker = ShapeAnalysis_Shell()
        checker.LoadShells(shell)
        if checker.CheckOrientedShells(shell, True):
            raise FusionImportError("A Fusion body's faces disagree about which side is inside.")
        if not _closed(shell):
            raise FusionImportError("A Fusion body isn't closed (it has open edges); only closed solids are imported.")
        bb.Add(solid, shell)
    if not BRepLib.OrientClosedSolid_s(solid):
        raise FusionImportError("A Fusion body couldn't be made into a solid (its shells don't enclose a volume).")
    # The faces' 2-D curves (pcurves) are computed by projection, and seams added to periodic faces bounded by loops
    # only (ACIS needs no seam), through one shared context so that edges stay shared between faces.
    whole = ShapeFix_Shape(solid)
    whole.Perform()
    found = cq.Shape.cast(whole.Shape()).Solids()
    if len(found) != 1:
        raise FusionImportError("A Fusion body couldn't be made into one solid.")
    solid = found[0].wrapped
    if trsf is not None:
        solid = TopoDS.Solid(BRepBuilderAPI_Transform(solid, trsf, False).Shape())
    if not BRepCheck_Analyzer(solid).IsValid():
        raise FusionImportError("A Fusion body didn't rebuild as a valid solid in STEVE's geometry kernel.")
    result = cq.Solid(solid)
    if not result.Volume() > 0:
        raise FusionImportError("A Fusion body rebuilt with no volume.")
    return result


def _closed(shell) -> bool:
    from OCP.ShapeAnalysis import ShapeAnalysis_FreeBounds
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    free = ShapeAnalysis_FreeBounds(shell, 1e-4, False, False)
    explorer = TopExp_Explorer(free.GetClosedWires(), TopAbs_EDGE)
    if explorer.More():
        return False
    explorer = TopExp_Explorer(free.GetOpenWires(), TopAbs_EDGE)
    return not explorer.More()


def solids_of(blob: Blob, label: str, clock: _Clock | None = None, sheets: list | None = None) -> list:
    """Every solid of a blob's bodies, in body then lump order: [cq.Solid]. Surface (sheet) bodies are left out; given
    a `sheets` list, their placed faces are added to it."""
    clock = clock or _Clock()
    ents = Entities(blob, label)
    builder = _Builder(ents, clock)
    builder.sheets = sheets if sheets is not None else []
    out = []
    for record in blob.records:
        if record.type == "body":
            out.extend(builder.body(record))
            if len(out) > MAX_SOLIDS:
                raise FusionImportError(f"The Fusion file has more than {MAX_SOLIDS} solids.")
    return out


# ---------------------------------------------------------------- display mesh (the gate)

FACE_NODE = struct.pack("<I", 4) + "Face".encode("utf-16-le")


def display_faces(world: bytes, mesh: bytes, clock: _Clock | None = None) -> list:
    """The display mesh of each B-rep face Fusion drew: [(vertices [(x, y, z) mm], triangles [(i, j, k)])].
    Each `Face` node of the scene names its block of `Fusion_mesh_000`: byte offset, then the position, normal
    and texture float counts (interleaved per vertex) and the index count (32-bit)."""
    clock = clock or _Clock()
    out = []
    start = 0
    budget = [MAX_MESH_VALUES]
    while True:
        at = world.find(FACE_NODE, start)
        if at < 0:
            break
        start = at + len(FACE_NODE)
        block = _mesh_block(world, start, mesh, budget)
        if block is None:
            raise FusionImportError("The Fusion file's display mesh isn't in a form STEVE recognises, so the import can't be checked.")
        out.append(block)
        if len(out) % 256 == 0:
            clock.check()
        if len(out) > 1_000_000:
            raise FusionImportError("The Fusion file's display mesh is too large.")
    return out


def _mesh_block(world, start, mesh, budget):
    """The first plausible block reference within 192 bytes after a `Face` node name. Every vertex and index read
    counts against `budget` (one list: the values left for the whole scene)."""
    for at in range(start, min(start + 192, len(world) - 20)):
        offset, positions, normals, uvs, indices = struct.unpack_from("<5I", world, at)
        if not positions or positions != normals or positions % 3 or indices % 3 or not indices:
            continue
        count = positions // 3
        if uvs not in (0, 2 * count):
            continue
        stride = (positions + normals + uvs) // count * 4
        end = offset + count * stride + indices * 4
        if end > len(mesh):
            continue
        budget[0] -= count + indices
        if budget[0] < 0:
            raise FusionImportError("The Fusion file's display mesh is too large to check the import against.")
        vertices = []
        for k in range(count):
            x, y, z = struct.unpack_from("<3f", mesh, offset + k * stride)
            if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z)):
                break
            vertices.append((x * MM, y * MM, z * MM))
        else:
            index = struct.unpack_from(f"<{indices}I", mesh, offset + count * stride)
            if max(index) < count:
                return vertices, [index[k:k + 3] for k in range(0, indices, 3)]
    return None


def _mesh_volume(blocks):
    volume = 0.0
    for vertices, triangles in blocks:
        for i, j, k in triangles:
            a, b, c = vertices[i], vertices[j], vertices[k]
            volume += _dot(a, _cross(b, c)) / 6.0
    return volume


def check_against_mesh(solids, blocks, sheets=()) -> list[dict]:
    """Refuses the import unless each solid matches the display mesh Fusion drew for it. Mesh faces go to the solid
    whose boundary they lie on; a mesh face lying on a left-out surface body (`sheets`, placed faces) closer than on
    any solid is set aside. Then, per solid:
    - sampled mesh vertices lie within SURFACE_TOLERANCE_MM of the solid's boundary (tessellation vertices are
      points of the true surface);
    - the mesh's enclosed volume is within VOLUME_TOLERANCE of the volume the solid predicts for that mesh: the
      solid's volume less the chordal slivers between the flat triangles and the true surface (estimated from
      sampled triangles: area times the signed gap at the centre, inside or outside the solid);
    - the bounds agree within BOUNDS_TOLERANCE of the diagonal plus the largest chordal gap."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    from OCP.TopAbs import TopAbs_IN
    gp = _gp()
    if not blocks:
        raise FusionImportError("The Fusion file has no display mesh of its bodies, so the import can't be checked. Show the bodies "
                                "in Fusion and save the design again.")
    def distance(shape, xyz):
        vertex = BRepBuilderAPI_MakeVertex(gp.gp_Pnt(*xyz)).Vertex()
        tool = BRepExtrema_DistShapeShape(vertex, shape)
        return tool.Value() if tool.IsDone() else math.inf

    def boundary(solid):
        from OCP.TopoDS import TopoDS_Compound
        from OCP.BRep import BRep_Builder
        bb = BRep_Builder()
        compound = TopoDS_Compound()
        bb.MakeCompound(compound)
        for face in solid.Faces():
            bb.Add(compound, face.wrapped)
        return compound

    faces = [boundary(solid) for solid in solids]
    owners = [[] for _ in solids]
    for vertices, triangles in blocks:
        probe = vertices[len(vertices) // 2]
        if sheets:  # A surface body's own display: not checked against any solid (it isn't imported).
            sheet = min(distance(shape, probe) for shape in sheets)
            if sheet <= SURFACE_TOLERANCE_MM and sheet < min(distance(shape, probe) for shape in faces):
                continue
        if len(solids) == 1:
            owner = 0
        else:
            owner = min(range(len(solids)), key=lambda k: distance(faces[k], probe))
        owners[owner].append((vertices, triangles))
    report = []
    for k, solid in enumerate(solids):
        mine = owners[k]
        number = f"solid {k + 1}" if len(solids) > 1 else "the solid"
        if not mine:
            raise FusionImportError(f"The Fusion file has no display mesh for {number}, so it can't be checked. Show every body in "
                                    "Fusion and save the design again.")
        bb = solid.BoundingBox()
        diagonal = math.sqrt(bb.xlen ** 2 + bb.ylen ** 2 + bb.zlen ** 2)
        # Vertices on the boundary.
        points = [p for vertices, _ in mine for p in vertices]
        step = max(1, len(points) // SURFACE_SAMPLES)
        worst = max(distance(faces[k], p) for p in points[::step])
        tolerance = SURFACE_TOLERANCE_MM + 1e-6 * diagonal
        if worst > tolerance:
            raise FusionImportError(f"The rebuilt {number} doesn't match Fusion's own display of it (the display lies {worst:.3g} mm off "
                                    "its surface), so it isn't imported.")
        # Chordal slivers: the volume between the flat triangles and the true surface, estimated from sampled
        # triangles (area times the signed gap at the centre) and scaled to the whole mesh's area.
        area, sampled_area, swept, gap = 0.0, 0.0, 0.0, 0.0
        triangles = [(vertices, t) for vertices, ts in mine for t in ts]
        step = max(1, len(triangles) // SURFACE_SAMPLES)
        for n, (vertices, (i, j, l)) in enumerate(triangles):
            a, b, c = vertices[i], vertices[j], vertices[l]
            cross = _cross((b[0] - a[0], b[1] - a[1], b[2] - a[2]), (c[0] - a[0], c[1] - a[1], c[2] - a[2]))
            piece = 0.5 * math.sqrt(_dot(cross, cross))
            area += piece
            if n % step == 0:
                centre = ((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3)
                here = distance(faces[k], centre)
                gap = max(gap, here)
                if here > 1e-9:  # Inside the solid, the mesh misses that sliver; outside, it adds it.
                    classifier = BRepClass3d_SolidClassifier(solid.wrapped, gp.gp_Pnt(*centre), 1e-9)
                    swept += piece * here * (1.0 if classifier.State() == TopAbs_IN else -1.0)
                sampled_area += piece
        chordal = swept * area / sampled_area if sampled_area > 0 else 0.0
        mesh_volume = abs(_mesh_volume(mine))
        volume = solid.Volume()
        expected = volume - chordal  # The mesh's volume the solid predicts, given the mesh's chordal gaps.
        if abs(mesh_volume - expected) > VOLUME_TOLERANCE * volume:
            raise FusionImportError(f"The rebuilt {number} doesn't match Fusion's own display of it (volume {volume:.6g} mm³, display "
                                    f"{mesh_volume:.6g} mm³), so it isn't imported.")
        lo = [min(p[q] for p in points) for q in range(3)]
        hi = [max(p[q] for p in points) for q in range(3)]
        brep = [bb.xmin, bb.ymin, bb.zmin, bb.xmax, bb.ymax, bb.zmax]
        mesh_bounds = lo + hi
        off = max(abs(x - y) for x, y in zip(brep, mesh_bounds))
        if off > BOUNDS_TOLERANCE * diagonal + gap + SURFACE_TOLERANCE_MM:
            raise FusionImportError(f"The rebuilt {number} doesn't match Fusion's own display of it (its bounds differ by {off:.3g} mm), "
                                    "so it isn't imported.")
        report.append({"volume_mm3": volume, "mesh_volume_mm3": mesh_volume, "expected_mesh_volume_mm3": expected,
                       "volume_difference": abs(mesh_volume - expected) / volume,
                       "surface_gap_mm": worst, "chordal_gap_mm": gap, "bounds_gap_mm": off, "mesh_faces": len(mine)})
    return report


# ---------------------------------------------------------------- design stream extras (data only)

_LENGTH_UNITS = {"mm": 10.0, "cm": 1.0, "m": 0.01, "in": 1 / 2.54, "ft": 1 / 30.48, "um": 1e4, "mil": 1000 / 2.54}
_ANGLE_UNITS = {"deg": 180 / math.pi, "rad": 1.0}
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,99}")
FEATURE_TYPES = ("Sketch", "Extrude", "Revolve", "Sweep", "Loft", "Rib", "Web", "Hole", "Thread", "Box", "Cylinder", "Sphere",
                 "Torus", "Coil", "Pipe", "Fillet", "Chamfer", "Shell", "Draft", "Scale", "Combine", "Split Body", "Split Face",
                 "Move", "Align", "Mirror", "Pattern", "Rectangular Pattern", "Circular Pattern", "Pattern on Path", "Thicken",
                 "Boundary Fill", "Replace Face", "Offset Face", "Press Pull", "Delete", "Joint", "As-built Joint", "Rigid Group",
                 "Plane", "Axis", "Point", "Construction Plane", "Construction Axis", "Construction Point", "Emboss", "Patch",
                 "Stitch", "Unstitch", "Trim", "Extend", "Remove", "Base Feature", "Form", "Physical Material", "Appearance",
                 "Flange", "Bend", "Unfold", "Refold", "Flat Pattern", "Silhouette Split", "Derive")


def _text(value: str) -> str:
    value = "".join(ch for ch in value if ch.isprintable() or ch == " ")
    return " ".join(value.split())[:MAX_TEXT]


def _utf16_at(data: bytes, pos: int, max_chars: int = 2000):
    """(text, end) for a u32-length-prefixed UTF-16 string at pos, or None."""
    if pos < 0 or pos + 4 > len(data):
        return None
    length = struct.unpack_from("<I", data, pos)[0]
    if length > max_chars or pos + 4 + 2 * length > len(data):
        return None
    raw = data[pos + 4:pos + 4 + 2 * length]
    try:
        text = raw.decode("utf-16-le")
    except UnicodeDecodeError:
        return None
    if any(ord(ch) < 0x20 and ch not in "\t" for ch in text):
        return None
    return text, pos + 4 + 2 * length


def _utf16_ending(data: bytes, end: int, max_chars: int = 2000, min_chars: int = 1):
    """(text, start) for a u32-length-prefixed UTF-16 string ending exactly at `end`, or None."""
    for length in range(min_chars, max_chars + 1):
        pos = end - 2 * length - 4
        if pos < 0:
            return None
        if struct.unpack_from("<I", data, pos)[0] == length:
            found = _utf16_at(data, pos, max_chars)
            if found and found[1] == end:
                return found[0], pos
    return None


def _value_in(unit: str, internal: float):
    unit = unit.strip()
    if unit in _LENGTH_UNITS:
        return internal * _LENGTH_UNITS[unit]
    if unit in _ANGLE_UNITS:
        return internal * _ANGLE_UNITS[unit]
    if unit == "":
        return internal
    return None


def parameters(stream: bytes, clock: _Clock | None = None) -> list[dict]:
    """User and model parameters: [{name, expression, value, unit, comment, kind}] (kind user | model). Each record
    ends `<role> 0000 <unit> <name> <f64 internal value> 00 01 10`, with the expression ten bytes (nine zeros and a
    flag) before the role, and for user parameters the comment before the expression."""
    clock = clock or _Clock()
    out, seen = [], set()
    pos, tried = 0, 0
    tail = b"\x00\x01\x10"
    while len(out) < MAX_PARAMETERS:
        pos = stream.find(tail, pos)
        if pos < 0:
            break
        here, pos = pos, pos + 1
        tried += 1
        if tried > MAX_CANDIDATES:
            break
        if not tried % 1024:
            clock.check()
        value_at = here - 8
        name = _utf16_ending(stream, value_at, 100)
        if not name or not _IDENT.fullmatch(name[0]):
            continue
        unit = _utf16_ending(stream, name[1], 40, 0)
        if unit is None:
            continue
        if stream[unit[1] - 4:unit[1]] != b"\x00\x00\x00\x00":
            continue
        role = _utf16_ending(stream, unit[1] - 4, 200)
        if role is None:
            continue
        gap_end = role[1]
        user = role[0] == "User Parameter"
        if stream[gap_end - 10:gap_end - 1] != b"\x00" * 9 or stream[gap_end - 1] not in (0, 1):
            continue
        expression = _utf16_ending(stream, gap_end - 10, 2000)
        if expression is None:
            continue
        comment = None
        if user and stream[expression[1] - 1:expression[1]] == b"\x00":
            comment = _utf16_ending(stream, expression[1] - 5, 2000, 0)
        internal = struct.unpack_from("<d", stream, value_at)[0]
        if not math.isfinite(internal) or name[0] in seen:
            continue
        seen.add(name[0])
        value = _value_in(unit[0], internal)
        item = {"name": name[0][:100], "expression": _text(expression[0]), "unit": _text(unit[0])[:20],
                "kind": "user" if user else "model"}
        if value is not None:
            item["value"] = round(value, 9)
        if user and comment and comment[0].strip():
            item["comment"] = _text(comment[0])
        if not user and role[0].strip():
            item["comment"] = _text(role[0])
        out.append(item)
        if len(out) % 64 == 0:
            clock.check()
    return out


NULL_GUID = struct.pack("<I", 36) + "00000000-0000-0000-0000-000000000000".encode("utf-16-le")


def features(stream: bytes, clock: _Clock | None = None) -> list[dict]:
    """Timeline features: [{type, name, description}] in the stream's order. Each feature record starts with a
    null GUID, a count of 11-byte references, the timeline index, the base name, its instance number (u64) and the
    description. The type is the base name when it is one of Fusion's feature names, else "Feature"."""
    clock = clock or _Clock()
    out = []
    pos, tried = 0, 0
    while len(out) < MAX_FEATURES:
        at = stream.find(NULL_GUID, pos)
        if at < 0:
            break
        pos = at + len(NULL_GUID)
        tried += 1
        if tried > MAX_CANDIDATES:
            break
        if not tried % 1024:
            clock.check()
        p = pos + 3
        if p + 4 > len(stream):
            break
        count = struct.unpack_from("<I", stream, p)[0]
        p += 4
        if count > 100000 or p + 11 * count + 8 > len(stream):
            continue
        if any(stream[p + 11 * k] != 1 for k in range(count)):
            continue
        p += 11 * count + 4
        name = _utf16_at(stream, p, 200)
        if not name or not name[0].strip():
            continue
        p = name[1]
        if p + 12 > len(stream):
            continue
        number = struct.unpack_from("<Q", stream, p)[0]
        description = _utf16_at(stream, p + 8, 2000)
        base = _text(name[0])
        kind = base if base in FEATURE_TYPES else "Feature"
        display = f"{base}{number}" if kind != "Feature" and 0 < number < 100000 else base
        item = {"type": kind, "name": display[:MAX_TEXT]}
        if description and description[0].strip():
            item["description"] = _text(description[0])
        out.append(item)
        if len(out) % 64 == 0:
            clock.check()
    return out


# ---------------------------------------------------------------- the whole file


class Design:
    def __init__(self, solids, names, parameters, features, checks, blobs, skipped=0):
        self.solids, self.names, self.parameters, self.features, self.checks, self.blobs = solids, names, parameters, features, checks, blobs
        self.skipped = skipped  # Surface (sheet) bodies left out (SHEET_NOTE).

    def extras(self) -> dict:
        """Parameters and features, at most MAX_EXTRAS_BYTES as JSON (the rest dropped, marked truncated)."""
        import json
        parameters, features = list(self.parameters), list(self.features)
        truncated = False
        while len(json.dumps({"parameters": parameters, "features": features})) > MAX_EXTRAS_BYTES:
            truncated = True
            if len(parameters) >= len(features):
                parameters = parameters[:len(parameters) * 3 // 4]
            else:
                features = features[:len(features) * 3 // 4]
        return {"parameters": parameters, "features": features, "truncated": truncated,
                **({"skipped_surfaces": self.skipped, "note": f"Left out {self.skipped} surface {'body' if self.skipped == 1 else 'bodies'} of the Fusion file: {SHEET_NOTE}."} if self.skipped else {})}


def _active(archive: Archive, pattern: str) -> list[str]:
    """Members of the active design asset matching `pattern`."""
    names = archive.find(pattern)
    active = [name for name in names if "[Active]" in name]
    return active or names


def read(path: str, check: bool = True) -> Design:
    import os
    clock = _Clock()
    if os.path.getsize(path) > MAX_FILE_BYTES:
        raise FusionImportError(f"Fusion files (.f3d) must be under {MAX_FILE_BYTES >> 20} MB; export a large design as STEP instead.")
    with open(path, "rb") as handle:
        data = handle.read()
    return read_bytes(data, check=check, clock=clock)


def read_bytes(data: bytes, check: bool = True, clock: _Clock | None = None) -> Design:
    clock = clock or _Clock()
    if not data.startswith(ZIP_MAGIC):
        raise FusionImportError("This isn't a Fusion file (.f3d): it isn't a ZIP archive.")
    archive = Archive(data)
    nested = [name for name in archive.names() if name.lower().endswith(".f3d")]
    if nested:
        raise FusionImportError("This is a Fusion archive of several designs (.f3z), which STEVE can't import yet: open it in Fusion "
                                "and export each design as .f3d (or the assembly as STEP).")
    blobs = _active(archive, r"(^|/)Breps\.BlobParts/[^/]+\.smbh$")
    if not blobs:
        if archive.find(r"\.smb$"):
            raise FusionImportError("This Fusion file has no bodies (only sketches or construction geometry).")
        raise FusionImportError("This isn't a Fusion design (.f3d): it has no Fusion geometry.")
    solids, names, sheets = [], [], []
    for name in blobs:
        clock.check()
        label = "geometry"
        blob = parse_asm(archive.read(name), clock, label)
        for solid in solids_of(blob, label, clock, sheets):
            solids.append(solid)
            names.append(None)
    if not solids:
        raise FusionImportError(f"This Fusion file has only surface bodies, which STEVE doesn't import: {SHEET_NOTE}."
                                if sheets else "This Fusion file has no solid bodies.")
    checks = []
    if check:
        worlds = _active(archive, r"OGS/DefaultScene/world$")
        meshes = _active(archive, r"OGS/DefaultScene/Fusion_mesh_000$")
        if not worlds or not meshes:
            raise FusionImportError("This Fusion file has no display mesh to check its bodies against; save it again in Fusion.")
        blocks = display_faces(archive.read(worlds[0]), archive.read(meshes[0]), clock)
        checks = check_against_mesh(solids, blocks, sheets)
    params, feats = [], []
    streams = _active(archive, r"FusionDesignSegmentType\d*/BulkStream\.dat$")
    if streams:
        stream = archive.read(streams[0])
        params, feats = parameters(stream, clock), features(stream, clock)
    return Design(solids, names, params, feats, checks, len(blobs), skipped=len(sheets))
