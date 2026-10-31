"""Dimensioned native rips and exact recognition of straight circular tube seams."""
from __future__ import annotations

import copy
import math
import cadquery as cq
from OCP.BRepAdaptor import BRepAdaptor_Surface

from .geometry import Sheet, cut_panel, fail, frame, number, plane, place, rectangle, TOL


class RipMixin:
    def sheet_rip(self, id, gap, panel=None, start=None, end=None, side='center',
                  bend=None, split_body=None, face=None, rule=None, thickness=None,
                  radius=None, k_factor=None, seam_angle=0, body=None, name=None, suppressed=False):
        """Slit a panel, separate a bend into two bodies, or open/convert a circular tube.

        Panel gaps are normal to the local line. Bend/cylinder gaps are chords on
        the inside surface. Bend separation requires an explicit new body ID.
        """
        with self._feature(id,'sheet_rip',name,suppressed) as feature:
            if feature is None:
                return
            gap=number(gap,'Rip gap',positive=True)
            if sum(value is not None for value in (panel,bend,face))!=1:
                fail('Select exactly one rip target: panel, bend, or cylindrical face.','SM_RIP_TARGET')
            if face is not None:
                if start is not None or end is not None or side!='center' or split_body is not None:
                    fail('Cylinder rips use gap and seam_angle, not panel/split options.','SM_RIP_OPTIONS')
                self._rip_cylinder(feature,face,gap,seam_angle,body,rule,thickness,radius,k_factor)
                return
            if any(v is not None for v in (rule,thickness,radius,k_factor)) or seam_angle!=0:
                fail('Native rips inherit their sheet rules; seam_angle applies only to cylinders.','SM_RIP_OPTIONS')
            current=self._sheet(body)
            if current.state!='folded':
                fail('Refold the sheet before creating a rip.','SM_RIP_STATE')
            if bend is not None:
                if start is not None or end is not None or side!='center':
                    fail('Bend rips use a centered inside-surface gap, not sketch options.','SM_RIP_OPTIONS')
                self._rip_bend(feature,current,bend,gap,split_body)
                return
            if split_body is not None:
                fail('split_body is used only for explicit bend separation.','SM_RIP_OPTIONS')
            if panel not in current.panels:
                fail('Select a planar panel in this sheet.','SM_RIP_TARGET',entity=panel)
            if side not in {'center','left','right'}:
                fail('Rip side must be center, left or right.','SM_RIP_OPTIONS')
            if any(not isinstance(p,(list,tuple)) or len(p)!=2 for p in (start,end)):
                fail('Rip start/end must be panel-local XY points.','SM_RIP_OPTIONS')
            a,b=[cq.Vector(*(number(v,'Rip coordinate') for v in p),0) for p in (start,end)]
            if (b-a).Length<=TOL:
                fail('A rip needs two distinct points.','SM_RIP_OPTIONS')
            location=cq.Plane(a,xDir=b-a,normal=(0,0,1))
            offset={'center':-gap/2,'left':0,'right':-gap}[side]
            tool=place(rectangle((b-a).Length,gap).translate((0,offset,0)),frame(location))
            candidate=current.clone();target=candidate.panels[panel]
            removed=target.face.intersect(tool).Area()
            if removed<=TOL:
                fail('The rip does not remove sheet material.','SM_RIP_EMPTY',entity=panel)
            # The rip must open a boundary or connect an existing opening to it.
            if tool.distance(target.face.outerWire())>TOL:
                fail('A rip must reach the panel outer boundary; use sheet_cut for an enclosed slot.','SM_RIP_CLOSED_SLOT',entity=panel)
            cut_panel(target,tool,id)
            candidate.rips.append(dict(id=id,kind='planar',panel=panel,start=[a.x,a.y],end=[b.x,b.y],gap_mm=gap,side=side,removed_area_mm2=removed))
            self._commit_sheet(feature,candidate)
            feature.detail.update(rip=candidate.rips[-1])

    def _rip_bend(self, feature, current, identity, gap, split_body):
        from ..model import ID
        from ..naming import Names
        if not isinstance(split_body,str) or not ID.fullmatch(split_body) or split_body in self.bodies:
            fail('Separating a bend creates two pieces. Supply a new, unused split_body ID.','SM_RIP_SPLIT_REQUIRED',entity=identity)
        matches=[b for b in current.bends if b['id']==identity]
        if len(matches)!=1 or matches[0].get('kind')=='roll' or matches[0]['parent'] is None or matches[0]['child'] is None:
            fail('Select an intact native bend between two planar panels.','SM_RIP_TARGET',entity=identity)
        bend=matches[0];r=bend['radius_mm'];theta=math.radians(abs(bend['angle_deg']))
        if gap>=2*r*math.sin(theta/2)-TOL:
            fail('The rip gap consumes the entire inside bend. Reduce the gap.','SM_RIP_GAP_TOO_LARGE',entity=identity,measured=gap,limit=2*r*math.sin(theta/2),units='mm')
        delta=2*math.asin(gap/(2*r))
        cut_width=delta/theta*bend['allowance_mm']
        low,high=(bend['allowance_mm']-cut_width)/2,(bend['allowance_mm']+cut_width)/2
        descendants={bend['child']}
        while True:
            more={b['child'] for b in current.bends if b['parent'] in descendants and b['child'] is not None}
            if more<=descendants:break
            descendants|=more
        parent=current.clone();child=current.clone()
        parent.panels={k:p for k,p in parent.panels.items() if k not in descendants}
        child.panels={k:p for k,p in child.panels.items() if k in descendants}
        child.id,child.root,child.names=split_body,bend['child'],[]
        parent.fixed=parent.root;child.fixed=child.root
        for sheet,index,panels in [(parent,0,set(parent.panels)),(child,1,set(child.panels))]:
            sheet.bends=[b for b in sheet.bends if b['id']!=identity and (b['parent'] in panels or b['child'] in panels)]
            stump=copy.deepcopy(bend)
            stump.update(id=f'{feature.id}.{index+1}',parent=bend['parent'] if index==0 else None,child=bend['child'] if index==1 else None,kind='rip_remainder')
            start,stop=(0,low) if index==0 else (high,bend['allowance_mm'])
            alpha=theta*start/bend['allowance_mm'];sign=1 if bend['angle_deg']>0 else -1
            p,u,out,n=(cq.Vector(*bend[k]) for k in ('origin','axis','outward','normal'))
            reference_radius=r if sign>0 else r+current.rules.thickness
            point=p+out*(reference_radius*math.sin(alpha))+n*(sign*reference_radius*(1-math.cos(alpha)))
            normal=n*math.cos(alpha)-out*(sign*math.sin(alpha))
            outward=out*math.cos(alpha)+n*(sign*math.sin(alpha))
            flat=plane(bend['flat'])
            stump.update(angle_deg=sign*math.degrees((theta-delta)/2),allowance_mm=stop-start,
                         allowance_method='rip_proportional',source_bend_angle_deg=bend['angle_deg'],straight_length_mm=0,
                         origin=list(point.toTuple()),normal=list(normal.toTuple()),outward=list(outward.toTuple()),
                         flat=frame(cq.Plane(flat.toWorldCoords((0,start,0)),xDir=flat.xDir,normal=flat.zDir)))
            stump['cuts']=[{**cut,'bounds':[cut['bounds'][0],max(start,cut['bounds'][1])-start,
                                          cut['bounds'][2],min(stop,cut['bounds'][3])-start]}
                           for cut in bend.get('cuts',[]) if min(stop,cut['bounds'][3])-max(start,cut['bounds'][1])>TOL]
            sheet.bends.append(stump)
            sheet.rips.append(dict(id=feature.id,kind='bend',bend=identity,gap_mm=gap,gap_reference='inside_chord',
                                   developed_gap_mm=cut_width,pieces=[current.id,split_body]))
            if hasattr(sheet,'forms'):
                sheet.forms=[f for f in sheet.forms if f.panel in panels]
        # Commit on an isolated registry, so either both bodies publish or neither does.
        staged=copy.copy(self)
        staged.bodies=dict(self.bodies);staged._sheet_metal=dict(self._sheet_metal)
        staged.names=Names();staged.names.faces={k:list(v) for k,v in self.names.faces.items()}
        if hasattr(self,'materials'):staged.materials=copy.deepcopy(self.materials)
        staged._commit_sheet(feature,parent);staged._commit_sheet(feature,child)
        if hasattr(self,'materials'):
            assignment=self.materials.of(current.id)
            if assignment and assignment.get('material'):
                staged.materials.add(assignment['material'],bodies=[split_body],finish=assignment.get('finish'),color=assignment.get('color'))
        self.bodies,self.names,self._sheet_metal=staged.bodies,staged.names,staged._sheet_metal
        if hasattr(staged,'materials'):self.materials=staged.materials
        self.active=current.id
        feature.body=current.id;feature.created=list(parent.names)+list(child.names)
        feature.detail=dict(sheet_metal=True,rip=parent.rips[-1],bodies=[current.id,split_body])

    def _rip_cylinder(self, feature, face, gap, seam_angle, body, rule, thickness, radius, k_factor):
        identity=body or self.active
        if identity not in self.bodies or identity in self.__dict__.get('_sheet_metal',{}):
            fail('Cylinder conversion requires an existing ordinary solid body.','SM_RIP_TARGET')
        shape=self.bodies[identity];selected=self.faces(face)
        if len(selected)!=1 or selected[0].geomType()!='CYLINDER' or not any(selected[0].isSame(f) for f in shape.Faces()):
            fail('Select one cylindrical face of the body.','SM_RIP_TARGET')
        rules=self._sheet_rules(rule,thickness,radius,k_factor)
        cylinder=BRepAdaptor_Surface(selected[0].wrapped).Cylinder()
        axis=cq.Vector(cylinder.Axis().Direction());center=cq.Vector(cylinder.Location())
        heights=[(v.Center()-center).dot(axis) for v in shape.Vertices()]
        low,high=min(heights),max(heights);height=high-low
        origin=center+axis*low;r,t=rules.radius,rules.thickness
        expected=cq.Solid.makeCylinder(r+t,height,origin,axis).cut(cq.Solid.makeCylinder(r,height,origin,axis))
        mismatch=shape.cut(expected).Volume()+expected.cut(shape).Volume()
        if len(shape.Solids())!=1 or mismatch>max(1e-6,shape.Volume()*1e-8):
            fail('The selected solid is not a complete, uniform, straight circular tube matching these rules.','SM_RIP_CYLINDER_UNSUPPORTED',entity=identity)
        if gap>=2*r-TOL:
            fail('Cylinder gap must be smaller than the inside diameter.','SM_RIP_GAP_TOO_LARGE',measured=gap,limit=2*r,units='mm')
        delta=2*math.asin(gap/(2*r))
        seam_angle=number(seam_angle,'Seam angle')
        alpha=math.radians(seam_angle)+delta/2
        x=cq.Vector(cylinder.XAxis().Direction());y=axis.cross(x)
        radial=x*math.cos(alpha)+y*math.sin(alpha)
        location=cq.Plane(origin+radial*r,xDir=axis,normal=-radial)
        angle=360-math.degrees(delta)
        _,k,ba,method=rules.allowance(angle)
        bend=dict(id=feature.id,parent=None,child=None,edge_index=None,kind='roll',angle_deg=angle,radius_mm=r,
                  k_factor=k,allowance_mm=ba,allowance_method=method,width_mm=height,straight_length_mm=0,
                  origin=list(location.origin.toTuple()),axis=list(axis.toTuple()),outward=list(location.yDir.toTuple()),
                  normal=list(location.zDir.toTuple()),flat=frame(cq.Plane.XY()))
        candidate=Sheet(identity,rules,feature.id,{},bends=[bend],reference=frame(location))
        candidate.rips.append(dict(id=feature.id,kind='cylinder',gap_mm=gap,gap_reference='inside_chord',seam_angle_deg=seam_angle,
                                   removed_angle_deg=math.degrees(delta),source_body=identity))
        self._commit_sheet(feature,candidate)
        feature.detail.update(rip=candidate.rips[-1])
