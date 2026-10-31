"""Physical materials of a modeling part (docs/MODELING.md section 4): library ids, density for mass.

    model.material("aluminum-6061-t6")                          # the part
    model.material("stainless-304", bodies=["extrude_2"], finish="brushed")
    model.appearance(color="#1c1c1e", bodies=["fuselage"])    # look only: no density, no mass
    model.appearance(color="#c8102e", faces=["door.end"])      # some faces of a body: the solid stays one solid

The full library (properties, appearance, sources, licenses) is web/src/materials/data/library.json,
built by scripts/materials/build.py; the runtime carries the compact copy next to this file. A person's own materials
("my:" ids, app/user_materials.py) come with the build that names them and are registered beside it.
"""
from __future__ import annotations

import difflib
import json
import re
from functools import lru_cache
from pathlib import Path

COLOR = re.compile(r"#[0-9a-fA-F]{6}")
FINISH = re.compile(r"[a-z][a-z0-9-]*")


@lru_cache(maxsize=1)
def library() -> dict[str, dict]:
    """{id: {"name", "category", "density" (g/cm³ or None), "base_color" (sRGB hex or None), "designations" (other names,
    material numbers, comparable grades; left out when there are none)}}."""
    try:
        return json.loads(Path(__file__).with_name("materials.json").read_text(encoding="utf-8"))["materials"]
    except (OSError, ValueError, KeyError):
        return {}


OWN = re.compile(r"my:[a-z0-9][a-z0-9-]{0,62}")


def register(materials: dict) -> None:
    """Adds the person's own materials a build carries, {"my:…": {name, category, properties: {density, …}}}, to this
    job's library (each job is its own process). Only "my:" ids: the shared library's entries are never replaced."""
    known = library()
    for material_id, entry in (materials or {}).items():
        if not isinstance(material_id, str) or not OWN.fullmatch(material_id) or not isinstance(entry, dict):
            continue
        density = (entry.get("properties") or {}).get("density")
        known[material_id] = {"name": str(entry.get("name") or material_id), "category": str(entry.get("category") or ""),
                              "density": density if isinstance(density, (int, float)) and not isinstance(density, bool) and density > 0 else None}


# Words that name a family, a standard or a qualifier, not the grade: "steel-aisi-1045" asks for grade "1045", and the
# designation "AISI 8620 (comparable)" names grade "8620".
GENERIC = {"steel", "stainless", "aluminum", "aluminium", "alloy", "grade", "aisi", "sae", "en", "din", "uns", "astm", "w", "nr", "comparable"}


def grade(text: str) -> str:
    """The grade a guessed id or a designation names, lower-case alphanumerics: "steel-18crnimo7-6" → "18crnimo76"."""
    return "".join(word for word in re.split(r"[^a-z0-9]+", text.lower()) if word not in GENERIC)


def suggestions(material: str, n: int = 3) -> list[str]:
    """Library ids close to an unknown one: first those whose id, name or designations (other names, EN material numbers,
    comparable AISI grades) hold the guessed grade, an exact designation first; else ids spelled alike."""
    known = library()
    guess = grade(material)
    if len(guess) >= 3:
        flat = re.compile(r"[^a-z0-9]")
        texts = {id: flat.sub("", " ".join([id, entry.get("name", ""), *entry.get("designations", [])]).lower()) for id, entry in known.items()}
        exact = {id for id, entry in known.items() if guess in (grade(d) for d in [id, *entry.get("designations", [])])}
        hits = sorted((id for id, text in texts.items() if guess in text), key=lambda id: (id not in exact, guess not in flat.sub("", id), len(id), id))
        if hits:
            return hits[:n]
    words = {id: f"{id} {entry.get('name', '')}".lower() for id, entry in known.items()}
    close = difflib.get_close_matches(material.lower(), list(known), n=n, cutoff=0.5)
    return close or [id for id, text in words.items() if material.lower() in text][:n]


def hint(material_id: str, guess: str = "") -> str:
    """An id with its library name, so a suggestion explains itself: 'steel-17crnimo6' (17CrNiMo6 (1.6587)); with the
    designation the guess matched when the name doesn't show it: 'steel-20nicrmo2' (20NiCrMo2 (1.6523), also AISI 8620 (comparable))."""
    entry = library().get(material_id, {})
    name = entry.get("name")
    if not name or name == material_id:
        return repr(material_id)
    wanted = grade(guess)
    also = next((d for d in entry.get("designations", []) if wanted and grade(d) == wanted and d not in name), None)
    return f"{material_id!r} ({name}" + (f", also {also}" if also else "") + ")"


