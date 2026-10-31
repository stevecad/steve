---
name: steve-standard-parts
description: >-
  Off-the-shelf parts (bearings, screws, nuts, washers, motors, connectors, pulleys, gears, extrusions, electronics) from the step.parts catalog (find_standard_parts, insert_standard_part) and McMaster-Carr parts the user downloaded (list_mcmaster_parts, insert_mcmaster_part), and declared fasteners (design.fasten: screw fit, hole sizes, thread engagement, bottoming, walls, screwdriver access in assembly order, BOM). Load before modelling any bought-in part, when a placeholder should become the real one, and before joining parts with screws or checking them.
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



# Standard parts

Adapted from the text-to-cad `step-parts` skill (github.com/earthtojake/text-to-cad, MIT). The parts are
open-source STEP models from step.parts (github.com/earthtojake/step.parts, MIT licensed).

Bought-in parts should be the real thing, not a hand-made look-alike: a 608 bearing, an M3×10 socket
head screw, a NEMA 17 motor, a GT2 pulley or 2020 extrusion has exact dimensions and mounting features
that a placeholder gets wrong.

## Find before you model

1. **Search first.** Before modelling a bearing, fastener, motor, connector, actuator, pulley, gear,
   extrusion or board, call `find_standard_parts` with the designation as people write it: `608 bearing`,
   `M3 socket head 10`, `NEMA 17`, `GT2 20 tooth pulley`, `2020 extrusion`.
2. **Retry before giving up.** When nothing matches, try the aliases and vendor spellings: drop the
   vendor prefix or suffix (`608ZZ` → `608`), split the model number (`17HS4401` → `NEMA 17`), use the
   standard (`ISO 4762 M3`, `DIN 912`), or narrow with a `category` / `family` from a result's facets.
3. **Match exactly.** Insert a part only when its key dimensions match what was asked for: thread and
   length for screws, bore, outside diameter and width for bearings, frame size for motors, tooth count and
   bore for pulleys. Near-exact is acceptable only when you say what differs. If nothing fits, model a
   placeholder and say that no catalog part matched.
4. **Don't replace on a guess.** Swap a placeholder for a catalog part only on an exact or near-exact
   match, and keep the placeholder otherwise.

## Insert

- `insert_standard_part(document_id, revision, part_id)`:
  - **Part:** it becomes `model.import_step(...)` in the catalog file's own coordinates. Pass `at=` and a
    `model.move(...)` after it places it.
  - **Design:** it becomes a component (`components/<id>.py`) placed with `design.add(<id>, at=...)`.
    Pass `at=` to place it. Inserting the same part again adds another instance, which suits four screws
    or two bearings.
  - `at` is `[x, y, z]` in mm, or `[[x, y, z], [axis, degrees]]` to turn the part about its own origin
    first. Catalog screws point along +Z: `at=[[0, 20, 5], ["Y", 90]]` lays one along +X.
- The tool returns the new revision. Call `generate_model`, then `inspect_model` to check where it sits.
  Its faces are named in file order, as for any STEP import (load `steve-step-import` to add features to it).
- A comment above the import records the catalog id, its page, the license and the file's sha256. Leave it.

## Declare the screws that join parts

In a design, a screw that joins parts is declared in `main.py`, not just placed. Every build then
measures it on the geometry as built:

```python
design.fasten("m3_1", "ISO 4762 M3x8",
              axis=bracket.face("bolt_hole.wall(0)"),       # a hole wall or circular edge
              head_on=bracket.face("extrude_1.end"),        # the face the head rests on: sets the direction
              clamps=["bracket"], into="motor_horn",        # instances, head side first
              thread="thread_forming")                      # tapped | thread_forming | insert | nut
```

- **Screws:** ISO 4762 (DIN 912), ISO 7380, ISO 10642 (DIN 7991), ISO 4017 (DIN 933) and ISO 7045,
  from M2 to M12. A countersunk head sits flush in its `head_on` face.
