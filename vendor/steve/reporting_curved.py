"""Bounded trimmed-surface area integration, used only for reporting.

Green's theorem on the parameter domain integrates F dv around the boundary,
where F(u,v) is the adaptive integral of |Su cross Sv| in u. Edge occurrences
preserve seams and subtract holes. No modeling B-rep or identity is changed.
"""
import math
import time
import warnings

from scipy.integrate import quad, IntegrationWarning
from OCP.BRepAdaptor import BRepAdaptor_Surface, BRepAdaptor_Curve2d
from OCP.TopAbs import TopAbs_EDGE, TopAbs_REVERSED, TopAbs_FORWARD
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.gp import gp_Pnt, gp_Vec, gp_Pnt2d, gp_Vec2d


def curved_area(face, max_seconds=0.5, max_evaluations=100000):
    face = TopoDS.Face(face.wrapped.Oriented(TopAbs_FORWARD))
    surface = BRepAdaptor_Surface(face)
    origin_u = surface.FirstUParameter()
    u_knots = []
    if surface.GetType().name == 'GeomAbs_BSplineSurface':
        spline = surface.BSpline()
        u_knots = [spline.UKnot(i) for i in range(1, spline.NbUKnots() + 1)]
    elif surface.GetType().name == 'GeomAbs_SurfaceOfExtrusion':
        curve = surface.BasisCurve()
        if curve.GetType().name == 'GeomAbs_BSplineCurve':
            spline = curve.BSpline()
            u_knots = [spline.Knot(i) for i in range(1, spline.NbKnots() + 1)]
    point, derivative_u, derivative_v = gp_Pnt(), gp_Vec(), gp_Vec()
    evaluations = 0
    started = time.monotonic()

    def jacobian(u, v):
        nonlocal evaluations
        evaluations += 1
        if evaluations > max_evaluations or time.monotonic() - started > max_seconds:
            raise ValueError('Area integration budget exceeded')
        surface.D1(u, v, point, derivative_u, derivative_v)
        return derivative_u.Crossed(derivative_v).Magnitude()

    terms = []
    explorer = TopExp_Explorer(face, TopAbs_EDGE)
    with warnings.catch_warnings():
        warnings.simplefilter('error', IntegrationWarning)
        while explorer.More():
            edge = TopoDS.Edge(explorer.Current())
            explorer.Next()
            curve = BRepAdaptor_Curve2d(edge, face)
            lo, hi = curve.FirstParameter(), curve.LastParameter()
            uv, derivative = gp_Pnt2d(), gp_Vec2d()

            def boundary(parameter):
                curve.D1(parameter, uv, derivative)
                u, v, dy = uv.X(), uv.Y(), derivative.Y()
                if dy == 0 or u == origin_u:
                    return 0.0
                points = sorted(k for k in u_knots if min(origin_u, u) < k < max(origin_u, u))
                integral = quad(lambda x: jacobian(x, v), origin_u, u,
                                epsabs=1e-9, epsrel=1e-10, points=points, limit=100)[0]
                return integral * dy

            points = []
            if curve.GetType().name == 'GeomAbs_BSplineCurve':
                spline = curve.BSpline()
                points = [spline.Knot(i) for i in range(1, spline.NbKnots() + 1)
                          if lo < spline.Knot(i) < hi]
            value = quad(boundary, lo, hi, epsabs=1e-8, epsrel=1e-10,
                         points=points, limit=100)[0]
            terms.append((-1 if edge.Orientation() == TopAbs_REVERSED else 1) * value)
    return abs(math.fsum(terms))