class Assignments:
    """`model.material` calls: a part default and per-body overrides (the last call for a body wins)."""

    def __init__(self):
        self.default: dict | None = None
        self.bodies: dict[str, dict] = {}
        self.problems: list[str] = []

    def add(self, material, bodies=None, finish=None, color=None):
        if not isinstance(material, str) or not material.strip():
            raise ValueError("model.material takes a material id from the library, e.g. \"aluminum-6061-t6\".")
        if isinstance(bodies, str):
            bodies = [bodies]
        if bodies is not None and (not isinstance(bodies, (list, tuple)) or not bodies or not all(isinstance(b, str) and b for b in bodies)):
            raise ValueError("model.material bodies= takes a list of body ids, e.g. bodies=[\"extrude_1\"].")
        if finish is not None and (not isinstance(finish, str) or not FINISH.fullmatch(finish)):
            raise ValueError(f"model.material finish= takes a finish id such as \"brushed\"; got {finish!r}.")
        if color is not None and (not isinstance(color, str) or not COLOR.fullmatch(color)):
            raise ValueError(f"model.material color= takes a hex color such as \"#1f6feb\"; got {color!r}.")
        material = material.strip()
        if material not in library():
            if material.startswith("my:"):
                self.problems.append(f"Unknown material {material!r}: it isn't one of your own materials (Materials → My materials); "
                                     "it may have been deleted, or its id is mistyped.")
                return
            close = suggestions(material)
            self.problems.append(f"Unknown material {material!r}." + (f" Did you mean {', '.join(hint(s, material) for s in close)}?" if close else ""))
            return
        entry = {"material": material, **({"finish": finish} if finish else {}), **({"color": color.lower()} if color else {})}
        if bodies is None:
            self.default = entry
        else:
            for body in bodies:
                self.bodies[body] = entry

    def of(self, body: str) -> dict | None:
        return self.bodies.get(body, self.default)

    def body(self, body: str, volume: float) -> dict:
        """What the summary reports for one body: material id, finish/color if set, mass in grams."""
        entry = self.of(body)
        density = library().get(entry["material"], {}).get("density") if entry else None
        return {**(entry or {"material": None}), "mass": round(volume * density / 1000, 4) if density else None}

    def color(self, body: str) -> str | None:
        """A body's colour as the viewer shows it (sRGB hex): its `color=`, else its material's base colour; None
        without a material."""
        entry = self.of(body)
        return entry and (entry.get("color") or library().get(entry["material"], {}).get("base_color"))

    def report(self, volumes: dict[str, float], surfaces=()) -> dict:
        """`volumes`: the solid bodies'; `surfaces`: surface bodies' ids, which have no mass to give a material."""
        masses = {body: self.body(body, volume)["mass"] for body, volume in volumes.items()}
        problems = self.problems + [f"Body {body!r} doesn't exist; its material does nothing." for body in self.bodies
                                    if body not in volumes and body not in surfaces]
        return {"default": self.default["material"] if self.default else None,
                "mass": round(sum(masses.values()), 4) if masses and all(m is not None for m in masses.values()) else None,
                "unassigned": [body for body in volumes if self.of(body) is None], "problems": problems}


