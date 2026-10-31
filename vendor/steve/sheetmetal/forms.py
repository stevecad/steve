"""Reusable local form tools with distinct formed solids, flat cuts and process marks.

Pressed forms describe nominal tool geometry. Their flat treatment is explicitly
declared; this module does not infer material flow, thinning or springback.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass
import math
import cadquery as cq
from OCP.BRepPrimAPI import BRepPrimAPI_MakeRevol
from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt

from ..naming import Names
from .geometry import Panel, Sheet, cut_panel, encode, decode, frame, plane, place, prism, rectangle, fuse, TOL
from .validation import number, fail


class SheetMetalForm:
    """A parameterized tool definition, reusable across sheets and source modules.

    lance/louver: width, length, gap, optional angle=30 and radius=sheet rule.
    emboss/dimple: diameter (raised land), height, optional angle=45 and radius.
    dimple additionally requires hole_diameter and explicit flat_hole_diameter.
    """
    def __init__(self, kind, *, name=None, source=None, **parameters):
        required={'lance':{'width','length','gap'},'louver':{'width','length','gap'},
                  'emboss':{'diameter','height'},'dimple':{'diameter','height','hole_diameter','flat_hole_diameter'}}
        if kind not in required:
            fail('Form kind must be lance, louver, emboss or dimple.','SM_FORM_TOOL_INVALID')
        allowed=required[kind]|{'angle','radius'}
        if set(parameters)-allowed or not required[kind]<=set(parameters):
            fail(f'{kind} requires {sorted(required[kind])}; optional angle/radius. Unknown or missing dimensions were supplied.','SM_FORM_TOOL_INVALID')
        for label,value in [('name',name),('source',source)]:
            if value is not None and (not isinstance(value,str) or not value.strip()):
                fail(f'Form {label} must be a nonempty string.','SM_FORM_TOOL_INVALID')
        checked={}
        for key,value in parameters.items():
            if key=='radius' and value is None:
                checked[key]=None
            elif key=='flat_hole_diameter':
                checked[key]=number(value,key,0)
            else:
                checked[key]=number(value,key,positive=True)
        checked.setdefault('angle',30.0 if kind in {'lance','louver'} else 45.0)
        checked.setdefault('radius',None)
        if checked['angle']>=(135 if kind=='lance' else 90) or checked['angle']<1:
            fail('Form angle must be at least 1°, below 90° for pressed forms and below 135° for a lance.','SM_FORM_TOOL_INVALID')
        if kind=='dimple' and (checked['hole_diameter']>=checked['diameter'] or checked['flat_hole_diameter']>=checked['diameter']):
            fail('Both hole diameters must be smaller than the raised land diameter. Zero flat hole means piercing after forming.','SM_FORM_TOOL_INVALID')
        self.kind,self.name,self.source,self.parameters=kind,name,source,checked

    def record(self):
        return dict(kind=self.kind,name=self.name,source=self.source,parameters=copy.deepcopy(self.parameters))

    @classmethod
    def restore(cls,record):
        return cls(record['kind'],name=record.get('name'),source=record.get('source'),**record['parameters'])


@dataclass
class Form:
    id: str
    panel: str
    tool: dict
    at: list
    angle: float
    direction: str
    clearance: float
    shape: cq.Shape
    footprint: cq.Face
    cuts: list
    labels: list
    treatment: str
    marks: list
    resolved: dict

    def record(self):
        return dict(id=self.id,panel=self.panel,tool=self.tool,at=self.at,angle=self.angle,direction=self.direction,
                    clearance=self.clearance,shape=encode(self.shape),footprint=encode(self.footprint),
                    cuts=[encode(f) for f in self.cuts],labels=self.labels,treatment=self.treatment,
                    marks=[encode(s) for s in self.marks],resolved=self.resolved)

    @classmethod
    def restore(cls,data):
        return cls(**{**data,'shape':decode(data['shape']),'footprint':decode(data['footprint']),
                      'cuts':[decode(f) for f in data['cuts']],'marks':[decode(s) for s in data['marks']]})

    def report(self):
        return dict(id=self.id,panel=self.panel,tool=self.tool,at=self.at,angle_deg=self.angle,direction=self.direction,
                    clearance_mm=self.clearance,flat_treatment=self.treatment,resolved=self.resolved,
                    thickness_model='constant_gauge' if self.tool['kind'] in {'lance','emboss','dimple'} else 'nominal_gauge_with_side_wall_junctions')

    def piece(self,location):
        moved=self.shape.moved(plane(location).location)
        names=Names()
        for label,face in zip(self.labels,moved.Faces(),strict=True):
            names.add(self.id+'.'+label,[face])
        return moved,names


def panel_material(sheet,panel,flat):
    result=copy.copy(panel);result.labels=list(panel.labels)
    for form in sheet.forms:
        if form.panel!=panel.id:continue
        for tool in form.cuts if flat else [form.footprint]:
            if tool.Area()>TOL:cut_panel(result,tool,form.id+('.cut' if flat else '.boundary'))
    return result


def validate_forms(sheet):
    for form in sheet.forms:
        if form.panel not in sheet.panels:
            fail('A form lost its supporting panel.','SM_FORM_PANEL_MISSING',entity=form.id)
        panel=sheet.panels[form.panel]
        contained=form.footprint.intersect(panel.face).Area()
        if abs(contained-form.footprint.Area())>max(1e-6,form.footprint.Area()*1e-8):
            fail('The form footprint crosses a panel edge, opening or bend. Place it wholly on one planar panel.','SM_FORM_BOUNDARY',entity=form.id,panel=panel.id)
        distance=min(form.footprint.distance(w) for w in panel.face.Wires())
        if distance<form.clearance-TOL or distance<TOL:
            fail('The form is too close to a panel edge, opening or bend.','SM_FORM_CLEARANCE',entity=form.id,
                 measured=distance,limit=form.clearance,units='mm')
    for index,form in enumerate(sheet.forms):
        for other in sheet.forms[:index]:
            if other.panel!=form.panel:continue
            distance=form.footprint.distance(other.footprint)
            if distance<max(form.clearance,other.clearance)-TOL or distance<TOL:
                fail('Form footprints overlap or violate their requested clearance.','SM_FORM_COLLISION',entity=form.id,other=other.id,
                     measured=distance,limit=max(form.clearance,other.clearance),units='mm')


def transfer_forms_after_bend(sheet,original_panel):
    """A form wholly in a sketched bend's moving panel follows that material."""
    for form in sheet.forms:
        if form.panel!=original_panel:continue
        original=sheet.panels[original_panel]
        if abs(form.footprint.intersect(original.face).Area()-form.footprint.Area())<1e-6:continue
        old=plane(original.flat);canonical=form.footprint.moved(old.location)
        matches=[]
        for panel in sheet.panels.values():
            if panel.id==original_panel:continue
            local=canonical.moved(plane(panel.flat).location.inverse)
            if abs(local.intersect(panel.face).Area()-form.footprint.Area())<1e-6:matches.append(panel)
        if len(matches)!=1:
            fail('The sketched bend crosses a form footprint. Move the form clear of the bend strip.','SM_FORM_CROSSES_BEND',entity=form.id)
        target=matches[0];new=plane(target.flat);move=new.location.inverse*old.location
        form.shape=form.shape.moved(move);form.footprint=form.footprint.moved(move)
        form.cuts=[f.moved(move) for f in form.cuts];form.marks=[m.moved(move) for m in form.marks]
        at=new.toLocalCoords(old.toWorldCoords((*form.at,0)))
        direction=old.xDir*math.cos(math.radians(form.angle))+old.yDir*math.sin(math.radians(form.angle))
        form.at=[at.x,at.y];form.angle=math.degrees(math.atan2(direction.dot(new.yDir),direction.dot(new.xDir)))
        form.panel=target.id


