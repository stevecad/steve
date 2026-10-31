"""STEP and Autodesk Fusion (.f3d) files uploaded to STEVE (POST /v1/imports), as a build sees them.

Code names an upload by its sha256 (or its import id). The build service attaches exactly the
uploads a build's code references and the kernel receives those files with the job; nothing
else is readable. Modeling documents use `model.import_step(...)` for both kinds (a Fusion file is
recognised by its content, a ZIP archive, and read by steve.fusion); plain CadQuery can load a
STEP file itself:

    from steve import imports
    result = cq.importers.importStep(imports.path("<sha256>"))
"""
from __future__ import annotations

import os
import re
from pathlib import Path

SHA256 = re.compile(r"[0-9a-f]{64}")
_FILES: dict[str, str] = {}  # reference as written in code (sha256 or import id) → sha256
_ROOT: Path | None = None
_SOLIDS: dict[str, list] = {}  # sha256 → [(solid, name)], read once per process (full builds execute twice)
_EXTRAS: dict[str, dict] = {}  # sha256 → a Fusion file's parameters and features (data from the file, never run)


class StepImportError(ValueError):
    """The file can't be used: unreadable, or no solids in it."""


def register(files: dict, root) -> None:
    """The build's attached uploads: {reference: sha256}, stored as `<root>/<sha256>.step`."""
    global _ROOT
    _ROOT = Path(root)
    for ref, sha in (files or {}).items():
        if isinstance(ref, str) and isinstance(sha, str) and SHA256.fullmatch(sha):
            _FILES[_key(ref)] = sha
            _FILES[sha] = sha


def _key(ref: str) -> str:
    ref = ref.strip().lower()
    return ref[len("sha256:"):] if ref.startswith("sha256:") else ref


def sha256(ref: str) -> str:
    if not isinstance(ref, str) or not ref.strip():
        raise StepImportError(f"An import is referenced by its sha256 or import id, not {ref!r}.")
    key = _key(ref)
    if key in _FILES:
        return _FILES[key]
    if SHA256.fullmatch(key) and _root() and (_root() / f"{key}.step").is_file():
        return key
    raise FileNotFoundError(f"No uploaded STEP file matches {ref!r}. Import the file first (Import in the Document group), "
                            "then reference it by its sha256 or import id.")


def _root() -> Path | None:
    if _ROOT is not None:
        return _ROOT
    local = os.getenv("STEVE_IMPORTS_DIR")  # Running a document outside the build service.
    return Path(local) if local else None


def path(ref: str) -> str:
    """Local path of an uploaded STEP file, for plain CadQuery (cq.importers.importStep)."""
    sha = sha256(ref)
    file = (_root() or Path("imports")) / f"{sha}.step"
    if not file.is_file():
        raise FileNotFoundError(f"The STEP file {sha[:12]}… wasn't sent with this build. Upload it again.")
    return str(file)


def solids(ref: str) -> list:
    """[(cq.Solid, name or None)] in file order: assembly components in order, then each shape's solids."""
    sha = sha256(ref)
    if sha not in _SOLIDS:
        file = path(ref)
        if kind(ref) == "f3d":
            from . import fusion
            try:
                design = fusion.read(file)
            except fusion.FusionImportError as error:
                raise StepImportError(str(error)) from None
            _SOLIDS[sha] = list(zip(design.solids, design.names))
            _EXTRAS[sha] = design.extras()
        else:
            _SOLIDS[sha] = _read(file)
    return _SOLIDS[sha]


def kind(ref: str) -> str:
    """"f3d" for an Autodesk Fusion design (a ZIP archive), else "step"."""
    from .fusion import is_fusion
    with open(path(ref), "rb") as handle:
        return "f3d" if is_fusion(handle.read(4)) else "step"


EXTRAS_PER_BUILD = 192 * 1024  # JSON bytes of Fusion extras one build reports: result.json stays far under its 1 MB cap.
_GRANTED: dict[str, int] = {}  # sha256 → JSON size of the extras reported (the same again when a build re-runs the code)


