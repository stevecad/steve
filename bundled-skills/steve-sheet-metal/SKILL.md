---
name: steve-sheet-metal
description: >-
  Native sheet metal (sheet_* features): rules and gauge/bend tables, flanges, hems, jogs, tabs, bends, corners, reliefs, rips, reusable lance/louver/dimple/emboss tools, unfold/refold, flat patterns, DXF, SM_* diagnostics. Load before any sheet_* code.
---

## Steve execution rules

This skill adapts Steve Studio's CAD guidance for Steve running locally. The modeling
examples below describe the shared CAD runtime. These local execution rules take
precedence over upstream service workflows and tool names in that reference.

- Read the active document with `cad_read`; inspect built geometry with `cad_inspect`.
  Do not guess persistent face names, document shapes, revision IDs or import hashes.
- Apply source changes with `cad_build(document=..., expected_revision=...)`, preserving
  the document schema returned by `cad_read`. Use `cad_set_parameters` for parameter
  changes. Inspect the build result and errors before reporting success.
- `cad_api_reference` provides installed Model, Sketch, Component and Design signatures.
  The installed runtime and available tool schemas are authoritative if reference
  examples describe newer or unavailable capabilities.
- Export built geometry using `cad_export` with the current revision and a supported
  format. Drawing PDF/SVG/DXF workflows are available in the drawing UI; do not claim
  the geometry export tool exports drawings unless its schema supports that.
- Find standard parts or locally imported McMaster parts with `cad_find_parts`, then
  cache a part using `cad_import_catalog_part`. Use the returned import hash with
  `Model.import_step`. Import arbitrary STEP files through the local Import UI.
- `cad_source_package` reads a transferable source package; `cad_import_package`
  imports supplied root and dependency documents locally. These do not publish.
- Upstream `read_part`, `edit_part`, `read_design`, `inspect_model`, upload-ticket,
  workspace/server/document-ID and cloud export instructions are reference context,
  not available local commands. Use the local tools above. Do not sign in to Studio,
  upload, publish, or call a connected Studio MCP merely to perform local CAD.
- SaaS upload quotas are not local limits. Simulation, electronics, CAM, teams and
  cloud jobs are outside this local CAD skill. Do not invent their availability.
  References to unbundled skills do not imply those features are installed.

## Upstream CAD reference



# Sheet metal

Sheet-metal features are ordinary `Model` or `Component` calls, in millimetres and degrees, with the
id first. There is no separate settings statement: the sheet's rules live on the call that starts
it (`sheet_base`, `sheet_roll` or `sheet_convert`).

## Starting a sheet

```python
from steve import Model, SheetMetalRule

thickness = 1.5  # mm Sheet thickness
radius = 1.5  # mm Inside bend radius

rule = SheetMetalRule(thickness, radius, 0.44, name="1.5 mm steel", source="Estimate by STEVE, not shop-calibrated")
model = Model()
with model.sketch("sketch_1", on="XY") as s:
    s.rect("r1", (-40, -25), (40, 25))
model.sheet_base("base", "sketch_1", rule=rule)
# or explicit: model.sheet_base("base", "sketch_1", thickness=1.5, radius=1.5, k_factor=0.44,
#                               source="Estimate by STEVE, not shop-calibrated")
```

- The base sketch is the **top** reference surface; material goes below it.
- K-factor is a shop process input (0–1, typically 0.3–0.5), not a material constant.
- **Provenance, always.** Every sheet's rules carry `source=`: on the `SheetMetalRule` (or table), or on
  `sheet_base`/`sheet_roll`/`sheet_convert` when the values are written there. The app shows it, and the
  DXF manifest sends it to the fabricator, so it must never pass a guess off as shop data:
  - Any value you chose yourself (thickness, radius or K the person didn't give):
    `source="Estimate by STEVE, not shop-calibrated"`. Name what you estimated when only part is yours,
    e.g. `"Estimate by STEVE (K-factor); thickness and radius from the user"`. Say so in your reply and
    suggest getting the fabricator's K-factor or bend table.
  - Values the person gave: record that, e.g. `source="From the user: K 0.38, their shop chart"`.
    Never use the word "estimate" for them.
  - A chart the person pastes becomes a `BendTable`/`GaugeTable` whose `source=` names it.
  - Keep an existing `source` unless the values it describes change.
- `BendTable([{"thickness", "radius", "angle", "allowance"|"deduction"|"k_factor"}, …],
  interpolate=False)` gives measured allowances. Pass `bend_table=table` to the rule. Lookup is
  exact (optional angle interpolation), with no extrapolation and no silent K fallback.
- `GaugeTable({"16ga": {"thickness": 1.5, "radius": 1.5, "k_factor": 0.44}}, material=…,
  bend_table=…)`, then `gauges.rule("16ga")`, for gauge-driven parts.
- `sheet_roll(id, width, angle, rule=…, on="XY")` makes an open cylinder (angle < 360°; the rest is the
  seam). It starts at the plane's origin, tangent to the plane, runs `width` along the plane's X, and
  its first material heads along the plane's +Y. A positive angle curls toward the plane's normal
  around an axis one inside radius above the origin (inside face on the plane); a negative angle
  curls away around an axis radius + thickness below it (outside face on the plane). Example:
  `on="YZ"` puts the axis at world (r, y, 0), and the arc starts at 180° seen in X–Z.
- `model.move(id, bodies=[…], translate=…, rotate=…)` keeps a body sheet metal: its flat, DXF and
  later `sheet_*` features stay valid. Build a roll on its default plane and place it with a move.
  A `copy=True` copy of a sheet is a plain solid; build a second sheet when it needs its own flat.
- `sheet_convert(id, face="plate.top", rule=…)` turns a uniform flat solid (e.g. an imported plate)
  into sheet metal. Bent or variable-thickness solids are rejected.

## Edges: the rim

Flanges, hems, jogs and contours attach to one straight **outer top boundary**:
`"edge(base.side(r1.right)|base.top)"`. Use the side face's name and the panel's `top`. Picking an
edge in the viewport gives this name.

Panel names:
- faces: `id.top`, `id.bottom`, `id.side(<sketch entity>)`;
- flange sides: `id.side(start|end|left|right)`;
- bend faces: `id.bend.inner|outer|start|end`;
- a contour's walls: `id.1`, `id.2`, …; a jog's rise: `id.rise`;
- a `sheet_cut`'s walls: `<cut id>.side(<sketch entity>)`, like an extruded cut (a hole drawn as
  circle `h0` and cut by `hole_cut` is `hole_cut.side(h0)`, a cylinder);