class Appearances:
    """`model.appearance` calls: how bodies look (paint, glazing), apart from what they're made of. A part default,
    per-body overrides and per-face overrides (`faces=`: face references, resolved on the finished model at every build,
    so they follow the geometry); a face's look wins over its body's, a body's over the part's, and the last call for a
    body or face wins. Never a density: mass and simulation follow `model.material` only."""

    NUMBERS = ("opacity", "roughness", "metalness")

    def __init__(self):
        self.default: dict | None = None
        self.bodies: dict[str, dict] = {}
        self.faces: list[tuple[list, dict]] = []  # (references, look), in call order

    def add(self, color=None, finish=None, opacity=None, roughness=None, metalness=None, bodies=None, faces=None):
        if isinstance(bodies, str):
            bodies = [bodies]
        if bodies is not None and (not isinstance(bodies, (list, tuple)) or not bodies or not all(isinstance(b, str) and b for b in bodies)):
            raise ValueError("model.appearance bodies= takes a list of body ids, e.g. bodies=[\"extrude_1\"].")
        if faces is not None and bodies is not None:
            raise ValueError("model.appearance takes bodies= or faces=, not both: call it once for each.")
        refs = None if faces is None else list(faces) if isinstance(faces, (list, tuple)) else [faces]
        if refs is not None and not refs:
            raise ValueError("model.appearance faces= takes face references, e.g. faces=[\"extrude_1.end\", \"door.side_faces\"].")
        if color is not None and (not isinstance(color, str) or not COLOR.fullmatch(color)):
            raise ValueError(f"model.appearance color= takes a hex color such as \"#1f6feb\"; got {color!r}.")
        if finish is not None and (not isinstance(finish, str) or not FINISH.fullmatch(finish)):
            raise ValueError(f"model.appearance finish= takes a finish id such as \"painted\" or \"matte\"; got {finish!r}.")
        values = dict(zip(self.NUMBERS, (opacity, roughness, metalness)))
        for key, value in values.items():
            if value is not None and (not isinstance(value, (int, float)) or isinstance(value, bool) or not 0 <= value <= 1):
                raise ValueError(f"model.appearance {key}= is a number from 0 to 1; got {value!r}.")
        entry = {**({"color": color.lower()} if color else {}), **({"finish": finish} if finish else {}),
                 **{key: float(value) for key, value in values.items() if value is not None}}
        if not entry:
            raise ValueError("model.appearance takes at least one of color=, finish=, opacity=, roughness= or metalness=.")
        if refs is not None:
            self.faces.append((refs, entry))
        elif bodies is None:
            self.default = entry
        else:
            for body in bodies:
                self.bodies[body] = entry

    def of(self, body: str) -> dict | None:
        return self.bodies.get(body, self.default)

    def face_looks(self, model) -> tuple[dict[str, dict[int, dict]], list[str]]:
        """`faces=` calls on the finished model: {body: {face index (the body's export order): look}}, the last call for
        a face winning, and the problems: a reference that names no face of the part's bodies now. A problem never fails
        the build: the faces keep their body's look."""
        if not self.faces:
            return {}, []
        index = {face: (body_id, i) for body_id, body in model.bodies.items() for i, face in enumerate(body.Faces())}
        out: dict[str, dict[int, dict]] = {}
        problems: list[str] = []
        for refs, entry in self.faces:
            for ref in refs:
                label = ref if isinstance(ref, str) else type(ref).__name__
                try:
                    found = model.faces(ref)
                except Exception as error:  # FeatureError, a selector that fails on this geometry
                    problems.append(f"Face appearance {label!r}: {error}")
                    continue
                hits = [index[face] for face in found if face in index]
                if not hits:
                    problems.append(f"Face reference {label!r} names no face of the part's bodies; its appearance does nothing.")
                for body, i in hits:
                    out.setdefault(body, {})[i] = entry
        return out, problems

    def problems(self, bodies) -> list[str]:
        return [f"Body {body!r} doesn't exist; its appearance does nothing." for body in self.bodies if body not in bodies]

    @staticmethod
    def grouped(looks: dict[int, dict]) -> list[dict]:
        """A body's face looks for the build report: one entry per distinct look, {"faces": [indices], **look}."""
        groups: list[tuple[dict, list[int]]] = []
        for i in sorted(looks):
            group = next((g for g in groups if g[0] is looks[i] or g[0] == looks[i]), None)
            if group:
                group[1].append(i)
            else:
                groups.append((looks[i], [i]))
        return [{"faces": faces, **look} for look, faces in groups]


def body_colors(model) -> dict[str, tuple[float, float, float]]:
    """{body id: (r, g, b) in 0–1} for a model's bodies with a colour, for the STEP export: the inspection views
    (runtime/screenshots.py) and other CAD tools show them. A body's `model.appearance` colour comes first, then its
    material's (Assignments.color). Flat colours: no finish, shine or opacity."""
    assigned = getattr(model, "__dict__", {}).get("materials")
    looks = getattr(model, "__dict__", {}).get("appearances")
    assigned = assigned if isinstance(assigned, Assignments) else None
    looks = looks if isinstance(looks, Appearances) else None
    if not assigned and not looks:
        return {}
    out = {}
    for body in model.bodies:
        color = ((looks.of(body) or {}).get("color") if looks else None) or (assigned.color(body) if assigned else None)
        if color and COLOR.fullmatch(color):
            out[body] = _rgb(color)
    return out


def face_colors(model) -> list[tuple[object, tuple[float, float, float]]]:
    """[(face, (r, g, b) in 0–1)] for faces whose `model.appearance(faces=...)` sets a colour, for the STEP export, as
    sub-shape colours over their body's (body_colors)."""
    looks = getattr(model, "__dict__", {}).get("appearances")
    if not isinstance(looks, Appearances) or not looks.faces:
        return []
    faced, _ = looks.face_looks(model)
    out = []
    for body, by_index in faced.items():
        faces = model.bodies[body].Faces()
        for i, entry in by_index.items():
            if entry.get("color") and COLOR.fullmatch(entry["color"]):
                out.append((faces[i], _rgb(entry["color"])))
    return out


def _rgb(color: str) -> tuple[float, float, float]:
    return tuple(int(color[i:i + 2], 16) / 255 for i in (1, 3, 5))