def _named_labels(shape,names):
    labels=[]
    for face in shape.Faces():
        label=names.name_of(face)
        if label is None:
            fail('The form tool produced an unnamed face.','SM_FORM_GEOMETRY_INVALID')
        labels.append(label.removeprefix('tool.'))
    return labels


def _lance(tool,rules):
    p=tool.parameters;w,length,gap=p['width'],p['length'],p['gap'];t=rules.thickness
    r,k,ba,method=rules.allowance(p['angle'],p['radius'])
    if length<=ba+TOL:
        fail('The lance blank is shorter than its bend allowance.','SM_FORM_TOO_SHORT',measured=length,limit=ba,units='mm')
    footprint=rectangle(w+2*(gap+t),length+gap+2*t).translate((-w/2-gap-t,-t,0))
    panel=Panel('tool.support',footprint,['edge_1','edge_2','edge_3','edge_4'],frame(cq.Plane.XY()),frame(cq.Plane.XY()))
    sheet=Sheet('tool',rules,panel.id,{panel.id:panel})
    opening=rectangle(w+2*gap,length+gap).translate((-w/2-gap,0,0))
    cut_panel(panel,opening,'tool.clearance')
    edges=[i for i,e in enumerate(panel.face.Edges()) if abs(e.Center().y)<TOL and abs(e.Length()-(w+2*gap))<TOL]
    if len(edges)!=1:fail('The lance attachment is ambiguous.','SM_FORM_GEOMETRY_INVALID')
    sheet.flange('tool.lance',panel.id,edges[0],length-ba,p['angle'],r,gap_start=gap,gap_end=gap,_allow_inner=True)
    shape,names=sheet.build()
    flat_keep=rectangle(w,length).translate((-w/2,0,0))
    cuts=opening.cut(flat_keep).Faces()
    marks=[flat_keep.outerWire(),cq.Edge.makeLine((-w/2,ba/2,0),(w/2,ba/2,0))]
    return shape,footprint,cuts,_named_labels(shape,names),'developed_lance',marks,dict(thickness_mm=t,inside_radius_mm=r,
                bend_angle_deg=p['angle'],allowance_mm=ba,allowance_method=method,straight_length_mm=length-ba)


