---
name: steve-surfaces
description: >-
  Sweeps, lofts and surfaces in a part: sweep options (frenet, binormal, guide curves, extra sections), loft options
  (ruled, continuity between its own sections, smoothing, degree), surface bodies from boundaries (fill,
  boundary_surface), turning surfaces into solids (thicken, solidify), and the continuity STEVE can and can't give.
  Load before writing or changing a sweep, a loft, a fill or boundary surface, or a thicken or solidify.
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



# Sweeps, lofts and surfaces

Look up any call's exact signature with `api_reference("Model.sweep")` (or `Model.loft`, `Model.fill`, …) rather
than guessing.

## Sweep

`model.sweep(id, profile, path, …)` sweeps a closed profile along a path (a sketch or edge refs). How the profile turns
(one of these at most; the default is a corrected Frenet frame):

- `frenet=True`: the plain Frenet frame.
- `binormal=(dx, dy, dz)`: keeps the profile's orientation to that direction, with no twist.
- `guide=<sketch>`: a guide curve steers the sweep and scales it from the profile's outline.
- `sections=[more profiles]` with `positions=[0..1 each]`: more profiles along the path, at those fractions of it.

A sweep isn't G2/Class-A.

## Loft

`model.loft(id, [sketches], …)` lofts through sketches in order. A point id may be the first or last section (a loft to
a point).

- `ruled=True`: straight between sections.
- `continuity="C1"|"C2"`: between the loft's own sections only.
- `smoothing=True`, `max_degree=2..25`.

A loft has no G2/Class-A continuity to other faces.

## Surface bodies

- `model.fill(id, boundary=[curves], continuity="G0"|"G1")`: an N-sided patch closing a loop of edges or sketch
  curves. "G0" (the default) passes through the edges; "G1" is also tangent to the face each edge bounds, per edge as
  `{edge: "G1"}` if needed, and an edge between two faces needs `support=` (the face to be tangent to).
  `constraints=` adds points or curves the patch passes through.
- `model.boundary_surface(id, curves_u, curves_v=None, ruled=False)`: a surface through two or more curve sets in
  order (a loft that stays a surface). With `curves_v` too, the outer curves bound a four-sided patch and the inner
  ones guide it.

Surface bodies have no volume or mass and are never machined: meshes, mass, simulation and machining leave them out,
and the build warns about them. Their continuity to neighbouring faces is G1 at most, never G2/Class-A.

## Solids from surfaces

- `model.thicken(id, source, thickness, side="out"|"in"|"both")`: offsets a surface (or faces) into a solid along
  the faces' normals. Faces `<id>.outer`, `<id>.inner`, `<id>.side`. A face curving tighter than the thickness is
  refused, with its radius.
- `model.solidify(id, [surfaces], tolerance=0.01)`: sews surfaces that close a volume into one solid (gaps up to the
  tolerance). A set that doesn't close is refused, naming each open edge.
