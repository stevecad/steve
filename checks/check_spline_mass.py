from pathlib import Path
import sys,json,math
import numpy as np
import cadquery as cq
from scipy.integrate import quad
from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.gp import gp_Pnt,gp_Vec
from OCP.TopAbs import TopAbs_REVERSED
r=Path(__file__).resolve().parents[1];sys.path.insert(0,str(r/'vendor'))
from upstream_runtime import mass_properties
wire=cq.Wire.assembleEdges([cq.Edge.makeSpline([cq.Vector(x,y,0) for x,y in [(0,0),(25,-4),(42,12),(30,31),(4,20),(-8,8)]],periodic=True)])
shape=cq.Solid.extrudeLinear(wire,[],cq.Vector(0,0,5))
face=next(f for f in shape.Faces() if f.geomType()=='PLANE');mom=np.zeros(6)
for edge in face.Edges():
 curve=BRepAdaptor_Curve(edge.wrapped);lo,hi=curve.FirstParameter(),curve.LastParameter();cuts=[lo,hi]
 if curve.GetType().name=='GeomAbs_BSplineCurve':
  b=curve.BSpline();cuts=sorted(set([lo,hi]+[b.Knot(i) for i in range(1,b.NbKnots()+1) if lo<b.Knot(i)<hi]))
 def f(t,k):
  p,v=gp_Pnt(),gp_Vec();curve.D1(t,p,v);x,y=p.X(),p.Y()
  return [x,x*x/2,x*y,x**3/3,x*y*y,x*x*y/2][k]*v.Y()
 sign=-1 if edge.wrapped.Orientation()==TopAbs_REVERSED else 1
 for k in range(6):mom[k]+=sign*sum(quad(lambda t:f(t,k),a,b,epsabs=1e-8,epsrel=1e-11)[0] for a,b in zip(cuts,cuts[1:]))
if mom[0]<0:mom=-mom
A,mx,my,x2,y2,xy=mom;cx,cy=mx/A,my/A;h=5;m=A*h
I=np.array([[h*(y2-A*cy*cy)+m*h*h/12,-h*(xy-A*cx*cy),0],[-h*(xy-A*cx*cy),h*(x2-A*cx*cx)+m*h*h/12,0],[0,0,h*(x2+y2-A*(cx*cx+cy*cy))]])
center=np.array([cx,cy,shape.BoundingBox().zmin+h/2]);actual=mass_properties(shape)
errors={'volume_relative':abs(actual['volume_mm3']-m)/m,'center_mm':float(np.max(np.abs(actual['center_of_mass_mm']-center))),'inertia_relative':float(np.max(np.abs(actual['inertia_mm5']-I))/np.max(np.abs(I)))}
row={'shape':'asymmetric periodic cubic spline extrusion','oracle':'independent boundary moment integration, split at spline knots; extrusion moments','area':A,'expected_volume':m,'expected_center':center.tolist(),'expected_inertia':I.tolist(),'actual':actual,'errors':errors}
print(json.dumps(row),flush=True)
assert errors['volume_relative']<1e-8 and errors['center_mm']<1e-6 and errors['inertia_relative']<1e-8
