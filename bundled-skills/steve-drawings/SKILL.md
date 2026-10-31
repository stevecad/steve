---
name: steve-drawings
description: >-
  Engineering drawings for manufacture: ISO or ANSI (ASME) sheets A4–A0 and A–E, first- or third-angle orthographic and isometric views, section views (hatched) and detail views, overall dimensions, feature dimensions with tolerances or ISO 286 fits attached to named model geometry, GD&T datums and feature control frames, title block fields, revision table, parts list (BOM) for assemblies with item balloons, hole tables read from hole features, cut list and notes, written as code with steve.drawing's Drawing (also edited by hand in the app's Drawing tab) and exported as SVG/PDF/DXF. Load before making, changing or explaining a drawing, title block, revision table, parts list or cut list.
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



# Engineering drawings

A drawing is code, like the model: `Drawing(...)` in main.py (after `result = ...`) declares one sheet, so it has
the design's history, branches and revisions. Full builds project the views with exact hidden-line removal and
make the files; previews skip them.

```python
from steve.drawing import Drawing

result = design.result()
Drawing(result, standard="ISO", sheet="A3", title="Gearbox", bom=True,
        fields={"number": "GBX-100", "owner": "Acme Ltd", "drawn_by": "JS", "date": "2026-10-07",
                "material": "See parts list", "tolerances": "ISO 2768-m"},
        revisions=[{"rev": "A", "description": "First release", "date": "2026-10-07", "by": "JS"}],
        notes=["Break all sharp edges 0.5 max.", "Remove all burrs."])
# One sheet per part to be made, from the same design:
Drawing(housing, standard="ISO", sheet="A3", views=("front", "top", "right", "iso"), cut_list=True,
        fields={"number": "GBX-101", "material": "6061-T6", "finish": "Clear anodise"})
```

## Arguments

- `source`: the `result` (part or design), a `Component` (one part of a design, in its own frame), a linked part
  or design (`Drawing(plate)` after `from links import plate`; its own names: `plate.face("extrude_1.end")`), or a
  CadQuery shape or Workplane.
- `standard`: `"ISO"` (first-angle projection, mm, ISO 5457 border and zones, ISO 7200-style title block,
  ISO 129 aligned dimension text) or `"ANSI"`/`"ASME"` (third-angle, inches, ASME Y14.1 sizes, unidirectional
  dimension text, no leading zero). `projection="first" | "third"` and `units="mm" | "in"` override the standard's.
- `dual_units`: dual dimensioning, the other unit in brackets after every length, the overall dimensions'
  (`dimensions=True`) too: on an inch sheet `dual_units="mm"` writes a 100 mm plate as `3.937 [100]`, and a
  tolerance as `3.937 ±.005 [100 ±0.13]`. `dual_precision`: its decimal places (default as that unit's own values).
  It follows the model; never type a converted value into a `suffix` or a note. Angles, `text=` overrides, hole
  tables, welds, tolerance frames and bend notes stay in the sheet's units, as does what the report lists.
- `sheet`: `A4 A3 A2 A1 A0` or `A B C D E` (default A3 for ISO, B for ANSI); `orientation="landscape" | "portrait"`.
- `views`: any of `front top right left bottom back iso`, and `flat` for a sheet-metal body's blank (below); placed by the projection method around the front view,
  the sheet's master. By default front looks along +Y (from −Y), top looks down −Z, right looks along −X.
- `front=(facing, up)`: the master's orientation, two of `front back top bottom left right`: the model side the
  front view shows and the side up on the paper (one next to it); a side alone (`front="top"`) keeps its own view's
  up. Default `("front", "top")`. Every other view follows it: `top` is the view from above the master, `right` from
  its right, `iso` turns with it. Use it to show the part's most descriptive side as the front instead of remodelling,
  e.g. `front=("top", "back")` for a plate modelled flat. Annotations keep their `view` names: after changing
  `front`, check `dangling` and `dimension_problems` for any whose geometry no longer shows in its view.
  Each view is a name, or a dict with its own settings: `{"view": "front", "scale": (1, 2), "hidden": False, "shaded": True, "at": (20, 0)}`
  (`at`: paper mm to move it, and its section and detail views, from where it goes on its own). Where a view goes on
  its own leaves room for its annotations, so changing a weld's `place`/`at`, a dimension's `offset`/`side` or a
  balloon can move every view. `"position": (x, y)` instead fixes a view's centre on the sheet (paper mm from its
  lower-left corner, as a placed note's `at`; section and detail views take it too): nothing else moves it. It needs
  the sheet's `scale=`. Once a sheet's layout is settled (or the person asks to keep it), give every view its
  `position` from `views_placed[].position` and write `scale=` before adjusting welds and dimensions; the Drawing
  tab's Sheet format has "Fix view positions" for this. Not with `at` on the same view. A fixed view is never moved:
  one past the border is reported in `overflow`, and annotations may now overlap a neighbouring view, so check.
  Left out, it's front, top, right and iso. `views=[]` is a blank sheet (border, title block, tables and notes,
  no section or detail views): how the Drawing tab starts a sheet the person lays out by hand. When asked for a
  drawing, still give the views it needs.
- `section_views`, `detail_views`: views taken from another view, below.
- `scale`: `(1, 2)` for 1:2, `(2, 1)` for 2:1. Default: the largest ISO 5455 preferred scale that fits.
- `hidden=True` dashes hidden edges in orthographic views (the iso view only with its own `{"view": "iso", "hidden":
  True}`); `dimensions=True` adds each view's overall size.
- `shaded=True` fills every view's faces in flat greys under its lines (shaded with edges); a view's own `"shaded"`
  overrides it, e.g. `views=("front", "top", "right", {"view": "iso", "shaded": True})` for a shaded iso only. Detail
  views take their parent's; section views are never shaded. Shading is in the SVG and the printed sheet; the DXF
  keeps the lines only.