- **Options:** `washer=True`, `fit="close"|"normal"|"loose"` (ISO 273 clearance holes), `through=True`
  when the tip may come out the far side. `thread="insert"` takes the standard heat-set insert, or
  `insert=(bore_mm, length_mm)` from its datasheet. A `"nut"` sits on the far side and takes no `into`.
- **Several holes:** `design.fasten_pattern("flange", "ISO 4762 M4x12", axes=[...], head_on=..., clamps=...,
  into=...)` declares `flange_1`, `flange_2`, … from a list of axes.
- **Holes:** each fastener's result has `holes`, the `hole(...)` arguments each part wants (clearance,
  counterbore or countersink on the seat part, tap drill, pilot or insert bore, depth). Write them as
  ordinary `hole` features in that part's component file; they are then checked like any hole.
- **Screwdriver access:** `design.assembly_steps([("frame", ["base", "frame"]), ("arm", ["bracket",
  "motor_*"])])` gives the order parts go in. Each fastener is then driven at its `step=` (default: the
  step of its last part), past everything installed by then; the screw must also go in along its axis.
  `driver="hex_2.5"`, `"ph2"`, `"socket_7"` or `design.tool(...)` picks the tool.
- **A placed catalog screw:** pass `instance="screw_m3_1"`. That instance isn't counted as a clash, and the
  BOM lists the screw once.
- **Rules:** `design.fastener_rules(min_wall_mm=2.0, min_engagement_d=2.0, ...)` overrides the generic
  limits for the whole design, and `rules={...}` overrides them for one fastener. Change a rule only for
  the person's hardware or printer data, never to make a check pass.

After `generate_model`, call `inspect_model(document_id, checks=["fasteners"])`, or pass
`options={"fastener": "m3_*"}` to see only some. Each fastener is `fail`, `review`, `pass` or
`unchecked`:
- Each finding has a `code`: through_hole, head_seat, head_proud, engagement, bottoming, breakthrough,
  pilot, tapped_hole, insert_bore, wall, head_clash, screw_clash, screw_screw, driver_access or
  insertion.
- A finding also gives the part, its faces, the `measured` value against the `limit`, and witness points.
- `measured.suggested_length_mm` is a standard length that would pass.

Fix the geometry or pick another screw, then check again. Not checked: preload, torque, thread strength
beyond the engagement rule, captive nuts and tilted (ball-end) drivers. Say so when they matter.

## Tell the person

Name what you inserted with its catalog id and link, for example: "608ZZ ball bearing (`bearing_608zz`,
https://www.step.parts/…)". Give the key dimensions you matched. Say when a part is a simplified
envelope: the catalog marks some as `geometryRepresentation: analytic simplified` and some families as
"envelope". If the catalog is unreachable, the tool says so. Model a clearly named placeholder and offer
to swap it in later.

## McMaster-Carr parts

McMaster-Carr has no open API and its site is the user's to browse, so **you never download from
McMaster**. The user downloads a part's 3-D STEP in their own browser and drops it into STEVE
(Parts → McMaster-Carr); it is then checked and kept by part number for reuse.

- When the user names a McMaster part number (`91251A540`) or asks for "the McMaster one", call
  `list_mcmaster_parts` (optionally with a search) to see what they already have.
- **In the list:** `insert_mcmaster_part(document_id, revision, part_number, at=…)`. It works like
  `insert_standard_part`: an import in a part, a component `mcmaster_<number>` in a design.
- **Not in the list:** give the user the product page, `https://www.mcmaster.com/<part number>`, and
  ask them to download the 3-D STEP and drop it into STEVE. Then stop and wait for them. Don't model a
  look-alike in its place unless they ask for a placeholder.
- Never say you downloaded, fetched or looked up a McMaster part, and never invent part numbers. If
  the user wants a suggestion, describe what to search for on McMaster (type, size, material).
- A comment above the import keeps the part number, its page and the file's sha256. Leave it.
