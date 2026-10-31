---
name: steve-materials
description: >-
  model.material(...) for parts and bodies: library ids, finishes, colours, mass and material problems; model.appearance(...) for a look without a material (paint, glazing, presentation, no mass), on the part, bodies or some faces (faces=, bands and trims without splitting solids); model.decal(...) image decals on flat or curved faces, across several faces. Load before choosing or assigning materials, changing how a part or body looks, answering mass/weight questions, or putting a logo, label or screen image on a part.
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



# Materials

Materials are **statements, not features**: no id, nothing rebuilt. They version, branch and
merge with the code.

```python
model.material("aluminum-6061-t6")                                         # the whole part
model.material("stainless-304", bodies=["extrude_2"], finish="brushed")     # some bodies
model.material("abs", bodies=["boss"], color="#1f2328")                     # appearance tint
```

- In a design component, use the component's variable: `plate.material("aluminum-6061-t6")`.
- `bodies=` overrides the part material for those bodies whatever the order; for one body the last
  call wins.
- `finish=` and `color="#rrggbb"` change only how the body renders (for a look with no material, see
  "Appearance without a material" below). Finishes include polished,
  machined, brushed, bead-blasted, cast, anodized, painted, powder-coated, glossy, satin, matte,
  textured, clear, frosted, natural and varnished; which apply depends on the material.
- Write material statements before `result = model.result()`.

## Ids

Ids are library slugs, e.g.:
- metals: `aluminum-6061-t6`, `aluminum-7075-t6`, `stainless-304`, `stainless-316`, `titanium-6al-4v`,
  `steel-s235jr`, `steel-a36`;
- plastics: `abs`, `pc`, `pla`, `pa6`, `pom-copolymer`;
- glass: `glass-soda-lime`;
- sheet-metal stock: `aluminum-5052-h32`, `steel-dc01` (cold-rolled, SPCC / SAE 1008 / ASTM A1008 CS),
  `steel-dx51d-z275` (hot-dip galvanized, G90 / ASTM A653 CS);
