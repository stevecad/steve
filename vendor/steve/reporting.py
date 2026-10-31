"""Area reporting without changing modeling geometry or topology identity keys.

OCCT's planar spline area quadrature can miss knot spans, including in its
adaptive path. Integrate the oriented boundary instead. Curved faces use a
bounded parameter-domain integral, with a logged kernel fallback on failure.
"""
import math
import warnings
import logging
from functools import lru_cache

import cadquery as cq
from numpy.polynomial.legendre import leggauss
from scipy.integrate import IntegrationWarning, quad
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.gp import gp_Pnt, gp_Vec


@lru_cache(maxsize=32)
def _gauss(order):
    return leggauss(order)


def planar_area(face):
    """Area of an analytic planar face, including holes and periodic edges.

    Green's theorem integrates n · (r × dr) / 2. A degree-d polynomial
    curve needs d Gauss points on each knot span; rational and conic edges
    use bounded one-dimensional adaptive integration. No B-rep is mutated.
    """
    surface = BRepAdaptor_Surface(face.wrapped)
    if surface.GetType().name != 'GeomAbs_Plane':
        raise ValueError('Boundary area requires an analytic planar face.')
    normal = gp_Vec(surface.Plane().Axis().Direction())
    origin = surface.Value((surface.FirstUParameter() + surface.LastUParameter()) / 2,
                           (surface.FirstVParameter() + surface.LastVParameter()) / 2)
    terms = []
    explorer = TopExp_Explorer(face.wrapped, TopAbs_EDGE)
    while explorer.More():
        edge = TopoDS.Edge(explorer.Current())
        explorer.Next()
        curve = BRepAdaptor_Curve(edge)
        lo, hi = curve.FirstParameter(), curve.LastParameter()
        knots, order = [lo, hi], None
        kind = curve.GetType().name
        if kind == 'GeomAbs_BSplineCurve':
            spline = curve.BSpline()
            if not spline.IsRational():
                order = spline.Degree()
            for i in range(1, spline.NbKnots() + 1):
                knot = spline.Knot(i)
                if spline.IsPeriodic():
                    period = spline.Period()
                    for k in range(math.floor((lo - knot) / period), math.ceil((hi - knot) / period) + 1):
                        parameter = knot + k * period
                        if lo < parameter < hi:
                            knots.append(parameter)
                elif lo < knot < hi:
                    knots.append(knot)
        elif kind == 'GeomAbs_BezierCurve' and not curve.Bezier().IsRational():
            order = curve.Bezier().Degree()
        elif kind == 'GeomAbs_Line':
            order = 1
        knots = sorted(set(knots))
        point, derivative = gp_Pnt(), gp_Vec()

        def integrand(parameter):
            curve.D1(parameter, point, derivative)
            return gp_Vec(origin, point).Crossed(derivative).Dot(normal) / 2

        sign = -1 if edge.Orientation() == TopAbs_REVERSED else 1
        for a, b in zip(knots, knots[1:]):
            if order is not None:
                nodes, weights = _gauss(order)
                value = math.fsum(float(w) * integrand((a + b) / 2 + (b - a) * float(n) / 2)
                                  for n, w in zip(nodes, weights)) * (b - a) / 2
            else:
                with warnings.catch_warnings():
                    warnings.simplefilter('error', IntegrationWarning)
                    value, _ = quad(integrand, a, b, epsabs=1e-10, epsrel=1e-10, limit=100)
            terms.append(sign * value)
    area = abs(math.fsum(terms))
    if not math.isfinite(area):
        raise ValueError('Planar boundary area is not finite.')
    return area


from .reporting_cache import MemoryAreaCache


@MemoryAreaCache
def face_area(face):
    if face.geomType() == 'PLANE':
        return planar_area(face)
    from .reporting_curved import curved_area
    try:
        area = curved_area(face)
        if not math.isfinite(area) or area <= 0:
            raise ValueError('Non-positive or non-finite integrated area.')
        return area
    except Exception as error:
        # Reporting must not make valid geometry unbuildable. Preserve the old
        # kernel estimate when integration cannot converge within its budget.
        logging.getLogger(__name__).warning('Area uses kernel estimate: %s', error)
        return face.Area()


def surface_area(shape):
    """Reporting area, counting face occurrences as OCCT SkipShared=False does."""
    wrapped = shape.wrapped if isinstance(shape, cq.Shape) else shape
    explorer = TopExp_Explorer(wrapped, TopAbs_FACE)
    areas = []
    while explorer.More():
        face = cq.Face(TopoDS.Face(explorer.Current()))
        explorer.Next()
        areas.append(face_area(face))
    return math.fsum(areas)


def volume_properties(shape):
    """Reporting moments; resolve polynomial extrusion knot spans explicitly.

    General rational NURBS Gauss-Kronrod integration can take minutes even for
    simple solids. Keep the kernel's existing path outside polynomial extrusions.
    This does not change geometry, topology keys or modeling calculations.
    """
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    wrapped = shape.wrapped if isinstance(shape, cq.Shape) else shape
    explorer = TopExp_Explorer(wrapped, TopAbs_FACE)
    polynomial = False
    spans = 0
    eligible = True
    while explorer.More():
        surface = BRepAdaptor_Surface(TopoDS.Face(explorer.Current()))
        explorer.Next()
        kind = surface.GetType().name
        if kind == 'GeomAbs_Plane':
            continue
        if kind != 'GeomAbs_SurfaceOfExtrusion':
            eligible = False
            break
        curve = surface.BasisCurve()
        if curve.GetType().name != 'GeomAbs_BSplineCurve':
            eligible = False
            break
        spline = curve.BSpline()
        if spline.IsRational() or spline.Degree() > 5:
            eligible = False
            break
        spans += spline.NbKnots()
        polynomial = True
        if spans > 256:
            eligible = False
            break
    props = GProp_GProps()
    if eligible and polynomial:
        try:
            error = BRepGProp.VolumePropertiesGK_s(
                wrapped, props, Eps=1e-8, IsUseSpan=True, CGFlag=True, IFlag=True)
            if math.isfinite(error) and 0 <= error <= 1e-8 and math.isfinite(props.Mass()):
                return props
            raise ValueError(f'Volume integration error estimate: {error}')
        except Exception as error:
            logging.getLogger(__name__).warning('Volume uses kernel estimate: %s', error)
            props = GProp_GProps()
    BRepGProp.VolumeProperties_s(wrapped, props)
    return props
