"""Native sheet-metal construction and development, in millimetres.

Planar panels carry both a folded frame and a material (flat) frame. Cylindrical
bends connect them with an explicit allowance. The graph is derived from source,
serializable, and independent of tessellation or viewport face indices.
"""
from __future__ import annotations

import base64
import copy
from dataclasses import dataclass, field
import io
import math

import cadquery as cq
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism
from OCP.gp import gp_Pnt, gp_Vec
from OCP.TopLoc import TopLoc_Location

from ..naming import Names

from .rules import Rules
from .validation import TOL, fail, number

VERSION = 1


def encode(shape):
    stream = io.BytesIO()
    shape.exportBrep(stream)
    return base64.b64encode(stream.getvalue()).decode('ascii')


def decode(data):
    return cq.Shape.importBrep(io.BytesIO(base64.b64decode(data, validate=True)))


def frame(plane):
    return [list(plane.origin.toTuple()), list(plane.xDir.toTuple()), list(plane.zDir.toTuple())]


def plane(data):
    return cq.Plane(origin=data[0], xDir=data[1], normal=data[2])


def place(shape, data):
    return shape.transformShape(plane(data).rG)


def move_frame(data, location):
    p = plane(data)
    matrix = cq.Matrix(location.wrapped.Transformation())
    origin = p.origin.transform(matrix)
    x = (p.origin+p.xDir).transform(matrix)-origin
    normal = (p.origin+p.zDir).transform(matrix)-origin
    return frame(cq.Plane(origin, xDir=x, normal=normal))


def rectangle(width, length):
    return cq.Face.makeFromWires(cq.Wire.makePolygon([(0, 0, 0), (width, 0, 0), (width, length, 0), (0, length, 0)], close=True))


def label_names(prefix, label):
    """A panel edge label's face names, primary first.

    A plain label is `<panel>.side(<label>)`; a full name (it has parentheses, like `hole_cut.side(h0)` or a name
    carried from another panel) is used as is; a list is a primary followed by older aliases that still resolve.
    """
    return [item if '(' in item else f'{prefix}.side({item})' for item in ([label] if isinstance(label, str) else label)]


def _history(maker, edges, labels):
    pairs = []
    for old, label in zip(edges, labels, strict=True):
        if label is not None:
            pairs.append((old, label))
            pairs.extend((cq.Shape.cast(edge), label) for edge in maker.Modified(old.wrapped))
    return pairs


def cut_panel(panel, tool, identity, tool_labels=None):
    """Keep boundary provenance when a notch trims or splits an existing edge.

    `tool_labels` (one per tool edge, None for an unnamed one) names the edges the tool leaves in the panel, like
    a sketched hole; they keep the numbered `<identity>_<n>` label as an alias.
    """
    before, labels = panel.face, panel.labels
    maker = BRepAlgoAPI_Cut(before.wrapped, tool.wrapped)
    result = cq.Shape.cast(maker.Shape())
    if not result.isValid() or len(result.Faces()) != 1:
        fail('The cut disconnects a panel or leaves invalid geometry.')
    panel.face = result.Faces()[0]
    inherited = _history(maker, before.Edges(), labels)
    made = _history(maker, tool.Edges(), tool_labels) if tool_labels is not None else []
    panel.labels = []
    for i, edge in enumerate(panel.face.Edges()):
        numbered = f'{identity}_{i+1}'
        label = next((label for old, label in inherited if edge.isSame(old)), None)
        if label is None:
            label = next(([label, numbered] for old, label in made if edge.isSame(old)), numbered)
        panel.labels.append(label)


def _lies_on(edge, other, tolerance=1e-6):
    return all(other.distance(cq.Vertex.makeVertex(*edge.positionAt(t).toTuple())) < tolerance for t in (0, .25, .5, .75, 1))


