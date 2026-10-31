"""A simulation result's colour contour, drawn offscreen with VTK for inspect_model(result=...) (app/result_views.py).

Runs inside a views job (app/features/runtime.py render_views, `contour_source`). Its one input holds only numbers the
solver wrote (app/result_views.py pack): each drawn mesh's node positions (m), surface triangles, the field's node
values and optionally the displacement to deform by. Nothing in it is evaluated.

The picture follows the Simulate workspace: the Rainbow colormap in BANDS bands (web/src/workspaces/simulate/
colormap.ts; tests check the stops match), the units it shows (units.ts: MPa, mm, °C; flow pressures in Pa or kPa),
one scale across every region drawn, a legend at the band boundaries, the peak marked, and with a deformation scale
the deformed shape over a faint undeformed one (Auto: the largest displacement at AUTO_FRACTION of the part, state.ts).
The cameras are the inspection views' (runtime/screenshots.py: orthographic, CAD Z-up). The numbers it reports (min,
max and where, the scale used) come from the full arrays, never from the picture.
"""
import json
import math
import struct
from pathlib import Path

MAGIC = b"STEVE-CONTOUR/1\n"
MAX_HEADER = 1 << 20
RAINBOW = ('#1f3fd0', '#1aa3e6', '#26c9a0', '#8ad13a', '#f2d636', '#f58c2a', '#df3a2f')
BANDS = 10
AUTO_FRACTION = 0.1
VIEWS = {'isometric': ((1, -1, 1), (0, 0, 1)),
         'top': ((0, 0, 1), (0, 1, 0)),
         'front': ((0, -1, 0), (0, 0, 1)),
         'right': ((1, 0, 0), (0, 0, 1))}
WIDTH, HEIGHT, ZOOM = 800, 640, 1.65
# The legend's left edge and the title's lowest line (normalised viewport), and the peak label's offset (pixels).
LEGEND_LEFT, TITLE_BOTTOM, CAPTION_GAP = 0.84, 0.86, 30
LABELS = {'von_mises': 'Von Mises stress', 'displacement': 'Displacement', 'reaction': 'Support reaction',
          'temperature': 'Temperature', 'heat_flux': 'Heat flux', 'velocity': 'Flow speed', 'pressure': 'Gauge pressure'}


def _linear(channel: float) -> float:
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def _srgb(channel: float) -> float:
    return channel * 12.92 if channel <= 0.0031308 else 1.055 * channel ** (1 / 2.4) - 0.055


def map_color(t: float, stops=RAINBOW) -> tuple:
    """The colormap at t ∈ [0, 1] as sRGB (0..1), blended in linear light as the studio's mapColor (THREE.Color) does."""
    linear = [tuple(_linear(int(hex_[i:i + 2], 16) / 255) for i in (1, 3, 5)) for hex_ in stops]
    x = min(1.0, max(0.0, t)) * (len(linear) - 1)
    i = min(len(linear) - 2, math.floor(x))
    return tuple(_srgb(a + (b - a) * (x - i)) for a, b in zip(linear[i], linear[i + 1]))


def band_colors(bands: int = BANDS) -> list:
    """Each band's colour at its centre, lowest first (colormap.ts bandColors)."""
    return [map_color((i + 0.5) / bands) for i in range(bands)]


def display(unit, flow: bool, sample: float) -> tuple:
    """(unit shown, scale, offset): SI values in the units the studio shows (units.ts show)."""
    if unit == 'Pa':
        if flow:
            return ('kPa', 1e-3, 0.0) if abs(sample) >= 1e4 else ('Pa', 1.0, 0.0)
        return 'MPa', 1e-6, 0.0
    if unit == 'm':
        return 'mm', 1e3, 0.0
    if unit == 'K':
        return '°C', 1.0, -273.15
    return ('' if unit in (None, '', '1') else str(unit)), 1.0, 0.0


def label_of(field: str) -> str:
    """A field in words: "Von Mises stress", "Temperature (step 5)", "Mode 2"."""
    base, _, step = field.partition('__')
    if base.startswith('mode_') and base[5:].isdigit():
        return f'Mode {int(base[5:])} shape'
    words = LABELS.get(base, base.replace('_', ' ').capitalize())
    return f'{words} (step {int(step)})' if step.isdigit() else words


