"""Code-owned sheet-metal rules; no built-in guesses about shop calibration."""
from __future__ import annotations

import copy
from dataclasses import dataclass
import math

from .validation import TOL, fail, number


def development(thickness, radius, angle, k_factor=None, allowance=None, deduction=None):
    """Return allowance and its effective neutral-line K factor."""
    theta = math.radians(abs(angle))
    if theta < TOL:
        fail('A bend angle must be nonzero.')
    supplied = sum(value is not None for value in (k_factor,allowance,deduction))
    if supplied != 1:
        fail('Specify exactly one of K factor, bend allowance or bend deduction.')
    if allowance is not None:
        developed = number(allowance,'Bend allowance',positive=True)
    elif deduction is not None:
        if abs(angle) >= 179:
            fail('Bend deduction is undefined near a 180 degree hem; use allowance or K factor.')
        developed = 2*(radius+thickness)*math.tan(theta/2)-number(deduction,'Bend deduction')
    else:
        developed = theta*(radius+number(k_factor,'K factor',0,1)*thickness)
    if not theta*radius-TOL <= developed <= theta*(radius+thickness)+TOL:
        fail('The bend allowance places the neutral line outside the material thickness.')
    return developed, min(1.0,max(0.0,(developed/theta-radius)/thickness))


class BendTable:
    """Lookup measured rows at exact thickness/radius, optionally interpolate angle.

    A row has thickness, radius, angle and exactly one of allowance/deduction/k_factor.
    Interpolation is linear in allowance within one thickness/radius group; never
    extrapolate and never interpolate between thicknesses, radii or materials.
    """
    def __init__(self, rows, *, name=None, source=None, interpolate=False):
        if not isinstance(rows,(list,tuple)) or not rows:
            fail('A bend table requires at least one calibration row.')
        if not isinstance(interpolate,bool):
            fail('Bend table interpolate must be a boolean.')
        self.name = name
        self.source = source
        for label,value in [('name',name),('source',source)]:
            if value is not None and (not isinstance(value,str) or not value.strip()):
                fail(f'Bend table {label} must be a nonempty string.')
        self.interpolate = interpolate
        checked = []
        for row in rows:
            if not isinstance(row,dict) or set(row)-{'thickness','radius','angle','allowance','deduction','k_factor'} or not {'thickness','radius','angle'} <= set(row):
                fail('Bend table rows require thickness, radius, angle and one development value.')
            t = number(row['thickness'],'Table thickness',positive=True)
            r = number(row['radius'],'Table radius',positive=True)
            a = number(row['angle'],'Table angle',TOL,360)
            ba,_ = development(t,r,a,**{key:row[key] for key in ('allowance','deduction','k_factor') if key in row})
            key = (t,r,a)
            if any(all(abs(x-y)<TOL for x,y in zip(key,(v['thickness'],v['radius'],v['angle']))) for v in checked):
                fail('Bend table rows must have unique thickness/radius/angle keys.')
            checked.append(dict(thickness=t,radius=r,angle=a,allowance=ba))
        self._rows = tuple(sorted(checked,key=lambda row:(row['thickness'],row['radius'],row['angle'])))

    def record(self):
        return dict(name=self.name,source=self.source,interpolate=self.interpolate,rows=copy.deepcopy(list(self._rows)))

    def lookup(self, thickness, radius, angle):
        angle = abs(angle)
        rows = [r for r in self._rows if abs(r['thickness']-thickness)<TOL and abs(r['radius']-radius)<TOL]
        exact = [r for r in rows if abs(r['angle']-angle)<TOL]
        if exact:
            return exact[0]['allowance'],'table'
        lower = [r for r in rows if r['angle']<angle]
        upper = [r for r in rows if r['angle']>angle]
        if self.interpolate and lower and upper:
            a,b = lower[-1],upper[0]
            weight = (angle-a['angle'])/(b['angle']-a['angle'])
            return a['allowance']+(b['allowance']-a['allowance'])*weight,'table_interpolated'
        fail(f'Bend table {self.name or "(unnamed)"!r} has no entry for thickness {thickness:g} mm, radius {radius:g} mm, angle {angle:g}°. Add a calibrated row or explicitly override this bend; extrapolation is disabled.',
             'SM_BEND_RULE_MISSING',table=self.name,thickness_mm=thickness,radius_mm=radius,angle_deg=angle)