def carried_labels(owner, before, labels, face, attachment):
    """Labels for `face`, a piece of panel `owner`'s `before` face in the same frame, as it becomes its own panel.

    An edge carried over whole keeps its full names from `owner` (`base.side(u0)` stays `base.side(u0)`); a trimmed
    edge keeps its label for the new panel; an edge for which `attachment(edge)` is true is the new panel's `start`.
    Each keeps the numbered `edge_<n>` label as an alias.
    """
    olds = list(zip(before.Edges(), labels, strict=True))
    boxes = [old.BoundingBox() for old, _ in olds]
    result = []
    for i, edge in enumerate(face.Edges()):
        numbered = f'edge_{i+1}'
        mid = edge.positionAt(.5)
        match = next(((old, label) for (old, label), box in zip(olds, boxes)
                      if box.xmin-1e-6 <= mid.x <= box.xmax+1e-6 and box.ymin-1e-6 <= mid.y <= box.ymax+1e-6
                      and box.zmin-1e-6 <= mid.z <= box.zmax+1e-6 and _lies_on(edge, old)), None)
        if match is not None:
            old, label = match
            items = [label] if isinstance(label, str) else list(label)
            # Whole: every name it had on `owner`. Trimmed: its primary label, now on this panel.
            items = label_names(owner, items) if abs(old.Length()-edge.Length()) < 1e-6 else items[:1]
            result.append([*items, numbered])
        elif attachment(edge):
            result.append(['start', numbered])
        else:
            result.append(numbered)
    return result


def join_panel(panel, tool, identity):
    """Extend a planar panel and retain labels on collinear outer boundaries."""
    before, labels = panel.face,panel.labels
    result = before.fuse(tool).clean()
    if not result.isValid() or len(result.Faces()) != 1:
        fail('The panel extension must remain one connected planar region.')
    panel.face = result.Faces()[0]
    panel.labels = []
    for i,edge in enumerate(panel.face.Edges()):
        matched = []
        for old,label in zip(before.Edges(),labels,strict=True):
            if edge.isSame(old):
                matched.append(label)
            elif edge.geomType()==old.geomType()=='LINE':
                u = (old.endPoint()-old.startPoint()).normalized()
                if (edge.startPoint()-old.startPoint()).cross(u).Length < TOL and (edge.endPoint()-old.startPoint()).cross(u).Length < TOL:
                    a,b = sorted(((edge.startPoint()-old.startPoint()).dot(u),(edge.endPoint()-old.startPoint()).dot(u)))
                    if min(b,old.Length())-max(a,0)>TOL:
                        matched.append(label)
        panel.labels.append(matched[0] if matched else f'{identity}_{i+1}')


def trim_halfplane(panel, normal, distance, identity):
    """Keep local XY points whose dot(normal, point) is at most distance."""
    normal=normal.normalized()
    section=cq.Plane(normal*distance,xDir=(normal.y,-normal.x,0),normal=(0,0,1))
    local=section.toLocalCoords(panel.face)
    box=local.BoundingBox()
    if box.ymax<=TOL:
        return
    if box.ymin>=-TOL:
        fail('Miter would remove the entire flange. Reduce the gap or change the flange dimensions.','SM_MITER_TOO_LARGE',entity=panel.id)
    margin=max(1,box.xlen,box.ylen)
    tool=rectangle(box.xlen+2*margin,box.ymax+margin).translate((box.xmin-margin,0,0))
    cut_panel(panel,place(tool,frame(section)),identity)


def subtract(piece, tool, identity):
    shape, names = piece
    maker = BRepAlgoAPI_Cut(shape.wrapped, tool.wrapped)
    result = cq.Shape.cast(maker.Shape())
    names.update(maker, result, [shape])
    named = [face for faces in names.faces.values() for face in faces]
    names.add(identity, [face.wrapped for face in result.Faces() if not any(face.isSame(old) for old in named)])
    return result, names


