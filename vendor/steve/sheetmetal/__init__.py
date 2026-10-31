"""Sheet-metal feature methods mixed into STEVE Model and Component."""
from __future__ import annotations

import copy
import math
import cadquery as cq
from .geometry import Panel, Rules, Sheet, TOL, carried_labels, cut_panel, join_panel, fail, frame, place, plane, number, rectangle
from .rips import RipMixin
from .forms import FormMixin


class SheetMetalMixin(RipMixin,FormMixin):
    def _sheet(self, body=None):
        identity = body or self.active
        sheet = self.__dict__.get('_sheet_metal', {}).get(identity)
        if sheet is None:
            fail(f'Body {identity!r} is not a sheet-metal body.')
        current = self.bodies.get(identity)
        if current is None or sheet.owner_shape is None or not current.isSame(sheet.owner_shape):
            fail(f'Sheet-metal body {identity!r} was changed by an unsupported solid operation. Use sheet-metal features before generating manufacturing output.',
                 'SM_UNSUPPORTED_SOLID_EDIT',entity=identity)
        return sheet

    def _commit_sheet(self, feature, sheet):
        shape, names = sheet.build()
        # Validate development on every edit; invalid flats cannot hide behind valid solids.
        sheet.flat_face()
        old = self.__dict__.get('_sheet_metal', {}).get(sheet.id)
        materials = None
        if old is None and sheet.rules.material is not None:
            from ..materials import Assignments, library
            if sheet.rules.material not in library():
                fail(f'Sheet rule material {sheet.rules.material!r} is not in the material library.')
            materials = copy.deepcopy(self.__dict__.get('materials', Assignments()))
            materials.add(sheet.rules.material,bodies=[sheet.id])
        if old is None and sheet.id in self.bodies:
            replaced = set(self.bodies[sheet.id].Faces())
            for ref, faces in self.names.faces.items():
                self.names.faces[ref] = [f for f in faces if f not in replaced]
        for name in old.names if old else []:
            self.names.faces.pop(name, None)
        self.names.merge(names)
        sheet.names = list(names.faces)
        sheet.owner_shape = shape
        self.bodies[sheet.id] = shape
        self.__dict__.setdefault('_sheet_metal', {})[sheet.id] = sheet
        self.active = sheet.id
        if materials is not None:
            self.materials = materials
        feature.body, feature.created = sheet.id, list(names.faces)
        feature.detail = dict(sheet_metal=True, state=sheet.state)

    @staticmethod
    def _sheet_rules(rule, thickness, radius, k_factor, source=None):
        if rule is None:
            return Rules(thickness,radius,k_factor,source=source)
        if not isinstance(rule,Rules):
            fail('rule must be a SheetMetalRule or a rule selected from a GaugeTable.')
        if any(v is not None for v in (thickness,radius,k_factor)):
            fail('Specify rule or explicit thickness/radius/k_factor, not both; edit the named rule to change its dimensions.')
        record=copy.deepcopy(rule.record())
        if source is not None:
            record['source']=source
        return Rules(**record)

    def sheet_base(self, id, profile, thickness=None, radius=None, k_factor=None, body=None, name=None, suppressed=False, rule=None, source=None):
        """Create sheet material below the profile plane; rules use mm and degrees."""
        with self._feature(id, 'sheet_base', name, suppressed) as feature:
            if feature is None:
                return
            identity = body or id
            if identity in self.bodies:
                fail(f'Body {identity!r} already exists.')
            faces, entities, sketch = self._profile_faces(profile)
            if len(faces) != 1:
                fail('A base sheet requires one connected planar profile (holes are allowed).')
            face = faces[0]
            local = sketch.plane.toLocalCoords(face)
            labels = [entities.get(edge) or f'edge_{i+1}' for i, edge in enumerate(face.Edges())]
            panel = Panel(id, local, labels, frame(sketch.plane), frame(cq.Plane.XY()))
            self._commit_sheet(feature, Sheet(identity, self._sheet_rules(rule,thickness,radius,k_factor,source), id, {id: panel}))

    def sheet_roll(self, id, width, angle, thickness=None, radius=None, k_factor=None, on='XY', body=None, name=None, suppressed=False, rule=None, source=None):
        """An exact open cylindrical sheet; width runs from the plane's origin along its X axis.

        The roll starts at the origin, tangent to the plane, and its first material heads along the plane's +Y.
        A positive angle curls toward the plane's normal around an axis one inside radius above the origin (inside
        face on the plane); a negative angle curls away around an axis radius + thickness below it (outside face on
        the plane). Example: on="YZ" puts the axis at world (radius, y, 0), the arc starting at 180° seen in X–Z.
        `on` takes the named planes XY, YZ, ZX, XZ, YX, ZY (as cq.Plane.named), a construction plane or a face; ZX and
        XZ share a plane but their normals are opposite (+Y and -Y), so the same roll curls to opposite sides.
        """
        with self._feature(id, 'sheet_roll', name, suppressed) as feature:
            if feature is None:
                return
            identity = body or id
            if identity in self.bodies:
                fail(f'Body {identity!r} already exists.')
            width = number(width,'Roll width',positive=True)
            angle = number(angle,'Roll angle',-359.9,359.9)
            if abs(angle)<1e-5:
                fail('Roll angle must be nonzero; use sheet_base for a flat plate.')
            rules = self._sheet_rules(rule,thickness,radius,k_factor,source)
            _,k,ba,method = rules.allowance(angle)
            location = self.plane_of(on)
            bend = dict(id=id,parent=None,child=None,edge_index=None,kind='roll',angle_deg=angle,radius_mm=rules.radius,
                        k_factor=k,allowance_mm=ba,allowance_method=method,width_mm=width,straight_length_mm=0,
                        origin=list(location.origin.toTuple()),axis=list(location.xDir.toTuple()),
                        outward=list(location.yDir.toTuple()),normal=list(location.zDir.toTuple()),flat=frame(cq.Plane.XY()))
            self._commit_sheet(feature,Sheet(identity,rules,id,{},bends=[bend],reference=frame(location)))

    def sheet_convert(self, id, face, thickness=None, radius=None, k_factor=None, body=None, name=None, suppressed=False, rule=None, source=None):
        """Recognize a uniform flat plate by exact reconstruction, including holes."""
        with self._feature(id, 'sheet_convert', name, suppressed) as feature:
            if feature is None:
                return
            identity = body or self.active
            if identity not in self.bodies:
                fail('Select an existing solid body to convert.')
            if identity in self.__dict__.get('_sheet_metal', {}):
                fail('This body already has sheet-metal history; edit its source rules instead.')
            selected = self.faces(face)
            shape = self.bodies[identity]
            if len(selected) != 1 or selected[0].geomType() != 'PLANE' or not any(selected[0].isSame(f) for f in shape.Faces()):
                fail('Select one planar outside face belonging to the body.')
            rules = self._sheet_rules(rule,thickness,radius,k_factor,source)
            top = selected[0]
            location = cq.Plane(top.Center(), normal=top.normalAt())
            local = location.toLocalCoords(top)
            panel = Panel(id, local, [f'edge_{i+1}' for i in range(len(local.Edges()))], frame(location), frame(cq.Plane.XY()))
            candidate = Sheet(identity,rules,id,{id:panel})
            rebuilt, _ = candidate.build()
            mismatch = shape.cut(rebuilt).Volume()+rebuilt.cut(shape).Volume()
            if len(shape.Solids()) != 1 or mismatch > max(1e-6,shape.Volume()*1e-8):
                fail('The body is not a uniform flat plate of this thickness. Bent/imported curved-sheet recognition is not supported by sheet_convert.')
            self._commit_sheet(feature,candidate)

    def sheet_contour(self, id, edge, segments, body=None, name=None, suppressed=False):
        """Constant-width sequence of tangent lengths and signed bends from an edge."""
        with self._feature(id, 'sheet_contour', name, suppressed) as feature:
            if feature is None:
                return
            if not isinstance(segments,(list,tuple)) or not 1 <= len(segments) <= 32:
                fail('A contour requires 1 to 32 segment dictionaries with length and angle.')
            current = self._sheet(body)
            parent,index = self._sheet_attachment(current,edge)
            candidate = current.clone()
            for i, segment in enumerate(segments):
                if not isinstance(segment,dict) or set(segment)-{'length','angle','radius','k_factor','allowance','deduction'} or not {'length','angle'} <= set(segment):
                    fail('Each contour segment needs length and angle; optional radius, k_factor, allowance or deduction.')
                child = id if len(segments)==1 else f'{id}.{i+1}'
                candidate.flange(child,parent,index,**segment)
                parent = child
                index = candidate.panels[child].labels.index('end')
            self._commit_sheet(feature,candidate)

    def sheet_tab(self, id, panel, bounds, gap, angle=45, radius=None, k_factor=None,
                  allowance=None, body=None, name=None, suppressed=False):
        """Cut a U clearance and form its rectangular tab with one cylindrical bend."""
        with self._feature(id, 'sheet_tab', name, suppressed) as feature:
            if feature is None:
                return
            candidate = self._sheet(body).clone()
            if candidate.state!='folded' or panel not in candidate.panels:
                fail('Select a planar panel in the folded sheet.')
            if not isinstance(bounds,(list,tuple)) or len(bounds)!=4:
                fail('Tab bounds must be [x0,y0,x1,y1] in panel-local millimetres.')
            x0,y0,x1,y1 = [number(v,'Tab coordinate') for v in bounds]
            gap = number(gap,'Tab cut clearance',positive=True)
            if x1-x0 <= TOL or y1-y0 <= TOL:
                fail('Tab bounds must have positive width and length.')
            angle = number(angle,'Tab angle',-180,180)
            if abs(angle)<1e-5:
                fail('Tab angle must be nonzero.')
            radius,k,ba,_ = candidate.rules.allowance(angle,radius,k_factor,allowance)
            if y1-y0 <= ba+TOL:
                fail('The tab is too short for the selected bend allowance; increase its length or reduce the radius.')
            item = candidate.panels[panel]
            tool = rectangle(x1-x0+2*gap,y1-y0+gap).translate((x0-gap,y0,0))
            if abs(item.face.intersect(tool).Area()-tool.Area()) > max(1e-6,tool.Area()*1e-8):
                fail('The tab and its clearance must lie entirely within one uninterrupted panel.')
            cut_panel(item,tool,id)
            line = cq.Edge.makeLine((x0-gap,y0,0),(x1+gap,y0,0))
            matches = [i for i,e in enumerate(item.face.Edges()) if abs(e.Length()-line.Length())<TOL and (e.Center()-line.Center()).Length<TOL]
            if len(matches)!=1:
                fail('The tab attachment could not be identified unambiguously.')
            candidate.flange(id,panel,matches[0],y1-y0-ba,angle,radius,k_factor,allowance,
                             gap_start=gap,gap_end=gap,_allow_inner=True)
            self._commit_sheet(feature,candidate)
            feature.detail.update(form='developable_tab',clearance_mm=gap)

    def sheet_bend(self, id, panel, start, end, angle=90, radius=None, k_factor=None,
                   allowance=None, deduction=None, body=None, name=None, suppressed=False):
        """Bend an existing blank along a line in panel-local XY; left side moves."""
        with self._feature(id, 'sheet_bend', name, suppressed) as feature:
            if feature is None:
                return
            candidate = self._sheet(body).clone()
            if candidate.state != 'folded' or panel not in candidate.panels:
                fail('Select a planar panel in the folded sheet.')
            if any(b['parent']==panel for b in candidate.bends):
                fail('Apply sketched bends before attaching flanges to that panel.')
            item = candidate.panels[panel]
            if any(not isinstance(p,(list,tuple)) or len(p)!=2 for p in (start,end)):
                fail('Bend start and end must be two panel-local XY coordinates.')
            a,b = [cq.Vector(*(number(v,'Bend coordinate') for v in p),0) for p in (start,end)]
            if (b-a).Length < TOL:
                fail('The bend line needs two distinct points.')
            bend_plane = cq.Plane(a,xDir=b-a,normal=(0,0,1))
            local = bend_plane.toLocalCoords(item.face)
            box = local.BoundingBox()
            angle = number(angle,'Bend angle',-180,180)
            if abs(angle)<1e-5:
                fail('A bend angle must be nonzero.')
            radius,k,ba,_ = candidate.rules.allowance(angle,radius,k_factor,allowance,deduction)
            if box.ymin >= -TOL or box.ymax <= ba+TOL:
                fail('The blank needs straight material on both sides of the bend allowance zone.')
            band = local.intersect(rectangle(box.xlen,ba).translate((box.xmin,0,0)))
            if len(band.Faces())!=1 or abs(band.Area()-box.xlen*ba)>max(1e-6,band.Area()*1e-8):
                fail('The sketched bend zone must be a full rectangular strip without holes or tapered boundaries.')
            retained = local.intersect(rectangle(box.xlen,-box.ymin).translate((box.xmin,box.ymin,0)))
            moving = local.intersect(rectangle(box.xlen,box.ymax-ba).translate((box.xmin,ba,0)))
            if len(retained.Faces())!=1 or len(moving.Faces())!=1:
                fail('Each side of the bend must remain one connected panel.')
            # Cut away the moving region using provenance rather than renaming old edges.
            before, labels = item.face, list(item.labels)
            tool = place(rectangle(box.xlen,box.ymax+1).translate((box.xmin,0,0)),frame(bend_plane))
            cut_panel(item,tool,id)
            line = cq.Edge.makeLine(bend_plane.toWorldCoords((box.xmin,0,0)),bend_plane.toWorldCoords((box.xmax,0,0)))
            matches = [i for i,e in enumerate(item.face.Edges()) if abs(e.Length()-line.Length())<TOL and (e.Center()-line.Center()).Length<TOL]
            if len(matches)!=1:
                fail('The bend start line must cross the panel as one straight boundary.')
            # Incoming attachment must remain entirely on the fixed side.
            for incoming in candidate.bends:
                if incoming['child']==panel:
                    inlet = cq.Edge.makeLine((0,0,0),(incoming['width_mm'],0,0))
                    if abs(sum(e.Length() for e in inlet.intersect(item.face).Edges())-incoming['width_mm'])>1e-6:
                        fail('The moving side contains the previous bend attachment; reverse the bend line.')
            candidate.flange(id,panel,matches[0],box.ymax-ba,angle,radius,k_factor,allowance,deduction)
            child = candidate.panels[id]
            moving_parent = place(moving.Faces()[0],frame(bend_plane))
            moving_flat = place(moving_parent,item.flat)
            child.face = plane(child.flat).toLocalCoords(moving_flat)
            # The moved leg keeps its edges' names (holes and whole edges keep `<panel>.side(...)`).
            on_line = lambda e: e.geomType()=='LINE' and all(abs(bend_plane.toLocalCoords(p).y-ba)<1e-6 for p in (e.startPoint(),e.endPoint()))
            child.labels = carried_labels(panel,before,labels,moving_parent,on_line)
            from .forms import transfer_forms_after_bend
            transfer_forms_after_bend(candidate,panel)
            self._commit_sheet(feature,candidate)

    def _sheet_attachment(self, current, edge):
        if current.state != 'folded':
            fail('Refold the sheet before adding an edge feature.')
        selected = self.edges(edge)
        if len(selected) != 1:
            fail('Select exactly one straight panel edge for a flange.')
        selected = selected[0]
        matches = []
        for panel in current.panels.values():
            for index, boundary in enumerate(place(panel.face, panel.folded).Edges()):
                if (boundary.Center() - selected.Center()).Length < TOL and abs(boundary.Length() - selected.Length()) < TOL and boundary.distance(selected) < TOL:
                    matches.append((panel.id, index))
        if len(matches) != 1:
            fail('The selected edge is not one unambiguous top boundary of a planar sheet panel.')
        return matches[0]

    def sheet_flange(self, id, edge, length=None, angle=90, radius=None, k_factor=None,
                     allowance=None, deduction=None, gap_start=0, gap_end=0, body=None, name=None, suppressed=False,
                     position='bend_outside', length_reference='tangent', offset=0, up_to=None, end_offset=0,
                     relief='none', relief_width=None, relief_depth=None, miter_gap=None):
        """Add a cylindrical bend and straight flange to a free outer panel edge."""
        with self._feature(id, 'sheet_flange', name, suppressed) as feature:
            if feature is None:
                return
            current = self._sheet(body)
            parent, index = self._sheet_attachment(current, edge)
            candidate = current.clone()
            candidate.flange(id, parent, index, length, angle, radius, k_factor, allowance, deduction, gap_start, gap_end,
                             position=position,length_reference=length_reference,offset=offset,
                             up_to=frame(self.plane_of(up_to)) if up_to is not None else None,end_offset=end_offset,
                             relief=relief,relief_width=relief_width,relief_depth=relief_depth)
            mitered=candidate.miter(id,miter_gap) if miter_gap is not None else []
            self._commit_sheet(feature, candidate)
            if miter_gap is not None:
                feature.detail.update(miter_gap_mm=miter_gap,mitered_panels=mitered)

    def sheet_hem(self, id, edge, length, gap, direction='up', allowance=None, body=None, name=None, suppressed=False):
        """An open 180-degree hem; gap is the clear distance between facing sheets."""
        with self._feature(id, 'sheet_hem', name, suppressed) as feature:
            if feature is None:
                return
            if direction not in {'up','down'}:
                fail('Hem direction must be up or down.')
            gap = number(gap, 'Open hem gap', positive=True)
            current = self._sheet(body)
            parent, index = self._sheet_attachment(current, edge)
            candidate = current.clone()
            candidate.flange(id, parent, index, length, 180 if direction=='up' else -180,
                             radius=gap/2, allowance=allowance)
            self._commit_sheet(feature, candidate)
            feature.detail['hem_type'] = 'open'

    def sheet_corner(self, id, panels, gap, relief_depth=None, body=None, name=None, suppressed=False):
        """Close an orthogonal wall corner: first wall stops short, second covers its end.

        The gap is measured between the first wall's square end and the second
        wall's nearest surface. Extensions start above a relief at the bend end.
        """
        with self._feature(id,'sheet_corner',name,suppressed) as feature:
            if feature is None:
                return
            candidate = self._sheet(body).clone()
            if candidate.state!='folded':
                fail('Refold the sheet before closing a corner.')
            if not isinstance(panels,(list,tuple)) or len(panels)!=2 or panels[0]==panels[1] or any(p not in candidate.panels for p in panels):
                fail('A corner requires two different sheet panel IDs, ordered as terminating wall then covering wall.')
            gap = number(gap,'Corner gap',positive=True)
            depth = candidate.rules.thickness if relief_depth is None else number(relief_depth,'Corner relief depth',0)
            first,second = [candidate.panels[p] for p in panels]
            frames = [plane(p.folded) for p in (first,second)]
            if abs(frames[0].zDir.dot(frames[1].zDir))>TOL or abs(abs(frames[0].yDir.dot(frames[1].yDir))-1)>TOL:
                fail('Corner closure requires perpendicular planar walls with parallel height directions.')
            if any(b['parent'] in panels for b in candidate.bends):
                fail('Close this corner before adding bends to either wall.')
            for panel in (first,second):
                incoming = [b for b in candidate.bends if b['child']==panel.id]
                if len(incoming)!=1 or abs(abs(incoming[0]['angle_deg'])-90)>TOL:
                    fail('Corner closure currently requires walls made by 90-degree bends.')
            changes = []
            for index,(panel,other) in enumerate(((first,second),(second,first))):
                own,opposite = plane(panel.folded),plane(other.folded)
                dot = own.xDir.dot(opposite.zDir)
                if abs(dot)<TOL:
                    fail('The selected wall ends do not face this corner.')
                d = (opposite.origin-own.origin).dot(opposite.zDir)
                interval = sorted((d/dot,(d-candidate.rules.thickness)/dot))
                box = panel.face.BoundingBox()
                center = (box.xmin+box.xmax)/2
                if center < interval[0]:
                    direction,edge,near,far = 1,box.xmax,interval[0],interval[1]
                elif center > interval[1]:
                    direction,edge,near,far = -1,box.xmin,interval[1],interval[0]
                else:
                    fail('The other wall intersects the middle of this panel; select adjacent free wall ends.')
                target = near-direction*gap if index==0 else far
                y0 = box.ymin+depth
                # Only close the common height range; do not grow material above the other wall.
                other_box = other.face.BoundingBox()
                ys = [own.toLocalCoords(opposite.toWorldCoords((0,y,0))).y for y in (other_box.ymin+depth,other_box.ymax)]
                y0,y1 = max(y0,min(ys)),min(box.ymax,max(ys))
                if y1-y0 <= TOL:
                    fail('The walls have no common straight height above the corner relief.')
                if abs(target-edge) <= TOL:
                    changes.append(dict(panel=panel.id,from_x=edge,to_x=target))
                    continue
                tool = rectangle(abs(target-edge),y1-y0).translate((min(target,edge),y0,0))
                if (target-edge)*direction>0:
                    join_panel(panel,tool,id)
                else:
                    cut_panel(panel,tool,id)
                changes.append(dict(panel=panel.id,from_x=edge,to_x=target))
            self._commit_sheet(feature,candidate)
            feature.detail.update(corner='butt',gap_mm=gap,relief_depth_mm=depth,panels=changes)

    def sheet_jog(self, id, edge, offset, length, angle=45, radius=None, body=None, name=None, suppressed=False):
        """Extend an edge with two opposed bends and a parallel offset end panel."""
        with self._feature(id, 'sheet_jog', name, suppressed) as feature:
            if feature is None:
                return
            current = self._sheet(body)
            offset = number(offset, 'Jog offset')
            angle = number(angle, 'Jog angle', 1, 90)
            radius = current.rules.radius if radius is None else number(radius, 'Inside radius', positive=True)
            theta = math.radians(angle)
            rise = (abs(offset)-(2*radius+current.rules.thickness)*(1-math.cos(theta)))/math.sin(theta)
            if rise <= TOL:
                fail('The offset is too small for the selected bend radius, thickness and angle.')
            parent, index = self._sheet_attachment(current, edge)
            candidate = current.clone()
            sign = 1 if offset > 0 else -1
            intermediate = id + '.rise'
            candidate.flange(intermediate, parent, index, rise, sign*angle, radius=radius)
            end = candidate.panels[intermediate].labels.index('end')
            candidate.flange(id, intermediate, end, length, -sign*angle, radius=radius)
            self._commit_sheet(feature, candidate)
            feature.detail['offset_mm'] = offset

    def sheet_cut(self, id, profile, panel=None, body=None, name=None, suppressed=False):
        """Through cuts, walls named `<id>.side(<sketch entity>)`; unfolded cuts may cross bends with axis-aligned rectangles."""
        with self._feature(id, 'sheet_cut', name, suppressed) as feature:
            if feature is None:
                return
            candidate = self._sheet(body).clone()
            faces, entities, sketch = self._profile_faces(profile)
            # A cut's walls are named like an extruded cut's: `<id>.side(<sketch entity>)`.
            named = [[f'{id}.side({entities[edge]})' if entities.get(edge) else None for edge in face.Edges()] for face in faces]
            if candidate.state == 'unfolded' and panel is None:
                self._sheet_flat_cut(candidate, id, faces, sketch, named)
                self._commit_sheet(feature, candidate)
                return
            matches = []
            for item in candidate.panels.values():
                if panel is not None and panel != item.id:
                    continue
                location = plane(candidate.panel_frame(item))
                if abs(abs(location.zDir.dot(sketch.plane.zDir)) - 1) < TOL and abs((sketch.plane.origin - location.origin).dot(location.zDir)) < TOL:
                    locals_ = [location.toLocalCoords(face) for face in faces]
                    if all(abs(item.face.intersect(face).Area() - face.Area()) < max(1e-6, face.Area()*1e-8) for face in locals_):
                        matches.append((item, locals_))
            if len(matches) != 1:
                fail('The cut must lie completely inside one planar panel. Select a panel explicitly; cuts crossing bends or panel edges are not supported by this operation yet.')
            item, tools = matches[0]
            for tool, labels in zip(tools, named, strict=True):
                cut_panel(item, tool, id, labels)
            self._commit_sheet(feature, candidate)

    def sheet_relief(self, id, profile, panel, body=None, name=None, suppressed=False):
        """Sketch-defined open notches in one panel, with exact line/arc boundaries."""
        with self._feature(id, 'sheet_relief', name, suppressed) as feature:
            if feature is None:
                return
            candidate = self._sheet(body).clone()
            if panel not in candidate.panels:
                fail('Select the panel to receive the relief.')
            item = candidate.panels[panel]
            faces, _, sketch = self._profile_faces(profile)
            location = plane(candidate.panel_frame(item))
            self._sheet_coplanar(location, sketch)
            area = item.face.Area()
            for face in faces:
                cut_panel(item, location.toLocalCoords(face), id)
            if area-item.face.Area() < TOL:
                fail('The relief does not remove any panel material.')
            # A planar-only relief must not leave an uncut tab under an existing bend.
            for bend in candidate.bends:
                if bend['parent'] != panel and bend['child'] != panel:
                    continue
                bend_plane = plane(candidate.unfolded_frame(bend['flat'])) if candidate.state == 'unfolded' else None
                if bend_plane is not None:
                    a = bend_plane.toWorldCoords((0, 0 if bend['parent']==panel else bend['allowance_mm'], 0))
                    u = bend_plane.xDir
                else:
                    a = cq.Vector(*bend['origin']) if bend['parent']==panel else cq.Vector(*candidate.panels[panel].folded[0])
                    u = cq.Vector(*bend['axis'])
                line = cq.Edge.makeLine(location.toLocalCoords(a), location.toLocalCoords(a+u*bend['width_mm']))
                if abs(sum(e.Length() for e in line.intersect(item.face).Edges())-bend['width_mm']) > 1e-6:
                    fail('The relief reaches an existing bend. Unfold and use sheet_cut for a supported cross-bend slot.',
                         'SM_FEATURE_NEAR_BEND',entity=item.id,bend=bend['id'])
            self._commit_sheet(feature, candidate)

    @staticmethod
    def _sheet_coplanar(location, sketch):
        if abs(abs(location.zDir.dot(sketch.plane.zDir))-1) > TOL or abs((sketch.plane.origin-location.origin).dot(location.zDir)) > TOL:
            fail('The cut sketch must lie on the selected sheet plane.')

    def _sheet_flat_cut(self, candidate, identity, faces, sketch, named):
        """Map rectangular bend intersections analytically to annular-sector cuts."""
        location = plane(candidate.unfolded_frame(frame(cq.Plane.XY())))
        self._sheet_coplanar(location, sketch)
        tools = [location.toLocalCoords(face) for face in faces]
        before_area = candidate.flat_face().Area()
        for tool, labels in zip(tools, named, strict=True):
            for item in candidate.panels.values():
                local = plane(item.flat).toLocalCoords(tool)
                if item.face.intersect(local).Area() > TOL:
                    cut_panel(item, local, identity, labels)
            for bend in candidate.bends:
                local = plane(bend['flat']).toLocalCoords(tool)
                intersection = candidate.bend_face(bend).intersect(local)
                for piece in intersection.Faces():
                    box = piece.BoundingBox()
                    if len(piece.Edges()) != 4 or any(e.geomType() != 'LINE' for e in piece.Edges()) or abs(piece.Area()-box.xlen*box.ylen) > max(1e-6,piece.Area()*1e-8):
                        fail('Cuts crossing a bend must intersect it in rectangles aligned with the bend axis. Move curved or diagonal cuts onto a planar panel.',
                             'SM_UNSUPPORTED_BEND_CUT',entity=bend['id'])
                    bend.setdefault('cuts', []).append(dict(id=identity, bounds=[box.xmin,box.ymin,box.xmax,box.ymax]))
        if before_area-candidate.flat_face().Area() < TOL:
            fail('The cut does not remove any sheet material.')

    def sheet_unfold(self, id, fixed=None, body=None, name=None, suppressed=False):
        """Flatten a sheet-metal body; `fixed` names the panel that stays put (default: the base panel)."""
        with self._feature(id, 'sheet_unfold', name, suppressed) as feature:
            if feature is None:
                return
            candidate = self._sheet(body).clone()
            if fixed is not None and fixed not in candidate.panels and not (not candidate.panels and fixed==candidate.root):
                fail('The fixed panel must name a panel in this sheet-metal body.')
            candidate.fixed = fixed or candidate.root
            candidate.state = 'unfolded'
            self._commit_sheet(feature, candidate)

    def sheet_refold(self, id, body=None, name=None, suppressed=False):
        """Fold an unfolded sheet-metal body back to its formed shape."""
        with self._feature(id, 'sheet_refold', name, suppressed) as feature:
            if feature is None:
                return
            candidate = self._sheet(body).clone()
            candidate.state = 'folded'
            self._commit_sheet(feature, candidate)

    def sheet_metal_summary(self):
        """Each sheet-metal body's report: state, rules, panels, bends and forms, with its status."""
        result = {}
        for identity, sheet in self.__dict__.get('_sheet_metal', {}).items():
            item = sheet.report()
            try:
                self._sheet(identity)
                item['status'] = 'ok'
            except Exception as error:
                item.update(status='error', error=str(error))
            result[identity] = item
        return result