@dataclass
class SheetMetalRule:
    thickness: float
    radius: float
    k_factor: float | None = None
    name: str | None = None
    gauge: str | None = None
    material: str | None = None
    bend_table: BendTable | dict | None = None
    source: str | None = None

    def __post_init__(self):
        self.thickness = number(self.thickness,'Thickness',positive=True)
        self.radius = number(self.radius,'Inside radius',positive=True)
        for key in ('name','gauge','material','source'):
            value = getattr(self,key)
            if value is not None and (not isinstance(value,str) or not value.strip()):
                fail(f'Sheet rule {key} must be a nonempty string.')
        if isinstance(self.bend_table,dict):
            self.bend_table = BendTable(**self.bend_table)
        if self.bend_table is not None and not isinstance(self.bend_table,BendTable):
            fail('bend_table must be a BendTable.')
        if self.k_factor is not None:
            self.k_factor = number(self.k_factor,'K factor',0,1)
        if self.bend_table is None and self.k_factor is None:
            fail('A sheet rule requires K factor or a bend table.')

    def allowance(self, angle, radius=None, k_factor=None, allowance=None, deduction=None):
        radius = self.radius if radius is None else number(radius,'Inside radius',positive=True)
        angle = number(angle,'Bend angle',-360,360)
        if sum(v is not None for v in (k_factor,allowance,deduction)) > 1:
            fail('Specify only one local development override: K factor, allowance or deduction.')
        if allowance is not None:
            method = 'allowance'
            developed,k = development(self.thickness,radius,angle,allowance=allowance)
        elif deduction is not None:
            method = 'deduction'
            developed,k = development(self.thickness,radius,angle,deduction=deduction)
        elif k_factor is not None or self.bend_table is None:
            method = 'k_factor'
            developed,k = development(self.thickness,radius,angle,k_factor=self.k_factor if k_factor is None else k_factor)
        else:
            developed,method = self.bend_table.lookup(self.thickness,radius,angle)
            developed,k = development(self.thickness,radius,angle,allowance=developed)
        return radius,k,developed,method

    def record(self):
        return dict(thickness=self.thickness,radius=self.radius,k_factor=self.k_factor,name=self.name,
                    gauge=self.gauge,material=self.material,source=self.source,bend_table=self.bend_table.record() if self.bend_table else None)


class GaugeTable:
    """Explicit gauge labels and dimensions for one shop/material; no universal gauges."""
    def __init__(self, rows, *, name=None, material=None, bend_table=None, source=None):
        if not isinstance(rows,dict) or not rows:
            fail('GaugeTable requires a mapping from gauge label to rule dimensions.')
        self._rules = {}
        for gauge, values in rows.items():
            if not isinstance(gauge,str) or not isinstance(values,dict) or set(values)-{'thickness','radius','k_factor'}:
                fail('Each gauge label maps to thickness, radius and optional k_factor.')
            if not {'thickness','radius'} <= set(values):
                fail('A gauge row requires explicit thickness and inside radius in millimetres.')
            self._rules[gauge] = SheetMetalRule(**values,gauge=gauge,name=name,material=material,bend_table=bend_table,source=source).record()

    def rule(self, gauge):
        if gauge not in self._rules:
            fail(f'Unknown gauge {gauge!r}; available labels: {", ".join(self._rules)}.')
        return SheetMetalRule(**copy.deepcopy(self._rules[gauge]))


# The graph/cache used this internal name before rules became an authored object.
Rules = SheetMetalRule