- `title`, `name` (the file name; defaults to the title).
- `fields`: `number owner drawn_by checked_by approved_by date material finish tolerances revision`, and any other
  `"label": "value"` (e.g. `"customer"`, `"project"`, `"weight"`), shown as extra title block cells. REV shows
  `revision`, else the last row of `revisions`.
- `title_block`: the person's own title block layout, in place of the ISO 7200 one (left out, the standard block is
  drawn). Rows, bottom row first, each `{"height": mm, "cells": [...]}`; each cell `{"width": mm}` with optionally
  `"label"`, `"field"` (a `fields` key, or `title revision scale sheet size units projection`, which the sheet fills
  in; `projection` draws the symbol), `"text"` (fixed text, e.g. the company name; a list of up to 12 lines for an
  address or statement) and `"text_height"` (mm). A field cell shows the field's own label (DRAWING NO., REV…) above
  its value unless `"label"` is given; `"label": ""` hides it. `"label_height"` (mm, from 1) sizes the label.
  `"rows": n` makes a cell span n rows upward as one open box (a logo/address box, a proprietary statement, a
  tolerance table): the rows above place their cells to the right of it. `"align"` (`left centre right`) and
  `"valign"` (`top middle bottom`) place the value or text; `"label_align"` and `"label_valign"` the label.
  `"bold": True` draws the value or text bold (headers, a revision letter), `"label_bold": True` the label. Rows are
  2.5 mm or taller; in rows under about 7 mm, hide the label or make it small. Up to 12 rows of 12 cells. The
  block's width is its widest row (a shorter row's last cell stretches); the parts list, revisions and other tables
  above it take that width. Only the layout's cells are drawn, so put every field the person fills in into a cell.
  A logo: `{"width": 50.8, "image": "logo.png"}` (no `field`/`text`) draws one of the design's .png or .jpg files
  beside main.py, scaled to fit with its aspect kept, placed by `align`/`valign` (centred), `"padding"` mm around it
  (default 1); up to 4 image cells. The person adds the file in the Source panel (file switcher → Import logo…: PNG
  or JPEG, at most 512 KB and 4096 px a side); never write, convert or fetch an image yourself, and no SVG or URLs.
  ```python
  Drawing(result, fields={"number": "BRK-001", "customer": "Globex", "drawn_by": "JS"}, title_block=[
      {"height": 14, "cells": [{"width": 110, "label": "PART NAME", "field": "title", "text_height": 5},
                               {"width": 50, "field": "number", "align": "centre"}, {"width": 20, "field": "revision"}]},
      {"height": 9, "cells": [{"width": 60, "text": "ACME ENGINEERING LTD"}, {"width": 40, "label": "CUSTOMER", "field": "customer"},
                              {"width": 30, "field": "drawn_by"}, {"width": 25, "field": "scale"}, {"width": 25, "field": "projection"}]},
  ])
  # A two-strip address box beside low label-less cells: the box spans both rows, the second row's cells start past it.
  title_block=[
      {"height": 3.2, "cells": [{"width": 60, "rows": 2, "text": ["ACME INC.", "1 Main St, Springfield"], "align": "centre",
                                 "valign": "middle"},
                                {"width": 120, "field": "number", "label": "", "align": "centre", "text_height": 2.5}]},
      {"height": 9.5, "cells": [{"width": 120, "field": "title", "label_height": 1.5}]},
  ]
  ```
- `revisions`: rows of `rev description date by`, oldest first.
- `bom`: `True` lists the design's bill of materials (components, linked parts, fasteners, cables with cut
  lengths), default for a design's result; or your own rows `{"name", "quantity", "description"}`; `False` hides it.
- `cut_list=True`: each distinct body with its quantity, bounding size (largest first, in its component's own
  axes) and material. Good for plate, bar and extrusion stock; a sheet-metal part's blank is its `flat` view (below).
- The `flat` view: a sheet-metal body's flat pattern, the very blank its sheet-metal DXF cuts, so the two never
  disagree and it follows every flange, relief, cut and bend allowance change. Never draw a blank by hand (a rectangle,
  a sketch, a second part sized to match): add `"flat"` to `views`. It's seen from above in the body's material plane
  (the DXF's frame), with each bend as a thin chain line noted `UP 90° R2` / `DOWN 45° R1.5` / `ROLL 180° R50` in the
  sheet's units, and `dimensions=True` gives the blank's overall size. A name, or a dict of `view`, `body`, `scale`,
  `at`, `position`: `body` is the sheet-metal body (its id on a part's sheet, `"<instance>:<body>"` on a design's, as
  the sheet-metal manifest names it), needed only when the sheet draws several (the build says which:
  `sheet_metal_bodies`); one flat view a sheet, so draw several bodies' blanks on sheets of their own. It's placed
  outside the projection grid like `iso`, labelled FLAT PATTERN, and takes no hidden lines, shading, hole tables,
  datums or frames on its geometry, welds, leader notes, balloons, or section and detail views (those go on the folded
  views). A body that isn't sheet metal, has gone, or whose flat can't be developed is reported in `view_problems`
  (`dangling_views` when the body is gone), with the sheet-metal error, never drawn from other geometry: fix the
  sheet-metal features first.
- Feature dimensions on the `flat` view (`"view": "flat"`) measure the blank as cut, by the body's own names: its
  edges (a panel's sides seen edge-on, `base.side(r.left)`, `flange_1.side(end)`; cut and hole sides), holes
  (`diameter`, or a distance to their centre) and each bend's centre line as drawn, `"<flange>.bend.line"` (the
  chain line the shop marks and gauges to; a bend split by a cut is one line). Dimension every bend line from one blank edge (or chain them bend to bend) for a part bent by
  hand: that's what replaces a table of bend positions. On a design's sheet prefix the instance, as everywhere:
  `"bracket_1:base.side(r.left)"`. A name the blank doesn't have (a sketch curve, a pressed form, another body's face)
  is reported in `dimension_problems`; one that's gone in `dangling`. The Drawing tab's Dimension tool picks the
  blank's edges, holes and bend lines too.
  ```python
  # A bracket with two flanges: its folded views, and its blank for the shop with its size and bend notes.
  Drawing(result, views=("front", "top", "right", "flat"), title="Bracket", fields={"material": "1.5 mm 5052-H32"})
  # A design's sheet of one placed bracket's blank.
  Drawing(result, views=[{"view": "flat", "body": "bracket_1:base", "scale": (1, 2)}], bom=False)
  # The blank with each bend line located from its left edge, for laying out by hand.
  Drawing(result, views=("front", "flat"), dimensions=True, feature_dimensions=[
      {"view": "flat", "refs": ["base.side(r.left)", "flange_1.bend.line"]},
      {"view": "flat", "refs": ["base.side(r.left)", "flange_2.bend.line"]}])
  ```
