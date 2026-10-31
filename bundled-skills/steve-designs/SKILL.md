---
name: steve-designs
description: >-
  Multi-component designs: params.py, one Component per file, placing instances, cross-component references, links to saved parts at a pinned revision, patterns, BOM, and fit checks (interference and clearance between instances, intended contacts, comparison with the previous revision). Load before any design (kind "design"), before checking whether a new or changed part fits its neighbours, and before building or migrating a large assembly (size limits, naming rules).
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



# Designs: components as files

Use a **design** (document kind `"design"`) for anything made of several coupled components: a
mechanism, a gearbox, an enclosure with a lid, an engine module. A single solid part stays a
**part** (one file, `model = Model()`). Never import `components` or `params` into a part; a part may
link saved parts and designs, added as features with `model.add` (see Linking).

## Layout

```
params.py              shared numbers: the design's interface (linking designs can override them)
components/<name>.py   exactly ONE Component per file: its sketches, features and bodies
main.py                imports components and places them; `result = design.result()`
```

- Add a component with `create_component` (it scaffolds `components/<name>.py` and imports it into
  `main.py`), then edit it with `edit_design(path="components/<name>.py", ...)`.
- Never put two components in one file and never define a component in `main.py`.
- Shared dimensions live in `params.py` as top-level numeric parameters (`width = 80  # mm Plate width`);
  components import them: `from params import width, thickness`.

## A component file

```python
from steve import Component
from params import plate_width, thickness
from components.frame import frame          # only when this component references the frame's geometry

plate = Component("plate", name="Top plate")
with plate.sketch("sketch_1", on="XY") as s:
    s.rect("r1", (-plate_width / 2, -20), (plate_width / 2, 20))
plate.extrude("extrude_1", "sketch_1", distance=thickness)
```

Components use the same feature calls as parts (sketch, extrude, fillet, hole, …), with the
component's variable instead of `model`.