- names last: after a `sheet_bend`, a hole or edge that moves whole onto the bent leg keeps its name
  (`base.side(u0)`, `hole_cut.side(h0)`), an edge the bend line trims is `<bend id>.side(<entity>)`,
  and the leg's top is `<bend id>.top`. Later cuts, flanges and hems keep them too.

Dimension holes on the drawing by these names; a hole's wall seen round gives its centre, so hole to
hole and hole to edge need no construction circles:
`{"view": "front", "refs": ["hole_cut.side(h0)", "hole_cut.side(h1)"]}`.

## Flanges

```python
model.sheet_flange("wall", "edge(base.side(r1.right)|base.top)", length=20, angle=90,
                   position="bend_outside", length_reference="tangent")
```

**Angle:** the bend angle from flat. Positive bends toward the top normal; negative bends down.

**`length_reference`** (what the length measures to):
- `"tangent"` (default): the straight part after the bend;
- `"outer_sharp"`: to the outside virtual sharp. Drawings and shops usually dimension this. Use it when
  the person gives outside dimensions.
- `"inner_sharp"`: to the inside virtual sharp.

**`position`** (where the flange sits relative to the edge):
- `"bend_outside"` (default): the bend starts at the edge, so the part grows;
- `"material_inside"`: the parent is trimmed so the flange's outside stays at the original edge,
  which keeps the outside dimension;
- `"material_outside"`;
- `"centered"`.

Other options:
- `offset=` moves the bend line outward (positive).
- `up_to=<plane or face>` with optional `end_offset=` replaces length.
- `gap_start=` / `gap_end=` shorten the flange from either end of the edge, for corner clearance.
- `radius=` overrides the sheet radius. `k_factor=`, `allowance=` or `deduction=` override the
  development.
- `relief="rectangular"` or `"round"` (with `relief_width`, `relief_depth`; default = thickness) for
  partial-width flanges.
- `miter_gap=0.5` trims two perpendicular coplanar return lips that would overlap, leaving that gap.
  Apply it before adding children to those lips.

## Other features

