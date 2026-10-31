"""CAM programs as code. A CAM document's main.py links the part it machines and the shop it machines it in, like a
design links parts, and makes `program = {...}` in the program format (api_reference("Program")):

    from links import part, shop
    from steve.cam import body, faces

    program = {
        "name": "Top side",
        "setups": [{"id": "top", "machine": shop.mill, "tooling": shop.rack, "stock": {...}, ...}],
        "operations": [
            {"id": "face", "setup": "top", "targets": [body(part, "extrude_1")],
             "strategy": {"kind": "face", "tool": shop.t_em8, ...}},
        ],
    }

Shop items (`shop.mill`, `shop.t_em8`) and part targets are names: the build returns the program with them as
references, nothing pinned. Running it resolves them to the shop items' latest library records and the part's linked
revision, and freezes exactly that (app/manufacturing/cam_documents.py). Nothing here builds the part.
"""
from __future__ import annotations

import math

from .links import Link
from .shop import Item


def _alias(link) -> str:
    if isinstance(link, Link):
        return link.alias
    raise TypeError(f"Name the part by its link (`from links import part`), not {type(link).__name__}.")


def _where(instances) -> dict:
    return {"instances": list(instances)} if instances else {}


def body(link, name: str, instances: tuple[str, ...] = ()) -> dict:
    """A whole body of the linked part as an operation target: `body(part, "extrude_1")`. In a linked design, name the
    instance path too: `body(rig, "extrude_1", instances=("frame", "plate"))`. inspect_model(checks=["machining"]) on
    the part lists its bodies."""
    return {"link": _alias(link), **_where(instances), "body": name, "kind": "body"}


def faces(link, *names: str, body: str, instances: tuple[str, ...] = ()) -> dict:
    """Named faces of one body of the linked part as an operation target: `faces(part, "hole_center.wall(0)",
    body="extrude_1")`. inspect_model(checks=["machining"]) on the part lists its holes and flats by name. A name
    without its instance (`part:` for a part) gets it."""
    if not names:
        raise ValueError("faces(part, ...) needs at least one face name.")
    instance = "/".join(instances) or "part"
    named = [name if ":" in name else f"{instance}:{name}" for name in names]
    return {"link": _alias(link), **_where(instances), "body": body, "kind": "face", "names": named}


def data(value, path="program"):
    """The program as data: shop items become {"$shop": key, "kind": kind}; everything else must already be data."""
    if isinstance(value, Item):
        return {"$shop": value.key, "kind": value.kind}
    if isinstance(value, Link):
        raise TypeError(f"{path}: a link alone isn't a target; use body({value.alias}, ...) or faces({value.alias}, ...).")
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError(f"{path}: keys must be text, not {key!r}.")
            out[key] = data(item, f"{path}.{key}")
        return out
    if isinstance(value, (list, tuple)):
        return [data(item, f"{path}[{index}]") for index, item in enumerate(value)]
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(f"{path}: {value} isn't a number a program can hold.")
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError(f"{path}: {type(value).__name__} isn't part of a program (numbers, text, lists, dicts, shop items, "
                    f"body()/faces() targets).")