- `notes`: lines, numbered on the sheet. A note written `{"text": "…", "at": (x, y)}` goes at that paper point instead
  (mm from the sheet's lower-left corner), unnumbered. A leader note points at one spot:
  `{"text": "FLUSH", "view": "right", "ref": "edge(extrude_1.end|extrude_2.side(r1.left))", "side": "up-left"}` draws a
  leader from that edge, face or vertex (refs as a weld's; an arrowhead, or a dot on a face seen face-on) to a short
  shoulder with the text beside it (`side`: `"up-right"`, `"up-left"`, `"down-right"` or `"down-left"`), `offset` paper mm past the view (default 10), or `at` (dx, dy) paper mm from the
  leader's tip to its shoulder. Use it for FLUSH, TYP, BREAK EDGE and other callouts about one feature, rather than a
  placed note near it: the reader shouldn't guess which edges it means. A ref that's gone is in `dangling` with
  `"annotation": "note"`, and `notes_placed` gives each one's tip and knee (SVG frame).
- `feature_dimensions`: dimensions of features, below.
- `datums`, `tolerance_frames`: GD&T, below.
- `balloons`, `hole_tables`: item balloons on an assembly and hole tables on a part, below.
- `welds`: weld symbols (AWS A2.4, ISO 2553), below.

Text is plain (no markup); 200 characters per field. Tables that don't fit list the rest in the CSV.

## Feature dimensions

Each one names model geometry by its persistent reference (the names features, `Copy reference` and picks use),
so its value is the model's exact geometry, not a measurement of the drawn lines, and it follows the design as it
changes. Here `base` is a `model.box("base", 120, 60, 20)`: a box's sides keep OCCT's names, `.front` +X,
`.back` −X, `.left` −Y, `.right` +Y (so the front view sees `.left` face-on and `.front`/`.back` edge-on):

```python
Drawing(result, standard="ISO", sheet="A3", feature_dimensions=[
    {"view": "front", "refs": ["base.back", "base.front"]},                      # 120, horizontal
    {"view": "front", "refs": ["base.bottom", "base.top"], "tolerance": (0.1, -0.05)},
    {"view": "top", "refs": ["hole_1.wall(0)"], "tolerance": 0.02, "prefix": "4X"},  # ⌀12 ±0.02 on a leader
    {"view": "top", "refs": ["base.back", "hole_1.wall(0)"]},                    # edge to the hole's centre
    {"view": "top", "refs": ["bore.wall(0)"], "fit": "H7"},                       # ⌀20 H7 (ISO 286)
    {"view": "top", "refs": ["edge(base.left|base.top)"], "display": "reference"},   # (120)
])
```

- `view`: an orthographic view on the sheet (not `iso`: it foreshortens). Default: the first one.
- `refs`: one or two references, as in features: faces (`base.top`, `bore.wall(0)`), edges (`edge(a|b)`),
  vertices (`vertex(a|b|c)`), or selectors (`select(edges, "%CIRCLE", on="base")`). Plain CadQuery parts have no
  names: use selectors only, `select(faces, ">X")`. In a design, dimension a component's own features on its own
  sheet (`Drawing(housing, …)`). A design's `result` sheet locates its placed instances: `"<instance>:<name>"`
  (`"plate_1:base.top"`, `"rotor_1:disk:body.end"` in a linked design), a component's own ref when it's placed
  once (`plate.face("base.top")`), or `select(faces, ">Z", on="<instance>")` (that instance where it's placed, in
  the design's frame); `select(...)` without `on=` runs over the whole assembly. The same refs work for datums,
  tolerance frames, weld `refs` and section/detail points on that sheet.
- A part's sketch curves are refs too, construction included: `"<sketch>.<entity>"` (`"path.p.side0"`, `"path.bend1"`;
  `"plate_1:path.p.side0"` on a design's sheet). Each one dimensioned is drawn in its view as a thin centre line.
  Formed wire and tube (a profile swept along a sketch path) are dimensioned on the path, the centreline: a `length`
  on each straight's line, an `angle` between neighbouring lines for each bend that isn't 90°, a `radius` on each
  bend's arc; a leg's length to the bends' virtual sharps is a distance between `sharp(...)`s of the path's lines
  (below). The swept faces are also named per path segment, `sweep_1.along(p.side0)`. Index selectors like
  `">X[1]"` count only faces and edges parallel to X, so they find nothing on round swept stock: use names.
- Inside and outside of round wire or tube: `ends` puts a distance's end at the tangent of the stock's far side
  from the other end (`"outside"`) or near side (`"inside"`) instead of its axis (`"centre"`, the default); one per
  ref, or one string for both. Dimension wire the way the vendor's print does: benders gauge outsides and outside
  sharps, so match those numbers rather than noting the difference. The ref is the round face, never the path's
  line: a straight's face `wire.along(p.side0)` (measured horizontally or vertically, across it), a bend's face
  (swept along the path's arc `bend1`: `wire.along(bend1)`; its outermost point that way, the top of the wire over
  a bend) or a circular edge. Outside to outside of two parallel straights: `{"view": "front", "refs":
  ["wire.along(p.side0)", "wire.along(p.side2)"], "ends": "outside"}`; an overall height from the cut end to the top
  of the wire over a bend: `{"refs": ["wire.start", "wire.along(bend1)"], "ends": ["centre", "outside"],
  "direction": "vertical"}`. On a `sharp(...)` of two straights' round faces, `ends` gives the outside (or inside)
  sharp, where the wire's outsides would meet: `{"refs": ["wire.along(p.side0)",
  "sharp(wire.along(p.side1)|wire.along(p.side2))"], "ends": "outside"}`. A flat face to the top of a wire on a
  design's sheet: `{"refs": ["bracket_1:plate.top", "wire_1:wire.along(p.side0)"], "ends": ["centre", "outside"]}`.
  An end that isn't round, or a straight running along the measuring direction, is reported with what to use.
- A virtual sharp, `"sharp(<one>|<other>)"`, is where two straight edges, or flat faces seen edge-on, would meet with
  the bend between them taken away: the corner formed sheet and wire drawings dimension to. It's a point, so it ends
  a distance (`horizontal`, `vertical` or `aligned`), never a length, diameter, radius, angle, datum or frame. It's
  drawn with thin lines running on from each straight past where they meet. Sheet metal outside to outside: the
  outer faces, `{"view": "front", "refs": ["base.bottom", "sharp(leg.bottom|flare.bottom)"]}` (match a vendor's
  "to the virtual sharp" this way rather than dimensioning only the flat). Formed wire on its centreline: the
  path's lines, `"sharp(path.p.side0|path.p.side1)"`; on its outside: the straights' faces with `ends` (above),
  `"sharp(wire.along(p.side0)|wire.along(p.side1))"` and `"ends": "outside"`. Either half may be an `edge(a|b)` or
  `select(...)`; on a design's sheet, `"clip_1:sharp(leg.bottom|flare.bottom)"`. Parallel halves have no sharp and are reported.
- `kind`: inferred when left out (smart dimension). Two faces seen edge-on, edges across the measuring direction,
  vertices or holes: `distance`; one straight edge: `length`; one circle or cylinder: `diameter` (an arc:
  `radius`); two edges or edge-on faces that meet: `angle`. Say `kind` when you mean another.
- `direction`: `horizontal`, `vertical` or `aligned` (between two points at the same depth); default chooses.
- `tolerance`: `0.1` for ±0.1, or `(upper, lower)` like `(0.1, -0.05)`, in the sheet's units (degrees for angles).
  `display`: `"limits"` (upper and lower limits instead), `"basic"` (boxed, theoretically exact, no tolerance) or
  `"reference"` (in parentheses, no tolerance). `precision`: decimal places (by default mm
  to 2, inches to 3, or 4 for an exact four-place size like .8125; halves round up). `prefix` / `suffix`: `"4X"`, `"THRU"`.
  On a sheet with `dual_units`: `dual_precision` gives one dimension's bracketed places, `dual=False` leaves it off
  (both are ignored while the sheet has no `dual_units`).
- `fit`: an ISO 286 tolerance class instead of a `tolerance`: a hole's in capitals (`"H7"`), a shaft's in lower
  case (`"g6"`). Its limits come from ISO 286's tables for the nominal size (the value as the sheet shows it, up to
  3150 mm), never approximated. `fit_shows`: `"class"` (`⌀12 H7`, the ISO default), `"deviations"`
  (`⌀12 H7 (+0.018/0)`) or `"limits"` (`12.018` over `12.000`, then `(H7)`; the default on inch sheets).
  Above 500 mm ISO 286 has shafts d to u and holes D to U only.
  A class ISO 286 doesn't define at that size, or a fit on an angle, is listed in `dimension_problems`; each drawn
  fit's nominal size and deviations (mm) are in the sheet's `fits`.
- `text` replaces the measured value: avoid it; it's reported as overridden.
- `id`: a short name (`"bore"`, `"d1"`) that datums and tolerance frames attach to; once per sheet.

Placement (all optional; leave them out for the automatic layout):

- `side`: horizontal dimensions `"above"` (default) or `"below"` their view; vertical ones `"left"` (default) or
  `"right"`; aligned ones `"out"` (default, away from the view's middle) or `"in"`; a diameter or radius leader
  `"up-right"`, `"up-left"`, `"down-right"` or `"down-left"` (default up-right, or the first of the others that
  stays on the sheet and off the title block and tables; `placed` says which). A leader that still reaches past
  the border or over the title block is drawn where it is and listed in `annotation_notes` with its `dimension`:
  give it another side or a shorter offset, or a smaller scale or a larger sheet. Angles have no side.
- `offset`: paper mm from the view's edge to the dimension line (aligned: from the geometry; a leader's reach; an
  angle's arc radius), more than 0 and up to 200. Stacking slots are 10, 18, 26… mm; below and right of a view the
  overall dimension takes the first, so they start at 18.
- `text_at`: `"centre"` (default), `"start"` or `"end"` (past that end's arrow, for tight spaces), or paper mm along
  the line from its middle towards its end (`-12`). On an angle, along the arc. Not for leaders.

```python
{"view": "front", "refs": ["base.back", "base.front"], "side": "below", "offset": 18, "text_at": "end"}
```

By default horizontal dimensions stack above their view and vertical ones to its left, shortest nearest; diameters
of round holes get a leader. ISO writes text along the line; ANSI writes it level, without leading zeros on inches.
A side that doesn't fit what the dimension measures is listed in `dimension_problems` (the message says which
fit). Placement is relative to the view and the dimension's own geometry, so it follows the model as it changes.
People place dimensions by dragging them on the sheet in the Drawing tab, which writes these same keys; keep
them as plain literals and keep the person's placement when you edit a dimension.

A dimension that can't be drawn is never moved onto other geometry. The build's `drawings` metadata lists it per
sheet: `dangling` (its geometry is gone: re-pick it), `dimension_problems` (not measurable as written, e.g.
foreshortened in that view; the message says what to do) and `overridden`; `feature_dimensions` counts the
dimensions drawn per view, and `placed` says where each drawn one went (its side and offset). Check these after
every change and fix what they list.

## GD&T: datums and feature control frames

Datum feature symbols and feature control frames (ASME Y14.5-2018, ISO 1101 and ISO 5459) attach like dimensions:
to one persistent face, edge or cylinder name (`ref`, or a `select(...)` on plain CadQuery) in a `view`, or to a
feature dimension by its `id` (`dimension`), where they go out past its text and stand for its feature of size.

```python
Drawing(housing, standard="ISO", sheet="A3",
    feature_dimensions=[{"view": "top", "refs": ["bore.wall(0)"], "fit": "H7", "id": "bore"}],
    datums=[{"label": "A", "view": "front", "ref": "base.bottom"},
            {"label": "B", "view": "front", "ref": "base.back"},
            {"label": "C", "dimension": "bore"}],
    tolerance_frames=[
        {"view": "front", "ref": "base.top", "characteristic": "flatness", "tolerance": 0.05},
        {"dimension": "bore", "characteristic": "position", "tolerance": 0.1, "zone": "diameter",
         "modifier": "MMC", "datums": ["A", "B"]},
        {"view": "front", "ref": "base.top", "characteristic": "parallelism", "tolerance": 0.02, "datums": ["A"]},
    ])
```

- `datums`: `label` (one or two capitals, once per sheet; ANSI sheets skip I, O and Q). Flat faces seen edge-on
  and straight edges get the triangle on their outline; holes and shafts seen round or side-on on theirs; a flat
  face seen face-on a leader with a dot.
- `tolerance_frames`: `characteristic` (`straightness flatness circularity cylindricity` (form, no datums),
  `profile_line profile_surface`, `angularity perpendicularity parallelism` (need a datum), `position`,
  `circular_runout total_runout` (need a datum); ISO sheets also `concentricity coaxiality symmetry`, which ASME
  Y14.5-2018 dropped), `tolerance` (the zone's size in the sheet's units), `zone="diameter"` for a ⌀ zone (axes:
  position, orientation, straightness), `modifier` `"MMC"` or `"LMC"` (not on circularity, cylindricity, profile
  or runout; only on a feature of size: a cylinder or a size dimension), `datums` (up to three, primary first, each
  `"A"` or `("A", "MMC")`), `projected` (Ⓟ with its height), `modifiers` (`free_state`, `tangent_plane`,
  `continuous_zone`).
- Both take `offset` (paper mm of leader). A frame referencing a datum not defined in `datums` on the same sheet,
  a form tolerance with datums, or a characteristic without its datum is an error with a plain message.
- Like dimensions, one whose geometry is gone is listed in `dangling`, and one that can't be shown in that view in
  `dimension_problems`, with `"annotation": "datum"` or `"frame"` and its `index`; `annotation_notes` lists frames
  drawn whose datum isn't. `datums` and `tolerance_frames` count what's drawn per view.

## Weld symbols

Weld symbols for weldment sheets, drawn the sheet's way: AWS A2.4 on ANSI sheets (arrow side under the reference
line), ISO 2553 system A on ISO sheets (arrow side on the continuous line, other side on the dashed identification
line under it). Each weld has an arrow to each of its `refs` (the joint's edges, faces or vertices), all meeting at
one end of the reference line; the tail carries the process or a note.

```python
Drawing(frame, standard="ISO", sheet="A3", welds=[
    {"view": "front", "type": "fillet", "size": 3, "length": 15, "pitch": 50, "tail": "MAG",   # a3 ◺ 15(50)
     "refs": ["edge(post.wall(0)|base.top)", "edge(post.wall(1)|base.top)", "edge(post.wall(2)|base.top)",
              "edge(post.wall(3)|base.top)"]},
    {"view": "top", "type": "fillet", "size": 4, "side": "both", "all_around": True, "field": True,
     "refs": ["edge(tube.end|plate.top)"], "tail": "TYP 8 PLACES"},
    {"view": "top", "type": "spot", "size": 5, "pitch": 30, "refs": ["lap.top"]},              # centred on the line
])
```

- `type`: `fillet`, `plug`, `slot` or `spot`, or a groove (below). `refs`: 1 to 8 persistent names (`select(...)` on
  plain CadQuery). `view`: any view on the sheet, a section's or detail's name, or `iso`.
- `side`: `arrow` (default), `other`, or `both` (fillets and grooves); a spot weld is centred on the line unless it
  says `arrow` or `other`.
- `size`, `length`, `pitch` in the sheet's units, as the person gives them: AWS writes `3 ◺ 15-50`, ISO
  `a3 ◺ 15(50)`. ISO prefixes the size: `a` a fillet's throat (`"leg": True` for its leg, `z`), `d` a plug's or spot
  weld's diameter, `c` a slot's width. `pitch` is centre to centre (more than `length`; a fillet or slot needs a
  `length` with it).
- `all_around` (the circle at the junction), `field` (the flag, pointing to the tail), `tail` (plain text, 200
  characters: the process, a count, `"TYP"`).
- Placement, optional: `place` (`above below left right up-right up-left down-right down-left`; default out from the
  view's middle) and `offset` (paper mm past the view, default 12), or `at` (`(dx, dy)` paper mm from the first
  arrow's tip to the reference line's start).
- Don't invent weld sizes, lengths, processes, groove angles, root openings, throats, contours or finishes: use the
  person's (their drawing, their skill, their notes, the joint's WPS), or ask. Leave a value out rather than guess;
  the tail is theirs too.
- A ref that's gone is listed in `dangling` with `"annotation": "weld"` and its `index` (the weld is still drawn
  with the arrows that remain, and the message says so); one that can't be shown (its view isn't on the sheet, it's
  outside a detail's circle, a name on plain CadQuery) is in `dimension_problems`. `welds` counts what's drawn per
  view, and `welds_placed` gives each one's first arrow tip and reference line start (SVG frame: mm, y down).
- People place and edit welds by hand with the Drawing tab's Weld tool, which writes these same rows (dragging one
  writes its `at`); keep their rows, keys and placement when you edit the list.

### Groove welds

Groove (butt) welds: `square`, `v`, `bevel`, `u`, `j`, and `flare_v` and `flare_bevel` where a round wire, rod or
tube meets another (flare-V) or a flat (flare-bevel). Each takes `side` `arrow`, `other` or `both` (a double V, ISO's
X; a double bevel, K; double U, J and flares). The upright leg of a bevel, J or flare-bevel is drawn on the left, as
the standards do.

```python
Drawing(frame, standard="ANSI", welds=[
    # A 60° V with a 2 mm root opening, 6 deep with a 5 effective throat, ground flush, both sides: 6(5) with 2 inside,
    # 60° past it, the flush line, then G.
    {"view": "front", "type": "v", "size": 6, "throat": 5, "root_opening": 2, "angle": 60, "side": "both",
     "contour": "flush", "finish": "G", "refs": ["edge(plate_a.end|plate_b.end)"]},
])
# A flare-bevel where a round wire lies on a flat bracket: name the joint.
Drawing(result, welds=[{"view": "front", "type": "flare_bevel", "throat": 1.5, "joint": ["wire_1", "bracket_1"]}])
```

| key | on | meaning |
|---|---|---|
| `size` | all grooves | the groove's depth of preparation (AWS `S`), in the sheet's units |
| `throat` | all grooves | the effective throat (AWS `(E)`, written `S(E)` with a size); ISO writes the penetration `s` (`s5`): the throat when given, else the size |
| `root_opening` | all grooves | the gap at the root (0 or more), written inside the symbol |
| `angle` | `v`, `bevel`, `u`, `j` | the groove angle in degrees, written just past the symbol; a square groove or a flare has none |
| `contour` | fillets and grooves | `flush`, `convex` or `concave`: a line or arc past the symbol (and past its angle) |
| `finish` | with a `contour` | the finishing letter, outermost on the contour: `C` chipping, `G` grinding, `H` hammering, `M` machining, `P` planishing, `R` rolling, `U` unspecified |

Stacked outward from the reference line, as in AWS A2.4: the root opening inside the symbol, the groove angle just
past it, then the contour, then the finish letter. A key on a weld that doesn't take it (an angle on a square groove
or a flare, a throat or root opening on a fillet, a finish without a contour, a contour on a plug, slot or spot weld)
is an error that names the key. `length` and `pitch` work on grooves as on fillets.

### Welds that follow the joint (weldments)

Where two pieces only touch (a round wire lying on a flat bracket) there's no shared edge to name. Name the joint
itself instead of `refs`: `joint` is the two pieces, `bead` a modelled weld bead. The arrows are found again on every
build, so the symbol follows the design as it changes. A weld takes one of `refs`, `joint` or `bead`.

```python
# A weldment's assembly sheet (the design's result): placed instance names.
Drawing(result, views=("front", "top", "iso"), balloons=True, welds=[
    {"view": "front", "type": "fillet", "size": 3, "joint": ["wire_1", "bracket_1"], "tail": "MIG"},
    {"view": "front", "type": "fillet", "size": 3, "joint": ["wire_2", "bracket_1"], "places": [0, 2]},
    {"view": "iso", "type": "fillet", "size": 4, "bead": "bead_1"},
], feature_dimensions=[  # On the same sheet: where each piece sits on the next.
    {"view": "front", "refs": ["bracket_1:plate.top", "select(faces, '%CYLINDER', on='wire_1')"]},  # to its axis
    {"view": "top", "refs": ["bracket_1:plate.left", "select(faces, '%CYLINDER', on='wire_1')"]},
    {"view": "front", "refs": ["bracket_1:plate.top", "wire_1:wire.along(p.side0)"],
     "ends": ["centre", "outside"]},  # to the top of the wire (its tangent), as vendors locate it
])
# A part with several bodies: body ids (the feature that made each body, or its body=).
Drawing(frame.result(), welds=[{"view": "front", "type": "fillet", "size": 3, "joint": ["wire", "bracket"]}])
```

- `joint`: the two bodies (on a part's sheet) or placed instances (on a design's `result` sheet). An arrow goes to
  each place they touch in that view: a wire lying on a bracket is one place, a wire across two rails two. Places
  are ordered along x, then y, then z; `places` picks some, counted from 0 (up to 8 arrows).
- The two must be separate bodies or instances: once a wire is joined into the bracket's solid there's no joint
  left to find, so make it with `op="new"` (or place it as its own instance).
- `bead`: a modelled weld bead's body or instance; the arrow goes to its visible outline.
- Pieces that no longer touch, a name that's gone, or a place that's gone are listed in `dangling` (with `joint` or
  `bead`, and `place`); the weld is never moved. A joint hidden in that view (behind or under a piece) is in
  `dimension_problems`: put that weld on a view that shows the joint.

## Section and detail views

Views form a tree: a section or detail view hangs off a parent view (an orthographic base view, or a section or
detail written before it) and takes its scale, place and style unless it sets its own; moving or rescaling the parent
moves or rescales it.

```python
Drawing(housing, standard="ISO", sheet="A3", views=("front", "top", "iso"),
    section_views=[{"name": "A", "parent": "front", "through": "bore.wall(0)"}],      # cut through the bore's axis
    detail_views=[{"name": "B", "parent": "A", "centre": "groove.wall(0)", "radius": 8, "scale": (5, 1)}],
    feature_dimensions=[{"view": "A", "refs": ["bore.wall(0)"], "fit": "H7"}])
```

- Section: `name` (one or two capitals; ANSI skips I, O and Q), `parent`, `through` (a persistent name, where the
  cutting plane goes: a hole's or shaft's axis, a face's or edge's middle, a vertex; or a model point `(x, y, z)`),
  `direction` (`"horizontal"`, the default, or `"vertical"`: the cutting line on the parent), `flip=True` to look the
  other way (default: down a horizontal line, left along a vertical one), and optionally `scale`, `hidden` (off by
  default) and `at` or `position`. It's placed by the projection method on the side it looks from, hatched where it cuts (alternate
  solids differ), labelled `SECTION A-A`, and the parent gets the cutting line, arrows and letters.
- Detail: `name`, `parent`, `centre` (as `through`), `radius` (model mm), and optionally `scale` (default twice the
  parent's) and `at` or `position`. The parent gets a lettered circle; the detail is labelled `DETAIL B (5:1)` and goes next to it.
- Feature dimensions, datums and tolerance frames take a section's or detail's `name` as their `view`. One outside a
  detail's circle is listed in `dimension_problems`.
- A section or detail whose `through`/`centre` no longer resolves is never moved: it isn't drawn and is listed in
  the sheet's `dangling_views` (with anything taken from it, and what's on it in `dangling`); a cutting plane that
  misses the part is in `view_problems`. `views_placed` lists every view drawn with its kind, parent and scale
  (and its `projection`, which the Drawing tab uses so people can click the model's geometry on the sheet).
- A section of a large assembly takes build time: section one component on its own sheet.

## Balloons and hole tables

```python
# The assembly sheet: one balloon per parts list item, or each placed by hand.
Drawing(result, standard="ISO", sheet="A3", bom=True, balloons=True)
Drawing(result, bom=True, balloons=[{"instance": "motor_1"}, {"instance": "housing", "view": "front", "side": "up-left", "offset": 14}])
# A part's sheet: its holes tagged in the top view, listed from the corner where base.left meets base.front.
Drawing(housing, views=("front", "top"), hole_tables=[{"view": "top", "origin": "vertex(base.left|base.front|base.top)"}])
```

- `balloons` (on a design's `result` sheet with a parts list): `True` for one per item on its first instance, or
  dicts of `instance` (a placed instance's name, as in `design.add(..., name=)`), and optionally `view` (default: the
  first base view that shows it; a section's or detail's name balloons a part seen only there), `side` (`above below left right up-right up-left down-right down-left`; default straight
  out from the view's middle) and `offset` (paper mm past the view, default 10). The number is always the instance's
  ITEM in that sheet's parts list (never write one); with rows written by hand, an instance matches the row named
  after its component. The leader starts with a dot on the part's own visible outline in that view.
- `hole_tables` (on a part's or component's sheet): dicts of `view` (one that looks along the holes), and optionally
  `holes` (hole features' ids like `"hole_1"`, single holes' walls like `"hole_1.wall(2)"`, or on plain CadQuery
  `select(faces, "%CYLINDER")`; default every hole feature that shows round there) and `origin` (where X and Y are
  measured from: a vertex, a hole, a face, or a model point `(x, y, z)`; default the view's lower-left corner). Each
  hole gets a tag in the view (one letter per size, numbered: A1, A2, B1) and a row: X, Y, ⌀, DEPTH (THRU for through
  holes, from the mouth for counterbored and countersunk ones) and CALLOUT (counterbore ⌀ × depth, countersink ⌀ ×
  angle, thread). Values are the model's, so the table follows it; rows that don't fit the sheet go to the CSV.
- Threads: write the tapped hole's thread on its feature, `model.hole("tap", on, pts, diameter=5.0, depth=12,
  thread="M6x1")` (the diameter is the tap drill); `design.fasten`'s suggested hole arguments include it for tapped
  holes.
- What can't be drawn is listed, never guessed: an instance or hole that's gone in `dangling` (`"annotation":
  "balloon"` or `"hole"`), and the rest in `balloon_problems` (no parts list, an instance not in it, one that doesn't
  show in that view; with `balloons=True`, items without a placed instance such as washers or cables, by `item`) and
  `hole_problems` (not round in that view, outside a detail's circle). `balloons` counts what's drawn per view,
  `balloons_placed` gives each one's instance and item, and `hole_tables` each table's tags.

## Doing it well

- Ask for (or use from the person's own skill) their standard, sheet size, title block values, general
  tolerance, units and revision scheme. Don't invent tolerances, approvals or dates; leave a field out instead.
- When someone needs their company's own title block (they describe it, or drop a picture of it in the chat), write
  it as `title_block=`: the rows and cells as they show them, bottom row first, sizes in mm, their labels, and their
  company's fixed text as `"text"`. Make each tall box one cell with `"rows"` rather than stacked cells (no lines
  through it), and match the sheet's alignment and label sizes (`"align"`, `"valign"`, `"label_height"`). Then suggest they save the sheet as a template (Sheet format → Templates) to start
  every new sheet from it, or keep the layout in their own skill. Logos and images aren't drawn: leave that cell
  blank or put the company name as text.
- One sheet per part that gets made, plus an assembly sheet with the parts list. A part's sheet usually needs
  front, top and right; add `iso` for clarity. Leave views out that add nothing.
- When you change a released design, add a revision row (next letter or number) saying what changed, in the
  same edit, so the drawing's revision table follows the design's history.
- Overall dimensions are automatic. Add feature dimensions for what the shop needs to make and check it (hole
  sizes and positions, slots, steps, angles), each once, in the view that shows it truest; set `dimensions=False`
  when they repeat the overall sizes. Don't invent tolerances: use the person's, or their general tolerance in
  `fields`. GD&T is theirs too: don't invent a datum scheme or tolerances; use theirs, or ask. Tell them anything
  critical still needs checking.
- Fits are the person's choice, like tolerances: use theirs, don't invent one. When they ask what's usual, the
  common hole-basis pairs are H7/g6 (sliding), H7/h6 (location) and H7/p6 (light press); the hole gets the capital
  class on its sheet, the shaft the lower-case one on its own.
- After generating, check the build's `drawings` metadata: each sheet's scale and views, `overflow` (views
  larger than the sheet: smaller scale or bigger sheet), `dangling` and `dimension_problems`, `overlaps`, and `error`.
- Then look at every sheet: `inspect_model(view="sheet", options={"sheet": n})` gives its picture with its report.
  Judge it as a reader would: text that's hard to read, annotations crowded together or far from what they point at,
  views too small for their detail, a lopsided or empty layout. On a large or crowded sheet, look closer with
  `options={"sheet": n, "region": box}`, where `box` is a view's or an overlap's box from the report. Fix what you
  see before saying the drawing is done.
- `overlaps` lists text that's hard to read: an annotation's text over other text, over the title block or a table,
  or crossed by a view's edges or a section's cutting-plane mark, and an annotation's own texts over each other
  (`own_texts`: a hole table's tags where holes are close). Each names the annotation (`dimension`, or `annotation`
  and `index`; a view's overall size is `overall_dimension`), what it's over, and the `box` they share. What's
  placed automatically already keeps clear of all of these (values slide along their lines, frames and balloons
  go further out, a feature's frames stack on one leader, hole tags take another corner), so what's listed is
  either placed by a value you wrote (`offset`, `side`, `at`, `text_at`, a view's `position`) or has no room at
  this scale. Change or leave out that value, move the view, or choose a larger scale.
- Big assemblies: drawing every view of everything takes build time. Draw components one sheet at a time.
- Sheet edits are cheap: a revision that changes only top-level `Drawing(...)` statements (written as above, one per
  statement, arguments that call nothing in the design) reuses the components and the design's motion and fit check
  results, so it doesn't run those checks again. To try sheet changes without touching the main line, make them on a
  branch (`edit_design(..., new_branch="<short-name>")`, then `generate_model(branch=...)`), and merge it
  (`merge_branch`) when the person asks.
- A wrong `Drawing` argument (an unknown `side`, view or `place`) fails the build with the values it accepts. Those
  values are listed in this skill's own sections (a leader note's `side` under `notes`, a dimension's `side` and a
  weld's `place` under their Placement): check them there before writing a placement word you aren't sure of.

## The Drawing tab

People also make and edit sheets by hand in the Design workspace's **Drawing** tab (beside Solid, Sheet metal and
Motion), which works like a CAD drawing workspace. New sheet first asks for the standard, size, orientation, a
template and what to draw (the part or design, or one of its components), then writes a blank sheet (`views=[]`, or
the standard views when ticked) for the person to place views on. The first base view placed on a blank sheet is its
master (written as `front` with `front=`), the Inspector turns it, and projected views follow. Its ribbon holds the tools: new sheet, sheet format and title block;
base, projected, section and detail views; dimension, note, balloon, GD&T frame and datum; parts list, hole table,
revision and cut list. Each is used on the sheet itself: a dimension is a click on a hole or on two edges, then a click
where it goes; a section is a cutting line drawn across a view; a detail is a circle dragged out on a view; a note is a
click where it goes (or first a click on an edge, face or corner, for a leader note pointing at it). The Browser
lists the sheets as a tree (views, the section and detail views taken from them, their annotations, the tables, notes
and title block), the Inspector edits what's selected, and right-click menus do the rest. Views, dimensions, balloons
and placed and leader notes are dragged into place. Every tool writes the
same `Drawing(...)` call you write, so keep the calls it edits easy to read:

- Put sheets the person edits by hand in main.py (a part's code, or a design's main.py), one top-level
  `Drawing(...)` statement per sheet.
- Write those arguments as plain literals (`sheet="A3"`, `views=("front", "top")`, `scale=(1, 2)`,
  `fields={"number": "BRK-001"}`). A variable or expression works too, but editing it in the tab writes its value as a
  literal in its place (the Inspector shows what it was, with Undo); one made by a loop or comprehension, or a sheet
  drawn inside a loop or a function, is left as written.
- When someone asks how to make a drawing by hand, point them to the Drawing tab; offer to fill it in for them.

Several sheets of the same model are several `Drawing(...)` calls: they're numbered in the order the code declares
them, and the title block's SHEET cell shows `n/m` on its own (`fields={"sheet": "1 OF 2"}` replaces it on that sheet,
as `"revision"` replaces REV; leave it out unless the person wants their own wording or numbering). People can also save a sheet's setup (standard, size,
orientation, projection, units, title block fields and layout, notes) as a template (Sheet format → Templates) and
start new sheets from it; the tab copies it into the call as plain literals, so there is nothing for you to look
up: write the same arguments.

## Where the person finds it

The Drawing tab shows the sheets. Export → Drawing (PDF) downloads every sheet as one PDF, a page per sheet at its
own paper size. Export → Drawing (view · print) opens the sheet in a new tab to check or print. Export → Drawings
(SVG · DXF) downloads every sheet as SVG and DXF with the parts list, cut list and hole tables as CSV.
Agents outside STEVE get the same files from generate_model: download=["drawings_pdf"] (the PDF) or ["drawings"]
(the SVG/DXF zip), each a one-time command.
For a product of several linked documents, Export → Product drawings (PDF · STEP) on the top document downloads every
linked document's sheets as one PDF in assembly order, and each document's STEP in one zip (each STEP file is made then,
so a large product can take a few minutes). Agents outside STEVE get
that PDF with generate_model(top document, download=["product_drawings_pdf"]): while its documents are still building,
`product_drawings.status` is "building" with how many are done; call again with the same arguments (it carries on).

House rules (their title block values and layout, numbering, standard, notes they always use) belong in the person's own
skill (Settings → Skills), which applies to STEVE and to their AI agents; their Drawing tab templates are the same
for working by hand.
