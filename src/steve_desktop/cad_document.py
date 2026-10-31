"""Studio-compatible CAD document helpers. Python source is authoritative."""

from steve_desktop.paths import RESOURCE_ROOT
import copy
import math
from pathlib import Path
import sys

VENDOR = RESOURCE_ROOT / 'vendor'
if str(VENDOR) not in sys.path:
    sys.path.insert(0, str(VENDOR))
from upstream_parse import parse


def validate(doc):
    message = doc.get('message')
    if message is not None and (not isinstance(message, str) or len(message) > 200):
        raise ValueError('Revision messages must be text of at most 200 characters.')
    if doc.get('kind') not in ('part', 'design', 'blender'):
        raise ValueError('Local documents must be CAD parts, designs or Blender scenes.')
    if not isinstance(doc.get('name'), str) or not doc['name'].strip():
        raise ValueError('A document name is required.')
    if not isinstance(doc.get('code'), str) or len(doc['code']) > 1000000:
        raise ValueError('Provide Python source (up to 1 MB).')
    files = doc.get('files', {})
    if not isinstance(files, dict) or len(files) > 200:
        raise ValueError('At most 200 source files are supported, matching Studio.')
    for name, content in files.items():
        p = Path(name)
        if p.is_absolute() or '..' in p.parts or ':' in name or '\\' in name:
            raise ValueError('Source files must stay inside the project.')
        if not isinstance(content, str) or len(content) > 2000000:
            raise ValueError('Invalid source file.')
    return doc


def source_model(doc, file=None):
    code = doc['files'][file] if file else doc['code']
    return parse(code)


def change_parameters(doc, values, file=None):
    doc = copy.deepcopy(doc)
    if file is None and doc.get('kind') == 'design' and 'params.py' in doc.get('files', {}):
        file = 'params.py'
    code = doc['files'][file] if file else doc['code']
    parsed = parse(code)
    params = {p['name']: p for p in parsed.get('parameters', [])}
    if not set(values).issubset(params):
        raise ValueError('Unknown or non-editable parameter.')
    replacements = []
    for name, value in values.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError('Parameter values must be finite numbers.')
        replacements.append((*params[name]['value_span'], repr(value)))
    # Upstream spans count UTF-16 code units, not Python Unicode characters.
    encoded = code.encode('utf-16-le')
    for start, end, value in sorted(replacements, reverse=True):
        encoded = encoded[:start*2] + value.encode('utf-16-le') + encoded[end*2:]
    code = encoded.decode('utf-16-le')
    if file:
        doc['files'][file] = code
    else:
        doc['code'] = code
    return doc


def bracket():
    return {'name': 'Mounting bracket', 'kind': 'part', 'files': {}, 'links': {}, 'code': '''from steve import Model

width = 80             # mm Overall width
depth = 50             # mm Base depth
height = 40            # mm Upright height
thickness = 6          # mm Wall thickness
hole_diameter = 6      # mm Mounting hole diameter
hole_spacing = 50      # mm Distance between hole centres

model = Model()
with model.sketch("base_profile", on="XY", name="Base profile") as s:
    s.rect("outline", (0, 0), (width, depth))
model.extrude("base", "base_profile", distance=thickness, name="Base plate")
model.box("upright", width, thickness, height, at=(0, depth-thickness, 0),
          centered=False, op="join", name="Upright")
model.hole("base_holes", on="base.end", diameter=hole_diameter,
           points=[((width-hole_spacing)/2, 20), ((width+hole_spacing)/2, 20)],
           name="Base mounting holes")
model.hole("upright_holes", on="upright.left", diameter=hole_diameter,
           points=[((width-hole_spacing)/2, 25), ((width+hole_spacing)/2, 25)],
           name="Upright mounting holes")
result = model.result()
'''}


FORMAT_HELP = '''Studio-compatible CAD document: {name, kind: "part"|"design", code, files: {}, links: {}}.
Python source is authoritative. The actual pinned upstream steve.Model / Component /
Design runtime executes locally on the matching CadQuery fork and OCCT version.
Parts: from steve import Model; model = Model(); ...; result = model.result().
Raw CadQuery also works: import cadquery as cq; result = cq.Workplane(...).
Designs: code is main.py, files includes params.py and components/*.py;
result = design.result(). Values and lengths are in mm; angles in degrees.
Top-level numeric assignments drive editable parameters. Preserve feature IDs.
Use cad_api_reference for exact signatures; never invent modeling APIs.
Use cad_read before editing and supply expected_revision. Inspect the built result.
Named upstream topology references are supplied by cad_inspect; positional face/edge
IDs refer only to one build revision. Re-read selection after changing geometry.
Links must contain locally available source snapshots; CAD never builds on a server.
'''