def _louver(tool,rules):
    p=tool.parameters;w,length,gap=p['width'],p['length'],p['gap'];t=rules.thickness
    r=rules.radius if p['radius'] is None else p['radius']
    theta=math.radians(p['angle'])
    tip=cq.Vector(0,r*math.sin(theta)+length*math.cos(theta),r*(1-math.cos(theta))+length*math.sin(theta))
    under=tip+cq.Vector(0,t*math.sin(theta),-t*math.cos(theta))
    if under.z<=TOL:
        fail('The louver has no clear opening below its lip. Increase length or angle.','SM_FORM_TOO_SHORT',measured=under.z,limit=0,units='mm')
    # Roof: exact cylindrical root and constant-gauge inclined panel.
    roof=Panel('tool.roof',rectangle(w,length),['start','right','end','left'],
               frame(cq.Plane((-w/2,r*math.sin(theta),r*(1-math.cos(theta))),xDir=(1,0,0),normal=(0,-math.sin(theta),math.cos(theta)))),frame(cq.Plane.XY()))
    # The sector builder uses this arc length only to parameterize its full sweep;
    # a pressed louver has no inferred neutral-axis development or bend-table row.
    bend=dict(id='tool.root',parent=None,child=None,angle_deg=p['angle'],radius_mm=r,allowance_mm=theta*r,width_mm=w,
              origin=[-w/2,0,0],axis=[1,0,0],outward=[0,1,0],normal=[0,0,1])
    helper=Sheet('tool',rules,'tool',{})
    roof_piece=prism(place(roof.face,roof.folded),-plane(roof.folded).zDir*t,roof.id,roof.labels)
    bend_piece=helper.bend_sector(bend)
    # Drawn end walls close the two short ends. Their junctions have nominal gauge;
    # this is a press-tool envelope, not an inference of local thinning.
    arc=cq.Edge.makeThreePointArc((0,0,0),(0,r*math.sin(theta/2),r*(1-math.cos(theta/2))),
                                 (0,r*math.sin(theta),r*(1-math.cos(theta))))
    points=[cq.Vector(0,r*math.sin(theta),r*(1-math.cos(theta))),tip,under,cq.Vector(0,under.y,-t),cq.Vector(0,0,-t),cq.Vector(0,0,0)]
    edges=[arc]+[cq.Edge.makeLine(a,b) for a,b in zip(points,points[1:])]
    side=cq.Face.makeFromWires(cq.Wire.assembleEdges(edges))
    labels=['root','roof','lip','front','bottom','back']
    sides=[prism(side.translate((w/2,0,0)),cq.Vector(t,0,0),'tool.right',labels),
           prism(side.translate((-w/2,0,0)),cq.Vector(-t,0,0),'tool.left',labels)]
    footprint=rectangle(w+4*t,under.y+gap+2*t).translate((-w/2-2*t,-t,0))
    opening=rectangle(w+2*t,under.y+gap).translate((-w/2-t,0,0))
    support=Panel('tool.support',footprint,['a','b','c','d'],frame(cq.Plane.XY()),frame(cq.Plane.XY()))
    cut_panel(support,opening,'tool.boundary')
    support_piece=prism(support.face,cq.Vector(0,0,-t),support.id,support.labels)
    shape,names=fuse([support_piece,bend_piece,roof_piece,*sides])
    slit=rectangle(w+2*t,gap).translate((-w/2-t,under.y,0))
    mark=rectangle(w+2*t,under.y).translate((-w/2-t,0,0)).outerWire()
    return shape,footprint,[slit],_named_labels(shape,names),'nominal_blank_with_louver_slit',[mark],dict(thickness_mm=t,
                inside_radius_mm=r,bend_angle_deg=p['angle'],height_mm=tip.z,opening_height_mm=under.z,projected_length_mm=under.y)