def prism(face, direction, prefix, labels):
    maker = BRepPrimAPI_MakePrism(face.wrapped, gp_Vec(*direction.toTuple()))
    maker.Build()
    if not maker.IsDone():
        fail(f"Could not construct sheet material for {prefix}.")
    shape, names = cq.Shape.cast(maker.Shape()), Names()
    names.add(prefix + '.top', [maker.FirstShape()])
    names.add(prefix + '.bottom', [maker.LastShape()])
    named = [label_names(prefix, label) for label in labels]
    primary = {items[0] for items in named}
    for edge, (first, *aliases) in zip(face.Edges(), named, strict=True):
        # Primary before aliases, so a face shows its primary name; an alias never takes another edge's name.
        generated = list(maker.Generated(edge.wrapped))
        for name in [first, *(alias for alias in aliases if alias not in primary)]:
            names.add(name, generated)
    return shape, names


def fuse(pieces, dimensionality=3):
    """Fuse with provenance and reject material overlap rather than hide it."""
    shape, names = pieces[0]
    expected = shape.Volume() if dimensionality == 3 else shape.Area()
    for other, labels in pieces[1:]:
        expected += other.Volume() if dimensionality == 3 else other.Area()
        maker = BRepAlgoAPI_Fuse(shape.wrapped, other.wrapped)
        if not maker.IsDone():
            fail('Sheet-metal regions could not be joined.')
        result = cq.Shape.cast(maker.Shape())
        names.merge(labels)
        names.update(maker, result, [shape, other])
        shape = result
    measured = shape.Volume() if dimensionality == 3 else shape.Area()
    if abs(expected - measured) > max(1e-6, expected * 1e-8):
        fail('Sheet-metal regions overlap. Change the flange dimensions or add a seam/clearance.',
             'SM_FLAT_OVERLAP' if dimensionality==2 else 'SM_MATERIAL_OVERLAP',
             measured=abs(expected-measured),limit=max(1e-6,expected*1e-8),units='mm2' if dimensionality==2 else 'mm3')
    if not shape.isValid() or (dimensionality == 3 and len(shape.Solids()) != 1):
        fail('The sheet must form one connected, valid solid.')
    return shape.Solids()[0] if dimensionality == 3 else shape, names


@dataclass
class Panel:
    id: str
    face: cq.Face
    labels: list[str | list[str]]  # One per face edge; see label_names.
    folded: list
    flat: list

    def record(self):
        return dict(id=self.id, face=encode(self.face), labels=self.labels, folded=self.folded, flat=self.flat)

    @classmethod
    def restore(cls, data):
        return cls(**{**data, 'face': decode(data['face'])})


