"""Saved section views: a named cut through the model, kept in the code so it follows revisions and branches.

    from steve import section_view
    section_view("bore_cut", axis="x", at=12.5)

The studio lists each one under Sections in the model tree and shows it as a fixed cut (the model clipped at `at` mm
along `axis`, its solid cut faces hatched) when it's clicked. A section view is display only: the geometry, the
summary and every export stay the same, so a build only checks its arguments. `flip=True` keeps the other side.
"""
from __future__ import annotations

import math
import re

NAME = re.compile(r"[a-z][a-z0-9_]*")  # Like feature ids and joint names (steve/model.py ID).
AXES = ("x", "y", "z")


class SectionError(ValueError):
    pass


def section_view(name: str, axis: str = "z", at: float = 0.0, flip: bool = False) -> None:
    """A named section view: the model cut by the plane normal to `axis` ("x", "y" or "z") at `at` mm from the origin,
    showing the side below `at` (`flip=True`: above). Display only; it changes nothing in the model."""
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise SectionError(f"section_view: name {name!r} must be lowercase letters, digits and underscores, starting with a letter "
                           "(like \"section_1\").")
    label = f"Section view {name!r}"
    if not isinstance(axis, str) or axis.lower() not in AXES:
        raise SectionError(f"{label}: axis must be \"x\", \"y\" or \"z\", not {axis!r}.")
    if isinstance(at, bool) or not isinstance(at, (int, float)) or not math.isfinite(at):
        raise SectionError(f"{label}: at= is a position in mm along the axis, a finite number; got {at!r}.")
    if not isinstance(flip, bool):
        raise SectionError(f"{label}: flip= is True or False; got {flip!r}.")
