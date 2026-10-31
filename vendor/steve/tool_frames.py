"""Named frame candidates exported with exact simulation bodies inside CAD."""
import cadquery as cq
from OCP.gp import gp_Pnt,gp_Vec


def _basis(direction):
    z=cq.Vector(*direction).normalized()
    seed=min((cq.Vector(1,0,0),cq.Vector(0,1,0),cq.Vector(0,0,1)),key=lambda a:abs(a.dot(z)))
    x=(seed-z*seed.dot(z)).normalized()
    return x.toTuple(),z.toTuple()


def named_references(model,body,location):
    """Keep ambiguous names as multiple candidates; never pick one implicitly."""
    if model is None:return {}
    from .model import DATUM_PLANES,AXES,_face_plane
    from .naming import edge_names,vertex_names
    result={};transform=location.wrapped.Transformation()
    def add(name,kind,origin,z=None,x=None,*,origin_kind='point',axis_kind='direction',surface=None):
        point=gp_Pnt(*origin).Transformed(transform).Coord()
        value=dict(kind=kind,origin_mm=point,origin_kind=origin_kind)
        if surface is not None:value['surface']=surface
        if z is not None:
            if x is None:x,z=_basis(z)
            value.update(x=gp_Vec(*x).Transformed(transform).Coord(),z=gp_Vec(*z).Transformed(transform).Coord(),axis_kind=axis_kind)
        result.setdefault(name,[]).append(value)
    for name in (*DATUM_PLANES,*model.planes):
        plane=model.plane_of(name)
        add(name,'plane',plane.origin.toTuple(),plane.zDir.toTuple(),plane.xDir.toTuple())
    for name,data in {**AXES,**model.axes}.items():add(name,'axis',data[:3],data[3:],axis_kind='line')
    for name,point in model.points.items():add(name,'point',point.toTuple())
    faces=body.Faces()
    for name,group in model.names.faces.items():
        for face in group:
            if face not in faces:continue
            if face.geomType()=='PLANE':
                plane=_face_plane(face)
                # A face locates a plane. Its sketch origin is not a spindle
                # centre, even when two projected origins happen to be coaxial.
                add(name,'face',plane.origin.toTuple(),plane.zDir.toTuple(),plane.xDir.toTuple(),origin_kind='plane',surface='plane')
            elif face.geomType() in ('CYLINDER','CONE','SPHERE'):
                from OCP.BRepAdaptor import BRepAdaptor_Surface
                adaptor=BRepAdaptor_Surface(face.wrapped,True)
                if face.geomType()=='SPHERE':
                    add(name,'face',adaptor.Sphere().Location().Coord(),surface='sphere')
                else:
                    axis=(adaptor.Cylinder() if face.geomType()=='CYLINDER' else adaptor.Cone()).Axis()
                    add(name,'face',axis.Location().Coord(),axis.Direction().Coord(),origin_kind='axis',axis_kind='line',surface=face.geomType().lower())
            else:add(name,'face',face.Center().toTuple(),origin_kind='undefined')
    for edge,name in edge_names(body,model.names).items():
        if edge.geomType()=='LINE':
            start,end=edge.startPoint(),edge.endPoint()
            add(name,'edge',start.toTuple(),(end-start).normalized().toTuple(),axis_kind='line')
        elif edge.geomType()=='CIRCLE':add(name,'edge',edge.arcCenter().toTuple(),edge.normal().toTuple(),axis_kind='line')
        else:add(name,'edge',edge.Center().toTuple())
    for vertex,name in vertex_names(body,model.names).items():add(name,'point',vertex.Center().toTuple())
    return result