@dataclass
class Sheet:
    id: str
    rules: Rules
    root: str
    panels: dict[str, Panel]
    bends: list[dict] = field(default_factory=list)
    state: str = 'folded'
    names: list[str] = field(default_factory=list)
    owner_shape: cq.Shape | None = field(default=None, repr=False)
    fixed: str | None = None
    reference: list | None = None  # Tangent plane for a pure cylindrical roll.
    rips: list[dict] = field(default_factory=list)
    forms: list = field(default_factory=list)

    def record(self):
        return dict(version=VERSION, id=self.id, rules=self.rules.record(), root=self.root,
                    panels={key: item.record() for key, item in self.panels.items()},
                    bends=self.bends, state=self.state, names=self.names, fixed=self.fixed, reference=self.reference,rips=self.rips,
                    forms=[f.record() for f in self.forms])

    @classmethod
    def restore(cls, data, owner_shape=None):
        from .forms import Form
        if data.get('version') != VERSION:
            fail('Unsupported sheet-metal cache version.')
        return cls(id=data['id'], rules=Rules(**data['rules']), root=data['root'],
                   panels={key: Panel.restore(item) for key, item in data['panels'].items()},
                   bends=data['bends'], state=data['state'], names=data['names'],
                   owner_shape=owner_shape if data.get('valid', True) else None, fixed=data.get('fixed'), reference=data.get('reference'),rips=data.get('rips',[]),
                   forms=[Form.restore(f) for f in data.get('forms',[])])

    def clone(self):
        return Sheet.restore(copy.deepcopy(self.record()))

    def transformed(self, trsf):
        """A clone moved rigidly by `trsf` (a gp_Trsf without scale or mirror). Only the world (folded) data moves:
        panel folded frames, bend origins and directions, and a roll's reference plane. Panel faces, flat frames,
        cuts and forms are local, so the developed blank is unchanged."""
        location = cq.Location(TopLoc_Location(trsf))
        moved = self.clone()
        for panel in moved.panels.values():
            panel.folded = move_frame(panel.folded, location)
        for bend in moved.bends:
            bend['origin'] = list(cq.Vector(gp_Pnt(*bend['origin']).Transformed(trsf)).toTuple())
            for key in ('axis', 'outward', 'normal'):
                bend[key] = list(cq.Vector(gp_Vec(*bend[key]).Transformed(trsf)).toTuple())
        if moved.reference is not None:
            moved.reference = move_frame(moved.reference, location)
        return moved

    def unfolded_frame(self, data):
        if not self.panels:
            return move_frame(data, plane(self.reference).location)
        fixed = self.panels[self.fixed or self.root]
        alignment = plane(fixed.folded).location * plane(fixed.flat).location.inverse
        return move_frame(data, alignment)

    def panel_frame(self, panel):
        return self.unfolded_frame(panel.flat) if self.state == 'unfolded' else panel.folded

    def flange(self, identity, parent_id, edge_index, length, angle, radius=None,
               k_factor=None, allowance=None, deduction=None, gap_start=0, gap_end=0, _allow_inner=False,
               position='bend_outside', length_reference='tangent', offset=0, up_to=None, end_offset=0,
               relief='none', relief_width=None, relief_depth=None):
        if self.state != 'folded':
            fail('Refold the sheet before adding a flange.')
        parent = self.panels[parent_id]
        edge = parent.face.Edges()[edge_index]
        if edge.geomType() != 'LINE':
            fail('An edge flange requires a straight panel boundary.')
        # Inner contours require a separate hole-flange formulation.
        if not _allow_inner and not any(edge.isSame(e) for e in parent.face.outerWire().Edges()):
            fail('An edge flange currently requires an outside boundary, not a hole edge.')
        angle = number(angle, 'Bend angle', -180, 180)
        if abs(angle) < 1e-5:
            fail('A bend angle must be nonzero.')
        radius, k, developed, method = self.rules.allowance(angle, radius, k_factor, allowance, deduction)
        length_reference={'outer_sharp':'outer','inner_sharp':'inner'}.get(length_reference,length_reference)
        if position not in {'bend_outside','material_inside','material_outside','centered'}:
            fail('Flange position must be bend_outside, material_inside, material_outside or centered.')
        if length_reference not in {'tangent','inner','outer'}:
            fail('Flange length_reference must be tangent, inner or outer.')
        if relief not in {'none','rectangular','round'}:
            fail('Bend relief must be none, rectangular or round.')
        if abs(angle)>=179 and (position!='bend_outside' or length_reference!='tangent'):
            fail('Virtual-sharp flange dimensions are undefined near 180 degrees; use tangent length and bend_outside placement.')
        offset = number(offset,'Flange placement offset')
        end_offset = number(end_offset,'Flange end offset')
        if up_to is not None:
            if length is not None or length_reference!='tangent':
                fail('An up_to flange uses its target plane instead of a length or length_reference.')
        elif end_offset != 0:
            fail('end_offset requires an up_to target plane.')
        theta = math.radians(abs(angle))
        setback = math.tan(theta/2)
        t = self.rules.thickness
        inward = {'bend_outside':0,'material_inside':radius+t,'material_outside':radius,'centered':radius+t/2}[position]*setback
        shift = offset-inward
        authored_length = None if length is None else number(length,'Flange length',positive=True)
        if up_to is None:
            length = number(length,'Flange length',positive=True)
            length -= {'tangent':0,'inner':radius,'outer':radius+t}[length_reference]*setback
            if length <= TOL:
                fail('Flange length leaves no straight material after the bend setback; increase it or reduce radius/angle.',
                     'SM_FLANGE_TOO_SHORT',entity=parent_id,measured=authored_length,limit=authored_length-length,units='mm')
        a, b = edge.startPoint(), edge.endPoint()
        u = (b - a).normalized()
        n = cq.Vector(0, 0, 1)
        out = n.cross(u)
        # Probe both sides of the boundary using a tiny planar disk intersection.
        probe = max(1e-5, min(edge.Length(), self.rules.thickness) * 1e-4)
        test = cq.Face.makeFromWires(cq.Wire.makeCircle(probe / 4, (a + b) * .5 + out * probe, n))
        if parent.face.intersect(test).Area() > probe * probe / 100:
            a, b, u, out = b, a, -u, -out
        start = number(gap_start, 'Start gap', 0)
        end = number(gap_end, 'End gap', 0)
        width = edge.Length() - start - end
        if width <= TOL:
            fail('Flange gaps leave no material width.')
        a = a + u * start
        edge_plane = cq.Plane(a,xDir=u,normal=n)
        original_a = a
        if shift < -TOL:
            cut_panel(parent,place(rectangle(width,-shift).translate((0,shift,0)),frame(edge_plane)),identity+'.position')
        elif shift > TOL:
            join_panel(parent,place(rectangle(width,shift),frame(edge_plane)),identity+'.position')
        if relief!='none':
            rw = t if relief_width is None else number(relief_width,'Relief width',positive=True)
            rd = t if relief_depth is None else number(relief_depth,'Relief depth',positive=True)
            # Relief lies beside the bent width, extending behind its start tangent.
            y0,y1 = shift-rd,max(0,shift)
            for x0 in (-rw,width):
                tool = rectangle(rw,y1-y0).translate((x0,y0,0))
                if relief=='round':
                    if rd < rw/2:
                        fail('Round relief depth must be at least half its width.')
                    circle = cq.Face.makeFromWires(cq.Wire.makeCircle(rw/2,(x0+rw/2,y0+rw/2,0),(0,0,1)))
                    if y1-(y0+rw/2)>TOL:
                        straight = rectangle(rw,y1-(y0+rw/2)).translate((x0,y0+rw/2,0))
                        circle = straight.fuse(circle).clean()
                    tool = circle.intersect(tool).clean()
                cut_panel(parent,place(tool,frame(edge_plane)),identity+'.relief')
        a = a+out*shift
        folded, flat = plane(parent.folded), plane(parent.flat)
        p = folded.toWorldCoords(a)
        axis = folded.toWorldCoords(a + u) - p
        outward = folded.toWorldCoords(a + out) - p
        normal = folded.zDir
        for bend in self.bends:
            if bend['parent'] != parent_id:
                continue
            delta = p-cq.Vector(*bend['origin'])
            other_axis = cq.Vector(*bend['axis'])
            if delta.cross(other_axis).Length < TOL and axis.cross(other_axis).Length < TOL:
                ends = sorted((delta.dot(other_axis), (delta+axis*width).dot(other_axis)))
                if min(ends[1], bend['width_mm'])-max(ends[0], 0) > TOL:
                    fail('That panel boundary already has a bend.')
        s = 1 if angle > 0 else -1
        ref_radius = radius if s > 0 else radius + self.rules.thickness
        end_point = p + outward * (ref_radius * math.sin(theta)) + normal * (s * ref_radius * (1 - math.cos(theta)))
        child_normal = normal * math.cos(theta) - outward * (s * math.sin(theta))
        child_plane = cq.Plane(end_point,xDir=axis,normal=child_normal)
        if up_to is not None:
            target = plane(up_to)
            cosine = target.zDir.dot(child_plane.yDir)
            if abs(cosine)<TOL:
                fail('The flange direction is parallel to the up_to target plane.')
            length = (target.origin-end_point).dot(target.zDir)/cosine-end_offset
            if length<=TOL:
                fail('The up_to plane/offset leaves no positive straight flange length.')
        flat_p = flat.toWorldCoords(a)
        flat_axis = flat.toWorldCoords(a + u) - flat_p
        flat_out = flat.toWorldCoords(a + out) - flat_p
        child = Panel(identity, rectangle(width, length), ['start', 'right', 'end', 'left'],
                      frame(cq.Plane(end_point, xDir=axis, normal=child_normal)),
                      frame(cq.Plane(flat_p + flat_out * developed, xDir=flat_axis, normal=flat_axis.cross(flat_out))))
        self.panels[identity] = child
        self.bends.append(dict(id=identity, parent=parent_id, child=identity, edge_index=edge_index,
            angle_deg=angle, radius_mm=radius, k_factor=k, allowance_mm=developed, allowance_method=method,
            width_mm=width, straight_length_mm=length, origin=list(p.toTuple()), axis=list(axis.toTuple()),
            outward=list(outward.toTuple()), normal=list(normal.toTuple()),
            position=position, length_reference=length_reference, authored_length_mm=authored_length,
            placement_offset_mm=offset, end_offset_mm=end_offset, relief=relief,
            attachment_start=list(original_a.toTuple()), attachment_end=list((original_a+u*width).toTuple()),
            flat=frame(cq.Plane(flat_p, xDir=flat_axis, normal=flat_axis.cross(flat_out)))))

    def miter(self, identity, gap):
        """Trim intersecting perpendicular, coplanar return flanges at their bisector."""
        gap=number(gap,'Miter gap',positive=True)
        child=self.panels[identity]
        current=plane(child.folded)
        pairs=[]
        for other in self.panels.values():
            if other.id==identity:
                continue
            previous=plane(other.folded)
            if current.zDir.dot(previous.zDir)<1-TOL or abs((current.origin-previous.origin).dot(current.zDir))>TOL:
                continue
            if place(child.face,child.folded).intersect(place(other.face,other.folded)).Area()<=TOL:
                continue
            if abs(current.yDir.dot(previous.yDir))>TOL:
                fail('Automatic miter currently requires perpendicular coplanar flange directions.','SM_MITER_UNSUPPORTED',entity=other.id)
            if any(b['parent'] in {identity,other.id} for b in self.bends):
                fail('Miter these flanges before attaching further bends to them.','SM_MITER_HAS_CHILDREN',entity=other.id)
            attached=[next((b for b in self.bends if b['child']==p.id),None) for p in (child,other)]
            if any(b is None for b in attached):
                fail('Automatic miter applies to two edge flanges, not the base panel.','SM_MITER_UNSUPPORTED',entity=other.id)
            gradient=(current.yDir-previous.yDir).normalized()
            c=(-current.origin.dot(current.yDir)+previous.origin.dot(previous.yDir))/(current.yDir-previous.yDir).Length
            for panel,location,sign,bend in [(child,current,1,attached[0]),(other,previous,-1,attached[1])]:
                n=gradient*sign
                local_n=cq.Vector(n.dot(location.xDir),n.dot(location.yDir),0)
                limit=-gap/2-sign*(gradient.dot(location.origin)+c)
                trim_halfplane(panel,local_n,limit,identity+'.miter')
                # Carry the open seam through the end of the cylindrical bend.
                # At local panel y=0, the bisector determines the retained axial span.
                if abs(local_n.x)<TOL:
                    fail('Could not identify the miter bend-end relief.','SM_MITER_UNSUPPORTED',entity=panel.id)
                cut_at=limit/local_n.x
                w=bend['width_mm']
                if local_n.x>0:
                    x0,x1=max(0,cut_at),w
                else:
                    x0,x1=0,min(w,cut_at)
                if x1-x0>TOL:
                    if x1-x0>=w-TOL:
                        fail('Miter would remove the whole bend attachment.','SM_MITER_TOO_LARGE',entity=panel.id)
                    bend.setdefault('cuts',[]).append(dict(id=identity+'.miter',bounds=[x0,0,x1,bend['allowance_mm']]))
            pairs.append(other.id)
        return pairs

    def bend_face(self, bend):
        face = rectangle(bend['width_mm'], bend['allowance_mm'])
        for cut in bend.get('cuts', []):
            x0, y0, x1, y1 = cut['bounds']
            face = face.cut(rectangle(x1-x0, y1-y0).translate((x0, y0, 0)))
        return face

    def bend_piece(self, bend, flat=False):
        identity = bend['id'] + '.bend'
        if flat:
            data = self.unfolded_frame(bend['flat'])
            face = place(rectangle(bend['width_mm'], bend['allowance_mm']), data)
            shape, original = prism(face, -plane(data).zDir * self.rules.thickness, identity, ['inlet', 'end', 'outlet', 'start'])
            names = Names()
            for key, faces in original.faces.items():
                suffix = key.removeprefix(identity+'.')
                if suffix in ('top', 'bottom'):
                    suffix = 'inner' if (suffix == 'top') == (bend['angle_deg'] > 0) else 'outer'
                else:
                    suffix = suffix.removeprefix('side(').removesuffix(')')
                names.add(identity+'.'+suffix, [f.wrapped for f in faces])
            for cut in bend.get('cuts', []):
                x0, y0, x1, y1 = cut['bounds']
                tool_face = place(rectangle(x1-x0,y1-y0).translate((x0,y0,0)),data)
                tool, _ = prism(tool_face,-plane(data).zDir*self.rules.thickness,'tool',['a','b','c','d'])
                shape, names = subtract((shape,names),tool,cut['id']+'.side')
            return shape, names
        shape, names = self.bend_sector(bend)
        for cut in bend.get('cuts', []):
            x0, y0, x1, y1 = cut['bounds']
            tool, _ = self.bend_sector(bend, x0, x1, y0, y1)
            shape, names = subtract((shape,names),tool,cut['id']+'.side')
        return shape, names

    def bend_sector(self, bend, x0=0, x1=None, y0=0, y1=None):
        identity = bend['id'] + '.bend'
        p, u, out, n = (cq.Vector(*bend[key]) for key in ('origin', 'axis', 'outward', 'normal'))
        p = p+u*x0
        width = (bend['width_mm'] if x1 is None else x1)-x0
        sign = 1 if bend['angle_deg'] > 0 else -1
        theta = math.radians(abs(bend['angle_deg']))
        alpha0 = theta*y0/bend['allowance_mm']
        alpha1 = theta*(bend['allowance_mm'] if y1 is None else y1)/bend['allowance_mm']
        r, t = bend['radius_mm'], self.rules.thickness
        center = p + n * (r if sign > 0 else -(r + t))
        def point(radius, alpha):
            return center + out * (radius * math.sin(alpha)) - n * (sign * radius * math.cos(alpha))
        outer = cq.Edge.makeThreePointArc(point(r+t, alpha0), point(r+t, (alpha0+alpha1)/2), point(r+t, alpha1))
        inner = cq.Edge.makeThreePointArc(point(r, alpha1), point(r, (alpha0+alpha1)/2), point(r, alpha0))
        edges = [outer, cq.Edge.makeLine(point(r+t, alpha1), point(r, alpha1)), inner,
                 cq.Edge.makeLine(point(r, alpha0), point(r+t, alpha0))]
        section = cq.Face.makeFromWires(cq.Wire.assembleEdges(edges))
        maker = BRepPrimAPI_MakePrism(section.wrapped, gp_Vec(*(u * width).toTuple()))
        shape, names = cq.Shape.cast(maker.Shape()), Names()
        names.add(identity + '.start', [maker.FirstShape()])
        names.add(identity + '.end', [maker.LastShape()])
        for edge in section.Edges():
            matches = [label for label, original in zip(['outer', 'outlet', 'inner', 'inlet'], edges)
                       if abs(edge.Length()-original.Length()) < TOL and (edge.Center()-original.Center()).Length < TOL]
            if len(matches) != 1:
                fail('The bend section has ambiguous edge provenance.')
            names.add(identity + '.' + matches[0], maker.Generated(edge.wrapped))
        return shape, names

    def build(self, flat=None):
        from .forms import panel_material,validate_forms
        self.validate_attachments()
        validate_forms(self)
        flat = self.state == 'unfolded' if flat is None else flat
        pieces = []
        for panel in self.panels.values():
            data = self.unfolded_frame(panel.flat) if flat else panel.folded
            material=panel_material(self,panel,flat)
            pieces.append(prism(place(material.face, data), -plane(data).zDir * self.rules.thickness, panel.id, material.labels))
        pieces.extend(self.bend_piece(bend, flat) for bend in self.bends)
        if not flat:
            pieces.extend(form.piece(self.panels[form.panel].folded) for form in self.forms)
        return fuse(pieces)

    def validate_attachments(self):
        """A panel edit must not leave material spanning a severed bend attachment."""
        for bend in self.bends:
            for key,y in [('parent',0),('child',bend['allowance_mm'])]:
                identity=bend[key]
                if identity is None:
                    continue
                panel=self.panels[identity]
                line=cq.Edge.makeLine((0,y,0),(bend['width_mm'],y,0))
                segments=line.intersect(self.bend_face(bend)).Edges()
                for segment in segments:
                    local=plane(panel.flat).toLocalCoords(place(segment,bend['flat']))
                    connected=sum(e.Length() for e in local.intersect(panel.face).Edges())
                    if local.Length()-connected>1e-6:
                        fail('A panel edit severs an existing bend attachment. Use a mapped cross-bend cut or explicit bend rip.',
                             'SM_ATTACHMENT_SEVERED',entity=identity,bend=bend['id'],measured=connected,limit=local.Length(),units='mm')

    def bend_line(self, bend):
        """A bend's centre line on the developed blank (the middle of its allowance, where it's marked and gauged), as
        the DXF draws it: its pieces in order along it (a cut across the bend leaves several), in flat_face's frame."""
        line = cq.Edge.makeLine((0,bend['allowance_mm']/2,0),(bend['width_mm'],bend['allowance_mm']/2,0))
        segments = sorted(line.intersect(self.bend_face(bend)).Edges(), key=lambda e:e.Center().x)
        return [place(segment, bend['flat']) for segment in segments]

    def developed(self):
        """The flat solid with its persistent names (each panel's sides and faces, each bend zone's, cut sides), in
        flat_face's frame: build(flat=True) moved back from where unfolding places it, so its
        edges lie on the DXF's outline. Pressed forms are marks on the blank, not edges, so they aren't in it."""
        shape, names = self.build(flat=True)
        if self.panels:
            fixed = self.panels[self.fixed or self.root]
            back = plane(fixed.flat).location * plane(fixed.folded).location.inverse
        else:
            back = plane(self.reference).location.inverse
        moved = Names()
        for name, faces in names.faces.items():
            moved.add(name, [face.moved(back) for face in faces])
        return shape.moved(back), moved

    def flat_face(self):
        from .forms import panel_material,validate_forms
        validate_forms(self)
        faces = [place(panel_material(self,p,True).face, p.flat) for p in self.panels.values()]
        faces.extend(place(self.bend_face(b), b['flat']) for b in self.bends)
        result, _ = fuse([(f, Names()) for f in faces], dimensionality=2)
        result = result.clean()
        if len(result.Faces()) != 1:
            fail('The flat pattern is not a single connected planar region.')
        return result.Faces()[0]

    def report(self):
        return dict(version=VERSION, body=self.id, units='mm', state=self.state, root=self.root, fixed=self.fixed or self.root,
                    rules=self.rules.record(), panels=[dict(id=p.id, folded=p.folded, flat=p.flat, active=self.panel_frame(p)) for p in self.panels.values()],
                    bends=self.bends,rips=self.rips,forms=[f.report() for f in self.forms])