def extras(ref: str) -> dict | None:
    """A Fusion file's parameters and features ({"parameters": […], "features": […], "truncated": bool}), once solids()
    has read it. The first files a build names get theirs in full; past EXTRAS_PER_BUILD the rest report counts only
    (an upload's own check build names one file, so its import record always has them)."""
    import json
    sha = sha256(ref)
    found = _EXTRAS.get(sha)
    if found is None:
        return None
    if sha not in _GRANTED:
        size = len(json.dumps(found))
        if sum(_GRANTED.values()) + size > EXTRAS_PER_BUILD:
            return {"parameters": [], "features": [], "truncated": True, "parameter_count": len(found["parameters"]),
                    "feature_count": len(found["features"]), **{k: found[k] for k in ("skipped_surfaces", "note") if k in found}}
        _GRANTED[sha] = size
    return found


_GENERIC = re.compile(r"(?:\d+|open cascade step translator.*|solid|body|part|shape)?", re.IGNORECASE)


def _read(file: str) -> list:
    import cadquery as cq
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDF import TDF_Label
    from OCP.collections import Sequence_TDF_Label
    from OCP.TDocStd import TDocStd_Document
    from OCP.TopLoc import TopLoc_Location
    from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ShapeTool

    def name_of(label):
        attr = TDataStd_Name()
        if not label.FindAttribute(TDataStd_Name.GetID_s(), attr):
            return None
        text = " ".join(attr.Get().ToExtString().split())[:120]
        return None if _GENERIC.fullmatch(text) else text

    # Each body's own name (the one Fusion and others write on its MANIFOLD_SOLID_BREP) becomes a sub-shape label only
    # with this on; it is off by default. OCCT 8's own setting (process-wide; every STEP read here wants it).
    try:
        from OCP.Interface import Interface_Static
        Interface_Static.SetIVal_s("read.stepcaf.subshapes.name", 1)
    except Exception:  # noqa: BLE001 - an OCCT without it: components' names only, as before
        pass
    document = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(False)
    reader.SetLayerMode(False)
    if reader.ReadFile(file) != IFSelect_RetDone:
        raise StepImportError("This isn't a readable STEP file (ISO 10303-21).")
    if not reader.Transfer(document):
        raise StepImportError("The STEP file has no geometry the kernel could read.")
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    roots = Sequence_TDF_Label()
    shapes.GetFreeShapes(roots)
    found, read = [], []

    def walk(label, location, name):
        if XCAFDoc_ShapeTool.IsAssembly_s(label):
            components = Sequence_TDF_Label()
            XCAFDoc_ShapeTool.GetComponents_s(label, components, False)
            for i in range(1, components.Length() + 1):
                component, referred = components.Value(i), TDF_Label()
                XCAFDoc_ShapeTool.GetReferredShape_s(component, referred)
                walk(referred, location.Multiplied(XCAFDoc_ShapeTool.GetLocation_s(component)), name_of(component) or name_of(referred) or name)
            return
        shape = XCAFDoc_ShapeTool.GetShape_s(label)
        if shape.IsNull():
            return
        solids = cq.Shape.cast(shape).Solids()
        for solid in solids:
            # A body's own name, from its sub-shape label: "Bracket / Body A" when its component holds several bodies,
            # else the component's name stands for it.
            sub, own = TDF_Label(), None
            if len(solids) > 1 and shapes.FindSubShape(label, solid.wrapped, sub):
                own = name_of(sub)
            moved = solid if location.IsIdentity() else cq.Shape.cast(solid.wrapped.Moved(location))
            found.append((moved, f"{name} / {own}" if own and name else own or name))
        read.append(cq.Shape.cast(shape if location.IsIdentity() else shape.Moved(location)))

    for i in range(1, roots.Length() + 1):
        walk(roots.Value(i), TopLoc_Location(), name_of(roots.Value(i)))
    loose = [] if found else [shell for shape in read for shell in shape.Shells()]
    if not found:
        # Some exporters write closed shells without a solid around them.
        from OCP.BRep import BRep_Tool
        from OCP.ShapeFix import ShapeFix_Solid
        for shell in loose:
            if BRep_Tool.IsClosed_s(shell.wrapped):
                fixer = ShapeFix_Solid()
                solid = cq.Shape.cast(fixer.SolidFromShell(shell.wrapped))
                if isinstance(solid, cq.Solid) and solid.Volume() > 0:
                    found.append((solid, None))
    if not found:
        faces = sum(len(shape.Faces()) for shape in read)
        raise StepImportError(f"The STEP file has no solids: it holds {faces} surface{'s' if faces != 1 else ''} but no closed volume."
                              if faces else "The STEP file has no solids.")
    return found