def _number(value: float) -> float:
    return float(f'{value:.6g}')


def read(path):
    """The input's header and arrays: [{"region", "positions" (n, 3), "triangles" (t, 3), "values" (n, c), "deform"}]."""
    import numpy as np
    data = Path(path).read_bytes()
    if not data.startswith(MAGIC) or len(data) < len(MAGIC) + 4:
        raise ValueError('A contour job needs its result input.')
    (length,) = struct.unpack_from('<I', data, len(MAGIC))
    start = len(MAGIC) + 4
    if length > MAX_HEADER or start + length > len(data):
        raise ValueError('The result input is malformed.')
    header = json.loads(data[start:start + length])
    body = memoryview(data)[start + length:]
    if not isinstance(header, dict) or not isinstance(header.get('meshes'), list) or not 0 < len(header['meshes']) <= 64 \
            or not isinstance(header.get('field'), str):
        raise ValueError('The result input is malformed.')

    def array(entry, dtype, components=None):
        if not isinstance(entry, dict) or entry.get('dtype') != dtype:
            raise ValueError('The result input is malformed.')
        offset, size, count, width = (entry.get(key) for key in ('offset', 'bytes', 'count', 'components'))
        if not all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in (offset, size, count, width)) \
                or (components is not None and width not in components) or count == 0 \
                or size != count * width * 4 or offset + size > len(body):
            raise ValueError('The result input is malformed.')
        return np.frombuffer(body, dtype=dtype, count=count * width, offset=offset).reshape(count, width)
    meshes = []
    for entry in header['meshes']:
        if not isinstance(entry, dict):
            raise ValueError('The result input is malformed.')
        positions = array(entry.get('positions'), '<f4', (3,))
        triangles = array(entry.get('triangles'), '<u4', (3,))
        values = array(entry.get('values'), '<f4', (1, 3))
        deform = array(entry['deform'], '<f4', (3,)) if entry.get('deform') is not None else None
        if len(values) != len(positions) or (deform is not None and len(deform) != len(positions)) \
                or int(triangles.max()) >= len(positions):
            raise ValueError('The result input is malformed.')
        meshes.append({'region': str(entry.get('region') or ''), 'positions': positions, 'triangles': triangles,
                       'values': values, 'deform': deform})
    return header, meshes


def summarize(header: dict, meshes: list) -> dict:
    """What the picture shows, from the full arrays: the field's range and where its extremes are (mm, design
    coordinates as modelled), in the studio's units, and the deformation scale used (Auto worked out here)."""
    import numpy as np
    scalars = [m['values'][:, 0].astype(np.float64) if m['values'].shape[1] == 1
               else np.linalg.norm(m['values'].astype(np.float64), axis=1) for m in meshes]
    for mesh, values in zip(meshes, scalars):
        mesh['scalar'] = values
    high = max(range(len(meshes)), key=lambda i: float(scalars[i].max()))
    low = min(range(len(meshes)), key=lambda i: float(scalars[i].min()))
    top, bottom = float(scalars[high].max()), float(scalars[low].min())
    unit, scale, offset = display(header.get('units'), bool(header.get('flow')), top if abs(top) >= abs(bottom) else bottom)

    def at(index, values, pick):
        node = int(pick(values))
        point = meshes[index]['positions'][node].astype(np.float64) * 1000
        return {'value': _number(float(values[node]) * scale + offset), 'at_mm': [round(float(v), 3) for v in point],
                **({'region': meshes[index]['region']} if meshes[index]['region'] else {})}
    asked = header.get('deformation_scale')
    factor = None
    if asked is not None:
        if any(m['deform'] is None for m in meshes):
            raise ValueError('The result input is malformed.')
        largest = max(float(np.linalg.norm(m['deform'].astype(np.float64), axis=1).max()) for m in meshes)
        if asked == 'auto':
            every = np.concatenate([m['positions'].ravel() for m in meshes])
            size = float(every.max() - every.min())
            factor = AUTO_FRACTION * size / largest if largest > 0 else 1.0
            # A displacement is never drawn smaller than it is; a mode shape (amplitude 1, no unit) is only a shape.
            shape = header.get('deform_units') != 'm'
            factor = float(f'{factor:.2g}') if math.isfinite(factor) and factor > 0 and (shape or factor > 1) else 1.0
        elif isinstance(asked, (int, float)) and not isinstance(asked, bool) and math.isfinite(asked) and asked >= 0:
            factor = float(asked)
        else:
            raise ValueError('The result input is malformed.')
    return {'field': header['field'], 'label': label_of(header['field']), 'units': unit,
            'min': _number(bottom * scale + offset), 'max': _number(top * scale + offset),
            'peak': at(high, scalars[high], np.argmax), 'lowest': at(low, scalars[low], np.argmin),
            'vector_magnitude': any(m['values'].shape[1] == 3 for m in meshes),
            'deformation_scale': factor, 'colormap': 'rainbow', 'bands': BANDS,
            '_scale': (scale, offset)}