def _round_form(tool,rules):
    p=tool.parameters;t=rules.thickness;r=rules.radius if p['radius'] is None else p['radius']
    theta=math.radians(p['angle']);a=p['diameter']/2;h=p['height']
    minimum=(2*r+t)*(1-math.cos(theta))
    length=(h-minimum)/math.sin(theta)
    if length<=TOL:
        fail('Form height is too small for its two bend radii and wall angle.','SM_FORM_TOO_SHORT',measured=h,limit=minimum,units='mm')
    hole=p.get('hole_diameter',0)/2
    # Top/reference and offset meridians. Circular arcs share centers, with radii
    # R/R+t, so plane, cone and torus regions maintain exact normal thickness.
    c1=cq.Vector(a,0,h-r-t)
    def first(rad,alpha):return c1+cq.Vector(rad*math.sin(alpha),0,rad*math.cos(alpha))
    top1=first(r+t,theta);bottom1=first(r,theta)
    shift=cq.Vector(length*math.cos(theta),0,-length*math.sin(theta))
    top2,bottom2=top1+shift,bottom1+shift
    c2=top2+cq.Vector(r*math.sin(theta),0,r*math.cos(theta))
    def second(rad,alpha):return c2-cq.Vector(rad*math.sin(alpha),0,rad*math.cos(alpha))
    outer=second(r,0).x+t
    edges=[];labels=[]
    def line(a,b,label):
        if (b-a).Length>TOL:edges.append(cq.Edge.makeLine(a,b));labels.append(label)
    def arc(a,m,b,label):edges.append(cq.Edge.makeThreePointArc(a,m,b));labels.append(label)
    line(cq.Vector(hole,0,h),first(r+t,0),'top')
    arc(first(r+t,0),first(r+t,theta/2),top1,'outer_crown')
    line(top1,top2,'outer_wall')
    arc(top2,second(r,theta/2),second(r,0),'outer_root')
    line(second(r,0),cq.Vector(outer,0,0),'support_top')
    line(cq.Vector(outer,0,0),cq.Vector(outer,0,-t),'boundary')
    line(cq.Vector(outer,0,-t),second(r+t,0),'support_bottom')
    arc(second(r+t,0),second(r+t,theta/2),bottom2,'inner_root')
    line(bottom2,bottom1,'inner_wall')
    arc(bottom1,first(r,theta/2),first(r,0),'inner_crown')
    line(first(r,0),cq.Vector(hole,0,h-t),'inside')
    line(cq.Vector(hole,0,h-t),cq.Vector(hole,0,h),'hole' if hole else 'axis')
    face=cq.Face.makeFromWires(cq.Wire.assembleEdges(edges))
    maker=BRepPrimAPI_MakeRevol(face.wrapped,gp_Ax1(gp_Pnt(0,0,0),gp_Dir(0,0,1)),2*math.pi,True)
    if not maker.IsDone():fail('Could not revolve the form meridian.','SM_FORM_GEOMETRY_INVALID')
    shape=cq.Shape.cast(maker.Shape());names=Names()
    for edge in face.Edges():
        matches=[label for original,label in zip(edges,labels) if abs(edge.Length()-original.Length())<TOL and (edge.Center()-original.Center()).Length<TOL]
        if len(matches)!=1:fail('Ambiguous form meridian provenance.','SM_FORM_GEOMETRY_INVALID')
        names.add('tool.'+matches[0],maker.Generated(edge.wrapped))
    footprint=cq.Face.makeFromWires(cq.Wire.makeCircle(outer,(0,0,0),(0,0,1)))
    flat_hole=p.get('flat_hole_diameter',0)/2
    cuts=[cq.Face.makeFromWires(cq.Wire.makeCircle(flat_hole,(0,0,0),(0,0,1)))] if flat_hole else []
    marks=[cq.Wire.makeCircle(rad,(0,0,0),(0,0,1)) for rad in [outer-t,a]+([hole] if hole else [])]
    return shape,footprint,cuts,_named_labels(shape,names),'nominal_blank_with_declared_pre_pierce' if flat_hole else 'nominal_blank_form_suppressed',marks,dict(
        thickness_mm=t,inside_radius_mm=r,wall_angle_deg=p['angle'],height_mm=h,formed_hole_diameter_mm=2*hole,
        flat_hole_diameter_mm=2*flat_hole,root_diameter_mm=2*(outer-t),pierce_after_forming=bool(hole and not flat_hole))


