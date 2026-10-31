---
name: steve-step-import
description: >-
  Imported STEP geometry: import_step, file-order face names (import_1.face(n)), adding features to imported bodies, and selector references that survive renumbered faces. Load when a part contains import_step or the person wants to change an imported file, or when a feature on numbered faces (import_1.face(n), model.add's code_1.face(n)) broke after an upstream change. Also load before bringing many parts or a whole assembly in from another CAD system.
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



# Imported STEP geometry

People import STEP files from the toolbar (or by dropping a file). The import becomes a feature
that names the upload by its content hash:

```python
model.import_step("import_1", "3f2a…(sha256)", name="Bracket", op="new", solids=None)
```

- `list_imports` shows the STEP files uploaded to this workspace and `insert_import` places one into a part or
  design. An agent outside STEVE uploads a file from its machine (or one it converted, e.g. from a mesh) with
  `request_upload(filename, size_bytes, sha256)` and runs the command it returns: a one-time ticket for that exact
  file. STEVE in the app asks the person to upload it (File → Import…, or drop it on the window). Never upload
  through a browser.
- `op="new"` (the default) adds one body per solid: `import_1` for one solid, `import_1_1`,
  `import_1_2`, … for several.
- `op="join"`, `"cut"` or `"intersect"` combine every imported solid with the target body.
- `solids=[k, …]` imports only those solids (1-based, file order).

## Many parts or a whole assembly

Each upload takes one ticket, at most 60 an hour per workspace (more returns 429 `too_many_tickets`);
re-requesting a file that is already uploaded returns `already_uploaded` and takes none. So don't upload
one file per part:

- Export the parts together as one STEP (or a few, up to 20 GB each) and give each component its own
  solid of it: `bracket.import_step("import_1", sha, name="Bracket", solids=[3])` in
  `components/bracket.py` (load steve-designs). The upload result and list_imports give `solid_names`,
  the file's solids in order; map them to components before writing.
- One build can use at most 1024 imported files and 20 GB of them together, counting every component and
  linked document it builds, so keep the split to a few files.
- Import each distinct part once, as a component, and place it as many times as it appears with
  `design.add(..., name=..., at=...)` or `design.pattern`, not one import per placed copy.
- Rename imported names before writing them: component ids and joint, coupling and fit check
  names are lowercase letters, digits and underscores (`Bracket__Left_Mount` → `bracket_left_mount`), and file names at most 64 characters.
  Keep a table of old → new names in a data file if the person needs to map them back.

## Face names

- Faces are named in file order: `import_1.face(12)`, or `import_1.solid(2).face(3)` when the
  file has several solids. Groups: `import_1.faces`, `import_1.solid(2).faces`.
- These names survive later features, so you can fillet imported edges, sketch on imported faces,
  cut into imported bodies and move them:

```python
with model.sketch("sketch_1", on="import_1.face(4)") as s:
    s.circle("c1", (0, 0), 3)
model.extrude("cut_1", "sketch_1", distance=-5, op="cut")
model.fillet("fillet_1", edges=["edge(import_1.face(4)|import_1.face(7))"], radius=1)
```

- There is no feature history inside an imported solid: you can't change its original dimensions,
  only add features to it, cut it, or remodel it natively.
- Use `inspect_model` and the selection context (the person's picks name faces like
  `import_1.face(n)`) to find the right face. Don't guess numbers.
- Face numbers change when the file is replaced (and `model.add` numbers change when its code
  adds or removes faces), breaking `edge(import_1.face(4)|import_1.face(7))`. For features that
  should survive that, reference the geometry instead; it is re-resolved at every build:

```python
model.chamfer("chamfer_1", edges=cq.selectors.BoxSelector((-1, -1, 19), (1, 1, 21))
              & cq.selectors.TypeSelector("CIRCLE"), distance=1.5)        # the circle centred at (0, 0, 20)
model.fillet("fillet_2", edges=['select(edges, "%CIRCLE and >Z", on="import_1")'], radius=1)
```

  `BoxSelector` matches by centre position; combine with `&`, `+`, `-`. `on=` limits a string
  selector to one body (or a feature's faces). Make selectors specific (position plus type), and
  check the feature's `detail.edges` count: a broad one can match new edges after a change.

## Errors

These are recorded on the feature, and later features still run:
- an unknown import;
- an unreadable file;
- a file with no solids (surfaces only);
- a solid index out of range.

`detail` reports `solids`, `imported`, `bodies`, `faces` and the file's `names`, one per solid in file order: the
body's own name, as `Component / Body` when its component holds several bodies, else the component's. Imported bodies
show those names until you give one with `model.body_name`, which wins. To
convert an imported flat plate to sheet metal, load `steve-sheet-metal` (`sheet_convert`).