def label_offset(x: float, y: float, width: float, height: float) -> tuple[float, float]:
    """Where the peak's label sits relative to the peak at pixel (x, y): up and to the right, unless that would run into
    the legend (on the right) or the title (at the top), when it goes to the left or below instead."""
    return (CAPTION_GAP if x + CAPTION_GAP + width < LEGEND_LEFT * WIDTH else -CAPTION_GAP - width,
            CAPTION_GAP if y + CAPTION_GAP + height < TITLE_BOTTOM * HEIGHT else -CAPTION_GAP - height)


def main(source, view='isometric'):
    """Writes view-<view>.png: the contour of the input's field; returns what was drawn and the numbers it shows."""
    import numpy as np
    from vtkmodules.util.numpy_support import ID_TYPE_CODE, numpy_to_vtk
    from vtkmodules.vtkCommonCore import vtkLookupTable, vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData
    from vtkmodules.vtkFiltersSources import vtkSphereSource
    from vtkmodules.vtkIOImage import vtkPNGWriter
    from vtkmodules.vtkRenderingAnnotation import vtkCaptionActor2D, vtkScalarBarActor
    from vtkmodules.vtkRenderingCore import (vtkActor, vtkLightKit, vtkPolyDataMapper, vtkRenderer, vtkRenderWindow,
                                             vtkTextActor, vtkWindowToImageFilter)
    import vtkmodules.vtkRenderingOpenGL2  # noqa: F401  The OpenGL backend (registers the render window).
    import vtkmodules.vtkRenderingFreeType  # noqa: F401  Legend and label text.
    if view not in VIEWS:
        raise ValueError(f'A contour is drawn from one of {", ".join(VIEWS)}.')
    header, meshes = read(source)
    result = summarize(header, meshes)
    scale, offset = result.pop('_scale')
    factor = result['deformation_scale']
    low, high = result['min'], result['max']
    if not high > low:  # A uniform field: one band's worth of range around it, so the legend still reads.
        spread = max(abs(high) * 1e-6, 1e-9)
        low, high = low - spread, high + spread

    table = vtkLookupTable()
    table.SetNumberOfTableValues(BANDS)
    table.Build()
    for index, color in enumerate(band_colors()):
        table.SetTableValue(index, *color, 1.0)
    table.SetTableRange(low, high)

    def polydata(points, triangles, scalars=None):
        data = vtkPolyData()
        vtk_points = vtkPoints()
        vtk_points.SetData(numpy_to_vtk(np.ascontiguousarray(points, dtype=np.float64), deep=True))
        data.SetPoints(vtk_points)
        cells = vtkCellArray()
        offsets = np.arange(0, 3 * len(triangles) + 1, 3, dtype=ID_TYPE_CODE)
        cells.SetData(_ids(offsets), _ids(np.ascontiguousarray(triangles, dtype=ID_TYPE_CODE).ravel()))
        data.SetPolys(cells)
        if scalars is not None:
            array = numpy_to_vtk(np.ascontiguousarray(scalars, dtype=np.float64), deep=True)
            array.SetName(result['field'])
            data.GetPointData().SetScalars(array)
        return data

    renderer = vtkRenderer()
    drawn_points, undeformed_points, peak_point, caption = [], [], None, None
    for mesh in meshes:
        used = np.unique(mesh['triangles'])  # The surface: interior nodes carry values but draw nothing.
        remap = np.full(len(mesh['positions']), -1, dtype=np.int64)
        remap[used] = np.arange(len(used))
        triangles = remap[mesh['triangles'].astype(np.int64)]
        base = mesh['positions'][used].astype(np.float64) * 1000
        points = base + mesh['deform'][used].astype(np.float64) * 1000 * factor if factor else base
        drawn_points.append(points)
        undeformed_points.append(base)
        mapper = vtkPolyDataMapper()
        mapper.SetInputData(polydata(points, triangles, mesh['scalar'][used] * scale + offset))
        mapper.SetLookupTable(table)
        mapper.SetScalarRange(low, high)
        mapper.SetScalarModeToUsePointData()
        mapper.ScalarVisibilityOn()
        mapper.InterpolateScalarsBeforeMappingOn()  # Crisp band edges, as the studio's banded contours.
        actor = vtkActor()
        actor.SetMapper(mapper)
        actor.GetProperty().SetAmbient(0.3)
        actor.GetProperty().SetDiffuse(0.75)
        renderer.AddActor(actor)
        if factor:  # The undeformed shape, faint, behind the deformed one.
            ghost_mapper = vtkPolyDataMapper()
            ghost_mapper.SetInputData(polydata(base, triangles))
            ghost_mapper.ScalarVisibilityOff()
            ghost = vtkActor()
            ghost.SetMapper(ghost_mapper)
            ghost.GetProperty().SetColor(0.55, 0.58, 0.62)
            ghost.GetProperty().SetOpacity(0.15)
            renderer.AddActor(ghost)
        if (mesh['region'] or None) == result['peak'].get('region'):
            node = int(np.argmax(mesh['scalar']))
            peak_point = mesh['positions'][node].astype(np.float64) * 1000
            if factor:
                peak_point = peak_point + mesh['deform'][node].astype(np.float64) * 1000 * factor

    every = np.concatenate(drawn_points)
    lower, upper = every.min(axis=0), every.max(axis=0)
    center = (lower + upper) / 2
    diagonal = float(np.linalg.norm(upper - lower)) or 1.0
    outline = np.concatenate(undeformed_points)

    if peak_point is not None:  # The peak: a small dot and its value, pointing at it.
        dot = vtkSphereSource()
        dot.SetCenter(*peak_point)
        dot.SetRadius(diagonal * 0.008)
        dot.SetThetaResolution(16)
        dot.SetPhiResolution(16)
        dot_mapper = vtkPolyDataMapper()
        dot_mapper.SetInputConnection(dot.GetOutputPort())
        marker = vtkActor()
        marker.SetMapper(dot_mapper)
        marker.GetProperty().SetColor(0.08, 0.08, 0.1)
        renderer.AddActor(marker)
        caption = vtkCaptionActor2D()
        caption.SetAttachmentPoint(*peak_point)
        caption.SetCaption(f"max {result['max']:.4g} {result['units']}".rstrip())
        caption.BorderOff()
        caption.LeaderOn()
        caption.ThreeDimensionalLeaderOff()
        caption.SetWidth(0.2)
        caption.SetHeight(0.05)
        caption.GetCaptionTextProperty().SetColor(0.08, 0.08, 0.1)
        caption.GetCaptionTextProperty().BoldOn()
        caption.GetCaptionTextProperty().ShadowOff()
        caption.GetCaptionTextProperty().ItalicOff()
        caption.GetProperty().SetColor(0.08, 0.08, 0.1)
        renderer.AddViewProp(caption)

    legend = vtkScalarBarActor()
    legend.SetLookupTable(table)
    legend.SetMaximumNumberOfColors(BANDS)
    legend.SetNumberOfLabels(BANDS + 1)
    legend.SetLabelFormat('%-#.4g')
    legend.SetTitle(f"{result['label']}" + (f" ({result['units']})" if result['units'] else ''))
    legend.SetOrientationToVertical()
    legend.GetPositionCoordinate().SetCoordinateSystemToNormalizedViewport()
    legend.GetPositionCoordinate().SetValue(LEGEND_LEFT, 0.1)
    legend.SetWidth(0.13)
    legend.SetHeight(0.78)
    for text in (legend.GetTitleTextProperty(), legend.GetLabelTextProperty()):
        text.SetColor(0.1, 0.1, 0.12)
        text.ShadowOff()
        text.ItalicOff()
    legend.GetLabelTextProperty().BoldOff()
    renderer.AddViewProp(legend)

    lines = [f"{result['label']}" + (f" ({result['units']})" if result['units'] else '') +
             (' · magnitude' if result['vector_magnitude'] else ''),
             f"min {result['min']:.4g}   max {result['max']:.4g} at ({', '.join(f'{v:g}' for v in result['peak']['at_mm'])}) mm"]
    if factor:
        lines.append(f'deformed ×{factor:g} (undeformed shown faint)')
    title = vtkTextActor()
    title.SetInput('\n'.join(lines))
    title.GetTextProperty().SetFontSize(15)
    title.GetTextProperty().SetColor(0.1, 0.1, 0.12)
    title.GetTextProperty().SetVerticalJustificationToTop()
    title.GetPositionCoordinate().SetCoordinateSystemToNormalizedViewport()
    title.GetPositionCoordinate().SetValue(0.02, 0.97)
    renderer.AddViewProp(title)

    lights = vtkLightKit()
    lights.AddLightsToRenderer(renderer)
    renderer.SetBackground(.95, .96, .98)
    window = vtkRenderWindow()
    window.SetOffScreenRendering(1)
    window.AddRenderer(renderer)
    window.SetSize(WIDTH, HEIGHT)
    direction, up = VIEWS[view]
    camera = renderer.GetActiveCamera()
    camera.SetParallelProjection(True)
    camera.SetFocalPoint(*center)
    camera.SetPosition(*(center + 3 * diagonal * np.asarray(direction, dtype=np.float64) / np.linalg.norm(direction)))
    camera.SetViewUp(*up)
    camera.SetParallelScale(diagonal)  # As the inspection views frame (diagonal 1, scale 1, then the same zoom).
    camera.Zoom(ZOOM)
    renderer.ResetCameraClippingRange()
    window.Render()
    if caption is not None:  # The peak's label goes where label_offset puts it, now its pixel is known.
        renderer.SetWorldPoint(*peak_point, 1.0)
        renderer.WorldToDisplay()
        x, y, _ = renderer.GetDisplayPoint()
        caption.SetPosition(*label_offset(x, y, caption.GetWidth() * WIDTH, caption.GetHeight() * HEIGHT))
        window.Render()
    grab = vtkWindowToImageFilter()
    grab.SetInput(window)
    grab.SetInputBufferTypeToRGB()
    grab.ReadFrontBufferOff()
    grab.Update()
    temporary = Path(f'view-{view}.tmp.png')
    writer = vtkPNGWriter()
    writer.SetFileName(str(temporary))
    writer.SetInputConnection(grab.GetOutputPort())
    writer.Write()
    if temporary.read_bytes()[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('Renderer did not produce a PNG.')
    temporary.replace(f'view-{view}.png')
    window.Finalize()
    low_corner, high_corner = outline.min(axis=0), outline.max(axis=0)
    return {'instances': [mesh['region'] for mesh in meshes if mesh['region']],
            'extent_mm': [round(float(v), 3) for v in (*low_corner, *high_corner)],
            'bounds_mm': [round(float(v), 3) for v in high_corner - low_corner],
            'result': result}


def _ids(values):
    """A numpy array of vtkIdType as a VTK id array (copied)."""
    from vtkmodules.util.numpy_support import numpy_to_vtkIdTypeArray
    return numpy_to_vtkIdTypeArray(values, deep=True)