| Call | What it does |
|---|---|
| `sheet_contour(id, edge, segments=[{"length": 20, "angle": 90}, {"length": 15, "angle": -90}])` | Chains walls (L, U, Z, hat sections), up to 32 segments. |
| `sheet_hem(id, edge, length=6, gap=1, direction="up")` | Open 180° hem. The inside radius is gap/2. |
| `sheet_jog(id, edge, offset=10, length=15, angle=45)` | Step up (+) or down to a parallel panel. |
| `sheet_tab(id, panel="base", bounds=(x0, y0, x1, y1), gap=1, angle=45)` | U-cut formed tab, in panel-local coordinates (base: its sketch's XY). The hinge is at y0; the tab reaches toward +Y. |
| `sheet_bend(id, panel="base", start=(50, 30), end=(50, 0), angle=90)` | Bends an existing blank along a line. The material left of start→end moves. Apply before flanging that panel. |
| `sheet_corner(id, panels=["right", "front"], gap=0.5)` | Butt-closes two perpendicular 90° walls. The first wall stops `gap` short; the second covers. Do this before further flanges on those walls. |
| `sheet_relief(id, "sketch", panel="base")` | Sketched notches open to an edge (corner and bend reliefs). |
| `sheet_cut(id, "sketch", panel="base")` | Through-cuts inside one flat panel. Sketch on the panel face (`on="base.top"`). |
| `sheet_unfold(id, fixed="base")` → `sheet_cut(...)` → `sheet_refold(id)` | Cuts across bends: the bend crossings must be rectangles aligned with the bend axis. |

**Never use ordinary solid features (extrude-cut, hole, fillet) on a sheet body.** They invalidate
its flat pattern. Use `sheet_cut` / `sheet_relief`.

## Rip and form tools

`sheet_rip` has three explicit targets:

- `sheet_rip(id, panel="base", start=(0,15), end=(20,15), gap=0.5, side="center")`
  cuts a straight panel-local slit reaching an outer boundary. `left`/`right` are
  relative to start→end. It cannot sever an attached bend or leave a disconnected panel.
- `sheet_rip(id, bend="wall", gap=0.5, split_body="detached_wall")` separates a
  native bend into two independently exported sheet bodies. The new body name is
  mandatory. Gap is the chord between inside curved edges; remaining bend angles
  and proportional developed lengths are recorded, with `allowance_method="rip_proportional"`.
- `sheet_rip(id, face="tube.side", gap=1, rule=rule, seam_angle=30)` verifies and
  opens a complete uniform circular tube. Rule radius is the tube's inside radius;
  gap is an inside chord. It rejects cones, eccentric/nonuniform walls and other shapes.
  Seam angle is around the selected cylinder's axis from its native X direction.

Define a reusable tool, then place it in panel-local XY:

```python
from steve import SheetMetalForm
tool = SheetMetalForm("louver", width=12, length=20, gap=0.5, angle=30,
                      name="Example vent", source="Example tool geometry; qualify with the shop")
model.sheet_form("vent", tool, panel="base", at=(20,20), angle=90, direction="up")
```

- `lance`: `width`, `length` (developed tab blank), `gap`, optional `angle=30`,
  `radius=sheet radius`. A U-cut bent tab with exact bend development.
- `louver`: `width` (clear roof width), `length` (straight inclined roof), `gap`
  (front blank slit), optional `angle=30`, `radius`. Closed drawn side walls and an
  open lip. Its side-wall junctions use a nominal gauge envelope.
- `emboss`: circular raised land `diameter`, `height`, optional `angle=45` (wall
  slope) and `radius`. Smooth, normal-offset plane/cone/torus surfaces.
- `dimple`: the emboss dimensions plus `hole_diameter` (formed) and explicit
  `flat_hole_diameter`. Zero flat hole means piercing after forming. Never infer
  the blank hole from the finished hole; use the user's/toolmaker's dimension.

Forms support rotation, `direction="up"|"down"` and edge/form `clearance` (default
thickness). Keep the footprint wholly within a planar panel; bends and later cuts
cannot cross it. A form wholly on the moving side of a sketched bend follows it.

Pressed forms have a **nominal blank**, not a computed strain-based development.
Their marks/centers are on `FORM_UP`, `FORM_DOWN`, `FORM_CENTER`, never `CUT`.
The main DXF excludes form marks; the ZIP's separate `.forming.dxf` includes them.
Only the declared slit/pre-pierce and lance clearance are cut. The ZIP also includes
a forms CSV; JSON carries definitions, resolved dimensions and `SM_FORM_NOMINAL_BLANK`.
Do not claim those forms predict draw-in, thinning, springback or supplier readiness.

## Check the build

- `read_design` → `model.metadata.sheet_metal.summary`: per body, thickness, bend count, flat
  bounds and area.
- The full `sheet-metal.json` has:
  - rules with provenance (`source`, bend table);
  - bends (angle, radius, K, allowance);
  - the flat outline;
  - `diagnostics`, each with code, severity, message, feature/entity and measured/limit:
    `SM_FLANGE_TOO_SHORT`, `SM_BEND_RULE_MISSING`, `SM_FEATURE_NEAR_BEND`, `SM_FLAT_OVERLAP`,
    `SM_MATERIAL_OVERLAP`, miter failures.
- A failed feature leaves the previous sheet intact. Fix the call named in the error.
- `manufacturing_validation` is `not_assessed`. A "ready" sheet means valid geometry and a valid flat
  pattern, not supplier approval. For manufacturability, load `dfm-sheet-metal`; for a SendCutSend
  order, `sendcutsend-preflight`.
- Full builds export a ZIP: a DXF per body (layers `CUT`, `BEND_UP`, `BEND_DOWN`, `ROLL`; mm; exact
  arcs), a bend-table CSV and an SVG drawing.
- For a shop drawing of the blank, add the `flat` view to a `Drawing` (load `steve-drawings`):
  `Drawing(result, views=("front", "top", "flat"))`. It shows the same development as the DXF, with the bend lines
  and their notes and, with dimensions, the blank's overall size, so never draw the blank by hand.

## Not supported (say so)

- arbitrary curved or diagonal cross-bend cuts;
- general corner and miter solving beyond the cases above;
- closed, rolled or teardrop hems;
- lofted transitions;
- recognising already-bent imported parts;
- arbitrary custom forming solids, rectangular embosses and beads beyond the listed tools;
- general cone rips or reverse seam-to-bend joining;
- bend sequencing and tooling collisions;
- nesting.
