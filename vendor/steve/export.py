"""What the runtime reports about a modeling document: feature results and reference names.

The runtime calls these after executing the user's code; both return None for plain
CadQuery, so non-modeling documents are untouched.
"""
from __future__ import annotations


def summary():
    """Feature statuses, bodies and sketch regions of the model that produced `result`; a design reports
    each of its components."""
    from .model import active_model
    design = _active_design()
    if design is not None:
        return {"design": design.summary()}
    model = active_model()
    return model.summary() if model else None


def _active_design():
    import sys
    module = sys.modules.get(f"{__package__}.design")  # Only if the code used designs at all.
    return module.active_design() if module else None


def names(shape, model=None):
    """Reference names for a shape's faces, edges and vertices: ({Face: name}, {Edge: name}, {Vertex: name})."""
    from .model import active_model
    model = model or (None if _active_design() else active_model())
    if model is None:
        return None
    import cadquery as cq
    refs = model.refs(cq.Shape.cast(shape) if not isinstance(shape, cq.Shape) else shape)
    return refs["faces"], refs["edges"], refs["vertices"]


def surface_body_ids(model=None):
    """The ids of the model's surface bodies (faces or open shells, no solid), in body order."""
    from .model import active_model, is_surface
    model = model or (None if _active_design() else active_model())
    return [identity for identity, body in model.bodies.items() if is_surface(body)] if model is not None else []


def face_bodies(model=None):
    """Exact current body owners, independent of a face's feature provenance."""
    from .model import active_model
    model = model or (None if _active_design() else active_model())
    owners = {}
    if model is not None:
        for identity, body in model.bodies.items():
            for face in body.Faces():
                owners.setdefault(face, []).append(identity)
    return owners