- plate: `steel-a36`, `steel-a572-50` (ASTM A572 Grade 50 HSLA), `steel-ar400` and `steel-ar500` (abrasion-resistant
  wear plate; AR grades are producer-defined, so their strengths are one producer's typical values);
- wood-based panels: `wood-mdf`, `wood-hdf` (hardboard), `wood-particleboard` (chipboard), `wood-osb`,
  `wood-plywood-softwood`, `wood-plywood-hardwood`. Panel density varies by product, and each has one producer's
  typical density; for a specific board's density, suggest the person's own material (below).

The library has a few hundred engineering materials, with sources. If you're unsure of an id, assign
your best guess and read the build's `modeling.materials.problems`: unknown ids come back with
suggestions and their names. They are reported, never fatal. A guess is matched against ids, names and
designations (other names, EN material numbers, comparable AISI/UNS grades), so `steel-c45`,
`steel-1-6587`, `steel-18crnimo7-6` or `steel-aisi-8620` finds the library's id for it, first.

Steels are named by their EN grade (`steel-<grade>`); AISI/SAE numbers aren't ids. Gear and shaft
steels in the library:
- `steel-17crnimo6`: 17CrNiMo6, 1.6587, the same material as 18CrNiMo7-6;
- `steel-20nicrmo2`: 20NiCrMo2, 1.6523, comparable to AISI 8620;
- `steel-34crnimo6`: 34CrNiMo6, 1.6582, comparable to AISI 4340;
- `steel-15crni6`, `steel-30crnimo8`, `steel-36crnimo4` (≈ AISI 9840), `steel-1c45` (C45, ≈ AISI 1045).

16MnCr5, 20MnCr5, 42CrMo4 (AISI 4140) and AISI 9310 aren't in the library: say so, offer the
closest grade above, or suggest the person adds the grade as their own material (below).

## The person's own materials

A person can keep their own materials (Materials dialog → My materials): new ones, or copies of a
library material with values they changed (marked "Modified"; the library's stays as it is). Their ids
start with `my:`, e.g. `model.material("my:bronze-c932")`, and give mass and simulation values like a
library id. Only the person makes, edits or deletes them, in the app; you can't see the list, so use
an id they give you (the dialog shows it under the name) and never invent a `my:` id. An unknown or
deleted one is reported in `problems`. For a material the library lacks, suggest they add it there.

## What the build reports

- Per body: `material`, `finish`/`color`, and `mass` in grams (exact volume × library density).
- `modeling.materials`: `default`, total `mass` (null unless every body has a material),
  `unassigned` bodies and `problems`.
- Simulations take materials from the design. A study can override them per body.

## Appearance without a material

`model.appearance(...)` sets only how the part or some bodies look. It is a statement like
`model.material` (no id, the same `bodies=` rule, the last call for a body wins) but never gives a
density: mass, simulation and machining don't see it.

```python
model.appearance(color="#1c1c1e", finish="matte")                                # the whole part
model.appearance(color="#9ec5e8", opacity=0.35, roughness=0.05, bodies=["canopy"])  # glazing
model.appearance(color="#c0c4c8", metalness=1, roughness=0.3, bodies=["inlet_cone"])
```

- `color` hex; `finish` a finish id from the list above (any finish, whatever the material);
  `opacity`, `roughness`, `metalness` numbers from 0 to 1. Give at least one.
- Use `appearance` for presentation: paint, glazing, colours of proxy, concept or exterior geometry
  whose inside isn't modelled. Use `material` only when the physical material is meant: it sets the
  mass and the simulation inputs. Never assign a material just to get a colour or see-through look.
- Both on one body: the appearance wins for every field it sets, the material still gives the mass.
- The build reports each body's `appearance`, and `modeling.appearances.problems` (unknown bodies).
  STEP exports and inspection views take the appearance colour.

### Some faces of a body

`faces=` gives some faces of a body their own look: bands, trims, the inner and outer sides of a
door, a rim detail. Geometry, solids, mass and simulation don't change, so **never split a valid
solid just to colour part of it**.

```python
model.appearance(color="#c8102e", finish="painted", faces=["strut.side_faces"])     # a red band
model.appearance(color="#2b2b2b", finish="matte", faces=["door.start", "door_lip.faces"])
inner = ["door.end", "select(faces, '<Y', on='door')"]                               # a named face set
model.appearance(color="#e8e8e0", faces=inner)
```

- `faces=` takes what `faces()` takes: one reference or a list. Use stable references (a feature's
  named faces such as `extrude_1.end`, `<id>.side_faces`, `<id>.faces`, or `select(...)`), not
  numbered `.face(<n>)` ones, which renumber when the geometry changes. A named face set is a Python
  list of references in a variable.
- References resolve on the finished model at every build, so the look follows the geometry. Write
  the statement after the features that make the faces, before `result = model.result()`.
- A face's look wins over its body's, a body's over the part's; for one face the last call wins. A
  face look replaces the body's look for that face (give every field it needs). Not with `bodies=`.
- The build reports each body's `face_appearances` (`[{faces: [indices], color, …}]`). A reference
  that names no face now is in `modeling.appearances.problems`; the build still succeeds. STEP
  exports carry face colours.

## Decals (images on faces)

A decal shows an image on a part's faces: a logo, a label, a screen, markings on a curved skin. It is a
feature (id first) but appearance only: geometry, mass and exports (STEP, STL) don't change.

```python
model.decal("logo", image="img_3fa2b9c41d07", on="extrude_1.end", width=40)   # height follows the image
model.decal("screen", image="img_9c0e41aa2b10", on="extrude_1.end", width=60, height=34, at=(10, 0), rotation=90)
# Curved or several faces: projected onto the faces turned toward it.
model.decal("roundel", image="img_51c0de7a9e22", on="tank.side", width=30)
model.decal("marking", image="img_7d2a90b3c5e1", on="fuselage.side_faces", width=120, height=20,
            at=(300, 0, 45), direction=(0, 0, 1), depth=30)
# Wrapped: follows the skin like a vinyl sticker, keeping its size where the surface curves away.
model.decal("walkway", image="img_7d2a90b3c5e1", on="fuselage.side_faces", width=400, height=40,
            at=(300, 0, 45), rotation=90, wrap=True)
```

- `image` is an uploaded image's id. `list_decal_images` lists the workspace's images. STEVE in the app
  adds an image the person attached in chat with `add_decal_image(attachment_id)` (the id in the image's
  label). An agent outside STEVE uploads a file from its machine with `request_upload` (a .png, .jpg or
  .webp): a one-time upload command whose response carries the id. Never invent ids.
- `on` is one face reference or several (a list, `select(...)`, `"loft_1.side_faces"`), all on one
  body; `rotation` in degrees. Use `inspect_model` to find face names and sizes.
- On **one flat face** the image lies on it: `at` is its centre in that face's sketch coordinates
  (default: the face's centre). Keep the decal inside its face.
- On **curved or several faces** (or with `direction=`/`depth=`) it is projected like a slide projector,
  continuous across seams: `at` is a point (x, y, z) in the part's coordinates on or near the faces,
  snapped onto them (default: the middle of the first face); `direction=(x, y, z)` the side it is seen
  from (default: the surface normal there); `depth` mm how far in front of and behind that point it
  reaches (default: half the image's larger side). Only faces turned toward the projector show it, so it
  never prints through to the far side of a fuselage or tube; it stretches where the surface turns away,
  so keep it on the part of a skin that faces it.
- **Projection or wrap?** Project markings seen from one side (a roundel, a logo, a window, a label on a
  bottle's front). Use `wrap=True` for stripes, bands, serial numbers and text that run round a body or
  along a curving skin: the image is laid along the surface, so a 400 mm stripe covers 400 mm of skin and
  keeps its height, where a projection would stretch it as the skin turns away. `at`, `rotation` and
  `direction` mean the same as for projection (the image's x starts tangent to the surface); `depth`
  doesn't apply (it is an error). A wrap can't go further round than the body's circumference.
- A cylinder or a cone carries any wrap without distortion. A large wrap on a doubly curved patch (a
  sphere, a nose cone's tip, a blended corner) must stretch toward its edges; the feature then builds with
  a warning saying so. Make it smaller or move it to a flatter part of the skin if that matters.
- The faces resolve again on the finished model at every build, like `model.appearance(faces=...)`;
  the feature's detail reports the body and its face indices. A reference that names no face is an
  error on the decal (by its name). Put decals after the features that make their faces.

## Choosing a material

- State the trade-offs: strength, stiffness, density, corrosion, machinability or printability,
  cost and finish.
- Library properties are typical values with sources, not certified minima. For safety-relevant
  choices, say the supplier's data sheet governs.
