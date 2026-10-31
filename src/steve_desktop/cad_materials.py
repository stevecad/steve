"""Local material validation from pinned Studio app/user_materials.py; no hosted storage."""

from steve_desktop.paths import RESOURCE_ROOT
import json
import math
import re
from functools import lru_cache
from pathlib import Path
from fastapi import HTTPException
from pydantic import BaseModel, Field, StrictFloat
COLOR = re.compile(r"#[0-9a-fA-F]{6}")

UNITS = {
    "density": ("g/cm³", 0, 30), "youngs_modulus": ("GPa", 0, 2000), "shear_modulus": ("GPa", 0, 1000),
    "poisson_ratio": ("", -1, 0.5), "yield_strength": ("MPa", 0, 20000), "ultimate_strength": ("MPa", 0, 20000),
    "elongation": ("%", 0, 1000), "flexural_strength": ("MPa", 0, 20000), "compressive_strength": ("MPa", 0, 20000),
    "thermal_conductivity": ("W/(m·K)", 0, 5000), "specific_heat": ("J/(kg·K)", 0, 50000),
    "thermal_expansion": ("µm/(m·K)", -100, 1000), "melting_point": ("°C", -273.15, 5000),
    "electrical_conductivity": ("MS/m", 0, 1000),
}
# Values that must be more than their lower bound (a density of 0 is no material); the others may equal it.
STRICT = {"density", "youngs_modulus", "shear_modulus", "poisson_ratio", "yield_strength", "ultimate_strength", "flexural_strength",
          "compressive_strength", "thermal_conductivity", "specific_heat", "melting_point"}


@lru_cache(maxsize=1)
def _library():
    # The shipped compact CAD library has the same category and material IDs.
    data = json.loads((RESOURCE_ROOT / 'vendor/steve/materials.json').read_text(encoding='utf-8'))['materials']
    return frozenset(item['category'] for item in data.values()), frozenset(data)


class MaterialBody(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    category: str = Field(min_length=1, max_length=64)
    based_on: str | None = Field(default=None, max_length=100)
    description: str = Field(default="", max_length=1000)
    color: str | None = Field(default=None, max_length=7)
    properties: dict[str, StrictFloat | None] = Field(default_factory=dict, max_length=len(UNITS))


def _clean(text: str) -> str:
    return " ".join("".join(ch for ch in text if ch.isprintable()).split())


def _checked(body: MaterialBody) -> dict:
    """The stored fields, or 422 naming what's wrong (never echoing the person's values)."""
    categories, materials = _library()
    name = _clean(body.name)
    if not name:
        raise HTTPException(422, "Give the material a name.")
    if body.category not in categories:
        raise HTTPException(422, "Choose one of the library's categories.")
    if body.based_on is not None and body.based_on not in materials:
        raise HTTPException(422, "based_on must be a material of the shared library.")
    if body.color is not None and not COLOR.fullmatch(body.color):
        raise HTTPException(422, "color is a hex color such as #b08d57.")
    properties = {}
    for key, value in body.properties.items():
        if key not in UNITS:
            raise HTTPException(422, f"Unknown property; these can be set: {', '.join(UNITS)}.")
        if value is None:
            continue
        unit, low, high = UNITS[key]
        # Poisson's ratio stays below 0.5 (an incompressible solid can't be solved), as simulation/schema.py Material.
        below = key == "poisson_ratio"
        if not math.isfinite(value) or value > high or value < low or (key in STRICT and value == low) or (below and value == high):
            label = key.replace("_", " ")
            raise HTTPException(422, f"The {label} must be {'more than' if key in STRICT else 'at least'} {low:g} and "
                                     f"{'less than' if below else 'at most'} {high:g}" + (f" {unit}" if unit else "") + ".")
        properties[key] = float(value)
    return {"name": name, "category": body.category, "based_on": body.based_on, "description": _clean(body.description),
            "color": body.color.lower() if body.color else None, "properties": properties}

