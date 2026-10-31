"""STEVE modeling library: human sketches and features as readable code on CadQuery.

See docs/MODELING.md. `Model` records features with operation history so references
survive parameter changes; `Sketch` blocks are solved with the shared planegcs core.
"""

from .sketch import Sketch, SketchError

__all__ = ["Model", "Component", "Design", "Sketch", "FeatureError", "SketchError", "active_model"]
__all__ += ["SheetMetalRule", "BendTable", "GaugeTable"]
__all__ += ["SheetMetalForm"]
__all__ += ["table"]
__all__ += ["section_view"]


def __getattr__(name):
    # The modeling layer needs CadQuery; the sketch declarations (used by the API's parser) don't.
    if name in {"Model", "FeatureError", "active_model"}:
        from . import model
        return getattr(model, name)
    if name in {"Component", "Design"}:
        from . import design
        return getattr(design, name)
    if name in {"SheetMetalRule", "BendTable", "GaugeTable"}:
        from .sheetmetal import rules
        return getattr(rules, name)
    if name == "SheetMetalForm":
        from .sheetmetal.forms import SheetMetalForm
        return SheetMetalForm
    if name == "table":   # A design's .csv tables (steve/tables.py): pure Python.
        from .tables import table
        return table
    if name == "section_view":   # A saved section view (steve/sections.py): display only, pure Python.
        from .sections import section_view
        return section_view
    raise AttributeError(name)