**Bodies that aren't parts.** A component that only exists for analysis or layout (the fluid or gas a
flow study needs as a body, a keep-out or envelope volume) is declared once, on the component:
`Component("air_path", name="Air path", hardware=False)`. It builds, shows in the viewer, is in the
design's STEP and studies use it as a body (`run_study` names its instance), but it has no BOM row
(nor a drawing's parts list, cut list or balloon), isn't in the design's volume, mass or centre of mass,
and the fit, motion, cable and fastener checks, the print meshes (STL/3MF, print set), the per-component
STEP files and the manufacturing checks leave it out. The build marks it `hardware: false` (components,
instances; `not_hardware` in the measurements); `read_design` shows it in the outline too. Never use it
to hide a real part from a check: a part that interferes is a design problem to fix. It can't take
`print=`, and a screw can't clamp or thread into it.

**Cross-component references** are persistent names qualified by the component:
`frame.face("extrude_1.end")`, `frame.edge("edge(extrude_1.end|extrude_1.side(r1.left))")`.
You can sketch on another component's face (`on=frame.face("…")`) or project its edges. Imports
form the build order; cycles are errors. Linked parts work the same way (see Linking below).

## main.py: placing instances

```python
from steve import Design
from params import blades
from components.disk import disk
from components.blade import blade
from links import bolt                       # a linked saved design or part

design = Design()
design.add(disk)                                              # instance name defaults to the component id
design.add(bolt(length=30), at=((0, 0, 40), ("Z", 15)))        # (translation mm, (axis, degrees))
design.pattern(blade, count=blades, axis="Z")                  # instances, not copies
result = design.result()
```

- `at=((x, y, z), ("Z", angle))` places an instance: first a rotation (degrees) about an axis through
  the instance's own origin, then a translation that puts its origin at (x, y, z) mm in the design's
  frame. `at=((10, 0, 0), ("Z", 90))`: origin at (10, 0, 0), the instance's +X along +Y. Give instances distinct names when you add one component twice: `design.add(bolt,
  name="bolt_2", at=...)`.
- `design.pattern(component, count, axis="Z", angle=360)` repeats instances around an axis through
  the origin (a full turn doesn't repeat the first). `design.pattern(component, count,
  direction=(1, 0, 0), spacing=25)` repeats them along a line. `at=` places the whole pattern. Patterns
  are counted in the bill of materials, not copied.
- Irregular spacing: `design.pattern(component, points=[(0, 0), (12.5, 4), (31, -2, 5)])` places one
  instance at each (x, y) or (x, y, z) in mm; `polar=True` reads (r, θ degrees[, z]) and turns each
  instance by θ about Z, like a circular pattern. Leave out `count`.
- Tables: a design may hold `.csv` files beside main.py (`holes.csv`; the person adds one with
  Source panel → file switcher → Import table…, or create it like any file). Read one with
  `from steve import table`: `design.pattern(hole, points=table("holes.csv"))`. The delimiter (comma,
  semicolon, tab) and a header row are detected; `table("holes.csv", columns=("x", "y"))` picks named
  columns, `.dicts()` gives rows by name. A table is data: never import it or lint it as Python.
  People can do this without code: Pattern → Table pattern on the ribbon (with main.py open) picks the
  component and table (or imports one) and writes that `design.pattern(...)` line.
  Inside a component, a table of absolute hole positions with IDs (a BGA or connector pin table):
  `model.point_pattern("pins", table("balls.csv", columns=("x", "y")), features=["pin"], absolute=True,
  labels=table("balls.csv", columns=("ball",)))`, with the seed `pin` hole at the first row's position;
  the copies are named `pins[A2].pin.wall(0)`, … (don't shift the rows by hand).
- Saved section views: `from steve import section_view`, then `section_view("bore_cut", axis="x", at=12.5)`
  (`flip=True` keeps the side above `at`) at the top level of a part's file or a design's main.py, one
  call a line with literal values. `at` is mm from the origin, not a fraction. Display only: the model tree
  lists them under Sections and shows one as a fixed cut; people save them from Section analysis → Save.
- `print={"build_direction": "+Z", "material": "petg"}` on `design.add` or `design.pattern` marks
  3D-printed instances for File → Export → Print set; see the `dfam-3d-printing` skill.

## Linking saved parts and designs

- Before creating a part, look for one to reuse: `list_designs(search=...)`. Link it, or extend the
  saved part itself with `edit_design` (a new parameter, a feature) rather than making a variant.
  Create a new document only when nothing fits, with a name and a docstring that say what it is for
  and what its parameters set, so it can be found and reused later.
- Links stay inside one workspace: a team's design links the team's parts, a personal design the person's own. A link
  to a document of another workspace is refused; never copy one into the other unless the person asks.
- Folders: each listed document has its `folder` path. For a project, search its folder first
  (`list_designs(folder="Fixtures/Brackets")` includes the folders below it), and create a family of parts
  there with `write_design(..., folder="Fixtures/Brackets")` (missing folders are created).
  `edit_design(document_id, revision, folder=...)` alone moves a document without a new revision.
- Libraries: folders the person marked as libraries (`libraries` in list_designs; their documents have
  `library: true`) hold their reusable parts. Look there before creating one (`list_designs(folder=<library>)`),
  and link it with `link_design`.
- Reuse a saved part or design with `link_design` (pinned to its current revision); it becomes
  importable as `from links import <alias>`. `document_id` is the document that gets the link;
  `target_document_id` is the one being linked. Check the result's `linked` names before building.
- Never copy another document's source into a design. To reuse one component of a saved design, link
  just it: `link_design(..., target_document_id=<design>, component="standoff")` builds only
  `components/standoff.py` (with that design's params, overridable), and its faces need no instance prefix.
- A component worth reusing elsewhere: extract it rather than copying it.
  `link_design(document_id, revision, alias="standoff", extract_component="standoff")` saves it as a new
  part (the shared parameters it uses become the part's own) and links it back in the same revision,
  called with this design's parameters, so the geometry stays the same. Use the component id as the alias
  to keep instance names. It is refused, naming the file and line, if another file imports the component
  or it imports another component. Then `generate_model` and check what the result's `notes` list.
- Use a link as a value (`plate`) or call it with parameter overrides (`bolt(length=30)`): each
  override set builds in its own namespace and is its own BOM line.
- Links stay at their pinned revision ("Update available" when the linked document has moved on).
  When the person asks, move a link to the latest revision: `link_design` again with the same alias
  and no `target_revision`, then `generate_model`, run the design's fit checks (below) and report what
  changed. Generate and validate a part before building a design that links it.
- Remove a link with `link_design(..., alias="bracket", unlink=True)` (it drops the import too; edit
  away other uses). To undo a change, `edit_design(document_id, revision, restore_revision=N)` saves
  revision N again as a new revision; never retype the old source by hand.
- A link's faces and edges have its own persistent names: `plate.face("extrude_1.end")`,
  `plate.edge("edge(…)")` (in a linked design, name the instance: `rotor.face("disk:body.end")`).
  Joints, fasteners and fits follow where the link is placed. To model on it from a component, pass
  the same `at=` as its `design.add`:

  ```python
  # components/bracket.py                     # main.py: design.add(plate, at=(50, 0, 0))
  from links import plate
  bracket = Component("bracket")
  with bracket.sketch("base", on=plate.face("extrude_1.end", at=(50, 0, 0))) as s:
      s.rect("r1", (0, 0), (20, 10))
  bracket.extrude("boss", "base", distance=8)
  ```

  An unknown name's error lists the link's names (`api_reference("LinkedInstance")` for the calls).
- A **circuit** (an Electronics board) links the same way and comes in as its board with every part's body:
  `design.add(led_board, at=(0, 0, 3))`, no overrides. For a case around it, load electronics-fabrication
  (its enclosure section).

## Limits

- Keep `main.py` to imports, placements and joints; put long data (placement or joint tables,
  coordinates) in its own file (`assembly_data.py`) and import it, so each file stays readable.
- At most 200 files besides `main.py`. File paths are lowercase module names, each name at most 64
  characters, at most 3 folders deep (`components/arm/elbow.py`).
- A document's whole source (every file) must fit in a 1 MB request, or the studio can't build or
  save it. Split a big assembly into linked documents (each subassembly its own design) instead of
  growing one.
- Component ids and joint, coupling, animation, explode, collision study and fit check names are lowercase
  letters, digits and underscores, starting with a letter. Saves report literal names that break
  this in `diagnostics` before any build; names computed from data are only checked by the build.
- To show how a design comes apart (a teardown, assembly instructions, an exploded view to play or record),
  use `design.explode(...)`, never slider joints or moved placements: it is display only. See the
  steve-motion skill, "Explode a design".

## After generate_model

- Start with `metadata.modeling.design.verdicts`: a line each for what the build found (errors, failed features, each
  fit, animation and motion check, cables, screws, mass), worst first. Then `mass`: the design's mass in grams from
  what's placed, `complete` false and `without_material` naming components with no material (their mass is unknown).
- Read `metadata.modeling.design` (summarised for a large design; long lists come as a table: `columns`, then `rows`):
  - components: each one's bodies, mass, materials and how many features it has, failed or warned (the failed and
    warned ones are listed in full at the top: `feature_errors`, `feature_warnings`);
  - how many instances (`read_design` lists them by name);
  - links with their revision;
  - `bom` (item, quantity, source; printed rows also `print`; `read_design(document_id, detail="bom")` adds each row's
    instances and screws by name);
  - errors.
- One component's build in full (its bodies, features and sketches as built, and its instances' placements):
  `read_design(document_id, detail="<component>")`.
- Fix component errors in the component's own file.
- `read_design` returns every file and the design's diagnostics (e.g. "two components in one file").
  To read just one file, pass its path: `read_design(document_id, path="components/arm.py")`.
- A large design's `read_design` (past about 60,000 characters) comes in pages, each within that.
  Page 1 is enough to plan: the outline (`features`) with every diagnostic, links, the model's
  summary with every problem and verdict, main.py and params.py when they fit, and the component
  files that fit, those with problems first. `pages` says how many there are and `contents` what
  each later page holds, with its call (`read_design(document_id, page=2)`). Later pages give the
  rest verbatim, each part with `at`, its place in the whole answer: a long file in ranges of whole
  lines (`lines`, `of`; a single line longer than a page in character ranges, marked `continues`
  until it ends), a long list in runs of items (`from`). A big file read with `path=` comes in pages
  the same way (follow `next`); put the pieces together in order, adding nothing between them. Before you edit a file, read all of it; never
  guess its contents. Every page names the revision and model id: if they change between pages,
  read again from page 1.
- A design revision is one commit of all its files. Editing one component rebuilds only that
  component and `main.py`.
- Look at what an edit changed, not just the whole design: `inspect_model(document_id,
  show=["bracket"])` draws only that instance, framed on it; `hide=["housing", "cover_*"]` shows
  what's inside. Entries are instance names, component names or patterns; `summary.drawn` gives
  what was drawn and its extent. Combine with `view` ("top", "front", "right").

## Fit: interference and clearance

Does a new or changed part fit its neighbours? Add a fit check to `main.py` once; every build runs it
with exact solids:

```python
design.clearance(0.3, pairs={("cable_plug", "shell"): 1.0})        # mm; default 0 (touching is fine)
design.contact("motor_1", "bracket", kind="seated")                # may touch
design.contact("bearing_1", "bracket", kind="press_fit", max_overlap_mm3=2.0)
design.contact("screw_*", "*", kind="threaded")                     # screws may engage their holes
design.fit_check("fit")                                             # every pair; instances=["bracket", "screw_*"] limits it
```

- It checks the design as modelled, each pose in `poses=["home", "folded"]`, and (`motion=True`,
  the default) every joint or coupling that moves a checked instance, over its limits, refined
  between samples so a contact between two steps isn't missed (see the steve-motion skill).
- Contacts and clearance pairs take instance names or patterns; the first matching contact applies.
  `design.rigid` is not a contact: fastened parts still may not overlap.
- Never declare a contact just to silence a clash. Declare only contacts that are designed (a seat,
  a press fit, a threaded hole); fix the geometry otherwise.
- At clearance 0 both a touching pair and one slightly apart pass; the check's `touching` lists
  each undeclared pair that touches (`min_distance_mm` 0, no overlap, `points`, `when`), and
  `touching_count` counts them all (a pair whose distance ran out of time isn't listed: the note says
  whether it touches wasn't determined, which doesn't fail the check). Read
  it to see which seats meet, with no contact per seat. When a seat must meet and you want its gap reported if it
  doesn't (a motor seated on its bracket), declare the contact: each entry of the check's `contacts` says
  `touching` (any of its pairs touched, at any pose checked) or, if false, its `closest` pair with
  `min_distance_mm` (`at_least`: a bound), `points` and `when`. That is a seat that isn't seated:
  report it with its gap, never as a pass (the check itself doesn't fail on it).
- After an edit, `generate_model`, then `inspect_model(document_id, checks=["interference"])`. Each
  pair is `new`, `worse`, `unchanged` or `resolved` against the previous revision (or
  `options={"base_revision": N}`); `pass` is false for new or worse pairs, and for a check that
  ran out of time before every requested pose and sweep (`incomplete: true`, the skipped ones in
  `unchecked`): that is not a pass, say so and run a full build (more time) or narrow the check with
  `instances=` or fewer `poses`, never report it as clear. Report those with
  `overlap_mm3`, `min_distance_mm` against `clearance_mm`, `points` and `when` (the worst pose), and
  mention unchanged ones separately. A fit check added in this revision has nothing to compare
  with: add it and generate before the edit you want judged.
- Fit and fastener checks don't wait for a long full build: once the revision's preview has built,
  `inspect_model` answers them from it. Views wait for the full build (`still_working` when it's not
  done yet: call again to keep waiting), and a view drawn on demand (posed, show/hide, or the first
  plain one) or manufacturability facts can take a while on a big design too: `still_working` says
  how far it has got, and the same call again picks up the same drawing. When the base revision
  is still being built, the result is this revision's checks with `comparison: "pending"` and
  `pass: null` (not a pass, not a fail) plus `still_working`: call again with the same arguments to
  finish the comparison (it joins that build), and never report a pending comparison as clear.
- `unverified` (the exact boolean failed, or ran out of time: the note names the pair; narrow the
  check with `instances=` or run a full build, which has more time) and `approximate` (not a valid closed solid, common
  with purchased STEP parts) are never a pass; say so. The raw report is
  `metadata.modeling.design.kinematics.fits`.
- In the studio, Properties → Motion lists each fit check's pairs for designs with joints; "show"
  moves to the worst pose and the pair turns red.
- Screws that join parts: declare them with `design.fasten(...)` (load the steve-standard-parts skill).
  Every build then checks their holes, thread engagement, walls and screwdriver access, and the BOM
  lists them; `inspect_model(checks=["fasteners"])` reports them.