def make_form(identity,panel,tool,rules,at,angle,direction,clearance):
    maker={'lance':_lance,'louver':_louver,'emboss':_round_form,'dimple':_round_form}[tool.kind]
    shape,footprint,cuts,labels,treatment,marks,resolved=maker(tool,rules)
    if not shape.isValid() or len(shape.Solids())!=1:
        fail('The selected form dimensions do not produce one valid solid.','SM_FORM_GEOMETRY_INVALID',entity=identity)
    if direction=='down':shape=shape.mirror('XY',(0,0,-rules.thickness/2))
    location=cq.Location((at[0],at[1],0),(0,0,1),angle)
    return Form(identity,panel,tool.record(),list(at),angle,direction,clearance,shape.moved(location),footprint.moved(location),
                [f.moved(location) for f in cuts],labels,treatment,[s.moved(location) for s in marks],resolved)


class FormMixin:
    def sheet_form(self,id,tool,panel,at=(0,0),angle=0,direction='up',clearance=None,body=None,name=None,suppressed=False):
        """Press a SheetMetalForm tool into a planar panel of the folded sheet at panel-local `at`, turned `angle`
        degrees, 'up' or 'down'; `clearance` defaults to the sheet thickness."""
        with self._feature(id,'sheet_form',name,suppressed) as feature:
            if feature is None:return
            if not isinstance(tool,SheetMetalForm):
                fail('tool must be a SheetMetalForm definition.','SM_FORM_TOOL_INVALID')
            if direction not in {'up','down'}:
                fail('Form direction must be up or down.','SM_FORM_TOOL_INVALID')
            if not isinstance(at,(list,tuple)) or len(at)!=2:
                fail('Form placement at must contain panel-local X and Y.','SM_FORM_TOOL_INVALID')
            at=[number(v,'Form placement') for v in at];angle=number(angle,'Form rotation')
            candidate=self._sheet(body).clone()
            if candidate.state!='folded' or panel not in candidate.panels:
                fail('Place a form on a planar panel of the folded sheet.','SM_FORM_PANEL_MISSING')
            clearance=candidate.rules.thickness if clearance is None else number(clearance,'Form clearance',0)
            form=make_form(id,panel,SheetMetalForm.restore(tool.record()),candidate.rules,at,angle,direction,clearance)
            candidate.forms.append(form)
            self._commit_sheet(feature,candidate)
            feature.detail.update(form=form.report())
