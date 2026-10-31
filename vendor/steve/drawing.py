"""Engineering drawings as code: a sheet of orthographic views, a title block, revision table, parts list and cut list.

    from steve.drawing import Drawing
    Drawing(result, standard="ISO", sheet="A3", fields={"number": "BRK-001", "material": "6061-T6"},
            revisions=[{"rev": "A", "description": "First release", "date": "2026-10-07", "by": "JS"}])

Each `Drawing(...)` in a part's or design's code is one sheet. Full builds project its views with Open CASCADE's exact
hidden-line removal (HLRBRep) at a standard scale and write drawing.svg (the first sheet, to view and print to PDF)
and drawings.zip (every sheet as SVG and DXF, and its tables as CSV). ISO sheets use first-angle projection, ISO 5457
sheet sizes and borders and an ISO 7200-style title block; ANSI sheets use third-angle projection and ASME Y14.1 sheet
sizes. Overall dimensions are automatic. Feature dimensions attach to the model's persistent face, edge and vertex
names and take their values from the model's exact geometry, never from the projected lines, so they follow the
design as it changes; one whose geometry is gone is reported, never moved onto other geometry. GD&T datum feature
symbols and feature control frames attach the same way, to named geometry or to a feature dimension. Views form a
tree: section views (cut through named geometry, the cut faces hatched) and detail views (a circled region, larger)
hang off a parent view and follow its scale and position; one whose geometry is gone is reported, never moved.
Item balloons point at a design's placed instances and take their numbers from the sheet's own parts list, so the two
always agree; hole tables tag a view's holes and list their position, size, depth and thread, read from the model's
hole features.
Everything on the sheet comes from the code, so a drawing has the design's history, branches and revisions.
"""
from __future__ import annotations

import contextlib
import csv
import hashlib
import io
import json
import math
import os
import re
import sys
import time
import zipfile
from pathlib import Path
from decimal import ROUND_HALF_UP, Decimal
from xml.sax.saxutils import escape, quoteattr

from . import images
from .iso286 import FIT, deviations as fit_deviations

SHEETS: list["Drawing"] = []  # Declared by the code being built, in order (sheet 1 first).

# Landscape (width, height) in mm: ISO 216 A sizes and ASME Y14.1 letter sizes.
SIZES = {"A4": (297, 210), "A3": (420, 297), "A2": (594, 420), "A1": (841, 594), "A0": (1189, 841),
         "A": (279.4, 215.9), "B": (431.8, 279.4), "C": (558.8, 431.8), "D": (863.6, 558.8), "E": (1117.6, 863.6)}
STANDARDS = {
    # Line widths per ISO 128-20 / ASME Y14.2 (mm); text heights per ISO 3098 / ASME Y14.2.
    "ISO": dict(projection="first", sheet="A3", units="mm", text=3.5, small=2.5, visible=0.5, hidden=0.35, thin=0.25),
    "ANSI": dict(projection="third", sheet="B", units="in", text=3.2, small=2.4, visible=0.6, hidden=0.3, thin=0.3),
}
# (towards the viewer, paper x) per view; paper y is their cross product.
VIEWS = {"front": ((0, -1, 0), (1, 0, 0)), "back": ((0, 1, 0), (-1, 0, 0)), "top": ((0, 0, 1), (1, 0, 0)),
         "bottom": ((0, 0, -1), (1, 0, 0)), "right": ((1, 0, 0), (0, 1, 0)), "left": ((-1, 0, 0), (0, -1, 0)),
         "iso": ((1, -1, 1), (1, 1, 0))}
# The sheet's master is its front view (ISO 5456-2's principal view): front=(the model side that faces the viewer, the
# side that's up on the paper). Every other view is projected from it, so "top" is the view from above the master.
# Each model side's direction towards the viewer; a side alone (front="top") is up as its own view has it.
MODEL_SIDES = {name: VIEWS[name][0] for name in ("front", "back", "top", "bottom", "left", "right")}
SIDE_UP = {"front": "top", "back": "top", "top": "back", "bottom": "front", "left": "top", "right": "top"}
# (column, row) around the front view; row +1 is above it. ISO 5456-2 first angle mirrors third angle.
GRID = {"third": {"front": (0, 0), "top": (0, 1), "bottom": (0, -1), "right": (1, 0), "left": (-1, 0), "back": (2, 0), "iso": (1, 1)},
        "first": {"front": (0, 0), "top": (0, -1), "bottom": (0, 1), "right": (-1, 0), "left": (1, 0), "back": (2, 0), "iso": (1, 1)}}
# Preferred scales (ISO 5455), largest first.
SCALES = [(50, 1), (20, 1), (10, 1), (5, 1), (2, 1), (1, 1), (1, 2), (1, 5), (1, 10), (1, 20), (1, 50), (1, 100), (1, 200),
          (1, 500), (1, 1000)]
FIELDS = {"number": "DRAWING NO.", "owner": "OWNER", "drawn_by": "DRAWN", "checked_by": "CHECKED", "approved_by": "APPROVED",
          "date": "DATE", "material": "MATERIAL", "finish": "FINISH", "tolerances": "GENERAL TOLERANCES"}
GAP = 15.0  # mm of paper between views
DIM_SPACE = 16.0  # mm of paper a view keeps below and to its right for its overall dimensions
TITLE_WIDTH = 180.0  # ISO 7200's largest title block; the tables above it share its width
TEXT_LIMIT = 200
# A sheet's own title block layout (title_block=): rows of cells, bottom row first, in place of the ISO 7200 one. A
# cell shows a field (one of `fields`, or one of TITLE_VALUES the sheet fills in), fixed text, or is left blank.
TITLE_ROWS, TITLE_CELLS = 12, 12
TITLE_ROW_KEYS = ("height", "cells")
TITLE_CELL_KEYS = ("width", "label", "field", "text", "text_height", "label_height", "rows", "align", "valign", "label_align",
                   "label_valign", "image", "padding", "bold", "label_bold")
# A cell may draw a logo instead of a value (image: one of the design's .png or .jpg files beside main.py,
# steve/images.py), scaled to fit inside its padding (mm) with its aspect kept; at most TITLE_IMAGES such cells a sheet.
TITLE_IMAGES, TITLE_PADDING = 4, 1.0
# A cell's text (or label) across it: left, centre or right; and up it: top, middle or bottom. Fixed text is a line, or a
# list of up to TITLE_LINES lines.
TITLE_ALIGN = {"left": "start", "centre": "middle", "center": "middle", "right": "end"}
TITLE_VALIGN = ("top", "middle", "bottom")
TITLE_LINES = 12
TITLE_MIN_HEIGHT = 2.5  # mm: a 3.2 mm strip of a company sheet
TITLE_VALUES = {"title": "TITLE", "revision": "REV", "scale": "SCALE", "sheet": "SHEET", "size": "SIZE", "units": "UNITS",
                "projection": ""}  # projection is the ISO 5456-2 symbol
TITLE_FIELD = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,39}")
TITLE_MIN_WIDTH = 60.0  # The parts list, cut list, hole tables and revisions above it take its width.
# Feature dimensions: what they measure, what they accept, and how they stack outside their view (paper mm).
DIMENSION_KINDS = {"distance": 2, "length": 1, "diameter": 1, "radius": 1, "angle": 2}
DIMENSION_KEYS = ("view", "refs", "kind", "direction", "tolerance", "fit", "fit_shows", "display", "precision", "prefix", "suffix",
                  "text", "offset", "side", "text_at", "id", "ends", "dual", "dual_precision")
DIRECTIONS = ("auto", "horizontal", "vertical", "aligned")
ENDS = ("centre", "inside", "outside")  # Where a distance ends on round wire or tube: its axis, or its near or far side
DISPLAYS = ("value", "basic", "reference", "limits")
FIT_SHOWS = ("class", "deviations", "limits")  # An ISO 286 fit's text: H7, H7 (+0.018/0), or its limits and (H7)
FIRST_SLOT = 10.0  # from the view's outline to its first dimension line
SLOT = 8.0  # between stacked dimension lines
# Where a dimension goes (`side`): horizontal ones above or below their view, vertical ones left or right of it,
# aligned ones out from the view's middle or in, and leaders towards a quadrant. The first of each is the default.
QUADRANTS = {"up-right": (1, 1), "up-left": (-1, 1), "down-right": (1, -1), "down-left": (-1, -1)}
SIDES = ("above", "below", "left", "right", "out", "in", *QUADRANTS)
TEXT_AT = ("centre", "start", "end")  # or paper mm along the line from its middle, towards its end
GLYPHS = {"⌀": "%%c", "±": "%%p", "°": "%%d"}  # DXF text codes for the symbols dimensions use
DIMENSION_ID = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,39}")
# GD&T (ASME Y14.5-2018, ISO 1101:2017): each geometric characteristic's type. Concentricity, coaxiality and symmetry
# are ISO's only: ASME Y14.5-2018 dropped them (position, profile or runout do their work).
CHARACTERISTICS = {"straightness": "form", "flatness": "form", "circularity": "form", "cylindricity": "form",
                   "profile_line": "profile", "profile_surface": "profile", "angularity": "orientation",
                   "perpendicularity": "orientation", "parallelism": "orientation", "position": "location",
                   "concentricity": "location", "coaxiality": "location", "symmetry": "location",
                   "circular_runout": "runout", "total_runout": "runout"}
ISO_ONLY = ("concentricity", "coaxiality", "symmetry")
NEEDS_DATUM = ("orientation", "runout", "concentricity", "coaxiality", "symmetry")
DIAMETER_ZONE = ("straightness", "angularity", "perpendicularity", "parallelism", "position", "concentricity", "coaxiality")
NO_MATERIAL = ("circularity", "cylindricity", "profile_line", "profile_surface", "circular_runout", "total_runout")
MATERIAL = {"MMC": "M", "LMC": "L"}  # Ⓜ and Ⓛ: at maximum or least material condition (ASME: boundary, on datums)
ZONE_MODIFIERS = {"free_state": "F", "tangent_plane": "T", "continuous_zone": "CZ"}  # Ⓕ, Ⓣ, and CZ uncircled
DATUM_KEYS = ("label", "view", "ref", "dimension", "offset")
FRAME_KEYS = ("view", "ref", "dimension", "characteristic", "tolerance", "zone", "modifier", "projected", "modifiers",
              "datums", "offset")
# The view tree: base views with their own settings, and section and detail views hanging off a parent view.
VIEW_KEYS = ("view", "scale", "hidden", "shaded", "at", "position")
# A sheet-metal body's flat pattern: the blank the sheet-metal export's DXF cuts (sheetmetal/export.py pattern()), seen
# from above in its material plane as the DXF has it, never projected from the master; its bend lines thin chain lines,
# each bend noted (UP 90° R2). Placed like the iso view, outside the projection grid.
FLAT = "flat"
FLAT_KEYS = ("view", "body", "scale", "at", "position")
FLAT_FRAME = ((0, 0, 1), (1, 0, 0))
SECTION_KEYS = ("name", "parent", "through", "direction", "flip", "scale", "hidden", "at", "position")
DETAIL_KEYS = ("name", "parent", "centre", "radius", "scale", "at", "position")
VIEW_NAME = re.compile(r"[A-Z]{1,2}")
# Section hatching (ISO 128-50): thin lines at 45°, alternating direction and then spacing (paper mm) per solid, so
# adjacent parts differ.
HATCHES = ((45.0, 2.5), (135.0, 2.5), (45.0, 1.5), (135.0, 1.5))
# Shaded views: flat grey faces under the view's lines, lit from over the viewer's shoulder, in SHADES levels from
# SHADE_LIGHT to SHADE_DARK (0-255 grey); meshed to SHADE_DEFLECTION mm on the paper of the largest shaded view.
SHADES, SHADE_LIGHT, SHADE_DARK, SHADE_DEFLECTION = 6, 0xf0, 0xa0, 0.1
LABEL_SPACE = 8.0  # mm of paper under a view for its label (SECTION A-A, DETAIL B (2:1), SCALE 1:2)
# Item balloons (ISO 6433, ASME Y14.34): on a placed instance, numbered from the parts list; outward from their view
# (side: straight above, below, left or right of it, or towards a quadrant), offset paper mm past its outline.
BALLOON_KEYS = ("instance", "view", "side", "offset")
NOTE_KEYS = ("text", "at", "view", "ref", "side", "offset")  # A note with `at` is placed there on the sheet; the others are listed, numbered
# Leader notes (ASME Y14.2's local notes, ISO 128-22's leader lines): FLUSH, TYP and the like on a leader to one edge,
# face or vertex in a view (a dot on a face seen face-on, else an arrowhead), ending in a short horizontal shoulder
# the text is written beside. Placed like balloons (side, offset paper mm past the view), or `at` (dx, dy) paper mm from
# the leader's tip to its shoulder.
NOTE_OFFSET, NOTE_SHOULDER = 10.0, 3.0
# Annotations placed with no offset (datums and frames on geometry, balloons, leader notes, weld symbols) go further
# out, a step at a time and at most this many, until they're clear of what's on the sheet (_Room).
OUT_STEPS = 40
CLEAR_STEP = 1.0  # mm: how finely one moved out past what's in the way looks for the nearest clear place
BALLOON_SIDES = ("above", "below", "left", "right", *QUADRANTS)
BALLOON_OFFSET = 10.0
# Weld symbols (AWS A2.4 on ANSI sheets, ISO 2553 system A on ISO ones): arrows (one per ref) to the joint in a view,
# meeting at one end of a horizontal reference line that carries the symbol on the arrow side, the other side or both.
# Placed like balloons (place, offset paper mm past the view), or `at` (dx, dy) paper mm from the first arrow's tip.
# Instead of refs, a weld may name its joint (two bodies or instances: an arrow to each place they touch, or the ones
# `places` picks) or its modelled bead (a body or instance), found again each build so the symbol follows the design.
WELD_KEYS = ("view", "refs", "type", "side", "size", "leg", "length", "pitch", "all_around", "field", "tail", "place",
             "offset", "at", "joint", "bead", "places", "throat", "root_opening", "angle", "contour", "finish")
JOINT_POINTS = 16  # The most distinct closest points a joint's contact places are grouped from.
# Groove (butt) welds: flare_v and flare_bevel where a round wire or tube meets another or a flat. Each may be on the
# arrow side, the other side or both (a double V, ISO's X; a double bevel, K; double U, J and flares).
WELD_GROOVES = ("square", "v", "bevel", "u", "j", "flare_v", "flare_bevel")
WELD_TYPES = ("fillet", "plug", "slot", "spot", *WELD_GROOVES)
WELD_SIDES = {"fillet": ("arrow", "other", "both"), "plug": ("arrow", "other"), "slot": ("arrow", "other"),
              "spot": ("centre", "arrow", "other"),  # The first is the default: a spot weld centred on the line.
              **{kind: ("arrow", "other", "both") for kind in WELD_GROOVES}}
WELD_ANGLED = ("v", "bevel", "u", "j")  # The grooves with a groove angle (a square groove or a flare has none).
WELD_CONTOURS = ("flush", "convex", "concave")
WELD_FINISHES = ("C", "G", "H", "M", "P", "R", "U")  # AWS A2.4: chipping, grinding, hammering, machining, planishing, rolling, unspecified.
WELD_LEADERS, WELD_OFFSET = 8, 12.0
# Hole tables (ASME Y14.5's hole charts): the view, its holes (hole features' ids, their walls, or selectors) and the
# origin positions are measured from. Columns fill TITLE_WIDTH (or a title_block's width).
HOLE_TABLE_KEYS = ("view", "holes", "origin")
HOLE_WALL = re.compile(r"([a-z][a-z0-9_]*)\.wall\((\d+)\)")
HOLE_ID = re.compile(r"[a-z][a-z0-9_]*")
HOLE_WIDTHS = [14, 24, 24, 24, 22, 72]


def _text(value, what: str) -> str:
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        raise ValueError(f"Drawing: {what} must be text, not {value!r}.")
    text = re.sub(r"[\x00-\x1f\x7f]+", " ", str(value)).strip()  # One line, and nothing XML can't carry.
    if len(text) > TEXT_LIMIT:
        raise ValueError(f"Drawing: {what} is longer than {TEXT_LIMIT} characters.")
    return text


class Drawing:
    """One drawing sheet of `source` (a part's or design's `result`, a Component, a linked part or design, or a CadQuery shape or
    Workplane).

    standard: "ISO" (first-angle, mm) or "ANSI" (third-angle, inches; "ASME" too). projection: "first" or "third"
    to differ from the standard's. sheet: A4–A0 or A–E (default A3 or B); orientation "landscape" or "portrait".
    views: any of front, top, right, left, bottom, back, iso; each a name, or a dict of view and its own scale,
    hidden, shaded and at (a paper offset in mm, (dx, dy), that moves it and its section and detail views) or position
    (its centre on the sheet, (x, y) paper mm from the lower-left corner, as a placed note's at: it stays there whatever
    the other views and the annotations do; needs scale=); default
    front, top, right and iso. Also flat: a sheet-metal body's flat pattern, the very blank its DXF cuts, seen from
    above in its material plane with its bend lines (thin chain lines, each noted like UP 90° R2) and, with
    dimensions, its overall size; a name, or a dict of view, body (which sheet-metal body: its id on a part's sheet,
    "<instance>:<body>" on a design's; needed only when there are several), scale, at and position. It isn't projected
    from the master, and one that can't be made is reported (view_problems), never drawn from other geometry. It takes
    feature dimensions (view "flat") to its blank, by the body's own names: its edges (sides seen edge-on, like
    base.side(r.left)), holes, and each bend's centre line as drawn, <flange>.bend.line (where a shop marks the bend);
    no other annotations. front: the master (front) view's orientation, (facing, up): the model side it shows
    (front, back, top, bottom, left or right) and the side up on the paper (one next to it), or a side alone with its
    own view's up; default ("front", "top"). The other views are projected from it: top is the view from above it,
    right from its right, and so on, laid out by the projection method. views=[] is a blank sheet: its border, title block, tables and notes, ready for views
    to be added (no section or detail views until then). scale:
    (1, 2) for 1:2, or a number; default the largest preferred scale that fits (a blank sheet's title block shows
    scale= only when given). hidden: dashed hidden lines in the
    orthographic views (the iso view has them only when its own hidden is True). shaded: grey shaded faces under the
    views' lines (a view's own shaded overrides it; detail views take their parent's; section views aren't shaded; DXF
    keeps the lines only). section_views: dicts of name ("A"), parent (a view, or an earlier section), through (a persistent name, or
    a model point (x, y, z)) where the cutting plane goes, and optionally direction (of the cutting line on the parent:
    horizontal or vertical), flip (look the other way), scale, hidden, and at (from beside its parent, wherever that
    is) or position. detail_views: dicts of name, parent,
    centre (as through), radius (model mm), and optionally scale (default twice the parent's), and at or position. Child views
    take their parent's scale, alignment and style unless they set their own. dimensions: overall
    dimensions of each orthographic view. units: "mm" or "in" for dimension text. dual_units: the other unit ("in" on
    a mm sheet, "mm" on an inch one) shown in brackets after each length, its overall dimensions' too (ASME Y14.5 dual
    dimensioning: 3.937 [100]), following the model; dual_precision: its decimal places (default as that unit's own
    values are written). Angles, text= overrides, hole tables, welds, tolerance frames and bend notes stay in the
    sheet's units. title, fields (number, owner,
    drawn_by, checked_by, approved_by, date, material, finish, tolerances, revision and sheet (in place of the latest
    revision's letter and the automatic n/m, like "1 OF 2"), and any other label: value), title_block (a
    title block of the sheet's own in place of the ISO 7200 one: rows, bottom row first, each a dict of height (mm)
    and cells, each cell a dict of width (mm) and optionally label, field (a fields key, or title, revision, scale,
    sheet, size, units or projection, which the sheet fills in; its label defaults to the field's, "" for none), text
    (fixed text instead of a field: a line, or a list of up to 12), text_height and label_height (mm), rows (how many
    rows it spans upward, as one box; the rows above place their cells past it), align and label_align (left, centre,
    right) and valign and label_valign (top, middle, bottom), bold and label_bold (True: its value or text, or its
    label, in bold), or image (a logo instead of a field or text: one of the
    design's .png or .jpg files beside main.py, at most 512 KB and 4096 px a side, scaled to fit the cell with its aspect
    kept, placed by align and valign) with padding (mm, default 1); up to 12 rows (2.5 mm or more) of 12 cells, up to 4
    of them images. Its width is
    its widest row's, a shorter row's last cell stretched to it; the tables above it take that width), revisions
    (dicts of rev, description, date, by), bom (True, False or rows of name, quantity, description; default True for
    designs), cut_list (True: each body's bounding size, per component), notes (lines, numbered; or a dict of text and at,
    the paper point in mm from the sheet's lower-left corner where that note is written instead; or a leader note, a
    dict of text, view and ref (one edge, face or vertex, as a weld's refs): a leader from it to the text, for FLUSH,
    TYP and the like, placed by side (a quadrant like up-left; default out from the view's middle) and offset (paper mm
    past the view), or at ((dx, dy) paper mm from the leader's tip to its shoulder); a ref that's gone is reported as
    dangling).
    feature_dimensions: dicts of view, refs (one or two persistent names: faces, edges, vertices, or select(...); or
    for a distance, a virtual sharp: sharp(a|b), where two straight edges or flat faces seen edge-on would meet over
    the bend between them, drawn with thin lines running on to it; a straight of round wire or tube is named by its
    face, like wire.along(p.side0), its axis being the line), and optionally kind (distance, length, diameter, radius, angle; inferred when left out), direction (horizontal,
    vertical, aligned), ends (a distance's end on round wire or tube, one per ref or one for both: centre, the
    default, at its axis; outside or inside, at the tangent of its far or near side from the other end, as wire is
    gauged: a straight's or a bend's face, or a circular edge; on a virtual sharp of two straights' faces, where the
    outsides or insides of the wire would meet), tolerance (0.1 for ±0.1, or (upper, lower) in the sheet's units) or fit (an ISO 286
    tolerance class: "H7" for a hole, "g6" for a shaft; its limits come from ISO 286's tables for the nominal size)
    with fit_shows (class, deviations or limits; default class, limits on inch sheets), display (basic,
    reference, limits), precision (decimal places), dual (False: no bracketed second unit on this one) and
    dual_precision (the bracketed value's decimal places, over the sheet's; both ignored without dual_units), prefix, suffix, text (replaces the measured value; reported),
    and where it's placed: offset (paper mm from the view to the dimension line; a leader's reach; an angle's
    radius), side (above or below, left or right, out or in, or a leader's up-right, up-left, down-right or
    down-left) and text_at (centre, start, end, or paper mm along the line from its middle); id names it for datums and
    tolerance frames to attach to.
    datums (GD&T datum feature symbols): dicts of label ("A"), and ref (one persistent face or edge name, or a
    select(...)) with view, or dimension (a feature dimension's id: its feature of size); optionally offset.
    tolerance_frames (feature control frames): dicts of characteristic (straightness, flatness, circularity,
    cylindricity, profile_line, profile_surface, angularity, perpendicularity, parallelism, position, circular_runout,
    total_runout; ISO also concentricity, coaxiality, symmetry), tolerance (the zone's size in the sheet's units),
    ref with view or dimension (as datums), and optionally zone ("diameter"), modifier (MMC or LMC), datums (up to three
    labels defined on this sheet, primary first, each "A" or ("A", "MMC")), projected (Ⓟ's height), modifiers
    (free_state, tangent_plane, continuous_zone) and offset.
    balloons (a design's result): True for one per parts list item, or dicts of instance (a placed instance's name),
    and optionally view (default: the first base view that shows it; a section's or detail's name too), side (above, below, left, right, or a quadrant like
    up-right; default straight out from the view's middle) and offset (paper mm past the view). Each balloon's number
    is its item's in the sheet's parts list.
    hole_tables: dicts of view, and optionally holes (hole features' ids, holes' walls like "hole_1.wall(0)", or
    select(...) on plain CadQuery; default every hole feature that shows round there) and origin (as a section's
    through; default the view's lower-left corner). Each hole is tagged in the view and listed with its position,
    diameter, depth, counterbore or countersink, and thread (a hole's thread=).
    welds (weld symbols: AWS A2.4 on ANSI sheets, ISO 2553 system A on ISO ones): dicts of type (fillet, plug, slot,
    spot, or the groove welds square, v, bevel, u, j, flare_v and flare_bevel), refs (1 to 8 of the joint's edges, faces
    or vertices: an arrow to each, meeting at the reference line) and view, and optionally side (arrow, other, or both
    for fillets and grooves; a spot weld is centred on the line by default), size,
    length and pitch (in the sheet's units: AWS 3 15-50, ISO a3 15(50); a plug's or spot weld's size is its diameter, a
    slot's its width, a groove's its depth), throat (a groove's effective throat: AWS 6(5), ISO s5), root_opening (a
    groove's, in the sheet's units), angle (a v, bevel, u or j groove's, in degrees), contour (flush, convex or concave,
    on fillets and grooves) and finish (its letter: C, G, H, M, P, R or U, with a contour), leg (True: a fillet's size
    is its leg, ISO z), all_around, field, tail (the process or a note,
    like "MAG" or "TYP 8 PLACES"), and where it goes: place (above, below, left, right or a quadrant) and offset (paper
    mm past the view), or at ((dx, dy) paper mm from the first arrow's tip). In place of refs, joint (two bodies of a
    part, or two placed instances on a design's result: an arrow to each place they touch, ordered along x, then y,
    then z; places picks some, counted from 0) or bead (a modelled weld bead's body or instance: an arrow to it); they
    follow the design, and a joint whose pieces no longer touch, or a name that's gone, is reported as dangling."""

    def __init__(self, source, *, name=None, standard="ISO", projection=None, sheet=None, orientation="landscape",
                 views=("front", "top", "right", "iso"), front=("front", "top"), scale=None, hidden=True, shaded=False, dimensions=True, units=None, dual_units=None,
                 dual_precision=None, title=None, fields=None, revisions=(), bom=None, cut_list=False, notes=(), feature_dimensions=(), datums=(),
                 tolerance_frames=(), section_views=(), detail_views=(), balloons=(), hole_tables=(), title_block=None,
                 welds=()):
        # What each argument evaluated to, for the Drawing tab to edit one written as a variable or an expression.
        given, unwritable = {}, []
        for key, value in list(locals().items()):
            if key in ("self", "source", "given", "unwritable"):
                continue
            try:
                given[key] = _given(value)
            except _Unwritable:
                unwritable.append(key)
        standard = str(standard).upper()
        standard = "ANSI" if standard == "ASME" else standard
        if standard not in STANDARDS:
            raise ValueError(f"Drawing: standard must be 'ISO' or 'ANSI', not {standard!r}.")
        self.standard, self.style = standard, STANDARDS[standard]
        self.projection = projection or self.style["projection"]
        if self.projection not in GRID:
            raise ValueError(f"Drawing: projection must be 'first' or 'third', not {projection!r}.")
        self.sheet = str(sheet or self.style["sheet"]).upper()
        if self.sheet not in SIZES:
            raise ValueError(f"Drawing: sheet must be one of {', '.join(SIZES)}, not {sheet!r}.")
        if orientation not in ("landscape", "portrait"):
            raise ValueError(f"Drawing: orientation must be 'landscape' or 'portrait', not {orientation!r}.")
        width, height = SIZES[self.sheet]
        self.size = (width, height) if orientation == "landscape" else (height, width)
        self.views, self.view_options = _views(views)
        # Every named view's (towards the viewer, paper x), turned with the master.
        self.front, self.base_frames = _oriented(front)
        self.scale = _scale(scale)
        self.hidden, self.shaded, self.dimensions = bool(hidden), bool(shaded), bool(dimensions)
        self.units = units or self.style["units"]
        if self.units not in ("mm", "in"):
            raise ValueError(f"Drawing: units must be 'mm' or 'in', not {units!r}.")
        other = "in" if self.units == "mm" else "mm"
        if dual_units not in (None, other):
            raise ValueError(f"Drawing: dual_units is the second unit shown in brackets, {other!r} on this "
                             f"{self.units} sheet, or None; not {dual_units!r}.")
        self.dual_units = dual_units
        if dual_precision is not None and (not isinstance(dual_precision, int) or isinstance(dual_precision, bool)
                                           or not 0 <= dual_precision <= 6):
            raise ValueError("Drawing: dual_precision is the bracketed value's decimal places, 0 to 6.")
        self.dual_precision = dual_precision  # Ignored without dual_units, like each dimension's.
        self.shape, self.design, self.model, label = _source(source)
        if FLAT in self.views and self.view_options[FLAT]["body"] is None:
            bodies = list(_sheet_bodies(self))
            if len(bodies) > 1:
                raise ValueError(f"Drawing: the flat view shows one sheet-metal body; this sheet has {len(bodies)} "
                                 f"({', '.join(bodies)}): name it, like {{\"view\": \"flat\", \"body\": \"{bodies[0]}\"}}.")
        self.title =_text(title if title is not None else label or "Untitled", "title")
        self.name = _text(name if name is not None else self.title, "name")
        if fields is not None and not isinstance(fields, dict):
            raise ValueError("Drawing: fields must be a dict like {'number': 'BRK-001', 'material': '6061-T6'}.")
        self.fields = {str(key): _text(value, f"field {key!r}") for key, value in (fields or {}).items()}
        self.title_block = _title_layout(self, title_block)
        # The title block's width, which the tables above it share.
        self.table_width = max(cell["x"] + cell["width"] for row in self.title_block for cell in row["cells"]) if self.title_block else TITLE_WIDTH
        self.revisions = []
        for row in revisions or ():
            if not isinstance(row, dict) or set(row) - {"rev", "description", "date", "by"}:
                raise ValueError("Drawing: each revision is a dict of rev, description, date and by.")
            self.revisions.append({key: _text(row.get(key, ""), f"revision {key}") for key in ("rev", "description", "date", "by")})
        if bom is None:
            bom = self.design is not None
        if isinstance(bom, (list, tuple)):
            self.bom = []
            for row in bom:
                if not isinstance(row, dict) or "name" not in row:
                    raise ValueError("Drawing: bom rows are dicts with name, and optionally quantity and description.")
                self.bom.append({"name": _text(row["name"], "bom name"), "quantity": _text(row.get("quantity", 1), "bom quantity"),
                                 "description": _text(row.get("description", ""), "bom description"), "instances": None})
        elif bom:
            if self.design is None:
                raise ValueError("Drawing: bom=True needs a design's result; give bom rows to list parts yourself.")
            self.bom = [_bom_row(row) for row in self.design.bom(instances=True)]
        else:
            self.bom = None
        self.cut_list = _cut_list(self) if cut_list else None
        # Listed: their text. Placed: (number as written, text, paper point). Leader notes: as _leader_note checks them.
        self.notes, self.placed_notes, leaders = [], [], []
        for index, note in enumerate([notes] if isinstance(notes, str) else notes or ()):
            if not isinstance(note, dict):
                self.notes.append(_text(note, "note"))
                continue
            if set(note) - set(NOTE_KEYS) or "text" not in note:
                raise ValueError(f"Drawing: notes[{index}] is text, or a dict of text and at (where on the sheet, paper mm), "
                                 "or a leader note: a dict of text, view and ref (and optionally side, offset or at).")
            if "ref" in note or "view" in note:  # Checked once the sheet's views are known.
                leaders.append((index, note))
                continue
            if "side" in note or "offset" in note:
                raise ValueError(f"Drawing: notes[{index}]: side and offset place a leader note; give it view and ref too.")
            text, at = _text(note["text"], "note"), note.get("at")
            if at is None:
                self.notes.append(text)
            elif (isinstance(at, (list, tuple)) and len(at) == 2 and all(map(_number, at))
                  and 0 <= at[0] <= self.size[0] and 0 <= at[1] <= self.size[1]):
                self.placed_notes.append((index + 1, text, (float(at[0]), float(at[1]))))
            else:
                raise ValueError(f"Drawing: notes[{index}]: at is a point on the {self.sheet} sheet in paper mm from its "
                                 f"lower-left corner, within {self.size[0]:g} × {self.size[1]:g}.")
        self.children = _children(self, section_views, detail_views)
        # A view placed by position stays put only at a scale the sheet is given (a fitted one changes with the layout).
        positioned = [(view, own["position"]) for view, own in self.view_options.items() if own["position"]]
        positioned += [(child["name"], child["position"]) for child in self.children if child["position"]]
        for view, (x, y) in positioned:
            if not (x <= self.size[0] and y <= self.size[1]):
                raise ValueError(f"Drawing: view {view}'s position is a point on the {self.sheet} sheet in paper mm from its "
                                 f"lower-left corner, within {self.size[0]:g} × {self.size[1]:g}.")
        if positioned and self.scale is None:
            raise ValueError(f"Drawing: view {positioned[0][0]} has a position, so give the sheet its scale (like scale=(1, 2)): "
                             "a fitted scale changes as the views and annotations do.")
        # Every view's (towards the viewer, paper x), by name: the base views' and their section and detail views'.
        # The flat's frame is the blank's material plane, as its DXF: it doesn't turn with the master.
        self.frames = {**{view: FLAT_FRAME if view == FLAT else self.base_frames[view] for view in self.views},
                       **{child["name"]: child["frame"] for child in self.children}}
        self.leader_notes = [_leader_note(self, note, index) for index, note in leaders]
        if isinstance(feature_dimensions, dict):
            feature_dimensions = [feature_dimensions]
        self.feature_dimensions = [_feature_dimension(self, item, index) for index, item in enumerate(feature_dimensions or ())]
        ids = [dim["id"] for dim in self.feature_dimensions if dim["id"]]
        if len(set(ids)) < len(ids):
            raise ValueError(f"Drawing: feature dimension ids are each used once; {sorted({i for i in ids if ids.count(i) > 1})} repeat.")
        if isinstance(datums, dict):
            datums = [datums]
        self.datums = [_datum(self, item, index) for index, item in enumerate(datums or ())]
        labels = [datum["label"] for datum in self.datums]
        if len(set(labels)) < len(labels):
            raise ValueError(f"Drawing: each datum letter is defined once on a sheet; {sorted({label for label in labels if labels.count(label) > 1})} repeat.")
        if isinstance(tolerance_frames, dict):
            tolerance_frames = [tolerance_frames]
        self.tolerance_frames = [_tolerance_frame(self, item, index) for index, item in enumerate(tolerance_frames or ())]
        if balloons is True:
            self.balloons = "all"
        elif balloons is False or balloons is None:
            self.balloons = []
        else:
            items = [balloons] if isinstance(balloons, (str, dict)) else balloons
            if not isinstance(items, (list, tuple)):
                raise ValueError("Drawing: balloons is True (one per parts list item) or a list like [{\"instance\": \"motor_1\"}].")
            self.balloons = [_balloon(self, item, index) for index, item in enumerate(items)]
        if isinstance(hole_tables, (str, dict)):
            hole_tables = [hole_tables]
        self.hole_tables = [_hole_table(self, item, index) for index, item in enumerate(hole_tables or ())]
        if isinstance(welds, dict):
            welds = [welds]
        self.welds = [_weld(self, item, index) for index, item in enumerate(welds or ())]
        self.arguments, self.unwritable, size = {}, unwritable, 0
        for key, value in given.items():
            try:
                value = _written(self, value)
            except ValueError:
                self.unwritable.append(key)
                continue
            size += len(json.dumps(value)) + len(key)
            if size > ARGS_LIMIT:
                self.unwritable.append(key)
                continue
            self.arguments[key] = value
        SHEETS.append(self)


# How much of a sheet's evaluated arguments its report carries (characters of JSON): past it, the rest are left out.
ARGS_LIMIT = 256_000


class _Unwritable(Exception):
    """An argument's value with no plain form (an object, a number that isn't finite)."""


def _given(value, depth: int = 0):
    """An argument's value as plain data (tuples as lists, dicts with text keys), its reference objects kept for
    _written to name once the sheet knows what it draws."""
    if depth > 16:
        raise _Unwritable
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int) or _number(value):
        return value if isinstance(value, int) else float(value)
    if isinstance(value, (list, tuple)):
        return [_given(item, depth + 1) for item in value]
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return {key: _given(item, depth + 1) for key, item in value.items()}
    if getattr(value, "_steve_ref", False):
        return value
    raise _Unwritable


def _written(drawing: "Drawing", value):
    """_given's plain data with each reference object as the name the sheet resolves (raises ValueError as _ref_name)."""
    if isinstance(value, list):
        return [_written(drawing, item) for item in value]
    if isinstance(value, dict):
        return {key: _written(drawing, item) for key, item in value.items()}
    if getattr(value, "_steve_ref", False):
        return _ref_name(drawing, value, "Drawing")
    return value


def _scale(scale):
    if scale is None:
        return None
    if isinstance(scale, (tuple, list)) and len(scale) == 2 and all(isinstance(v, (int, float)) and v > 0 for v in scale):
        return float(scale[0]) / float(scale[1])
    if isinstance(scale, (int, float)) and not isinstance(scale, bool) and scale > 0:
        return float(scale)
    raise ValueError(f"Drawing: scale is (1, 2) for 1:2, (2, 1) for 2:1, or a number; not {scale!r}.")


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _title_layout(drawing: "Drawing", layout) -> list[dict] | None:
    """title_block= as checked: rows (bottom first) of height and cells of width, label, field or text (its lines), text
    and label heights, alignment, an image (read and checked: steve/images.py) and its padding, and the rows each
    spans upward, placed left to right past the cells spanning up into
    their row (x: from the block's left); each row as wide as the widest (its last cell stretched); None for the ISO
    7200 block. Problems name the row and cell, never what's written in them."""
    if layout is None:
        return None
    w, h = drawing.size
    left = 20.0 if drawing.standard == "ISO" else (12.7 if max(w, h) > 450 else 10.0)  # As _frame draws the border.
    margin = 10.0 if drawing.standard == "ISO" else left
    room_w, room_h = w - left - margin, h - 2 * margin
    shape = ('title_block is a list of rows, bottom row first, like [{"height": 10, "cells": [{"width": 120, "label": '
             '"TITLE", "field": "title"}, {"width": 60, "label": "DRAWING NO.", "field": "number"}]}]')
    if not isinstance(layout, (list, tuple)) or not layout:
        raise ValueError(f"Drawing: {shape}.")
    if len(layout) > TITLE_ROWS:
        raise ValueError(f"Drawing: title_block has at most {TITLE_ROWS} rows.")
    for r, row in enumerate(layout):
        where = f"Drawing: title_block[{r}]"
        if not isinstance(row, dict) or set(row) - set(TITLE_ROW_KEYS) or not {"height", "cells"} <= set(row):
            raise ValueError(f"{where} is a dict of height (mm) and cells; {shape}.")
        if not _number(row["height"]) or not TITLE_MIN_HEIGHT <= row["height"] <= 100:
            raise ValueError(f"{where}: height is the row's height in mm, {TITLE_MIN_HEIGHT:g} to 100.")
        if not isinstance(row["cells"], (list, tuple)) or not 1 <= len(row["cells"]) <= TITLE_CELLS:
            raise ValueError(f"{where}: cells is a list of 1 to {TITLE_CELLS} cells.")
    heights = [float(row["height"]) for row in layout]
    rows = [{"height": height, "cells": []} for height in heights]
    taken = [[] for _ in layout]  # Each row's spans (cell) of the cells reaching up into it from rows below.
    shown = 0  # Image cells so far
    for r, row in enumerate(layout):
        where = f"Drawing: title_block[{r}]"
        x = 0.0
        for c, cell in enumerate(row["cells"]):
            at = f"{where}.cells[{c}]"
            if not isinstance(cell, dict) or set(cell) - set(TITLE_CELL_KEYS) or "width" not in cell:
                raise ValueError(f"{at} is a dict of width (mm), and optionally {', '.join(TITLE_CELL_KEYS[1:])}.")
            if not _number(cell["width"]) or not 4 <= cell["width"] <= room_w:
                raise ValueError(f"{at}: width is the cell's width in mm, 4 to {room_w:g} (the {drawing.sheet} sheet's border).")
            span = cell.get("rows", 1)
            if not isinstance(span, int) or isinstance(span, bool) or not 1 <= span <= len(layout) - r:
                raise ValueError(f"{at}: rows is how many rows the cell spans upward, 1 to {len(layout) - r} (the rows from it to the top).")
            height = sum(heights[r:r + span])
            field = cell.get("field")
            if field is not None and not (isinstance(field, str) and TITLE_FIELD.fullmatch(field)):
                raise ValueError(f"{at}: field is a key of fields (like \"number\"), or one of {', '.join(TITLE_VALUES)}.")
            if field is not None and "text" in cell:
                raise ValueError(f"{at} has a field or text, not both.")
            sizes = {}
            for key, low in (("text_height", 1.5), ("label_height", 1.0)):
                size = cell.get(key)
                if size is not None and (not _number(size) or not low <= size <= min(20.0, height)):
                    raise ValueError(f"{at}: {key} is in mm, {low:g} to {min(20.0, height):g} (its cell's height).")
                sizes[key] = float(size) if size is not None else None
            places = {}
            for key, allowed in (("align", TITLE_ALIGN), ("valign", TITLE_VALIGN), ("label_align", TITLE_ALIGN), ("label_valign", TITLE_VALIGN)):
                value = cell.get(key)
                if value is not None and not (isinstance(value, str) and value in allowed):
                    raise ValueError(f"{at}: {key} is one of {', '.join(allowed)}.")
                places[key] = value
            weights = {}
            for key in ("bold", "label_bold"):
                if not isinstance(cell.get(key, False), bool):
                    raise ValueError(f"{at}: {key} is True or False.")
                weights[key] = cell.get(key, False)
            text = cell.get("text")
            if isinstance(text, (list, tuple)):
                if not 1 <= len(text) <= TITLE_LINES:
                    raise ValueError(f"{at}: text is a line, or a list of 1 to {TITLE_LINES} lines.")
                text = [_text(line, f"title_block[{r}].cells[{c}] text") for line in text]
            elif text is not None:
                text = [_text(text, f"title_block[{r}].cells[{c}] text")]
            image, padding = cell.get("image"), cell.get("padding")
            if image is not None:
                if field is not None or "text" in cell:
                    raise ValueError(f"{at} draws an image, or shows a field or text, not both.")
                if weights["bold"]:
                    raise ValueError(f"{at}: bold is for a cell's value or text; an image cell's label takes label_bold.")
                if (shown := shown + 1) > TITLE_IMAGES:
                    raise ValueError(f"Drawing: title_block has at most {TITLE_IMAGES} image cells.")
                try:
                    data, kind, *pixels = images.read(image)
                except images.ImageError as error:
                    raise ValueError(f"{at}: {error}") from None
                image = {"name": image, "data": data, "kind": kind, "pixels": tuple(pixels)}
            elif padding is not None:
                raise ValueError(f"{at}: padding is the room around a cell's image; give it an image too.")
            if padding is not None and (not _number(padding) or not 0 <= padding < min(float(cell["width"]), height) / 2):
                raise ValueError(f"{at}: padding is in mm, 0 to less than half the cell's width and height.")
            label = cell.get("label")
            if label is None:  # A field's own label (DRAWING NO., REV…), or its key in capitals.
                label = {**TITLE_VALUES, **FIELDS}.get(field, field.replace("_", " ").upper()) if field else ""
            # Past the cells reaching up from below that start where this one would (as a table's rowspan).
            while (below := next((other for other in taken[r] if other["x"] <= x + 1e-6 < other["x"] + other["width"]), None)):
                x = below["x"] + below["width"]
            width = float(cell["width"])
            for above in range(r, r + span):
                if any(other["x"] < x + width - 1e-6 and x < other["x"] + other["width"] - 1e-6 for other in taken[above]):
                    raise ValueError(f"{at} overlaps a cell spanning up from a row below in title_block[{above}]; make it "
                                     f"narrower, or that cell's rows fewer.")
            out = {"x": x, "width": width, "row": r, "rows": span, "height": height, "label": _text(label, f"title_block[{r}].cells[{c}] label"),
                   "field": field, "text": text, **sizes, **places, **weights, "image": image,
                   "padding": TITLE_PADDING if padding is None else float(padding)}
            rows[r]["cells"].append(out)
            for above in range(r + 1, r + span):
                taken[above].append(out)
            x += width

    def extent(r):  # The cell reaching furthest right in row r, its own or one spanning up into it.
        return max([*rows[r]["cells"], *taken[r]], key=lambda cell: cell["x"] + cell["width"])
    width = max(cell["x"] + cell["width"] for r in range(len(rows)) for cell in [extent(r)])
    if not TITLE_MIN_WIDTH <= width <= room_w:
        raise ValueError(f"Drawing: title_block is {width:g} mm wide; its widest row is {TITLE_MIN_WIDTH:g} to {room_w:g} mm "
                         f"(the {drawing.sheet} sheet's border).")
    if sum(heights) > room_h / 2:
        raise ValueError(f"Drawing: title_block is taller than half the {drawing.sheet} sheet ({room_h / 2:g} mm); make its rows lower.")
    for r in range(len(rows)):  # A shorter row's last cell reaches the block's right edge.
        last = extent(r)
        if last["x"] + last["width"] < width - 1e-6:
            # Unless a spanning cell has a neighbour to its right in another of its rows: then nothing can fill the gap.
            reach = range(last["row"], last["row"] + last["rows"])
            if any(other is not last and other["x"] >= last["x"] + last["width"] - 1e-6 for i in reach for other in [*rows[i]["cells"], *taken[i]]):
                raise ValueError(f"Drawing: title_block[{r}] is {last['x'] + last['width']:g} mm wide, short of the block's {width:g} mm; "
                                 f"widen its cells.")
            last["width"] = width - last["x"]
    return rows


def _view_options(item: dict, where: str) -> dict:
    """A view's own scale, hidden lines, shading and paper offset, as written; None where it takes its parent's or the
    sheet's."""
    try:
        scale = _scale(item.get("scale"))
    except ValueError:
        raise ValueError(f"{where}: scale is (1, 2) for 1:2, (2, 1) for 2:1, or a number.") from None
    hidden, shaded = item.get("hidden"), item.get("shaded")
    if hidden is not None and not isinstance(hidden, bool):
        raise ValueError(f"{where}: hidden is True or False.")
    if shaded is not None and not isinstance(shaded, bool):
        raise ValueError(f"{where}: shaded is True or False.")
    at = item.get("at")
    if at is None:
        at = (0.0, 0.0)
    elif isinstance(at, (list, tuple)) and len(at) == 2 and all(_number(v) and abs(v) <= 1000 for v in at):
        at = (float(at[0]), float(at[1]))
    else:
        raise ValueError(f"{where}: at is a paper offset in mm from where the view goes on its own, like (20, -10).")
    position = item.get("position")
    if position is not None:  # Checked against the sheet's size by the Drawing.
        if not (isinstance(position, (list, tuple)) and len(position) == 2 and all(_number(v) and 0 <= v <= 10000 for v in position)):
            raise ValueError(f"{where}: position is the view's centre on the sheet, (x, y) paper mm from its lower-left "
                             "corner, like (120, 180).")
        if item.get("at") is not None:
            raise ValueError(f"{where}: give the view at (an offset from where it goes on its own) or position (where it "
                             "goes on the sheet), not both.")
        position = (float(position[0]), float(position[1]))
    return {"scale": scale, "hidden": hidden, "shaded": shaded, "at": at, "position": position}


def _views(views) -> tuple[list[str], dict]:
    """The base views' names, in order (each once), and each one's own settings."""
    items = [views] if isinstance(views, (str, dict)) else list(views or ())
    names, options, unknown = [], {}, []
    for index, item in enumerate(items):
        where = f"Drawing: views[{index}]"
        name, own = item, None
        if isinstance(item, dict) and item.get("view") == FLAT:
            if set(item) - set(FLAT_KEYS):
                raise ValueError(f"{where}: a flat view is a dict of {', '.join(FLAT_KEYS)}, like {{\"view\": \"flat\", "
                                 "\"body\": \"base\"}: it has no hidden lines or shading.")
            body = item.get("body")
            if body is not None and not (isinstance(body, str) and body.strip()):
                raise ValueError(f"{where}: body is the sheet-metal body whose flat pattern it shows: its id on a part's "
                                 "sheet, like \"base\", or \"<instance>:<body>\" on a design's, like \"bracket_1:base\".")
            name, own = FLAT, {**_view_options(item, where), "body": body.strip() if body else None}
        elif isinstance(item, dict):
            if "view" not in item or set(item) - set(VIEW_KEYS):
                raise ValueError(f"{where} is a view's name, or a dict of {', '.join(VIEW_KEYS)}, like "
                                 "{\"view\": \"front\", \"scale\": (1, 2)}.")
            name, own = item["view"], _view_options(item, where)
        if not isinstance(name, str) or (name not in VIEWS and name != FLAT):
            unknown.append(name)
        elif name not in options:
            names.append(name)
            options[name] = own or {"scale": None, "hidden": None, "shaded": None, "at": (0.0, 0.0), "position": None, "body": None}
    if unknown:  # None at all is a blank sheet: its border, title block, tables and notes, ready for views.
        raise ValueError(f"Drawing: views must be some of {', '.join((*VIEWS, FLAT))}; got {', '.join(map(repr, unknown))}.")
    return names, options


def _oriented(front) -> tuple[tuple[str, str], dict]:
    """front= as written, checked, and every named view's frame: VIEWS turned by the rotation that takes the default
    front view to the master's (exactly VIEWS by default)."""
    if isinstance(front, str) and front in MODEL_SIDES:
        front = (front, SIDE_UP[front])
    sides = ", ".join(MODEL_SIDES)
    if not (isinstance(front, (list, tuple)) and len(front) == 2 and all(isinstance(side, str) and side in MODEL_SIDES for side in front)):
        raise ValueError(f"Drawing: front is (facing, up), two of {sides}: the model side the front view shows and the "
                         f"side up on the paper, like (\"top\", \"back\"); not {front!r}.")
    facing, up = front
    n, y = MODEL_SIDES[facing], MODEL_SIDES[up]
    if any(a * b for a, b in zip(n, y)):
        raise ValueError(f"Drawing: front=({facing!r}, {up!r}): up is a side next to {facing}, not {'it' if up == facing else 'opposite it'}.")
    x = _cross(y, n)
    n0, x0 = VIEWS["front"]
    y0 = _cross(n0, x0)
    dot = lambda a, b: sum(p * q for p, q in zip(a, b))  # noqa: E731

    def turn(v):
        return tuple(x[i] * dot(x0, v) + y[i] * dot(y0, v) + n[i] * dot(n0, v) for i in range(3))

    return (facing, up), {name: (turn(towards), turn(across)) for name, (towards, across) in VIEWS.items()}


def _first_view(drawing: "Drawing") -> str:
    """Where an annotation goes when it doesn't say: the sheet's first orthographic view (front on a blank sheet, so
    it's reported as not on the sheet rather than refused)."""
    orthographic = [view for view in drawing.views if view not in ("iso", FLAT)]
    return orthographic[0] if orthographic else drawing.views[0] if drawing.views else "front"


def _off_flat(view, where: str, what: str):
    """Annotations other than feature dimensions go on the folded model's views: the flat view shows the blank, which
    is dimensioned (its edges, holes and bend lines) and noted with its bends."""
    if view == FLAT:
        raise ValueError(f"{where}: the flat view shows the developed blank, which takes feature dimensions (to its edges, "
                         f"holes and bend lines, like \"<flange>.bend.line\") and its bend notes, so {what} go on the "
                         "front, top, side or section views. Its overall size is dimensioned with the sheet's dimensions=True.")


def _unit(v) -> tuple:
    length = math.sqrt(sum(c * c for c in v))
    return tuple(c / length for c in v)


def _cross(a, b) -> tuple:
    return a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]


def _section_frame(parent, direction: str, flip: bool, projection: str):
    """A section view's (towards the viewer, paper x), the grid step from its parent to where it goes, and the way its
    arrows point on the parent (paper). A horizontal cutting line looks down the parent (as the top view looks at the
    front), a vertical one across it (as the right view); flip looks the other way. Placed by the projection method."""
    n, x = _unit(parent[0]), _unit(parent[1])
    y = _cross(n, x)
    negative = lambda v: tuple(-c for c in v)  # noqa: E731
    if direction == "horizontal":
        frame, step, looking = (negative(y), x) if flip else (y, x), (0, 1), (0.0, 1.0 if flip else -1.0)
    else:
        frame, step, looking = (negative(x), n) if flip else (x, negative(n)), (1, 0), (1.0 if flip else -1.0, 0.0)
    if flip != (projection == "first"):
        step = (-step[0], -step[1])
    return frame, step, looking


def _own(drawing: "Drawing", ref) -> bool:
    """Whether a reference (`housing.face(...)`) is into what this sheet draws: its component, or the linked part it
    draws (`plate.face(...)` on `Drawing(plate)`: the part's own names, as written)."""
    if ref.component is drawing.model:
        return True
    return (drawing.model is not None and getattr(ref.component, "_steve_linked", False) and ref.target is ref.component
            and ref.component.__dict__.get("_model") is drawing.model)


def _ref_name(drawing: "Drawing", ref, where: str) -> str:
    """A reference object as the name the sheet resolves: its own name on its component's (or linked part's) sheet; on
    a design's sheet, `"<instance>:<name>"` of the one instance of its component (placed more than once: name it)."""
    if _own(drawing, ref):
        return ref.ref
    if drawing.design is not None:
        placed = [item["name"] for item in drawing.design.instances if item["component"] is ref.component]
        if len(placed) == 1:
            return f"{placed[0]}:{ref.ref}"
        if placed:
            raise ValueError(f"{where}: {ref.component.id} is placed {len(placed)} times ({', '.join(placed)}); name the "
                             f"instance, like \"{placed[0]}:{ref.ref}\".")
    raise ValueError(f"{where}: {ref!r} is in another component; put it on that component's sheet.")


def _point_ref(drawing: "Drawing", value, where: str):
    """Where a section's cutting plane or a detail's circle goes, as written: a persistent name, or a model point."""
    if getattr(value, "_steve_ref", False):  # housing.face("bore.wall(0)") on housing's own sheet
        value = _ref_name(drawing, value, where)
    if isinstance(value, (list, tuple)) and len(value) == 3 and all(map(_number, value)):
        return tuple(float(v) for v in value)
    if isinstance(value, str) and value.strip():
        return value.strip()
    raise ValueError(f"{where} is a reference name (a hole, a face, an edge or a vertex, like \"hole_1.wall(0)\") or a "
                     "model point (x, y, z) in mm.")


def _children(drawing: "Drawing", sections, details) -> list[dict]:
    """Section and detail views as written, checked, each with its frame. A parent is a base orthographic view or a
    section or detail view written before it. Their references are resolved when the sheet is drawn."""
    frames = {view: drawing.base_frames[view] for view in drawing.views if view not in ("iso", FLAT)}
    children = []
    for kind, items, keys in (("section", sections, SECTION_KEYS), ("detail", details, DETAIL_KEYS)):
        for index, item in enumerate([items] if isinstance(items, dict) else list(items or ())):
            where = f"Drawing: {kind}_views[{index}]"
            if isinstance(item, dict) and "center" in item and "centre" not in item:
                item = {("centre" if key == "center" else key): value for key, value in item.items()}
            if not isinstance(item, dict) or set(item) - set(keys):
                unknown = ", ".join(sorted(map(str, set(item) - set(keys)))) if isinstance(item, dict) else ""
                raise ValueError(f"{where} is a dict of {', '.join(keys)}" + (f"; not {unknown}." if unknown else "."))
            name = item.get("name")
            if not isinstance(name, str) or not VIEW_NAME.fullmatch(name.strip()):
                raise ValueError(f"{where}: name is the {kind} view's capital letter (or two), like \"A\".")
            name = name.strip()
            if name in frames:
                raise ValueError(f"{where}: {name!r} names another section or detail view; give each its own letter.")
            if drawing.standard == "ANSI" and set(name) & set("IOQ"):
                raise ValueError(f"{where}: ASME Y14.3 doesn't use I, O or Q for views (they read as numbers); pick another.")
            parent = item.get("parent", next(iter(frames), None))
            if not isinstance(parent, str) or parent not in frames:
                raise ValueError(f"{where}: parent is an orthographic view on this sheet, or a section or detail view written "
                                 f"before it ({', '.join(frames) or 'none yet'}), not {parent!r}.")
            child = {"kind": kind, "index": index + 1, "name": name, "parent": parent,
                     **_view_options({key: item.get(key) for key in ("scale", "hidden", "at", "position")}, where)}
            if kind == "section":
                direction, flip = item.get("direction", "horizontal"), item.get("flip", False)
                if direction not in ("horizontal", "vertical"):
                    raise ValueError(f"{where}: direction is the cutting line's on the parent view: \"horizontal\" or \"vertical\".")
                if not isinstance(flip, bool):
                    raise ValueError(f"{where}: flip is True (look the other way) or False.")
                child["frame"], child["step"], child["looking"] = _section_frame(frames[parent], direction, flip, drawing.projection)
                child.update(through=_point_ref(drawing, item.get("through"), f"{where}: through"), direction=direction, flip=flip)
            else:
                radius = item.get("radius")
                if not _number(radius) or not 0 < radius <= 100000:
                    raise ValueError(f"{where}: radius is the circle's radius in model mm, like 10.")
                child.update(frame=frames[parent], centre=_point_ref(drawing, item.get("centre"), f"{where}: centre"),
                             radius=float(radius))
            frames[name] = child["frame"]
            children.append(child)
    return children


def _feature_dimension(drawing: Drawing, item, index: int) -> dict:
    """A feature dimension as written, checked. Its references are resolved when the sheet is drawn."""
    where = f"Drawing: feature_dimensions[{index}]"
    if not isinstance(item, dict) or set(item) - set(DIMENSION_KEYS):
        unknown = ", ".join(sorted(map(str, set(item) - set(DIMENSION_KEYS)))) if isinstance(item, dict) else ""
        raise ValueError(f"{where} is a dict of {', '.join(DIMENSION_KEYS)}" + (f"; not {unknown}." if unknown else "."))
    view = item.get("view", _first_view(drawing))
    if view == "iso":
        raise ValueError(f"{where}: isometric views foreshorten lengths, so dimensions go on the front, top, right, left, "
                         "bottom or back view.")
    if view not in VIEWS and view not in drawing.frames:
        raise ValueError(f"{where}: view must be one of {', '.join(v for v in VIEWS if v != 'iso')}, \"flat\" (with a flat "
                         f"view on the sheet), or a section or detail view's name, not {view!r}.")
    refs = item.get("refs")
    refs = list(refs) if isinstance(refs, (list, tuple)) else [refs]
    for i, ref in enumerate(refs):
        if getattr(ref, "_steve_ref", False):  # housing.face("extrude_1.end") on housing's (or its design's) sheet
            refs[i] = _ref_name(drawing, ref, where)
    if not 1 <= len(refs) <= 2 or not all(isinstance(ref, str) and ref.strip() for ref in refs):
        raise ValueError(f"{where}: refs is one or two reference names, like [\"extrude_1.start\", \"extrude_1.end\"].")
    kind = item.get("kind")
    if kind is not None and kind not in DIMENSION_KINDS:
        raise ValueError(f"{where}: kind must be one of {', '.join(DIMENSION_KINDS)}, not {kind!r}.")
    if kind is not None and len(refs) != DIMENSION_KINDS[kind]:
        raise ValueError(f"{where}: a {kind} dimension takes {DIMENSION_KINDS[kind]} reference(s).")
    direction = item.get("direction", "auto")
    if direction not in DIRECTIONS:
        raise ValueError(f"{where}: direction must be one of {', '.join(DIRECTIONS)}, not {direction!r}.")
    tolerance = item.get("tolerance")
    if isinstance(tolerance, (list, tuple)):
        if len(tolerance) != 2 or not all(map(_number, tolerance)) or tolerance[0] < tolerance[1]:
            raise ValueError(f"{where}: tolerance is (upper, lower), like (0.1, -0.05).")
        tolerance = (float(tolerance[0]), float(tolerance[1]))
    elif tolerance is not None and (not _number(tolerance) or tolerance <= 0):
        raise ValueError(f"{where}: tolerance is a number for ±, like 0.1, or (upper, lower), like (0.1, -0.05).")
    fit = item.get("fit")
    if fit is not None:
        if not isinstance(fit, str) or not FIT.fullmatch(fit.strip()):
            raise ValueError(f"{where}: fit is an ISO 286 tolerance class: a hole's in capitals, like \"H7\", a shaft's in "
                             "lower case, like \"g6\".")
        fit = fit.strip()
        if tolerance is not None:
            raise ValueError(f"{where}: a dimension takes a fit or a tolerance, not both.")
    fit_shows = item.get("fit_shows")
    if fit_shows is not None and fit_shows not in FIT_SHOWS:
        raise ValueError(f"{where}: fit_shows must be one of {', '.join(FIT_SHOWS)}, not {fit_shows!r}.")
    if fit_shows is not None and fit is None:
        raise ValueError(f"{where}: fit_shows is how a fit is shown; add a fit, like \"H7\".")
    display = item.get("display", "value")
    if display not in DISPLAYS:
        raise ValueError(f"{where}: display must be one of {', '.join(DISPLAYS)}, not {display!r}.")
    if display == "limits" and tolerance is None and fit is None:
        raise ValueError(f"{where}: limits are shown from a tolerance or a fit; add one.")
    if display in ("basic", "reference") and (tolerance is not None or fit is not None):
        raise ValueError(f"{where}: a {display} dimension has no tolerance or fit of its own.")
    if display == "limits" and fit is not None:  # A fit's limits: the same as fit_shows="limits".
        if fit_shows not in (None, "limits"):
            raise ValueError(f"{where}: display \"limits\" shows a fit's limits; leave fit_shows out or make it \"limits\".")
        fit_shows = "limits"
    precision = item.get("precision")
    if precision is not None and (not isinstance(precision, int) or isinstance(precision, bool) or not 0 <= precision <= 6):
        raise ValueError(f"{where}: precision is a number of decimal places, 0 to 6.")
    dual = item.get("dual", True)
    if not isinstance(dual, bool):
        raise ValueError(f"{where}: dual is True or False: False leaves the bracketed second unit off this dimension.")
    dual_precision = item.get("dual_precision")
    if dual_precision is not None and (not isinstance(dual_precision, int) or isinstance(dual_precision, bool)
                                       or not 0 <= dual_precision <= 6):
        raise ValueError(f"{where}: dual_precision is the bracketed value's decimal places, 0 to 6.")
    # A sheet without a second unit (turned off, or units switched) ignores each dimension's dual settings.
    offset = item.get("offset")
    if offset is not None and (not _number(offset) or not 0 < offset <= 200):
        raise ValueError(f"{where}: offset is the paper distance (mm) from the view to the dimension line, like 12.")
    side = item.get("side")
    if side is not None and side not in SIDES:
        raise ValueError(f"{where}: side is one of {', '.join(SIDES)} (which fit depends on the dimension), not {side!r}.")
    text_at = item.get("text_at")
    text_at = "centre" if text_at == "center" else text_at
    if text_at is not None and not (isinstance(text_at, str) and text_at in TEXT_AT) and (not _number(text_at) or abs(text_at) > 200):
        raise ValueError(f"{where}: text_at is \"centre\", \"start\", \"end\", or paper mm along the line from its middle, "
                         "like -12.")
    if text_at == "centre" or (_number(text_at) and text_at == 0):
        text_at = None
    dim_id = item.get("id")
    if dim_id is not None and not (isinstance(dim_id, str) and DIMENSION_ID.fullmatch(dim_id)):
        raise ValueError(f"{where}: id is a short name starting with a letter, like \"bore\" or \"d1\".")
    ends = item.get("ends")
    if ends is not None:
        ends = [ends] * len(refs) if isinstance(ends, str) else list(ends) if isinstance(ends, (list, tuple)) else None
        ends = ends and ["centre" if end == "center" else end for end in ends]
        if not ends or len(ends) != len(refs) or not all(end in ENDS for end in ends):
            raise ValueError(f"{where}: ends is where a distance ends on round wire or tube, one per ref: "
                             f"{', '.join(ENDS)}, like [\"outside\", \"centre\"].")
        if len(refs) != 2 or kind not in (None, "distance"):
            raise ValueError(f"{where}: ends is for a distance between two features; leave it out of a {kind or 'single'} "
                             "dimension.")
        ends = tuple(ends) if set(ends) != {"centre"} else None
    return {"index": index + 1, "id": dim_id, "view": view, "refs": [ref.strip() for ref in refs], "kind": kind, "direction": direction, "ends": ends,
            "tolerance": tolerance, "fit": fit, "fit_shows": fit_shows, "display": display, "precision": precision, "offset": float(offset) if offset else None,
            "dual": dual and drawing.dual_units is not None, "dual_precision": dual_precision,
            "side": side, "text_at": float(text_at) if _number(text_at) else text_at,
            **{key: _text(item[key], f"dimension {key}") if item.get(key) is not None else "" for key in ("prefix", "suffix", "text")}}


def _attachment(drawing: Drawing, item: dict, where: str) -> dict:
    """What a datum or tolerance frame attaches to: one piece of named model geometry in a view, or a feature
    dimension (by its id). Checked as written; the geometry is resolved when the sheet is drawn."""
    ref, on = item.get("ref"), item.get("dimension")
    if (ref is None) == (on is None):
        raise ValueError(f"{where} attaches to model geometry (ref, like \"base.bottom\") or to a feature dimension "
                         "(dimension, its id): one of them.")
    offset = item.get("offset")
    if offset is not None and (not _number(offset) or not 0 < offset <= 200):
        raise ValueError(f"{where}: offset is the paper distance (mm) from the feature to the symbol, like 8.")
    offset = float(offset) if offset else None
    if on is not None:
        dim = next((dim for dim in drawing.feature_dimensions if dim["id"] is not None and dim["id"] == on), None)
        if dim is None:
            raise ValueError(f"{where}: no feature dimension on this sheet has the id {on!r}; give the dimension "
                             "\"id\": \"…\" and attach to that.")
        if item.get("view") not in (None, dim["view"]):
            raise ValueError(f"{where}: it's drawn with its dimension, in the {dim['view']} view; leave view out.")
        return {"view": dim["view"], "ref": None, "dimension": dim["index"], "dimension_id": on, "offset": offset}
    if getattr(ref, "_steve_ref", False):  # housing.face("base.bottom") on housing's (or its design's) sheet
        ref = _ref_name(drawing, ref, where)
    if not isinstance(ref, str) or not ref.strip():
        raise ValueError(f"{where}: ref is one reference name, like \"base.bottom\" or \"hole_1.wall(0)\".")
    view = item.get("view", _first_view(drawing))
    _off_flat(view, where, "datums and tolerance frames")
    if view == "iso" or (view not in VIEWS and view not in drawing.frames):
        raise ValueError(f"{where}: view must be one of {', '.join(v for v in VIEWS if v != 'iso')}, or a section or "
                         f"detail view's name, not {view!r}.")
    return {"view": view, "ref": ref.strip(), "dimension": None, "dimension_id": None, "offset": offset}


def _datum(drawing: Drawing, item, index: int) -> dict:
    """A datum feature symbol as written, checked (ASME Y14.5-2018, ISO 5459)."""
    where = f"Drawing: datums[{index}]"
    if not isinstance(item, dict) or set(item) - set(DATUM_KEYS):
        raise ValueError(f"{where} is a dict of {', '.join(DATUM_KEYS)}.")
    label = item.get("label")
    if not isinstance(label, str) or not re.fullmatch(r"[A-Z]{1,2}", label.strip()):
        raise ValueError(f"{where}: label is a datum's capital letter (or two), like \"A\".")
    label = label.strip()
    if drawing.standard == "ANSI" and set(label) & set("IOQ"):
        raise ValueError(f"{where}: ASME Y14.5 doesn't use I, O or Q as datum letters (they read as numbers); pick another.")
    return {"index": index + 1, "label": label, **_attachment(drawing, item, where)}


def _tolerance_frame(drawing: Drawing, item, index: int) -> dict:
    """A feature control frame as written, checked against ASME Y14.5-2018 and ISO 1101:2017's rules."""
    where = f"Drawing: tolerance_frames[{index}]"
    if not isinstance(item, dict) or set(item) - set(FRAME_KEYS):
        unknown = ", ".join(sorted(map(str, set(item) - set(FRAME_KEYS)))) if isinstance(item, dict) else ""
        raise ValueError(f"{where} is a dict of {', '.join(FRAME_KEYS)}" + (f"; not {unknown}." if unknown else "."))
    characteristic = item.get("characteristic")
    if not isinstance(characteristic, str) or characteristic not in CHARACTERISTICS:
        raise ValueError(f"{where}: characteristic is one of {', '.join(CHARACTERISTICS)}, not {characteristic!r}.")
    if drawing.standard == "ANSI" and characteristic in ISO_ONLY:
        raise ValueError(f"{where}: ASME Y14.5-2018 has no {characteristic}; use position, profile or runout, or an ISO sheet.")
    kind = CHARACTERISTICS[characteristic]
    tolerance = item.get("tolerance")
    if not _number(tolerance) or tolerance <= 0:
        raise ValueError(f"{where}: tolerance is the zone's size in the sheet's units, a number more than 0, like 0.1.")
    zone = item.get("zone")
    if zone not in (None, "diameter"):
        raise ValueError(f"{where}: zone is \"diameter\" (a cylindrical zone, ⌀) or left out (between two lines or planes).")
    if zone and characteristic not in DIAMETER_ZONE:
        raise ValueError(f"{where}: a {characteristic} tolerance zone isn't cylindrical; leave zone out.")
    modifier = item.get("modifier")
    if modifier is not None and modifier not in tuple(MATERIAL):
        raise ValueError(f"{where}: modifier is \"MMC\" or \"LMC\" (or left out, regardless of feature size).")
    if modifier and characteristic in NO_MATERIAL:
        raise ValueError(f"{where}: {characteristic} takes no material condition modifier; leave modifier out.")
    projected = item.get("projected")
    if projected is not None and (not _number(projected) or projected <= 0):
        raise ValueError(f"{where}: projected is the projected tolerance zone's height in the sheet's units, like 20.")
    if projected is not None and kind not in ("orientation", "location"):
        raise ValueError(f"{where}: a projected tolerance zone is for orientation or location tolerances.")
    modifiers = item.get("modifiers") or []
    modifiers = [modifiers] if isinstance(modifiers, str) else modifiers
    if not isinstance(modifiers, (list, tuple)) or not all(m in tuple(ZONE_MODIFIERS) for m in modifiers):
        raise ValueError(f"{where}: modifiers are some of {', '.join(ZONE_MODIFIERS)}.")
    if "tangent_plane" in modifiers and kind != "orientation":
        raise ValueError(f"{where}: tangent_plane is for orientation tolerances (parallelism, perpendicularity, angularity).")
    datums = item.get("datums") or []
    datums = [datums] if isinstance(datums, str) else list(datums) if isinstance(datums, (list, tuple)) else None
    references = []
    for datum in datums if datums is not None else [None]:
        letter, condition = (datum, None) if isinstance(datum, str) else tuple(datum) if isinstance(datum, (list, tuple)) and len(datum) == 2 else (None, None)
        if not isinstance(letter, str) or condition not in (None, *MATERIAL):
            raise ValueError(f"{where}: datums are up to three datum letters, primary first, each \"A\" or (\"A\", \"MMC\").")
        references.append((letter.strip(), condition))
    defined = [d["label"] for d in drawing.datums]
    for letter, _ in references:
        if letter not in defined:
            raise ValueError(f"{where}: datum {letter!r} isn't defined on this sheet"
                             + (f" (it defines {', '.join(defined)})" if defined else "") + "; add it to datums first.")
    if len(references) > 3:
        raise ValueError(f"{where}: a frame references at most three datums (primary, secondary, tertiary).")
    if len({letter for letter, _ in references}) < len(references):
        raise ValueError(f"{where}: each datum is referenced once in a frame.")
    if kind == "form" and references:
        raise ValueError(f"{where}: {characteristic} is a form tolerance, which has no datums; leave datums out.")
    if (kind in NEEDS_DATUM or characteristic in NEEDS_DATUM) and not references:
        raise ValueError(f"{where}: {characteristic} is measured from a datum; add at least one to datums.")
    if characteristic in NO_MATERIAL and any(condition for _, condition in references):
        raise ValueError(f"{where}: {characteristic} takes no material condition on its datums.")
    return {"index": index + 1, "characteristic": characteristic, "tolerance": float(tolerance), "zone": zone,
            "modifier": modifier, "projected": float(projected) if projected is not None else None,
            "modifiers": list(dict.fromkeys(modifiers)), "datums": references, **_attachment(drawing, item, where)}


def _balloon(drawing: Drawing, item, index: int) -> dict:
    """An item balloon as written, checked. Its instance and number are found when the sheet is drawn."""
    where = f"Drawing: balloons[{index}]"
    if isinstance(item, str):
        item = {"instance": item}
    if not isinstance(item, dict) or set(item) - set(BALLOON_KEYS):
        unknown = ", ".join(sorted(map(str, set(item) - set(BALLOON_KEYS)))) if isinstance(item, dict) else ""
        raise ValueError(f"{where} is an instance's name, or a dict of {', '.join(BALLOON_KEYS)}" + (f"; not {unknown}." if unknown else "."))
    instance = item.get("instance")
    if not isinstance(instance, str) or not instance.strip():
        raise ValueError(f"{where}: instance is a placed instance's name in the design, like \"motor_1\".")
    view = item.get("view")
    _off_flat(view, where, "balloons")
    if view is not None and view not in drawing.frames:
        raise ValueError(f"{where}: view is one of this sheet's views ({', '.join(drawing.frames)}), not {view!r}.")
    side = item.get("side")
    if side is not None and side not in BALLOON_SIDES:
        raise ValueError(f"{where}: side is one of {', '.join(BALLOON_SIDES)}, not {side!r}.")
    offset = item.get("offset")
    if offset is not None and (not _number(offset) or not 0 < offset <= 200):
        raise ValueError(f"{where}: offset is the paper distance (mm) from the view to the balloon, like 10.")
    return {"index": index + 1, "instance": _text(instance, "balloon instance"), "view": view, "side": side,
            "offset": float(offset) if offset else None}


def _leader_note(drawing: Drawing, item: dict, index: int) -> dict:
    """A leader note as written, checked. Its ref is resolved when the sheet is drawn."""
    where = f"Drawing: notes[{index}]"
    view, ref = item.get("view"), item.get("ref")
    if getattr(ref, "_steve_ref", False):  # frame.edge("…") on frame's (or its design's) sheet
        ref = _ref_name(drawing, ref, where)
    if not isinstance(ref, str) or not ref.strip() or view is None:
        raise ValueError(f"{where}: a leader note points at one edge, face or vertex in a view: give view and ref, like "
                         "{\"text\": \"FLUSH\", \"view\": \"right\", \"ref\": \"edge(extrude_1.end|extrude_2.side(r1.left))\"}.")
    _off_flat(view, where, "leader notes")
    if view not in VIEWS and view not in drawing.frames:
        raise ValueError(f"{where}: view must be one of {', '.join(VIEWS)}, or a section or detail view's name, not {view!r}.")
    side, offset, at = item.get("side"), item.get("offset"), item.get("at")
    if side is not None and side not in QUADRANTS:
        raise ValueError(f"{where}: side is where the note goes from its leader's tip: one of {', '.join(QUADRANTS)}, not {side!r}.")
    if offset is not None and (not _number(offset) or not 0 < offset <= 200):
        raise ValueError(f"{where}: offset is the paper distance (mm) from the view to the note's shoulder, like 10.")
    if at is not None:
        if not (isinstance(at, (list, tuple)) and len(at) == 2 and all(_number(v) and abs(v) <= 300 for v in at)):
            raise ValueError(f"{where}: at is where the leader's shoulder starts, (dx, dy) paper mm from its tip, like (-15, 10).")
        if side is not None or offset is not None:
            raise ValueError(f"{where}: at places the note exactly; leave side and offset out.")
        at = (float(at[0]), float(at[1]))
    return {"index": index + 1, "text": _text(item["text"], "note"), "view": view, "ref": ref.strip(),
            "side": side, "offset": float(offset) if offset is not None else None, "at": at}


def _weld(drawing: Drawing, item, index: int) -> dict:
    """A weld symbol as written, checked (AWS A2.4 on ANSI sheets, ISO 2553 on ISO ones). Sizes are the person's, in
    the sheet's units; nothing is assumed. Its refs are resolved when the sheet is drawn."""
    where = f"Drawing: welds[{index}]"
    if not isinstance(item, dict) or set(item) - set(WELD_KEYS):
        unknown = ", ".join(sorted(map(str, set(item) - set(WELD_KEYS)))) if isinstance(item, dict) else ""
        raise ValueError(f"{where} is a dict of {', '.join(WELD_KEYS)}" + (f"; not {unknown}." if unknown else "."))
    view = item.get("view", _first_view(drawing))
    _off_flat(view, where, "weld symbols")
    if view not in VIEWS and view not in drawing.frames:
        raise ValueError(f"{where}: view must be one of {', '.join(VIEWS)}, or a section or detail view's name, not {view!r}.")
    given = [key for key in ("refs", "joint", "bead") if item.get(key) is not None]
    if len(given) > 1:
        raise ValueError(f"{where}: give one of refs, joint or bead, not {' and '.join(given)}.")
    refs, joint, bead, places = [], None, None, None
    if "joint" in given:
        joint = item["joint"]
        if (not isinstance(joint, (list, tuple)) or len(joint) != 2 or not all(isinstance(name, str) and name.strip() for name in joint)
                or joint[0].strip() == joint[1].strip()):
            raise ValueError(f"{where}: joint is the two bodies (a part's) or placed instances (a design's) that are welded, "
                             "like [\"wire_1\", \"bracket_1\"].")
        joint = [_text(name, f"welds[{index}] joint") for name in joint]
        places = item.get("places")
        if places is not None:
            places = list(places) if isinstance(places, (list, tuple)) else [places]
            if (not 1 <= len(places) <= WELD_LEADERS or len(set(places)) < len(places)
                    or not all(isinstance(p, int) and not isinstance(p, bool) and 0 <= p < 1000 for p in places)):
                raise ValueError(f"{where}: places picks the joint's contact places to point at (ordered along x, then y, "
                                 f"then z, counted from 0): 1 to {WELD_LEADERS} of them, like [0, 2].")
    elif "bead" in given:
        bead = item["bead"]
        if not isinstance(bead, str) or not bead.strip():
            raise ValueError(f"{where}: bead is the modelled weld bead's body (a part's) or placed instance (a design's), like \"bead_1\".")
        bead = _text(bead, f"welds[{index}] bead")
    else:
        refs = item.get("refs")
        refs = list(refs) if isinstance(refs, (list, tuple)) else [refs]
        for i, ref in enumerate(refs):
            if getattr(ref, "_steve_ref", False):  # frame.edge("…") on frame's (or its design's) sheet
                refs[i] = _ref_name(drawing, ref, where)
        if not 1 <= len(refs) <= WELD_LEADERS or not all(isinstance(ref, str) and ref.strip() for ref in refs):
            raise ValueError(f"{where}: refs is 1 to {WELD_LEADERS} reference names of the joint (edges, faces or vertices), "
                             "one arrow each, like [\"edge(wall.end|base.top)\"]; or name the joint itself (joint: two "
                             "bodies or instances) or its modelled bead (bead).")
    if item.get("places") is not None and joint is None:
        raise ValueError(f"{where}: places picks among a joint's contact places; give it with joint.")
    kind = item.get("type")
    if kind not in WELD_TYPES:
        raise ValueError(f"{where}: type is one of {', '.join(WELD_TYPES)}, not {kind!r}.")
    side = item.get("side", WELD_SIDES[kind][0])
    side = "centre" if side == "center" else side
    if side not in WELD_SIDES[kind]:
        raise ValueError(f"{where}: a {kind} weld's side is one of {', '.join(WELD_SIDES[kind])}, not {side!r}.")
    values = {}
    for key in ("size", "length", "pitch"):
        value = item.get(key)
        if value is not None and (not _number(value) or not 0 < value <= 100000):
            raise ValueError(f"{where}: {key} is a number more than 0 in the sheet's units ({drawing.units}), like 3.")
        values[key] = float(value) if value is not None else None
    if values["pitch"] is not None and values["length"] is None and kind in ("fillet", "slot", *WELD_GROOVES):
        raise ValueError(f"{where}: pitch is the spacing of an intermittent weld's segments; give their length too.")
    if values["pitch"] is not None and values["length"] is not None and values["pitch"] <= values["length"]:
        raise ValueError(f"{where}: pitch (centre to centre) is more than each segment's length.")
    leg = item.get("leg", False)
    if not isinstance(leg, bool) or (leg and (kind != "fillet" or values["size"] is None)):
        raise ValueError(f"{where}: leg is True when a fillet weld's size is its leg (ISO z) rather than its throat (a).")
    groove = kind in WELD_GROOVES
    for key, least, what in (("throat", 0, "a groove weld's effective throat (E, ISO s)"),
                             ("root_opening", None, "a groove weld's root opening (the gap at its root, 0 for none)"),
                             ("angle", 0, "the groove angle in degrees, like 60")):
        value = item.get(key)
        if value is None:
            values[key] = None
            continue
        if key == "angle" and kind not in WELD_ANGLED:
            raise ValueError(f"{where}: angle is the groove angle of a v, bevel, u or j groove weld; a {kind} weld has none.")
        if not groove:
            raise ValueError(f"{where}: {key} is {what}; a {kind} weld has none.")
        top = 180 if key == "angle" else 100000
        if not _number(value) or not (value > least if least is not None else value >= 0) or not value < top:
            raise ValueError(f"{where}: {key} is {what}: a number " + ("of 0 or more" if least is None else "more than 0")
                             + (" and less than 180." if key == "angle" else f" in the sheet's units ({drawing.units})."))
        values[key] = float(value)
    contour, finish = item.get("contour"), item.get("finish")
    if contour is not None and (contour not in WELD_CONTOURS or kind not in ("fillet", *WELD_GROOVES)):
        raise ValueError(f"{where}: contour is the weld face's shape on a fillet or groove weld: one of "
                         f"{', '.join(WELD_CONTOURS)}" + (f"; a {kind} weld has none." if contour in WELD_CONTOURS else "."))
    if finish is not None:
        if not isinstance(finish, str) or finish.upper() not in WELD_FINISHES:
            raise ValueError(f"{where}: finish is the letter of how the weld's face is finished: one of {', '.join(WELD_FINISHES)}.")
        if contour is None:
            raise ValueError(f"{where}: finish is written on the weld's contour; give contour (flush, convex or concave) too.")
        finish = finish.upper()
    flags = {}
    for key in ("all_around", "field"):
        if not isinstance(item.get(key, False), bool):
            raise ValueError(f"{where}: {key} is True or False.")
        flags[key] = item.get(key, False)
    tail = item.get("tail")
    tail = _text(tail, f"welds[{index}] tail") if tail is not None else ""
    place = item.get("place")
    if place is not None and place not in BALLOON_SIDES:
        raise ValueError(f"{where}: place is where the symbol goes past its view: one of {', '.join(BALLOON_SIDES)}.")
    offset = item.get("offset")
    if offset is not None and (not _number(offset) or not 0 < offset <= 200):
        raise ValueError(f"{where}: offset is the paper distance (mm) from the view to the reference line, like 12.")
    at = item.get("at")
    if at is not None:
        if not (isinstance(at, (list, tuple)) and len(at) == 2 and all(_number(v) and abs(v) <= 300 for v in at)):
            raise ValueError(f"{where}: at is where the reference line starts, (dx, dy) paper mm from the first arrow's tip, like (20, 15).")
        if place is not None or offset is not None:
            raise ValueError(f"{where}: at places the symbol exactly; leave place and offset out.")
        at = (float(at[0]), float(at[1]))
    return {"index": index + 1, "view": view, "refs": [ref.strip() for ref in refs], "joint": joint, "bead": bead,
            "places": places, "type": kind, "side": side, **values, "leg": leg, "contour": contour, "finish": finish,
            **flags, "tail": tail, "place": place,
            "offset": float(offset) if offset else None, "at": at}


def _hole_table(drawing: Drawing, item, index: int) -> dict:
    """A hole table as written, checked. Its holes are found and measured when the sheet is drawn."""
    where = f"Drawing: hole_tables[{index}]"
    if isinstance(item, str):
        item = {"view": item}
    if not isinstance(item, dict) or set(item) - set(HOLE_TABLE_KEYS):
        unknown = ", ".join(sorted(map(str, set(item) - set(HOLE_TABLE_KEYS)))) if isinstance(item, dict) else ""
        raise ValueError(f"{where} is a dict of {', '.join(HOLE_TABLE_KEYS)}" + (f"; not {unknown}." if unknown else "."))
    view = item.get("view", _first_view(drawing))
    _off_flat(view, where, "hole tables")
    if view == "iso" or (view not in VIEWS and view not in drawing.frames):
        raise ValueError(f"{where}: view must be one of {', '.join(v for v in VIEWS if v != 'iso')}, or a section or "
                         f"detail view's name, not {view!r}: the one that shows the holes round.")
    holes = item.get("holes")
    if holes is not None:
        holes = list(holes) if isinstance(holes, (list, tuple)) else [holes]
        for i, ref in enumerate(holes):
            if getattr(ref, "_steve_ref", False):  # housing.face("hole_1.wall(0)") on housing's own sheet
                if not _own(drawing, ref):
                    raise ValueError(f"{where}: {ref!r} is in another component; put it on that component's sheet.")
                holes[i] = ref.ref
        if not holes or not all(isinstance(ref, str) and ref.strip() for ref in holes):
            raise ValueError(f"{where}: holes is a list of hole features' ids (\"hole_1\"), holes' walls "
                             "(\"hole_1.wall(0)\"), or selectors like \"select(faces, '%CYLINDER')\".")
        holes = [ref.strip() for ref in holes]
    origin = item.get("origin")
    if origin is not None:
        origin = _point_ref(drawing, origin, f"{where}: origin")
    return {"index": index + 1, "view": view, "holes": holes, "origin": origin}


def _source(source):
    """(shape, design or None, model or None, name) of what a drawing shows."""
    import cadquery as cq
    from .design import Component
    from .links import Link, LinkedInstance
    if isinstance(source, Link):  # standoff: its default build, as standoff()
        source = source()
    if isinstance(source, LinkedInstance):  # A linked part or design: what it built, under its document's name.
        if source.result is None or getattr(source.result, "_steve_empty", False):
            raise ValueError(f"Drawing: the linked {source.name!r} has nothing modelled yet.")
        shape, design, model, _ = _source(source.result)
        return shape, design, model, source.name
    if isinstance(source, Component):
        shape = source.shape()
        if shape is None:
            raise ValueError(f"Drawing: component {source.name!r} has no bodies yet.")
        return shape, None, source, source.name
    if isinstance(source, cq.Assembly):
        design = getattr(source, "_steve_design", None)
        return source.toCompound(), design, None, design.name if design is not None else source.name
    if isinstance(source, cq.Workplane):
        values = [v for v in source.vals() if isinstance(v, cq.Shape)]
        if not values:
            raise ValueError("Drawing: the Workplane holds no solid geometry.")
        source = values[0] if len(values) == 1 else cq.Compound.makeCompound(values)
    if isinstance(source, cq.Shape):
        model = getattr(source, "_steve_model", None)
        return source, None, model, getattr(model, "name", None)
    raise ValueError("Drawing: draw your `result`, a Component, a linked part or design, or a CadQuery shape or Workplane "
                     f"(this is a {type(source).__name__}).")


def _sheet_bodies(drawing: Drawing) -> dict:
    """The sheet-metal bodies a sheet draws, by the name its flat view takes, each (its model, its body id): a part's
    (or component's) body ids; on a design's result "<instance>:<body>", as the sheet-metal export names them (a
    linked design's instances by their path)."""
    from .links import LinkedInstance
    from .sheetmetal.export import components
    owners = [("", drawing.model)] if drawing.design is None and drawing.model is not None else []
    for item in drawing.design.instances if drawing.design is not None else ():
        if isinstance(item["component"], LinkedInstance):
            owners += [(instance, model) for instance, model, *_ in components(item["component"].result, item["name"])]
        else:
            owners.append((item["name"], item["component"]))
    return {f"{instance}:{body}" if instance else body: (model, body)
            for instance, model in owners for body in getattr(model, "__dict__", {}).get("_sheet_metal", {})}


def _flat_pattern(drawing: Drawing, tolerance: float) -> tuple:
    """The flat view's (outline, bend lines, the bends to note, body, box), model mm in the blank's material plane:
    sheetmetal/export.py pattern()'s face and bends, the same the DXF is written from, so the two never disagree. A
    body that isn't a sheet-metal body here (gone: dangling), or whose flat can't be developed, is a _Problem."""
    from .sheetmetal.export import pattern
    bodies = _sheet_bodies(drawing)
    body = drawing.view_options[FLAT]["body"] or next(iter(bodies), None)
    if body is None:
        raise _Problem("nothing on this sheet is sheet metal: a flat view shows a sheet-metal body's flat pattern.")
    if body not in bodies:
        raise _Problem(f"{body!r} isn't one of this sheet's sheet-metal bodies ({', '.join(bodies) or 'none'}).", dangling=True)
    model, identity = bodies[body]
    try:
        face, data = pattern(model._sheet(identity))
    except Exception as error:  # The sheet-metal diagnostic as the export would give it: this flat has no DXF either.
        code = (getattr(error, "sheet_diagnostic", None) or {}).get("code")
        raise _Problem(f"its flat pattern can't be developed{f' ({code})' if code else ''}: {error}") from None
    outline = [[(p.x, p.y) for p in points] for edge in face.Edges() if (points := _edge_points(edge, tolerance))]
    lines, longest = [], {}
    for bend in data["bends"]:  # A bend a cut crosses has a line per piece; its note goes on the longest.
        lines.append([tuple(bend["start"]), tuple(bend["end"])])
        length = math.dist(bend["start"], bend["end"])
        if length > longest.get(bend["id"], (0.0, None))[0]:
            longest[bend["id"]] = (length, bend)
    return outline, lines, [bend for _, bend in longest.values()], body, tuple(data["bounds_mm"])


def _bend_note(bend: dict, units: str) -> str:
    """A flat pattern's bend note as shop drawings write it: its direction, angle and inside radius (UP 90° R2); a
    rolled sheet's ROLL."""
    turn = "ROLL" if bend["kind"] == "roll" else bend["direction"].upper()
    return f"{turn} {_figure(bend['angle_deg'], 'mm')}° R{_length(bend['radius_mm'], units)}"


def _flat_cells(positions: dict) -> list:
    """Where the flat view may go in the grid: alone, the first cell; else past the other views in the master's row, or
    above or below them all."""
    if not positions:
        return [(0, 0)]
    column, row = positions.get("front", next(iter(positions.values())))
    return [(max(c for c, _ in positions.values()) + 1, row), (column, max(r for _, r in positions.values()) + 1),
            (column, min(r for _, r in positions.values()) - 1)]


def _bom_row(row: dict) -> dict:
    description = row.get("standard") or ""
    if row.get("link"):
        description = f"Linked {row.get('kind') or 'part'}" + (f", revision {row['revision']}" if row.get("revision") is not None else "")
    elif row.get("kind") == "cable" and row.get("cut_length_mm") is not None:
        description = f"Cut length {row['cut_length_mm']} mm"
    elif row.get("print"):
        description = f"Printed ({row['print'].get('process', 'fdm').upper()})"
    if row.get("surface"):  # Only surface bodies: drawn, but no part to make (Design.bom).
        description = f"{description}, {row['note']}" if description else row["note"][:1].upper() + row["note"][1:]
    return {"name": _text(row.get("name") or row.get("item") or "", "bom name"), "quantity": str(row.get("quantity", 1)),
            "description": _text(description, "bom description"), "instances": list(row.get("instances") or [])}


def _cut_list(drawing: Drawing) -> list[dict]:
    """Each distinct body with its quantity and bounding size (largest first) in its own component's axes; components
    that aren't hardware (`Component(..., hardware=False)`) have none."""
    from .design import SURFACE_BOM_NOTE, Component, is_hardware
    from .materials import library
    from .model import is_surface
    owners = []
    if drawing.design is not None:
        for item in drawing.design.instances:
            if isinstance(item["component"], Component) and is_hardware(item["component"]):
                owners.append(item["component"])
    elif drawing.model is not None:
        owners.append(drawing.model)
    rows: dict[tuple, dict] = {}
    if not owners:
        solids = drawing.shape.Solids()
        if drawing.design is not None and drawing.design._not_hardware():  # The hardware's solids only.
            from .design import _instance_shape
            solids = [solid for item in drawing.design.instances if is_hardware(item["component"])
                      and (shape := _instance_shape(item)) is not None for solid in shape.Solids()]
        for index, solid in enumerate(solids):
            rows[("solid", index)] = {"name": f"Solid {index + 1}", "quantity": 1, "size": _size(solid), "material": ""}
    for owner in owners:
        names = owner.__dict__.get("body_names", {})
        assignments = owner.__dict__.get("materials")
        for body_id, body in owner.bodies.items():
            entry = rows.get((id(owner), body_id))
            if entry is None:
                assigned = assignments.of(body_id) if assignments else None
                material = (assigned or {}).get("material") or ""
                label = names.get(body_id) or body_id
                name = label if len(owners) == 1 else f"{getattr(owner, 'name', '')} · {label}"
                material = SURFACE_BOM_NOTE if is_surface(body) else library().get(material, {}).get("name", material)  # No part to make.
                entry = rows[(id(owner), body_id)] = {"name": _text(name, "body name"), "quantity": 0, "size": _size(body),
                                                      "material": _text(material, "material")}
            entry["quantity"] += 1
    return [{**row, "quantity": str(row["quantity"])} for row in rows.values()]


def _size(shape) -> list[float]:
    box = shape.BoundingBox()
    return sorted((box.xlen, box.ylen, box.zlen), reverse=True)


def _length(value_mm: float, units: str) -> str:
    if units == "in":
        text = _fixed(value_mm / 25.4, _inch_places(value_mm / 25.4))
        return text[1:] if text.startswith("0.") else text  # ASME Y14.5: no leading zero on inch values.
    return _fixed(value_mm, 2).rstrip("0").rstrip(".")


# ───────── Projection ─────────

def _edge_points(edge, tolerance: float) -> list:
    """Points along an edge (model mm), within `tolerance` of it: a straight one's ends."""
    import cadquery as cq
    from OCP.GCPnts import GCPnts_QuasiUniformDeflection
    if edge.geomType() == "LINE":
        return [edge.startPoint(), edge.endPoint()]
    points = GCPnts_QuasiUniformDeflection(edge._geomAdaptor(), tolerance)
    if not points.IsDone() or points.NbPoints() < 2:
        return []
    return [cq.Vector(points.Value(i).X(), points.Value(i).Y(), points.Value(i).Z()) for i in range(1, points.NbPoints() + 1)]


def project(shape, view, hidden: bool, tolerance: float, parts: dict | None = None, own: dict | None = None):
    """(visible, hidden) polylines of `shape` seen from `view` (a name, or (towards the viewer, paper x)), in model mm
    on the paper plane, from exact HLR. With `parts` (name → placed shape, together `shape`), each is added to the one
    HLR pass on its own, so they hide each other as before, and `own` gets each one's visible lines."""
    import cadquery as cq
    from OCP.BRepLib import BRepLib
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
    from OCP.HLRAlgo import HLRAlgo_Projector
    from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape
    towards, across = VIEWS[view] if isinstance(view, str) else view
    algo = HLRBRep_Algo()
    for part in (parts or {"": shape}).values():
        algo.Add(part.wrapped)
    algo.Projector(HLRAlgo_Projector(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(*towards), gp_Dir(*across))))
    algo.Update()
    algo.Hide()
    output = HLRBRep_HLRToShape(algo)

    def polylines(compounds):
        lines = []
        for compound in compounds:
            if compound.IsNull():
                continue
            BRepLib.BuildCurves3d_s(compound, 1e-6)  # HLR edges are 2D until given 3D curves.
            for edge in cq.Shape.cast(compound).Edges():
                points = _edge_points(edge, tolerance)
                if points:
                    lines.append([(p.x, p.y) for p in points])
        return lines

    visible = None
    if parts:
        try:  # Each part's own visible lines (HLRBRep_HLRToShape's per-shape overloads); together, every visible line.
            mine = {name: polylines([output.VCompound(part.wrapped), output.OutLineVCompound(part.wrapped)]) for name, part in parts.items()}
            visible = [line for lines in mine.values() for line in lines]
            if own is not None:
                own.update(mine)
        except Exception:  # The kernel can't split them: the lines as one, and balloons report they can't find theirs.
            visible = None
            if own is not None:
                own.clear()
    if visible is None:
        visible = polylines([output.VCompound(), output.OutLineVCompound()])
    dashed = polylines([output.HCompound(), output.OutLineHCompound()]) if hidden else []
    return visible, dashed


# ───────── Projection cache ─────────
# Each view's projection (its visible and hidden lines, each placed part's own visible lines, a section's cut outlines
# and plane point), kept from one build of the sheets for the next: an edit to a sheet's annotations, layout or another
# view redraws it without projecting again. The dispatcher sends the record of the person's own latest build of the
# same model (app/worker.py drawing_projections, steve.cachekeys sheets_key) as the one file in STEVE_DRAWING_CACHE;
# within it, a view's entry is found only by everything its lines depend on (_projection_key): the exact geometry
# projected and how it's seen. Anything else misses and is projected again; an entry that isn't valid is ignored.

PROJECTIONS = "drawing-projections.json"  # app/kernel_protocol.py ARTIFACT_LIMITS; kept with the build, never served
PROJECTION_VERSION = 1
PROJECTION_KEY = re.compile(r"[0-9a-f]{64}")
PROJECTION_LIMIT = 64 * 1024 * 1024  # bytes: a larger record isn't kept (the next build projects again)
PROJECTION_ENTRIES = 1024
_CACHE: "_Projections | None" = None  # While write_artifacts draws the sheets with one.


def _geometry_digest(shape, parts) -> str | None:
    """What a sheet projects, exactly: the BREP of its shape and of each part added to the HLR pass on its own (name,
    placement and all), hashed. Shapes shared by instances are written once. None when it can't be written: that
    sheet's views are projected, as without a cache."""
    import cadquery as cq
    try:
        buffer = io.BytesIO()
        cq.Compound.makeCompound([shape, *(parts or {}).values()]).exportBrep(buffer)
    except Exception:  # noqa: BLE001
        return None
    names = json.dumps(None if parts is None else list(parts))
    return hashlib.sha256(names.encode() + b"\0" + buffer.getvalue()).hexdigest()


def _projection_key(geometry: str, kind: str, *arguments) -> str:
    """A view's entry: the geometry projected (_geometry_digest), the kind of view and every argument that changes its
    lines (exact reprs, never rounded), on this runtime."""
    text = repr((PROJECTION_VERSION, os.environ.get("STEVE_RUNTIME_VERSION") or "", geometry, kind, arguments))
    return hashlib.sha256(text.encode()).hexdigest()


def _finite(value) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _polylines(value) -> list:
    """Stored polylines ([[x, y], …] each) as project returns them; ValueError when they aren't."""
    if not isinstance(value, list):
        raise ValueError("not polylines")
    lines = []
    for line in value:
        if not isinstance(line, list) or not all(isinstance(p, list) and len(p) == 2 and _finite(p[0]) and _finite(p[1]) for p in line):
            raise ValueError("not a polyline")
        lines.append([(p[0], p[1]) for p in line])
    return lines


def _encode(visible, dashed, own: dict, cuts=None, point=None) -> dict:
    """A view's projection as its record's entry. Visible lines that are just each part's together aren't stored twice."""
    lines = lambda found: [[[x, y] for x, y in line] for line in found]  # noqa: E731
    joined = [line for part in own.values() for line in part]
    entry = {"visible": None if own and joined == visible else lines(visible), "hidden": lines(dashed),
             "own": {name: lines(part) for name, part in own.items()}}
    if cuts is not None:
        entry["cuts"] = [[index, [[a[0], a[1], b[0], b[1]] for a, b in segments]] for index, segments in cuts]
        entry["point"] = list(point.toTuple())
    return entry


def _decode(entry, section: bool):
    """(project's or _section's result, each part's visible lines) from a record's entry; None when it isn't one."""
    try:
        if not isinstance(entry["own"], dict) or not all(isinstance(name, str) for name in entry["own"]):
            raise ValueError("not parts")
        mine = {name: _polylines(lines) for name, lines in entry["own"].items()}
        visible = [line for lines in mine.values() for line in lines] if entry["visible"] is None else _polylines(entry["visible"])
        dashed = _polylines(entry["hidden"])
        if not section:
            return (visible, dashed), mine
        cuts = []
        for index, segments in entry["cuts"]:
            if type(index) is not int or index < 0 or not isinstance(segments, list) or not all(
                    isinstance(s, list) and len(s) == 4 and all(map(_finite, s)) for s in segments):
                raise ValueError("not a cut")
            cuts.append((index, [((s[0], s[1]), (s[2], s[3])) for s in segments]))
        point = entry["point"]
        if not cuts or not isinstance(point, list) or len(point) != 3 or not all(map(_finite, point)):
            raise ValueError("not a section")
    except (KeyError, TypeError, ValueError):
        return None
    import cadquery as cq
    return (visible, dashed, cuts, cq.Vector(*point)), mine


class _Projections:
    """One build's projection cache: the entries of the earlier build's record (`found`, checked as they're used), and
    every view this build drew (`kept`), written for the next one."""

    def __init__(self, found: dict | None = None):
        self.found, self.kept, self.reused, self.projected = found or {}, {}, 0, 0

    @classmethod
    def load(cls, folder) -> "_Projections":
        """With the one record in `folder` (runtime/kernel.py puts it there), when there is one and it's a record:
        anything else is left out, never an error."""
        files = sorted(Path(folder).glob("*.json")) if folder and Path(folder).is_dir() else []
        found = {}
        if len(files) == 1:
            try:
                record = json.loads(files[0].read_text())
            except (OSError, ValueError, RecursionError):
                record = None
            if isinstance(record, dict) and record.get("version") == PROJECTION_VERSION and isinstance(record.get("views"), dict):
                found = {key: entry for key, entry in record["views"].items()
                         if isinstance(key, str) and PROJECTION_KEY.fullmatch(key) and isinstance(entry, dict)}
        return cls(found)

    def reuse(self, key: str | None, own: dict, section: bool = False):
        """A view's projection from the earlier build (project's result, or _section's), `own` given each part's
        visible lines; None when it has none under `key`, or one that isn't valid."""
        entry = self.found.get(key) if key else None
        decoded = _decode(entry, section) if entry is not None else None
        if decoded is None:
            return None
        result, mine = decoded
        own.update(mine)
        self.kept[key] = entry
        self.reused += 1
        return result

    def keep(self, key: str | None, visible, dashed, own: dict, cuts=None, point=None):
        """A view just projected, for the next build (none without a key)."""
        self.projected += 1
        if key and len(self.kept) < PROJECTION_ENTRIES:
            self.kept[key] = _encode(visible, dashed, own, cuts, point)

    def write(self):
        """This build's record (PROJECTIONS). Optional: none when it's empty, over PROJECTION_LIMIT or can't be
        written (a line that isn't finite), and the next build projects again."""
        Path(PROJECTIONS).unlink(missing_ok=True)
        if not self.kept:
            return
        try:
            text = json.dumps({"version": PROJECTION_VERSION, "views": self.kept}, separators=(",", ":"), allow_nan=False)
        except ValueError:
            return
        if len(text) <= PROJECTION_LIMIT:
            Path(PROJECTIONS + ".tmp").write_text(text)
            Path(PROJECTIONS + ".tmp").replace(PROJECTIONS)


def _bounds(lines):
    xs = [x for line in lines for x, _ in line]
    ys = [y for line in lines for _, y in line]
    return (min(xs), min(ys), max(xs), max(ys)) if xs else (0.0, 0.0, 0.0, 0.0)


# ───────── Feature dimensions: measured on the model ─────────

class _Problem(Exception):
    """Why a feature dimension isn't drawn: dangling (its geometry is gone) or not measurable as asked."""

    def __init__(self, message: str, dangling: bool = False):
        super().__init__(message)
        self.dangling = dangling


def _view_axes(view):
    """(paper x, paper y, towards the viewer) of a view (a name, or its frame) as model directions: HLR's projector
    frame."""
    import cadquery as cq
    towards, across = VIEWS[view] if isinstance(view, str) else view
    n, x = cq.Vector(*towards).normalized(), cq.Vector(*across).normalized()
    return x, n.cross(x), n


def _resolve(drawing: Drawing, ref: str, view=None) -> list:
    """The faces, edges or vertices a reference names now (in the flat view: on its developed blank). Raises a dangling
    _Problem when it names nothing."""
    import cadquery as cq
    if _sharp_halves(ref) is not None:
        raise _Problem(f"{ref!r} is a virtual sharp, a point that's only on the drawing: a feature dimension's distance "
                       "can end there; attach this to a face or an edge instead.")
    if view == FLAT:
        return _flat_resolve(drawing, ref)
    model = drawing.model
    try:
        if model is None and drawing.design is not None and (found := _instance_geometry(drawing, ref)) is not None:
            shapes = found
        elif model is None:
            match = re.fullmatch(r"select\(\s*(faces|edges|vertices)\s*,\s*([\"'])(.+?)\2\s*\)", ref)
            if not match and drawing.design is not None:
                raise _Problem(f"{ref!r}: a design's sheet refers to its whole result with a selector, like select(faces, "
                               "\">Z\"), or to one placed instance: select(faces, \">Z\", on=\"<instance>\") or "
                               "\"<instance>:<name>\", like \"plate_1:base.top\".")
            if not match:
                raise _Problem(f"{ref!r}: this drawing shows plain CadQuery geometry, which has no persistent names; "
                               "refer to it with a selector like select(faces, \">Z\") or select(edges, \"%CIRCLE\").")
            shapes = getattr(cq.Workplane().add(drawing.shape), match.group(1))(match.group(3)).vals()
        else:
            shapes = _named(model, ref)
    except _Problem:
        raise
    except Exception as error:
        raise _Problem(str(error)[:300] or f"{ref!r} no longer exists.", dangling=True) from None
    if not shapes:
        raise _Problem(f"{ref!r} matches nothing in the model now.", dangling=True)
    return shapes


BEND_LINE = re.compile(r"(.+)\.bend\.line")


def _flat_blank(drawing: Drawing) -> tuple:
    """The flat view's developed blank, named, for what's dimensioned on it: (a model holding only the flat solid and
    its persistent names, each bend's centre line by bend id, the body, its own model). The solid sits in the frame of
    the outline the view draws (the DXF's), so a dimension to it measures the blank as cut. Made once a sheet."""
    if (found := drawing.__dict__.get("_flat_blank")) is not None:
        return found
    from .model import Model
    bodies = _sheet_bodies(drawing)
    body = drawing.view_options[FLAT]["body"] or next(iter(bodies), None)
    model, identity = bodies[body]  # The flat view is drawn, so _flat_pattern found it.
    try:
        sheet = model._sheet(identity)
        shape, names = sheet.developed()
        lines = {}
        for bend in sheet.bends:
            lines.setdefault(bend["id"], []).extend(sheet.bend_line(bend))
    except Exception as error:
        raise _Problem(f"{body}'s flat blank can't be named for dimensioning: {str(error)[:200]}") from None
    blank = Model()
    blank.bodies[identity], blank.names, blank.active = shape, names, identity
    drawing._flat_blank = found = (blank, lines, body, model)
    return found


def _flat_resolve(drawing: Drawing, ref: str) -> list:
    """What a reference names on the flat view's blank: a side (an edge of the blank seen edge-on, like
    "base.side(r.left)" or a hole's wall), an edge or vertex of it, or "<bend>.bend.line", the bend's centre line as
    drawn. On a design's sheet "<instance>:<name>" of the view's body."""
    blank, lines, body, model = _flat_blank(drawing)
    name = ref
    if drawing.design is not None:
        instance = body.rsplit(":", 1)[0]
        name = next((ref[len(prefix):] for prefix in (f"{instance}:", f"{instance.replace('/', ':')}:") if ref.startswith(prefix)), None)
        if name is None:
            raise _Problem(f"{ref!r}: the flat view shows {body}'s blank; name its geometry \"{instance}:<name>\", like "
                           f"\"{instance}:<flange>.bend.line\".")
    if match := BEND_LINE.fullmatch(name):
        if match.group(1) in lines:
            return list(lines[match.group(1)])
        raise _Problem(f"{ref!r}: {body} has no bend {match.group(1)!r} now (its bends: {', '.join(lines) or 'none'}).",
                       dangling=True)
    try:
        sketch = getattr(model, "sketch_edges", None) is not None and model.sketch_edges(name) is not None
    except Exception:  # A sketch's id with a curve it no longer has.
        sketch = True
    if sketch:
        raise _Problem(f"{ref!r} is a sketch curve, which isn't on the developed blank: dimension the blank's edges, holes "
                       "and bend lines.")
    try:
        shapes = _named(blank, name)
    except Exception:
        shapes = []
    if shapes:
        return shapes
    try:
        folded = bool(_named(model, name))
    except Exception:
        folded = False
    if folded:  # Another body's, or what only the folded part has.
        raise _Problem(f"{ref!r} isn't on the developed blank the flat view shows ({body}): dimension its edges, holes and "
                       "bend lines, like \"<flange>.bend.line\".")
    raise _Problem(f"{ref!r} matches nothing on {body}'s blank now.", dangling=True)


def _named(model, ref: str) -> list:
    """The faces, edges or vertices a persistent name or selector names in a part or component."""
    import cadquery as cq
    if (curves := model.sketch_edges(ref)) is not None:  # A sketch's line or arc: a swept wire's path, a construction line.
        return curves
    if ref.startswith("vertex("):
        return model.projection_source(ref)
    if ref.startswith("select(vertices"):
        return [s for s in model._select(ref) if isinstance(s, cq.Vertex)]
    if ref.startswith(("edge(", "select(edges")) or ref.endswith("_edges"):
        return model.edges(ref)
    return model.faces(ref)


def _instance_geometry(drawing: Drawing, ref: str) -> list | None:
    """On a design's sheet, one placed instance's geometry where it's placed: `select(faces, ">Z", on="plate_1")` runs
    the selector on that instance in the design's frame (">Z" is up on the sheet); `"plate_1:base.top"` is a name of
    its component (or linked part; `"rotor_1:disk:body.end"` in a linked design). None for the whole result's refs."""
    import cadquery as cq
    from .design import Component, _instance_shape
    from .links import LinkedInstance
    from .model import FeatureError
    scoped = re.fullmatch(r"select\(\s*(faces|edges|vertices)\s*,\s*([\"'])(.+?)\2\s*,\s*on\s*=\s*([\"'])(.+?)\4\s*\)", ref)
    named = re.fullmatch(r"([^\s()'\":]+):(.+)", ref, re.S)
    if not scoped and not named:
        return None
    instance = (scoped.group(5) if scoped else named.group(1)).strip()
    item = next((item for item in drawing.design.instances if item["name"] == instance), None)
    if item is None:
        placed = ", ".join(item["name"] for item in drawing.design.instances) or "none"
        raise _Problem(f"{ref!r}: {instance!r} isn't a placed instance in the design now (its instances: {placed}).",
                       dangling=True)
    if scoped:
        shape = _instance_shape(item)
        return getattr(cq.Workplane().add(shape), scoped.group(1))(scoped.group(3)).vals() if shape is not None else []
    part, name, location = item["component"], named.group(2).strip(), item["location"]
    if isinstance(part, LinkedInstance):
        try:
            part, name, inner = part._resolve(name)
        except FeatureError as error:
            raise _Problem(f"{ref!r}: {error} Point at it with a selector instead, like select(faces, \">Z\", "
                           f"on=\"{instance}\").") from None
        location = location * inner if inner is not None else location
    elif not isinstance(part, Component):
        raise _Problem(f"{ref!r}: {instance} has no persistent names; point at it with a selector, like select(faces, "
                       f"\">Z\", on=\"{instance}\").")
    return [shape.moved(location) for shape in _named(part, name)]


def _sketch_curves(drawing: Drawing, ref: str) -> list:
    """The sketch curves a feature dimension's ref names ("cl.w.side0", or "<instance>:cl.w.side0" on a design's
    sheet), where they are on the sheet's model; [] for any other ref. Views never draw sketches, so these are drawn as
    centre lines for the dimension to sit on."""
    from .links import LinkedInstance
    try:
        if drawing.model is not None:
            return drawing.model.sketch_edges(ref) or []
        named = drawing.design is not None and re.fullmatch(r"([^\s()'\":]+):(.+)", ref, re.S)
        item = named and next((item for item in drawing.design.instances if item["name"] == named.group(1)), None)
        if not item:
            return []
        part, name, location = item["component"], named.group(2).strip(), item["location"]
        if isinstance(part, LinkedInstance):
            part, name, inner = part._resolve(name)
            location = location * inner if inner is not None else location
        if not hasattr(part, "sketch_edges"):
            return []
        return [curve.moved(location) for curve in part.sketch_edges(name) or []]
    except Exception:  # Its dimension reports why it can't be found.
        return []


def _round(shape):
    """(centre, axis, radius) of a circular edge or a cylindrical face, else None."""
    import cadquery as cq
    if isinstance(shape, cq.Edge) and shape.geomType() == "CIRCLE":
        return shape.arcCenter(), shape.normal(), shape.radius()
    if isinstance(shape, cq.Face) and shape.geomType() == "CYLINDER":
        from OCP.BRepAdaptor import BRepAdaptor_Surface
        cylinder = BRepAdaptor_Surface(shape.wrapped).Cylinder()
        location, direction = cylinder.Axis().Location(), cylinder.Axis().Direction()
        return (cq.Vector(location.X(), location.Y(), location.Z()), cq.Vector(direction.X(), direction.Y(), direction.Z()),
                cylinder.Radius())
    return None


def _samples(shape) -> list:
    import cadquery as cq
    if isinstance(shape, cq.Vertex):
        return [cq.Vector(shape.toTuple())]
    points = [cq.Vector(v.toTuple()) for v in shape.Vertices()]
    for edge in shape.Edges():
        points += [edge.positionAt(i / 8) for i in range(9)]
    return points


def _along(shape, axis, tolerance):
    """The one coordinate a face, edge or vertex has along a paper axis in this view (a face seen edge-on, an edge
    across the axis, a vertex, a hole's centre), or None."""
    import cadquery as cq
    if isinstance(shape, cq.Vertex):
        return cq.Vector(shape.toTuple()).dot(axis)
    if (found := _round(shape)) is not None:
        centre, normal, _ = found
        across = abs(normal.dot(axis))
        if across < 1e-6 or (isinstance(shape, cq.Edge) and across > 1 - 1e-6):
            return centre.dot(axis)
        return None
    if isinstance(shape, cq.Face):
        if shape.geomType() == "PLANE" and abs(shape.normalAt().dot(axis)) > 1 - 1e-6:
            return shape.Center().dot(axis)
        return None
    values = [p.dot(axis) for p in _samples(shape)]
    return values[0] if values and max(values) - min(values) <= tolerance else None


def _line(shapes, n, tolerance):
    """(point, direction, middle) of a straight edge, or a flat face seen edge-on, lying in the paper plane; else None."""
    import cadquery as cq
    shape = shapes[0]
    if isinstance(shape, cq.Edge) and shape.geomType() == "LINE":
        a, b = shape.startPoint(), shape.endPoint()
        if (b - a).Length <= tolerance or abs((b - a).normalized().dot(n)) > 1e-6:
            return None
        return a, b - a, shape.Center()
    if isinstance(shape, cq.Face) and shape.geomType() == "PLANE":
        normal = shape.normalAt()
        if abs(normal.dot(n)) > 1e-6:
            return None
        return shape.Center(), n.cross(normal), shape.Center()
    return None


def _crossing(p1, d1, p2, d2, least: float = 1e-9):
    """Where two lines on the paper cross, or None when they're parallel (the sine of the angle between them `least`
    or under)."""
    cross = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(cross) <= least * math.hypot(*d1) * math.hypot(*d2):
        return None
    t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / cross
    return (p1[0] + t * d1[0], p1[1] + t * d1[1])


def _extreme(shapes, axis, sign: int):
    """(coordinate, point): the farthest a group of faces or edges reaches along a paper axis (sign 1) or against it
    (-1), and a point of it there. Exact, from each one's distance to a plane beyond it (BRepExtrema), never its
    bounding box: a wire's tangent line, the top of a bend. None when it can't be found."""
    import cadquery as cq
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    towards, best = axis * sign, None
    for shape in shapes:
        box = shape.BoundingBox()
        size = max(box.DiagonalLength, 1.0)
        beyond = box.center + towards * (2 * size)
        extrema = BRepExtrema_DistShapeShape(shape.wrapped, cq.Face.makePlane(4 * size, 4 * size, beyond, towards).wrapped)
        if not extrema.IsDone() or extrema.NbSolution() < 1:
            return None
        reach, found = beyond.dot(towards) - extrema.Value(), extrema.PointOnShape1(1)
        if (round_ := _round(shape)) is not None and isinstance(shape, cq.Face):  # A cylinder's tangent: centre ± r exactly.
            exact = round_[0].dot(towards) + round_[2]
            reach = exact if abs(reach - exact) <= 1e-4 * max(round_[2], 1.0) else reach
        if best is None or reach > best[0]:
            best = (reach, cq.Vector(found.X(), found.Y(), found.Z()))
    return (best[0] * sign, best[1]) if best else None


def _round_stock(drawing: Drawing, ref: str, shapes, axis=None) -> str | None:
    """Why a ref can't end a distance at its inside or outside (on `axis`, when given), or None when it can: the round
    faces of wire or tube (a straight's cylinder across the measuring direction, a bend's face) or circular edges."""
    import cadquery as cq
    if _sketch_curves(drawing, ref):
        return (f"{ref!r} is the wire's centre line, which has no inside or outside: name the round face swept along it, "
                "like wire.along(p.side0), or leave this end at its centre.")
    for shape in shapes:  # A bend's face is a torus, or a spline where the sweep couldn't make one.
        kind = shape.geomType() if isinstance(shape, (cq.Face, cq.Edge)) else None
        if not (isinstance(shape, cq.Face) and kind != "PLANE" or kind == "CIRCLE"):
            return (f"{ref!r} isn't round: only round wire or tube (a straight's or a bend's face) or a circular edge has an "
                    "inside and an outside; leave this end at its centre.")
        if axis is not None and kind in ("CYLINDER", "CIRCLE") and abs(_round(shape)[1].dot(axis)) > 1e-6:
            return (f"{ref!r} runs along or at an angle to the measuring direction here, so it has no one tangent line "
                    "across it: dimension to a bend's face, or to a virtual sharp of two straights' faces, or measure "
                    "across it.")
    return None


SHARP = re.compile(r"(?:([^\s()'\":]+):)?sharp\((.*)\)", re.S)


def _sharp_halves(ref: str) -> list | None:
    """The two refs a virtual sharp names: `sharp(leg.bottom|flare.bottom)`, or on a design's sheet
    `clip_1:sharp(leg.bottom|flare.bottom)` (both on clip_1); None for any other ref. The `|` that splits them is the
    one outside brackets and quotes, so either half can be an edge(a|b) or a select(...)."""
    match = SHARP.fullmatch(ref.strip())
    if not match:
        return None
    inner, halves, depth, quote, start = match.group(2), [], 0, None, 0
    for i, c in enumerate(inner):
        if quote:
            quote = None if c == quote else quote
        elif c in "\"'":
            quote = c
        elif c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        elif c == "|" and depth == 0:
            halves.append(inner[start:i].strip())
            start = i + 1
    halves.append(inner[start:].strip())
    if len(halves) != 2 or not all(halves):
        raise _Problem(f"{ref!r}: a virtual sharp is where two straight edges or flat faces would meet, written "
                       "sharp(<one>|<other>), like sharp(leg.bottom|flare.bottom).")
    return [f"{match.group(1)}:{half}" for half in halves] if match.group(1) else halves


def _straight(shape, n, tolerance):
    """(point, direction, radius, points on its line) of a straight of round wire or tube (a cylindrical face whose
    axis lies flat in the paper plane: its axis is the line), or of a straight edge or a flat face seen edge-on (radius
    None, its own points); else None."""
    import cadquery as cq
    found = _round(shape) if isinstance(shape, cq.Face) else None
    if found is not None:
        centre, axis, radius = found
        if abs(axis.dot(n)) > 1e-6:
            return None
        return centre, axis, radius, [centre + axis * (q - centre).dot(axis) for q in _samples(shape)]
    line = _line([shape], n, tolerance)
    return None if line is None else (line[0], line[1], None, _samples(shape))


def _sharp(drawing: Drawing, ref: str, halves: list, axes, tolerance, end: str = "centre", view=None) -> tuple:
    """A virtual sharp in a view: where two straight edges, or flat faces seen edge-on, or the axes of two straights of
    round wire or tube would meet with the bend between them taken away (ASME Y14.5, ISO 129-1). `end` outside or
    inside: where the wire's outsides (away from the other straight) or insides would meet, each line moved by its
    radius. Returns a vertex there (at the first one's depth) and its `corner` with each straight's `ends` nearest it
    (model mm on the paper plane), for the thin lines that show it."""
    import cadquery as cq
    x, y, n = axes
    flat = lambda p: (p.dot(x), p.dot(y))  # noqa: E731
    lines, ends, radii, depth = [], [], [], None
    for half in halves:
        shapes = _resolve(drawing, half, view)
        found = [_straight(shape, n, tolerance) for shape in shapes]
        if None in found:
            raise _Problem(f"{ref!r}: {half!r} isn't a straight edge, a flat face seen edge-on, or a straight of round "
                           "wire or tube, lying flat in this view; a virtual sharp is where two of those would meet.")
        (p, d, radius, _), points = found[0], [flat(q) for *_, on in found for q in on]
        if end != "centre" and (radius is None or any(abs((r or 0) - radius) > tolerance for _, _, r, _ in found)):
            raise _Problem(f"{ref!r}: an {end} sharp is where the {end}s of two straights of round wire or tube would meet; "
                           f"name {half!r} by its round face, like wire.along(p.side0).")
        p, d = flat(p), flat(d)
        size = math.hypot(*d)
        if any(abs((q[0] - p[0]) * d[1] - (q[1] - p[1]) * d[0]) / size > tolerance for q in points):
            raise _Problem(f"{ref!r}: {half!r} is several pieces of geometry that don't lie on one line in this view; "
                           "pick one straight edge or face.")
        lines.append((p, d))
        ends.append(points)
        radii.append(radius)
        depth = (found[0][0] if radius is not None else shapes[0].Center()).dot(n) if depth is None else depth
    least = math.sin(math.radians(0.5))
    corner = _crossing(*lines[0], *lines[1], least=least)
    if corner is None:
        raise _Problem(f"{ref!r}: these two are parallel in this view, so they never meet; dimension to one of them "
                       "instead.")
    if end != "centre":  # Each line moves by its radius away from the other straight (outside) or towards it (inside).
        legs = []
        for points in ends:
            far = max(points, key=lambda q: math.hypot(q[0] - corner[0], q[1] - corner[1]))
            length = max(math.hypot(far[0] - corner[0], far[1] - corner[1]), 1e-12)
            legs.append(((far[0] - corner[0]) / length, (far[1] - corner[1]) / length))
        moves = []
        for i, ((p, d), radius) in enumerate(zip(lines, radii)):
            size, other = math.hypot(*d), legs[1 - i]
            normal = (-d[1] / size, d[0] / size)
            away = -1 if normal[0] * other[0] + normal[1] * other[1] > 0 else 1
            step = radius * away * (1 if end == "outside" else -1)
            moves.append((normal[0] * step, normal[1] * step))
        lines = [((p[0] + m[0], p[1] + m[1]), d) for (p, d), m in zip(lines, moves)]
        ends = [[(q[0] + m[0], q[1] + m[1]) for q in points] for points, m in zip(ends, moves)]
        corner = _crossing(*lines[0], *lines[1], least=least)  # Not parallel: moving a line keeps its direction.
    ends = [min(points, key=lambda q: math.hypot(q[0] - corner[0], q[1] - corner[1])) for points in ends]
    point = x * corner[0] + y * corner[1] + n * depth
    return cq.Vertex.makeVertex(*point.toTuple()), {"corner": corner, "ends": ends, "round": None not in radii}


def _measure(drawing: Drawing, dim: dict) -> dict:
    """What a feature dimension measures on the model (its value in mm or degrees) and where it sits in its view
    (model mm on the paper plane). Raises _Problem when it can't be measured as asked."""
    import cadquery as cq
    view = dim["view"]
    if view not in drawing.frames:
        raise _Problem(f"the {view} view isn't on this sheet; add it or move the dimension to another view.")
    x, y, n = _view_axes(drawing.frames[view])
    tolerance = max(drawing.shape.BoundingBox().DiagonalLength, 1.0) * 1e-6
    ends = dim.get("ends") or ("centre",) * len(dim["refs"])
    groups, sharps, tangents = [], [], []  # tangents: the ends at a round face's inside or outside, by index
    rounds = []  # Which ends could be at an inside or outside: round wire or tube, or a sharp of two of its straights
    for i, (ref, end) in enumerate(zip(dim["refs"], ends)):
        if (halves := _sharp_halves(ref)) is None:
            groups.append(_resolve(drawing, ref, view))
            why = _round_stock(drawing, ref, groups[-1])
            if end != "centre":
                if why:
                    raise _Problem(why)
                tangents.append(i)
            rounds.append(why is None)
            continue
        vertex, sharp = _sharp(drawing, ref, halves, (x, y, n), tolerance, end, view)
        groups.append([vertex])
        rounds.append(sharp.pop("round"))
        sharps.append(sharp)
    flat = lambda p: (p.dot(x), p.dot(y))  # noqa: E731
    kind = dim["kind"]
    if sharps and (kind not in (None, "distance") or len(groups) == 1):
        raise _Problem("a virtual sharp is a point: dimension a distance to it, from a face, an edge, a hole or another "
                       "virtual sharp.")
    if tangents:
        kind = "distance"
    if kind is None:  # Smart dimension: the kind from what's picked.
        first = groups[0][0]
        if len(groups) == 1:
            if _round(first) is not None:
                kind = "radius" if isinstance(first, cq.Edge) and not first.IsClosed() else "diameter"
            elif isinstance(first, cq.Edge) and first.geomType() == "LINE":
                kind = "length"
            else:
                raise _Problem("pick a straight edge, a circle or a cylinder to dimension on its own, or two features "
                               "for a distance or an angle.")
        else:
            lines = [_line(group, n, tolerance) for group in groups]
            crossing = None not in lines and lines[0][1].normalized().cross(lines[1][1].normalized()).Length > 1e-6
            kind = "angle" if crossing else "distance"

    if kind in ("diameter", "radius"):
        found = [_round(shape) for shape in groups[0]]
        if None in found:
            raise _Problem(f"a {kind} needs a circular edge or a cylindrical face.")
        centre, axis, radius = found[0]
        if any(abs(r - radius) > tolerance for _, _, r in found):
            raise _Problem(f"{dim['refs'][0]!r} is several circles of different sizes now; pick one.")
        value, symbol = (2 * radius, "⌀") if kind == "diameter" else (radius, "R")
        facing = abs(axis.dot(n))
        if facing > 1 - 1e-6:
            return {"type": "round", "centre": flat(centre), "radius": radius, "value": value, "symbol": symbol}
        if kind == "radius" or facing > 1e-6:
            raise _Problem(f"the {view} view shows this {'arc' if kind == 'radius' else 'circle'} "
                           + ("side-on; dimension a radius in the view that looks along its axis." if kind == "radius"
                              else "at an angle, so it's foreshortened there; use a view along or across its axis."))
        points = [p for shape in groups[0] for p in _samples(shape)]
        if abs(axis.dot(y)) > 1 - 1e-6:  # Axis up the paper: across it is horizontal.
            u, edge = centre.dot(x), max(p.dot(y) for p in points)
            return {"type": "linear", "axis": "x", "at": [(u - radius, edge), (u + radius, edge)], "value": value, "symbol": symbol}
        if abs(axis.dot(x)) > 1 - 1e-6:
            u, edge = centre.dot(y), min(p.dot(x) for p in points)
            return {"type": "linear", "axis": "y", "at": [(edge, u - radius), (edge, u + radius)], "value": value, "symbol": symbol}
        raise _Problem(f"the {view} view shows this cylinder at an angle; dimension its diameter where its axis runs "
                       "straight up or across the sheet, or where it shows round.")

    if kind == "length":
        edges = groups[0]
        if len(edges) != 1 or not isinstance(edges[0], cq.Edge) or edges[0].geomType() != "LINE":
            raise _Problem(f"a length needs one straight edge; {dim['refs'][0]!r} is {len(edges)} piece(s) of geometry now.")
        a, b = edges[0].startPoint(), edges[0].endPoint()
        if abs((b - a).normalized().dot(n)) > 1e-6:
            raise _Problem(f"this edge runs into the paper in the {view} view, so it's foreshortened there; "
                           "dimension it in a view that shows its true length.")
        groups = [[cq.Vertex.makeVertex(*a.toTuple())], [cq.Vertex.makeVertex(*b.toTuple())]]
        kind = "distance"

    if kind == "angle":
        lines = [_line(group, n, tolerance) for group in groups]
        if None in lines:
            raise _Problem(f"an angle is between two straight edges, or flat faces seen edge-on, that lie flat in the "
                           f"{view} view.")
        (p1, d1, m1), (p2, d2, m2) = [(flat(p), flat(d), flat(m)) for p, d, m in lines]
        corner = _crossing(p1, d1, p2, d2)
        if corner is None:
            raise _Problem("these two are parallel: dimension the distance between them instead.")
        legs, reach = [], []
        for middle, direction in ((m1, d1), (m2, d2)):
            leg = (middle[0] - corner[0], middle[1] - corner[1])
            length = math.hypot(*leg)
            if length <= tolerance:
                leg, length = direction, 0.0
            size = math.hypot(*leg)
            legs.append((leg[0] / size, leg[1] / size))
            reach.append(length)
        degrees = math.degrees(math.acos(max(-1.0, min(1.0, legs[0][0] * legs[1][0] + legs[0][1] * legs[1][1]))))
        return {"type": "angle", "corner": corner, "legs": legs, "reach": reach, "value": degrees, "symbol": ""}

    # A distance: along the paper's x or y, or aligned between two points.
    def coordinate(group, axis):
        values = [_along(shape, axis, tolerance) for shape in group]
        return None if None in values or max(values) - min(values) > tolerance else values[0]

    def point(group):
        shape = group[0]
        if len(group) == 1 and isinstance(shape, cq.Vertex):
            return cq.Vector(shape.toTuple())
        found = [_round(s) for s in group]
        if None not in found and abs(abs(found[0][1].dot(n)) - 1) < 1e-6 and all((c - found[0][0]).cross(n).Length <= tolerance for c, _, _ in found):
            return found[0][0]  # A hole seen round: its centre.
        return None

    def middle(group, axis, value):  # Where an end is, to tell which way the other one is: its axis, or a bend's middle.
        if value is not None:
            return value
        low, high = _extreme(group, axis, -1), _extreme(group, axis, 1)
        return None if low is None or high is None else (low[0] + high[0]) / 2

    def tangent(i, name, axis, across, values):
        """An end at its round face's outside (away from the other end) or inside: its coordinate and where its
        extension line starts, or (None, why)."""
        group = groups[i]
        if why := _round_stock(drawing, dim["refs"][i], group, axis):
            return None, why
        own, other = middle(group, axis, values[i]), middle(groups[1 - i], axis, values[1 - i])
        if own is None or other is None or abs(other - own) <= tolerance:
            return None, (f"{dim['refs'][i]!r} and the other end are level {name}ly in the {view} view, so it has no "
                          f"{ends[i]} that way; try the other direction.")
        towards = 1 if other > own else -1
        found = _extreme(group, axis, towards if ends[i] == "inside" else -towards)
        if found is None:
            return None, f"couldn't find the {ends[i]} of {dim['refs'][i]!r} {name}ly in the {view} view."
        value, at = found
        if all(isinstance(shape, cq.Face) and shape.geomType() == "CYLINDER" for shape in group):
            return value, [p.dot(across) for shape in group for p in _samples(shape)]  # Along its tangent line.
        return value, [at.dot(across)]  # From the tangent point: the top of a bend, a circle's side.

    options, why = {}, None
    for name, axis, across in (("horizontal", x, y), ("vertical", y, x)):
        if dim["direction"] in ("auto", name):
            values = [None if i in tangents else coordinate(group, axis) for i, group in enumerate(groups)]
            spread = [[p.dot(across) for shape in group for p in _samples(shape)] for group in groups]
            for i in tangents:
                values[i], spread[i] = tangent(i, name, axis, across, [None if j in tangents else v for j, v in enumerate(values)])
                why = why or (spread[i] if values[i] is None else None)
            if None not in values:
                options[name] = (values, spread)
    if tangents and dim["direction"] == "aligned":
        raise _Problem("an inside or outside end on round wire or tube is measured horizontally or vertically; for an "
                       "aligned distance, end it at a virtual sharp on the outside or inside of two straights instead.")
    if tangents and not options and why:
        raise _Problem(why)
    points = [point(group) for group in groups] if dim["direction"] in ("auto", "aligned") and not tangents else [None]
    missing = any(p is None for p in points)  # (`in` would compare Vectors with None)
    nonzero = [name for name, (values, _) in options.items() if abs(values[1] - values[0]) > tolerance]
    if dim["direction"] == "aligned" or (dim["direction"] == "auto" and len(nonzero) != 1 and not missing):
        if missing:
            raise _Problem("an aligned distance is between two points: vertices, or holes' centres where they show round.")
        if abs((points[1] - points[0]).dot(n)) > tolerance:
            raise _Problem(f"these points are at different depths in the {view} view, so the distance between them is "
                           "foreshortened there; dimension it horizontally or vertically, or in another view.")
        value = (points[1] - points[0]).Length
        if value <= tolerance:
            raise _Problem("these two are in the same place.")
        return {"type": "aligned", "at": [flat(points[0]), flat(points[1])], "value": value, "symbol": "", "sharps": sharps,
                "round_ends": rounds}
    chosen = nonzero[0] if len(nonzero) == 1 else next(iter(options), None)
    if chosen is None:
        asked = "" if dim["direction"] == "auto" else f" {dim['direction']}ly"
        raise _Problem(f"can't measure between these{asked} in the {view} view: pick faces seen edge-on, straight edges "
                       "across the measuring direction, vertices or holes.")
    values, spread = options[chosen]
    if abs(values[1] - values[0]) <= tolerance:
        raise _Problem(f"these two are 0 apart {chosen}ly in the {view} view; try the other direction.")
    if chosen == "horizontal":  # Extension lines start at each feature's top, below the dimension line.
        at = [(values[0], max(spread[0])), (values[1], max(spread[1]))]
        return {"type": "linear", "axis": "x", "at": at, "value": abs(values[1] - values[0]), "symbol": "", "sharps": sharps,
                "round_ends": rounds}
    at = [(min(spread[0]), values[0]), (min(spread[1]), values[1])]  # From each feature's left side.
    return {"type": "linear", "axis": "y", "at": at, "value": abs(values[1] - values[0]), "symbol": "", "sharps": sharps,
            "round_ends": rounds}


# ───────── The sheet ─────────

class Sheet:
    """Paper-space primitives (mm, y up from the sheet's bottom-left corner), written as SVG and DXF."""

    def __init__(self, size, style):
        self.width, self.height = size
        self.style = style
        self.lines = []  # (points, kind): kind visible | hidden | thin | frame | chain | hatch
        self.fills = []  # closed polygons, filled black (arrowheads)
        self.shades = []  # (polygon, level): shaded views' faces, farthest first, under everything else (SVG only)
        self.circles = []  # (x, y, r, kind)
        self.texts = []  # (x, y, text, size, anchor, rotation, bold)
        self.groups = []  # ((kind, number), (lines, fills, texts) from, ... to, view or None): a feature dimension, balloon…
        self.views = []  # (view name, (lines, circles, texts) from, ... to): a section or detail view, a DXF group
        self.spans = []  # (view name, (lines, circles, texts, fills, shades) from, ... to): what each view draws (SVG)
        self.layers = []  # (layer name, (lines, circles, texts, fills) from, ... to): the title block's, tables' and view dimensions' (DXF only)
        self.parents = {}  # A section or detail view → the view it hangs off
        self.on = None  # The view being drawn (Sheet.view): the groups opened in it are on it
        self.hole_rows = []  # The hole tables' rows in mm, for the drawing's CSV
        self.picks = []  # (view, kind, ref, face, points): what a click on the sheet picks (_picks); never drawn or exported
        self.regions = []  # (kind, index, (x0, y0, x1, y1)): where the title block and each table went, for the Drawing tab
        self.images = []  # (x, y, w, h, image): title block logos, lower-left corner and size (images: name, data, kind, pixels)
        self.tags = {}  # ("lines" | "fills", index) → data attributes: in a group, drawn as its own path (Sheet.leader, tagged)
        self.marks = {}  # line index → the section whose cutting-plane mark it's part of, for _overlaps to name
        self.leaders = set()  # line indices that are leaders (an annotation's line out to what it's on), for _overlaps

    def _counts(self):
        return len(self.lines), len(self.circles), len(self.texts), len(self.fills), len(self.shades)

    def rewind(self, counts):
        """Takes back what's been drawn since `counts` (_counts), to draw it again somewhere else."""
        for items, n in zip((self.lines, self.circles, self.texts, self.fills, self.shades), counts):
            del items[n:]
        self.tags = {key: value for key, value in self.tags.items() if key[1] < counts[0 if key[0] == "lines" else 3]}
        self.marks = {i: name for i, name in self.marks.items() if i < counts[0]}
        self.leaders = {i for i in self.leaders if i < counts[0]}

    @contextlib.contextmanager
    def view(self, name: str, parent: str | None = None, part: bool = False):
        """What's drawn inside is view `name`'s: its own <g data-view-lines> in the SVG (a child view's with its
        `data-parent`), so the Drawing tab moves it whole while it's dragged, and the groups opened inside are on it
        (their `data-on-view`). A section or detail view (`part`) is its own group in the DXF too, so it moves as one in
        other CAD tools. Its feature dimensions stay their own groups."""
        start, outer = self._counts(), self.on
        self.on = name
        if parent is not None:
            self.parents[name] = parent
        try:
            yield
        finally:
            self.on = outer
            end = self._counts()
            self.spans.append((name, start, end))
            if part:
                self.views.append((name, start[:3], end[:3]))

    @contextlib.contextmanager
    def group(self, number: int, kind: str = "dimension"):
        """What's drawn inside belongs to feature dimension `number` (or balloon, or hole table's tags: `kind`): its
        own <g data-dimension> (data-balloon, data-hole-table) in the SVG, with the view it's on, so the Drawing tab can
        pick and move it, and its own group in the DXF, so it moves as one in other CAD tools."""
        start, view = (len(self.lines), len(self.fills), len(self.texts)), self.on
        try:
            yield
        finally:
            self.groups.append(((kind, int(number)), start, (len(self.lines), len(self.fills), len(self.texts)), view))

    @contextlib.contextmanager
    def layer(self, name: str):
        """What's drawn inside goes on DXF layer `name` (upper-cased): the title block's and tables' lines and text, a
        view's overall dimensions. Only the DXF reads it; the SVG is unchanged."""
        start = self._counts()[:4]
        try:
            yield
        finally:
            self.layers.append((name, start, self._counts()[:4]))

    def _owners(self) -> dict:
        """(list name, index) → the (kind, number) of the group it belongs to."""
        return {(key, i): owner for owner, start, end, _ in self.groups
                for key, a, b in zip(("lines", "fills", "texts"), start, end) for i in range(a, b)}

    def line(self, points, kind="thin"):
        self.lines.append(([tuple(p) for p in points], kind))

    def rect(self, x, y, w, h, kind="thin"):
        self.line([(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)], kind)

    def text(self, x, y, text, size=None, anchor="start", rotation=0.0, width=None, bold=False):
        size = size or self.style["text"]
        if width is not None:  # Shortened to fit (an estimate: sans-serif averages about 0.6 em a character, bold 0.65).
            fits = max(1, int(width / ((0.65 if bold else 0.6) * size)))
            text = text if len(text) <= fits else text[:max(1, fits - 1)] + "…"
        if text:
            self.texts.append((x, y, text, size, anchor, rotation, bool(bold)))

    def arrow(self, tip, toward):
        (x, y), (dx, dy) = tip, toward
        length = math.hypot(dx, dy) or 1.0
        ux, uy = dx / length, dy / length
        back = (x + 3 * ux, y + 3 * uy)
        self.fills.append([(x, y), (back[0] - 0.5 * uy, back[1] + 0.5 * ux), (back[0] + 0.5 * uy, back[1] - 0.5 * ux)])

    def _point(self, p) -> str:
        """A paper point as the SVG's frame has it (mm, y down), for a data attribute."""
        return f"{p[0]:.3f} {self.height - p[1]:.3f}"

    def leader(self, tip, to, head: str | None = "arrow"):
        """A thin line from `tip`, on the model, to `to`, with an arrowhead (or a dot) at the tip. In a group, it's its
        own path tagged with its tip (`data-leader`; the arrowhead's `data-arrow` with its tip and the line's other end,
        a dot `data-anchored`), so the Drawing tab keeps the tip where it is and re-routes the line to what's dragged."""
        self.tags["lines", len(self.lines)] = f'data-leader="{self._point(tip)}"'
        self.leaders.add(len(self.lines))
        self.line([tip, to])
        if head == "dot":
            self.tags["fills", len(self.fills)] = 'data-anchored=""'
            _dot(self, tip)
        elif head == "arrow" and math.hypot(to[0] - tip[0], to[1] - tip[1]) > 1e-6:
            self.tags["fills", len(self.fills)] = f'data-arrow="{self._point(tip)} {self._point(to)}"'
            self.arrow(tip, (to[0] - tip[0], to[1] - tip[1]))

    @contextlib.contextmanager
    def tagged(self, attributes: str):
        """The lines and fills drawn inside are tagged with `attributes` (a dimension line and its arrows:
        `data-dimension-line`), each its own path in its group."""
        lines, fills = len(self.lines), len(self.fills)
        try:
            yield
        finally:
            self.tags.update({("lines", i): attributes for i in range(lines, len(self.lines))})
            self.tags.update({("fills", i): attributes for i in range(fills, len(self.fills))})

    def _widths(self) -> dict:
        thin = self.style["thin"]
        return {"visible": self.style["visible"], "hidden": self.style["hidden"], "thin": thin, "frame": 0.7, "chain": thin, "hatch": thin}

    def _strokes(self, lines) -> list[str]:
        width = self._widths()
        out = []
        for kind in ("frame", "visible", "hidden", "thin", "chain", "hatch"):
            parts = [" ".join(("M" if i == 0 else "L") + f"{x:.3f} {self.height - y:.3f}" for i, (x, y) in enumerate(points))
                     for points, k in lines if k == kind and len(points) >= 2]
            if parts:
                # Hidden lines dashed; cutting planes long dash, dot (ISO 128-20 type 04 / ASME Y14.2 cutting-plane).
                dash = {"hidden": ' stroke-dasharray="3 1.5"', "chain": ' stroke-dasharray="8 1.5 0.5 1.5"'}.get(kind, "")
                out.append(f'<path stroke-width="{width[kind]:g}"{dash} d="{" ".join(parts)}"/>')
        return out

    def _fills(self, fills) -> list[str]:
        return (['<path fill="#000000" d="' + " ".join(
            "M" + " L".join(f"{x:.3f} {self.height - y:.3f}" for x, y in polygon) + " Z" for polygon in fills) + '"/>'] if fills else [])

    def _shades(self, shades) -> list[str]:
        """Shaded views' faces in their order: a path per run of one grey, outlined in it so neighbours leave no seams."""
        out, run, level = [], [], None
        for polygon, shade in [*shades, (None, None)]:
            if shade != level and run:
                grey = round(SHADE_LIGHT - (SHADE_LIGHT - SHADE_DARK) * level / max(SHADES - 1, 1))
                colour = f"#{grey:02x}{grey:02x}{grey:02x}"
                out.append(f'<path fill="{colour}" stroke="{colour}" stroke-width="0.06" stroke-linejoin="round" d="{"".join(run)}"/>')
                run = []
            if polygon is not None:
                level = shade
                run.append("M" + "L".join(f"{x:.2f} {self.height - y:.2f}" for x, y in polygon) + "Z")
        return out

    def _texts(self, texts) -> list[str]:
        out = []
        for x, y, text, size, anchor, rotation, bold in texts:
            turn = f' transform="rotate({-rotation:g} {x:.3f} {self.height - y:.3f})"' if rotation else ""
            weight = ' font-weight="bold"' if bold else ""
            out.append(f'<text x="{x:.3f}" y="{self.height - y:.3f}" font-size="{size:g}" text-anchor="{anchor}"{weight}{turn}>'
                       f'{escape(text)}</text>')
        return out

    def svg(self) -> str:
        width = self._widths()
        owners = self._owners()
        spans = {(key, i): name for name, start, end in self.spans
                 for key, a, b in zip(("lines", "circles", "texts", "fills", "shades"), start, end) for i in range(a, b)}
        # What view `name` draws (none: the sheet's own frame, title block and tables), less its annotations' groups.
        mine = lambda key, items, name=None: [item for i, item in enumerate(items)  # noqa: E731
                                              if (key, i) not in owners and spans.get((key, i)) == name]
        stroke = '<g fill="none" stroke="#000000" stroke-linecap="round" stroke-linejoin="round">'
        font = 'font-family="Helvetica, Arial, sans-serif"'

        def drawn(name=None) -> list[str]:
            out = [*self._shades(mine("shades", self.shades, name)), stroke, *self._strokes(mine("lines", self.lines, name))]
            for x, y, r, kind in mine("circles", self.circles, name):
                out.append(f'<circle cx="{x:.3f}" cy="{self.height - y:.3f}" r="{r:.3f}" stroke-width="{width[kind]:g}"/>')
            return [*out, "</g>", *self._fills(mine("fills", self.fills, name)), f'<g fill="#000000" {font}>',
                    *self._texts(mine("texts", self.texts, name)), "</g>"]

        out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width:g}mm" height="{self.height:g}mm" '
               f'viewBox="0 0 {self.width:g} {self.height:g}">',
               f'<rect x="0" y="0" width="{self.width:g}" height="{self.height:g}" fill="#ffffff"/>']
        for x, y, w, h, image in self.images:  # Title block logos, embedded (a data: URI of their checked kind only).
            out.append(f'<image x="{x:.3f}" y="{self.height - y - h:.3f}" width="{w:.3f}" height="{h:.3f}" preserveAspectRatio="none" '
                       f'href="data:{images.MEDIA[image["kind"]]};base64,{images.encode(image["data"])}"/>')
        out += drawn()
        for name in dict.fromkeys(name for name, _, _ in self.spans):  # Each view's lines, hatching and label, to move whole.
            parent = f" data-parent={quoteattr(self.parents[name])}" if name in self.parents else ""
            out += [f"<g data-view-lines={quoteattr(name)}{parent}>", *drawn(name), "</g>"]
        for (kind, number), (l0, f0, t0), (l1, f1, t1), view in self.groups:  # Each feature dimension (balloon…) on its own, on top.
            on = f" data-on-view={quoteattr(view)}" if view is not None else ""
            # Its leaders, extension lines and dimension line (Sheet.leader, tagged) each a path of its own, tagged.
            lines = [self.lines[i] for i in range(l0, l1) if ("lines", i) not in self.tags]
            fills = [self.fills[i] for i in range(f0, f1) if ("fills", i) not in self.tags]
            own = [f'<path {self.tags["lines", i]} {self._strokes([self.lines[i]])[0].removeprefix("<path ")}'
                   for i in range(l0, l1) if ("lines", i) in self.tags and len(self.lines[i][0]) >= 2]
            heads = [f'<path {self.tags["fills", i]} {self._fills([self.fills[i]])[0].removeprefix("<path ")}'
                     for i in range(f0, f1) if ("fills", i) in self.tags]
            out += [f'<g data-{kind}="{number}"{on}>', stroke, *self._strokes(lines), *own, "</g>",
                    *self._fills(fills), *heads, f'<g fill="#000000" {font}>', *self._texts(self.texts[t0:t1]), "</g></g>"]
        if self.picks:  # What each line is on the model, for the Drawing tab's tools (unstroked: it draws nothing).
            out.append('<g data-picks="" fill="none" stroke="none">')
            for view, kind, ref, face, points in self.picks:
                tags = f'data-view={quoteattr(view)} data-pick="{kind}"' + (f" data-ref={quoteattr(ref)}" if ref else "") + (
                    f" data-face={quoteattr(face)}" if face else "")
                if kind == "vertex":
                    (x, y), = points
                    out.append(f'<circle {tags} cx="{x:.3f}" cy="{self.height - y:.3f}" r="0.4"/>')
                else:
                    d = " ".join(("M" if i == 0 else "L") + f"{x:.3f} {self.height - y:.3f}" for i, (x, y) in enumerate(points))
                    out.append(f'<path {tags} d="{d}"/>')
            out.append("</g>")
        out.append("</svg>")
        return "\n".join(out)

    def dxf(self, path):
        import ezdxf
        document = ezdxf.new("R2010", setup=True)
        document.units = 4  # Millimetres.
        owners, members, views, parts = self._owners(), {}, {}, {}
        # What has a layer of its own: a feature dimension's lines, arrows and value on DIMENSION; else the title block's,
        # tables' (TITLEBLOCK) and views' overall dimensions' (Sheet.layer); everything else on its kind's layer or TEXT.
        own = {(key, i): name.upper() for name, start, end in self.layers
               for key, a, b in zip(("lines", "circles", "texts", "fills"), start, end) for i in range(a, b)}
        own.update({place: "DIMENSION" for place, (kind, _) in owners.items() if kind == "dimension"})
        kinds, used = {kind for _, kind in self.lines}, set(own.values())
        some = {"CHAIN": "chain" in kinds, "HATCH": "hatch" in kinds, "DIMENSION": "DIMENSION" in used, "TITLEBLOCK": "TITLEBLOCK" in used,
                "BEND": "BEND" in used}
        for layer, color, linetype in (("FRAME", 7, "Continuous"), ("VISIBLE", 7, "Continuous"), ("HIDDEN", 8, "DASHED"),
                                       ("THIN", 7, "Continuous"), ("TEXT", 7, "Continuous"), ("CHAIN", 7, "CENTER"),
                                       ("HATCH", 8, "Continuous"), ("DIMENSION", 7, "Continuous"), ("TITLEBLOCK", 7, "Continuous"),
                                       ("BEND", 7, "CENTER")):  # A flat view's bend lines and notes.
            if some.get(layer, True):  # Section views', dimensions' and the title block's layers only where there are some.
                document.layers.new(layer, dxfattribs={"color": color, "linetype": linetype})
        space = document.modelspace()
        for name, start, end in self.views:
            for key, a, b in zip(("lines", "circles", "texts"), start, end):
                views.update({(key, i): name for i in range(a, b)})

        def owned(key, index, entity):
            if (key, index) in owners:
                members.setdefault(owners[key, index], []).append(entity)
            elif (key, index) in views:
                parts.setdefault(views[key, index], []).append(entity)

        for index, (points, kind) in enumerate(self.lines):
            if len(points) >= 2:
                owned("lines", index, space.add_lwpolyline(points, dxfattribs={"layer": own.get(("lines", index), kind.upper())}))
        for index, polygon in enumerate(self.fills):
            # A DXF SOLID takes 3 or 4 corners: a larger fill (a leader's dot, an octagon) goes as the triangles of a fan;
            # every fill drawn is convex.
            pieces = [polygon] if len(polygon) <= 4 else [[polygon[0], polygon[i], polygon[i + 1]] for i in range(1, len(polygon) - 1)]
            for piece in pieces:
                owned("fills", index, space.add_solid(piece, dxfattribs={"layer": own.get(("fills", index), "THIN")}))
        for index, (x, y, r, kind) in enumerate(self.circles):
            owned("circles", index, space.add_circle((x, y), r, dxfattribs={"layer": own.get(("circles", index), kind.upper())}))
        if any(text[6] for text in self.texts):  # Title block cells' bold text: a text style of Arial Bold.
            document.styles.new("BOLD", dxfattribs={"font": "arialbd.ttf"})
        for index, (x, y, text, size, anchor, rotation, bold) in enumerate(self.texts):
            shift = {"start": 0.0, "middle": 0.5, "end": 1.0}[anchor] * (0.65 if bold else 0.6) * size * len(text)
            angle = math.radians(rotation)
            for glyph, code in GLYPHS.items():
                text = text.replace(glyph, code)
            weight = {"style": "BOLD"} if bold else {}
            layer = own.get(("texts", index), "TEXT")
            owned("texts", index, space.add_text(text, dxfattribs={"layer": layer, "height": size, "rotation": rotation, **weight,
                                                                    "insert": (x - shift * math.cos(angle), y - shift * math.sin(angle))}))
        if self.images:  # Title block logos: IMAGE entities of the image files beside the DXF in drawings.zip.
            document.layers.new("IMAGE", dxfattribs={"color": 7})
            definitions = {}
            for x, y, w, h, image in self.images:
                if image["name"] not in definitions:
                    definitions[image["name"]] = document.add_image_def(filename=image["name"], size_in_pixel=image["pixels"])
                space.add_image(definitions[image["name"]], insert=(x, y), size_in_units=(w, h), dxfattribs={"layer": "IMAGE"})
        for (kind, number), entities in members.items():  # Each feature dimension, balloon and table's tags moves as one.
            prefix, what = {"dimension": ("DIM", "Feature dimension"), "balloon": ("BALLOON", "Item balloon"),
                            "hole-table": ("HOLETAGS", "Hole tags of hole table"), "datum": ("DATUM", "Datum"),
                            "frame": ("FCF", "Tolerance frame"), "note": ("NOTE", "Note"), "weld": ("WELD", "Weld symbol")}[kind]
            document.groups.new(f"{prefix}-{number}", description=f"{what} {number}").set_data(entities)
        for name, entities in parts.items():  # Each section and detail view: its lines, hatching and label.
            document.groups.new(f"VIEW-{name}", description=f"View {name}").set_data(entities)
        document.saveas(str(path))


def _frame(sheet: Sheet, standard: str):
    """Trimmed-sheet frame with grid reference zones (ISO 5457: 20 mm filing margin on the left, 10 mm elsewhere)."""
    w, h = sheet.width, sheet.height
    left = 20.0 if standard == "ISO" else (12.7 if max(w, h) > 450 else 10.0)
    margin = 10.0 if standard == "ISO" else left
    x0, y0, x1, y1 = left, margin, w - margin, h - margin
    sheet.rect(x0, y0, x1 - x0, y1 - y0, "frame")
    columns, rows = max(4, round((x1 - x0) / 50)), max(4, round((y1 - y0) / 50))
    for i in range(columns):
        xa, xb = x0 + (x1 - x0) * i / columns, x0 + (x1 - x0) * (i + 1) / columns
        label = str(i + 1 if standard == "ISO" else columns - i)  # ISO counts from the left, ASME from the right.
        for y, edge in ((y1, y1 + 5), (y0, y0 - 5)):
            if i:
                sheet.line([(xa, y), (xa, edge)])
            sheet.text((xa + xb) / 2, (y + edge) / 2 - 1, label, sheet.style["small"], "middle")
    for j in range(rows):
        ya, yb = y1 - (y1 - y0) * j / rows, y1 - (y1 - y0) * (j + 1) / rows
        label = chr(ord("A") + j) if standard == "ISO" else chr(ord("A") + rows - 1 - j)  # ASME letters from the bottom.
        for x, edge in ((x0, x0 - 5), (x1, x1 + 5)):
            if j:
                sheet.line([(x, ya), (edge, ya)])
            sheet.text((x + edge) / 2, (ya + yb) / 2 - 1, label, sheet.style["small"], "middle")
    return x0, y0, x1, y1


def _projection_symbol(sheet: Sheet, cx: float, cy: float, projection: str):
    """ISO 5456-2's truncated cone: its end view left of the cone for third angle, right of it for first angle."""
    cone_x = cx - 7 if projection == "first" else cx + 1
    circle_x = cx + 4 if projection == "first" else cx - 4
    sheet.line([(cone_x, cy - 1.5), (cone_x + 6, cy - 3), (cone_x + 6, cy + 3), (cone_x, cy + 1.5), (cone_x, cy - 1.5)], "visible")
    sheet.circles += [(circle_x, cy, 3.0, "visible"), (circle_x, cy, 1.5, "visible")]


def _table(sheet: Sheet, x, y, widths, rows, height=6.0, upward=True, size=None):
    """Rows of cells from (x, y), the first row there and the rest above it (or below with upward=False)."""
    size = size or sheet.style["small"] + 0.5
    for index, row in enumerate(rows):
        top = y + (index + 1) * height if upward else y - index * height
        left = x
        for width, value in zip(widths, row):
            sheet.rect(left, top - height, width, height)
            sheet.text(left + 1.2, top - height / 2 - size * 0.35, value, size, width=width - 2.4)
            left += width
    return len(rows) * height


def _title_place(left, bottom, width, height, size, align, valign, lines=1):
    """Where text `size` mm high goes in a title block cell: x and anchor across it (align), and its first line's
    baseline up it (valign), its lines 1.4 × size apart."""
    anchor = TITLE_ALIGN[align or "left"]
    x = {"start": left + 1, "middle": left + width / 2, "end": left + width - 1}[anchor]
    pitch = (lines - 1) * 1.4 * size
    if valign == "top":
        y = bottom + height - 0.8 - 0.72 * size  # Capitals are about 0.72 of the text's height.
    elif valign == "middle":
        y = bottom + height / 2 - size * 0.35 + pitch / 2
    else:
        y = bottom + min(1.6, max(0.4, height - 0.8 - 0.72 * size - pitch)) + pitch
    return x, y, anchor


def _title_block(sheet: Sheet, drawing: Drawing, x1, y0, scale_text, number, count):
    """ISO 7200-style title block in the bottom-right corner (TITLE_WIDTH wide), or the sheet's own (title_block=);
    returns its height."""
    style, fields = sheet.style, drawing.fields
    x = x1 - TITLE_WIDTH

    def cell(left, bottom, width, height, label, value, size=None):
        sheet.rect(left, bottom, width, height)
        sheet.text(left + 1, bottom + height - style["small"] - 0.4, label, style["small"] * 0.8, width=width - 2)
        sheet.text(left + 1, bottom + 1.6, value, size or style["text"] * 0.85, width=width - 2)

    revision = fields.get("revision") or (drawing.revisions[-1]["rev"] if drawing.revisions else "")
    sheet_text = fields.get("sheet") or f"{number}/{count}"  # fields["sheet"] (like "1 OF 2") replaces the n/m.
    if drawing.title_block:
        values = {"title": drawing.title, "revision": revision, "scale": scale_text, "sheet": sheet_text,
                  "size": drawing.sheet, "units": drawing.units}
        x, row = x1 - drawing.table_width, y0
        for line in drawing.title_block:
            for item in line["cells"]:
                left, width, height, field = x + item["x"], item["width"], item["height"], item["field"]
                sheet.rect(left, row, width, height)  # Its rows' height, so no row line crosses a spanning cell.
                size = item["text_height"] or style["text"] * 0.85
                lines = item["text"] if item["text"] is not None else [values.get(field, fields.get(field, ""))] if field else [""]
                symbol = field == "projection" and item["text"] is None
                # The value: under its label at the bottom by default, or in the middle with no label.
                tx, ty, anchor = _title_place(left, row, width, height, size, item["align"],
                                              item["valign"] or ("bottom" if item["label"] else "middle"), len(lines))
                label_size = item["label_height"] or style["small"] * 0.8
                lx, ly, label_anchor = _title_place(left, row, width, height, label_size, item["label_align"], item["label_valign"] or "top")
                if item["label_height"] is None and item["label_valign"] is None:
                    ly = row + height - style["small"] - 0.4  # As the ISO 7200 block's labels.
                if item["label"] and not symbol and any(lines) and item["valign"] is None and item["label_valign"] is None \
                        and ty + 0.72 * size > ly - 0.3:
                    # A low cell: the label up to its top and the value down to its bottom, the label smaller if need be.
                    ty = row + 0.5 + (len(lines) - 1) * 1.4 * size
                    if item["label_height"] is None:
                        label_size = max(1.0, min(label_size, (height - 1.3 - 0.72 * size - (len(lines) - 1) * 1.4 * size) / 0.72))
                    ly = row + height - 0.5 - 0.72 * label_size
                if item["label"]:
                    sheet.text(lx, ly, item["label"], label_size, label_anchor, width=width - 2, bold=item["label_bold"])
                if item["image"]:
                    # Scaled to fit inside the padding (under a label at the top), its aspect kept.
                    pad = item["padding"]
                    top = row + height - pad - (label_size + 0.8 if item["label"] and (item["label_valign"] or "top") == "top" else 0.0)
                    room_w, room_h = width - 2 * pad, top - row - pad
                    pw, ph = item["image"]["pixels"]
                    if room_w > 0 and room_h > 0:
                        fit = min(room_w / pw, room_h / ph)
                        iw, ih = pw * fit, ph * fit
                        ix = {"start": left + pad, "middle": left + (width - iw) / 2, "end": left + width - pad - iw}[TITLE_ALIGN[item["align"] or "centre"]]
                        iy = {"top": top - ih, "middle": row + pad + (room_h - ih) / 2, "bottom": row + pad}[item["valign"] or "middle"]
                        sheet.images.append((ix, iy, iw, ih, item["image"]))
                elif symbol:
                    _projection_symbol(sheet, left + width / 2, row + height / 2, drawing.projection)
                else:
                    for index, text in enumerate(lines):
                        sheet.text(tx, ty - index * 1.4 * size, text, size, anchor, width=width - 2, bold=item["bold"])
            row += line["height"]
        sheet.rect(x, y0, drawing.table_width, row - y0, "visible")
        sheet.regions.append(("title-block", None, (x, y0, x1, row)))
        return row - y0

    # Bottom row: title, drawing number, revision.
    cell(x, y0, 110, 14, "TITLE", drawing.title, style["text"] * 1.4)
    cell(x + 110, y0, 50, 14, FIELDS["number"], fields.get("number", ""))
    cell(x + 160, y0, 20, 14, "REV", revision)
    # Second row: owner and approvals.
    row = y0 + 14
    cell(x, row, 60, 9, FIELDS["owner"], fields.get("owner", ""))
    for offset, key in ((60, "drawn_by"), (90, "checked_by"), (120, "approved_by"), (150, "date")):
        cell(x + offset, row, 30, 9, FIELDS[key], fields.get(key, ""))
    # Third row: material, tolerances, units, scale, size, sheet, projection.
    row += 9
    cell(x, row, 46, 9, FIELDS["material"], fields.get("material", ""))
    cell(x + 46, row, 44, 9, FIELDS["tolerances"], fields.get("tolerances", ""))
    cell(x + 90, row, 16, 9, "UNITS", drawing.units)
    cell(x + 106, row, 18, 9, "SCALE", scale_text)
    cell(x + 124, row, 14, 9, "SIZE", drawing.sheet)
    cell(x + 138, row, 18, 9, "SHEET", sheet_text)
    sheet.rect(x + 156, row, 24, 9)
    _projection_symbol(sheet, x + 168, row + 4.5, drawing.projection)
    row += 9
    # Finish and any other fields, two to a row.
    extra = [(FIELDS.get(key, key.replace("_", " ").upper()), value) for key, value in fields.items()
             if (key not in FIELDS or key == "finish") and key != "sheet"]
    extra = [item for item in extra if item[0] != "REVISION"]
    for index in range(0, len(extra), 2):
        for column, (label, value) in enumerate(extra[index:index + 2]):
            cell(x + column * 90, row, 90, 9, label, value)
        row += 9
    sheet.rect(x, y0, TITLE_WIDTH, row - y0, "visible")
    sheet.regions.append(("title-block", None, (x, y0, x1, row)))
    return row - y0


def _stack(sheet: Sheet, drawing: Drawing, x1, bottom, top, hole_tables=()):
    """The parts list, cut list, hole tables (`hole_tables`: their numbers, titles and rows) and notes above the title
    block (ISO 7573: header at the bottom, items upward). Rows that don't fit are summarised. Returns the height used;
    each table and the notes record their region on the sheet."""
    x, used = x1 - drawing.table_width, 0.0
    sections = []
    if drawing.bom:
        sections.append(("parts-list", None, "PARTS LIST", [12, 14, 74, 80], ["ITEM", "QTY", "NAME", "DESCRIPTION"],
                         [[str(i + 1), row["quantity"], row["name"], row["description"]] for i, row in enumerate(drawing.bom)]))
    if drawing.cut_list:
        unit = drawing.units
        sections.append(("cut-list", None, "CUT LIST", [12, 14, 74, 50, 30], ["ITEM", "QTY", "BODY", f"SIZE ({unit})", "MATERIAL"],
                         [[str(i + 1), row["quantity"], row["name"], " × ".join(_length(v, unit) for v in row["size"]), row["material"]]
                          for i, row in enumerate(drawing.cut_list)]))
    for index, title, rows in hole_tables:
        sections.append(("hole-table", index, title, HOLE_WIDTHS, ["TAG", f"X ({drawing.units})", f"Y ({drawing.units})", "⌀", "DEPTH", "CALLOUT"], rows))
    for kind, index, title, widths, header, rows in sections:
        room = int((top - bottom - used - 13) // 6)
        if room < 1:
            break
        if len(rows) > room:
            wide = next(i for i, w in enumerate(widths) if i >= 2 and w >= 60)  # The summary: in the first wide column.
            more = [""] * len(widths)
            more[wide] = f"… {len(rows) - room + 1} more in the drawing's CSV"
            rows = rows[:room - 1] + [more]
        start = used
        with sheet.layer("titleblock"):  # The tables beside the title block; the notes stay on TEXT.
            used += _table(sheet, x, bottom + used, _widths(drawing, widths), [header] + rows)
            sheet.rect(x, bottom + used, drawing.table_width, 7)
            sheet.text(x + 1.2, bottom + used + 2.2, title, sheet.style["small"] + 0.5)
        used += 7
        sheet.regions.append((kind, index, (x, bottom + start, x1, bottom + used)))
    if drawing.notes:
        size = sheet.style["small"] + 0.5
        per_line = int((drawing.table_width - 8) / (0.6 * size))
        lines = []
        for index, note in enumerate(drawing.notes):
            words, current = note.split(), f"{index + 1}."
            for word in words:
                if len(current) + 1 + len(word) > per_line:
                    lines.append(current)
                    current = "   " + word
                else:
                    current += " " + word
            lines.append(current)
        lines = lines[:max(0, int((top - bottom - used - 12) // (size * 1.6)))]
        if lines:
            start = used
            used += 3
            for line in reversed(lines):
                sheet.text(x + 1.2, bottom + used, line, size)
                used += size * 1.6
            sheet.text(x + 1.2, bottom + used, "NOTES:", size)
            used += size * 1.6 + 2
            sheet.regions.append(("notes", None, (x, bottom + start, x1, bottom + used)))
    return used


def _widths(drawing: Drawing, widths):
    """A table's column widths (made for TITLE_WIDTH) across the sheet's title block width."""
    return widths if drawing.table_width == TITLE_WIDTH else [width * drawing.table_width / TITLE_WIDTH for width in widths]


def _revision_table(sheet: Sheet, drawing: Drawing, x1, y1):
    if not drawing.revisions:
        return 0.0
    x, widths = x1 - drawing.table_width, _widths(drawing, [16, 104, 34, 26])
    rows = [["REV", "DESCRIPTION", "DATE", "BY"]] + [[r["rev"], r["description"], r["date"], r["by"]] for r in drawing.revisions]
    sheet.rect(x, y1 - 7, drawing.table_width, 7)
    sheet.text(x + drawing.table_width / 2, y1 - 4.8, "REVISIONS", sheet.style["small"] + 0.5, "middle")
    height = 7 + _table(sheet, x, y1 - 7, widths, rows, upward=False)
    sheet.regions.append(("revisions", None, (x, y1 - height, x1, y1)))
    return height


def _dimensions(sheet: Sheet, box, size_mm, units: str, aligned: bool, dual: tuple | None = None, room: "_Room | None" = None):
    """Overall width (below) and height (right) of a view: extension lines, dimension lines, arrows and values.
    `dual`: (unit, places or None) of a second unit in brackets after each value, as _label writes it. A value that
    `room` finds in the way of a cutting-plane mark, a view's edges or other text moves along its line to the nearest
    place that's clear; an ASME value written level in a vertical line's gap sits far enough out to clear the view."""
    x0, y0, x1, y1 = box
    text_size = sheet.style["text"]
    for horizontal in (True, False):
        size = size_mm[0 if horizontal else 1]
        value = _length(size, units)
        if dual:
            value += f" [{_figure(size / 25.4 if dual[0] == 'in' else size, dual[0], dual[1])}]"
        width = 0.6 * text_size * len(value)
        # ASME Y14.5: unidirectional values, read from the bottom, in a gap in the dimension line (ISO: above it).
        gap = (width if horizontal else text_size) / 2 + 1
        span = (x1 - x0) if horizontal else (y1 - y0)
        beside = not aligned and span < 2 * gap + 6  # Too short for a gap: the value beside the line.
        if horizontal:
            at = y0 - 8
            sheet.line([(x0, y0 - 1.5), (x0, at - 2)])
            sheet.line([(x1, y0 - 1.5), (x1, at - 2)])
            a, b = (x0, at), (x1, at)
        else:  # A level value in the line's gap reaches back towards the view by half its width.
            at = x1 + (8.0 if aligned or beside else max(8.0, width / 2 + 1.5))
            sheet.line([(x1 + 1.5, y0), (at + 2, y0)])
            sheet.line([(x1 + 1.5, y1), (at + 2, y1)])
            a, b = (at, y0), (at, y1)
        along = width / 2 if horizontal or aligned else text_size / 2  # The value's half length along the line

        def draw(shift, a=a, b=b, horizontal=horizontal, value=value, gap=gap, at=at, beside=beside):
            sheet.arrow(a, (b[0] - a[0], b[1] - a[1]))
            sheet.arrow(b, (a[0] - b[0], a[1] - b[1]))
            middle = ((a[0] + b[0]) / 2 + shift, a[1]) if horizontal else (a[0], (a[1] + b[1]) / 2 + shift)
            if aligned:  # ISO 129-1: values above the line, read from the bottom or the right.
                sheet.line([a, b])
                if horizontal:
                    sheet.text(middle[0], middle[1] + 1, value, text_size, "middle")
                else:
                    sheet.text(middle[0] - 1, middle[1], value, text_size, "middle", 90)
            elif beside:
                sheet.line([a, b])
                if horizontal:
                    sheet.text(middle[0], middle[1] + 1, value, text_size, "middle")
                else:
                    sheet.text(middle[0] + 1.5, middle[1] - text_size / 2, value, text_size)
            else:
                if horizontal:
                    sheet.line([a, (middle[0] - gap, at)])
                    sheet.line([(middle[0] + gap, at), b])
                else:
                    sheet.line([a, (at, middle[1] - gap)])
                    sheet.line([(at, middle[1] + gap), b])
                sheet.text(middle[0], middle[1] - text_size * 0.35, value, text_size, "middle")

        _first_clear(sheet, room, _slides(span, along + 2), draw)  # Between the arrows (3 mm each)


def _places(value: float) -> int:
    """Decimal places a tolerance was written with (0.05 → 2)."""
    text = repr(float(value))
    return 6 if "e" in text else min(6, len(text.split(".")[1].rstrip("0")))


def _fixed(value: float, places: int) -> str:
    """`value` to `places` places, a half rounded away from zero (.8125 → .813, not the float tie's even .812),
    after float noise past the 9th place is snapped off. Mirrored by `fixed` in web/src/drawing/measure.ts."""
    if not math.isfinite(value):
        return f"{value:.{places}f}"
    return f"{Decimal(repr(round(value, 9))).quantize(Decimal(1).scaleb(-places), ROUND_HALF_UP):f}"


def _inch_places(value: float) -> int:
    """Places an inch value is written to by default: 3, or 4 when it is exactly a four-place size such as a
    sixteenth (.8125, .4375, .0625), so its last half-thousandth isn't dropped."""
    if not math.isfinite(value):
        return 3
    snapped = Decimal(repr(round(value, 7)))
    return 4 if snapped == snapped.quantize(Decimal("1e-4")) != snapped.quantize(Decimal("1e-3")) else 3


def _figure(value: float, units: str, places: int | None = None, signed: bool = False) -> str:
    """A number as dimension text: millimetres to 2 places with trailing zeros dropped, inches to 3 (4 for an
    exact four-place size) with no leading zero (ASME Y14.5), or exactly `places` places; halves round up."""
    if places is None:
        text = _fixed(value, _inch_places(value)) if units == "in" else _fixed(value, 2).rstrip("0").rstrip(".")
    else:
        text = _fixed(value, places)
    if float(text) == 0:
        text = text.lstrip("-")
    if units == "in":
        text = re.sub(r"^(-?)0\.", r"\1.", text)
    return "+" + text if signed and float(text) > 0 else text


def _nominal(dim: dict, value: float, units: str) -> float:
    """The nominal size (mm) an ISO 286 fit is looked up at: the value as the sheet shows it, so a measured
    11.9999999 is 12; on inch sheets, to the micrometre."""
    if units == "mm":
        return round(value, dim["precision"] if dim["precision"] is not None else 2)
    return round(value, 3)


def _decimals(value: Decimal) -> int:
    return max(0, -value.normalize().as_tuple().exponent)


def _fit_label(dim: dict, label: dict, measured: str, units: str, symbol: str, fit: tuple, words,
               dual: tuple | None = None, second: str = "") -> dict:
    """A dimension with an ISO 286 fit (ISO 14405-1, ISO 286-1): `⌀12 H7`, `⌀12 H7 (+0.018/0)`, or its limits
    stacked with `(H7)` after. On inch sheets the limits are converted from mm to 4 places (ASME B4.2's practice).
    `dual`: (unit, places or None) of the bracketed second unit, `second` the nominal value in it."""
    nominal, upper, lower = fit
    shows = dim["fit_shows"] or ("limits" if units == "in" else "class")

    def figures(unit, places=None):
        digits = places if places is not None else 4 if unit == "in" else min(6, max(3, _decimals(upper), _decimals(lower)))
        return lambda mm, signed=False: _figure(float(mm) / 25.4 if unit == "in" else float(mm), unit, digits, signed)  # noqa: E731

    def deviation(figure):
        if upper == -lower:
            return f"±{figure(upper)}"
        return "/".join(figure(d, signed=True) if d else "0" for d in (upper, lower))

    figure = figures(units)
    other = figures(*dual) if dual else None
    value = dim["text"] or measured
    if shows == "class":
        label["main"] = words(f"{value} {dim['fit']}" + (f" [{second}]" if dual else ""))
    elif shows == "deviations":
        label["main"] = words(f"{value} {dim['fit']} ({deviation(figure)})" + (f" [{second} ({deviation(other)})]" if dual else ""))
    else:  # Upper limit above the lower one, the class beside them.
        base = Decimal(repr(nominal))
        limit = lambda mm: symbol + figure(mm) + (f" [{other(mm)}]" if dual else "")  # noqa: E731
        label.update(limits=True, upper=words(limit(base + upper)), lower=words(limit(base + lower)), fit=f"({dim['fit']})")
    return label


def _label(dim: dict, value: float, units: str, symbol: str, fit: tuple | None = None,
           dual: tuple | None = None) -> tuple[dict, str]:
    """(what the dimension's text says, the measured text), from the model's value (mm, or degrees for angles).
    `fit`: (nominal mm, upper, lower deviations in mm) of the dimension's ISO 286 fit. `dual`: (unit, places or None)
    of a second unit written in brackets after each value (ASME Y14.5 dual dimensioning: `3.937 [100]`); never on an
    angle or a text= override. The measured text stays in the sheet's units."""
    angle = units == "°"
    dual = None if angle or dim["text"] else dual
    shown = value if angle or units == "mm" else value / 25.4
    tolerance = dim["tolerance"]
    places = dim["precision"]
    if places is None and tolerance is not None and units == "in":  # ASME: inch values as precise as their tolerance.
        places = max(3, *(_places(t) for t in (tolerance if isinstance(tolerance, tuple) else (tolerance,))))
    if places is None and angle:
        places = 0 if abs(shown - round(shown)) < 1e-6 else 1
    unit = "in" if units == "in" else "mm"
    measured = symbol + _figure(shown, unit, places) + ("°" if angle else "")
    words = lambda middle: " ".join(part for part in (dim["prefix"], middle, dim["suffix"]) if part)  # noqa: E731
    # A length in the sheet's units, written in the second unit: its own places, else that unit's usual ones.
    other = (lambda length, fixed=None, signed=False: _figure(length * (25.4 if unit == "in" else 1 / 25.4), dual[0],  # noqa: E731
                                                              dual[1] if dual[1] is not None else fixed, signed)) if dual else None
    second = other(shown) if dual else ""
    label = {"main": words(dim["text"] or (measured + (f" [{second}]" if dual else ""))), "upper": None, "lower": None,
             "limits": False, "basic": dim["display"] == "basic", "fit": None}
    if dim["display"] == "reference":
        label["main"] = f"({label['main']})"
    if fit is not None:
        return _fit_label(dim, label, measured, unit, symbol, fit, words, dual, second), measured
    if tolerance is None:
        return label, measured
    upper, lower = tolerance if isinstance(tolerance, tuple) else (tolerance, -tolerance)
    tolerance_places = max(_places(upper), _places(lower))
    if dim["display"] == "limits":  # Upper limit above the lower one (ASME Y14.5, ISO 14405-1).
        digits = max(places if places is not None else _places(round(shown, 6)), tolerance_places)
        suffix = "°" if angle else ""
        limit = lambda length: (symbol + _figure(length, unit, digits) + suffix  # noqa: E731
                                + (f" [{other(length, 3 if dual[0] == 'in' else 2)}]" if dual else ""))
        label.update(limits=True, upper=words(limit(shown + upper)), lower=words(limit(shown + lower)))
        return label, measured
    suffix = "°" if angle else ""
    if upper == -lower:
        label["main"] = words(f"{dim['text'] or measured} ±{_figure(upper, unit, tolerance_places)}{suffix}"
                              + (f" [{second} ±{other(upper)}]" if dual else ""))
    else:
        deviation = lambda value: _figure(value, unit, tolerance_places, signed=True) + suffix if value else "0"  # noqa: E731
        bracketed = lambda value: f"{deviation(value)} [{other(value, signed=True) if value else '0'}]"  # noqa: E731
        label.update(upper=(bracketed if dual else deviation)(upper), lower=(bracketed if dual else deviation)(lower))
    return label, measured


def _width(text: str, size: float) -> float:
    return 0.6 * size * len(text)


def _layout(label: dict, size: float):
    """(pieces (dx, dy, text, size) from the box's bottom-left, width, height, boxed) of a dimension's text."""
    if label["limits"]:
        small = size * 0.8
        pieces = [(0.0, small * 1.25, label["upper"], small), (0.0, 0.0, label["lower"], small)]
        width, height = max(_width(label["upper"], small), _width(label["lower"], small)), small * 1.95
        if label.get("fit"):  # The fit's class beside its limits: (H7).
            left = width + 0.8
            pieces.append((left, (height - size * 0.7) / 2, label["fit"], size))
            width = left + _width(label["fit"], size)
    else:
        pieces, width, height = [(0.0, 0.0, label["main"], size)], _width(label["main"], size), size * 0.7
        if label["upper"] is not None:  # Deviations stacked after the value, upper above lower.
            small, left = size * 0.7, width + 0.8
            pieces += [(left, small * 1.2, label["upper"], small), (left, 0.0, label["lower"], small)]
            width, height = left + max(_width(label["upper"], small), _width(label["lower"], small)), max(height, small * 1.9)
    if label["basic"]:  # A basic dimension's value sits in a box.
        pieces = [(dx + 1.0, dy + 1.0, text, s) for dx, dy, text, s in pieces]
        width, height = width + 2.0, height + 2.0
    return pieces, width, height, label["basic"]


def _put(sheet: Sheet, at, layout, angle: float, align: str):
    """Writes laid-out dimension text at `at` (its box's bottom middle, middle, or bottom left), turned `angle`°."""
    pieces, width, height, boxed = layout
    ox, oy = {"bottom": (-width / 2, 0.0), "middle": (-width / 2, -height / 2), "left": (0.0, 0.0)}[align]
    turn = math.radians(angle)
    c, s = math.cos(turn), math.sin(turn)

    def place(dx, dy):
        return at[0] + dx * c - dy * s, at[1] + dx * s + dy * c

    for dx, dy, text, size in pieces:
        x, y = place(ox + dx, oy + dy)
        sheet.text(x, y, text, size, "start", angle)
    if boxed:
        sheet.line([place(ox, oy), place(ox + width, oy), place(ox + width, oy + height), place(ox, oy + height), place(ox, oy)])


def _shift(text_at, span: float, half: float) -> float:
    """Where text `half` long (from its middle, plus a margin) sits along a line `span` long: paper mm from the
    line's middle towards its end. start and end put it past that end's arrow (ISO 129-1, for tight spaces)."""
    if text_at == "start":
        return -(span / 2 + 2 + half)
    if text_at == "end":
        return span / 2 + 2 + half
    return float(text_at or 0.0)


def _linear(sheet: Sheet, a, b, layout, aligned: bool, text_at=None) -> dict:
    """A dimension line from a to b with arrows and its text: above the line and along it (ISO 129-1), or level in a
    gap in the line (ASME Y14.5 unidirectional). `text_at` moves the text along the line (_shift); past an arrow,
    the line runs out under it. The line and its arrows are tagged `data-dimension-line`, so the Drawing tab moves them
    apart from the text while it's dragged along the line. Returns the text's shift and the shifts start and end would give."""
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    span = math.hypot(dx, dy) or 1e-9
    ux, uy = dx / span, dy / span

    def stroke(points):
        with sheet.tagged('data-dimension-line=""'):
            sheet.line(points)

    with sheet.tagged('data-dimension-line=""'):
        sheet.arrow(a, (dx, dy))
        sheet.arrow(b, (-dx, -dy))
    mx, my = (ax + bx) / 2, (ay + by) / 2
    _, width, height, _ = layout
    gap = min((width / 2 + 1) / abs(ux) if abs(ux) > 1e-9 else math.inf, (height / 2 + 1) / abs(uy) if abs(uy) > 1e-9 else math.inf)
    half = width / 2 + 1 if aligned else gap
    shift = _shift(text_at, span, half)
    tx, ty = mx + ux * shift, my + uy * shift
    placed = {"shift": shift, "start": _shift("start", span, half), "end": _shift("end", span, half), "at": (tx, ty)}

    def at(t):
        return a if t == -span / 2 else b if t == span / 2 else (mx + ux * t, my + uy * t)

    if aligned:
        angle = math.degrees(math.atan2(dy, dx))
        angle = angle - 180 if angle > 90 else angle + 180 if angle <= -90 else angle  # Read from the bottom or the right.
        turn = math.radians(angle)
        stroke([a, b] if text_at is None else [at(min(-span / 2, shift - half)), at(max(span / 2, shift + half))])
        _put(sheet, (tx - math.sin(turn), ty + math.cos(turn)), layout, angle, "bottom")
        return placed
    if text_at is None and span < 2 * gap + 6:  # Too short for a gap: the text beside the line.
        stroke([a, b])
        if abs(ux) >= abs(uy):
            _put(sheet, (mx, my + 1), layout, 0.0, "bottom")
        else:
            _put(sheet, (mx + 1.5, my - height / 2), layout, 0.0, "left")
        return placed
    if text_at is not None and abs(shift) + gap > span / 2 - 3:  # Past an arrow: the line runs out to the text.
        near = shift - math.copysign(gap, shift)
        stroke([at(min(-span / 2, near)), at(max(span / 2, near))])
    else:
        stroke([a, (tx - ux * gap, ty - uy * gap)])
        stroke([(tx + ux * gap, ty + uy * gap), b])
    _put(sheet, (tx, ty), layout, 0.0, "middle")
    return placed


def _sides(spec: dict) -> tuple:
    """The sides a measured dimension can go on, its default first."""
    if spec["type"] == "linear":
        return ("above", "below") if spec["axis"] == "x" else ("left", "right")
    return {"aligned": ("out", "in"), "round": tuple(QUADRANTS)}.get(spec["type"], ())


def _placement_problem(dim: dict, spec: dict) -> str | None:
    """Why a dimension's side or text_at doesn't fit what it measures, or None."""
    sides = _sides(spec)
    if dim["side"] is not None and dim["side"] not in sides:
        what = {"x": "horizontal", "y": "vertical"}.get(spec.get("axis"), spec["type"]) if spec["type"] == "linear" else \
            {"aligned": "aligned", "round": "diameter or radius", "angle": "angle"}[spec["type"]]
        if not sides:
            return f"an {what} has no side: leave side out (offset sets its radius)."
        return f"side {dim['side']!r} doesn't fit a{'n' if what[0] in 'aeiou' else ''} {what} dimension: use {' or '.join(map(repr, sides))}, or leave it out."
    if dim["text_at"] is not None and spec["type"] == "round":
        return "text_at doesn't apply to a leader: leave it out (side and offset place it)."
    return None


def _measured(dim: dict, spec: dict, units: str) -> dict:
    """What a placed dimension states, for an inspection plan (an ERP's characteristics, app/carbon.py): its value as
    drawn (mm or inches as the drawing's units, degrees for an angle), its symbol (⌀, R), its tolerance as (upper,
    lower) in those units, and how it's displayed (basic and reference ones aren't inspected)."""
    angle = spec["type"] == "angle"
    value = spec["value"] if angle or units == "mm" else spec["value"] / 25.4
    tolerance = dim["tolerance"]
    limits = None if tolerance is None else [float(tolerance[0]), float(tolerance[1])] if isinstance(tolerance, tuple) \
        else [float(tolerance), -float(tolerance)]
    return {"value": round(float(value), 6), "unit": "deg" if angle else units, "symbol": spec.get("symbol") or "",
            **({"tolerance": limits} if limits else {}), **({"fit": dim["fit"]} if dim["fit"] else {}),
            **({"display": dim["display"]} if dim["display"] else {})}


def _round_leader_box(centre, radius: float, reach: float, width: float, height: float, side: str):
    """The paper a diameter or radius leader covers on `side`: from its tip on the circle to its shoulder and text."""
    sx, sy = QUADRANTS[side]
    tip = (centre[0] + sx * radius * math.sqrt(0.5), centre[1] + sy * radius * math.sqrt(0.5))
    elbow = (tip[0] + sx * reach * math.sqrt(0.5), tip[1] + sy * reach * math.sqrt(0.5))
    xs, ys = (tip[0], elbow[0], elbow[0] + sx * (width + 2)), (tip[1], elbow[1], elbow[1] + 1 + height)
    return min(xs), min(ys), max(xs), max(ys)


def _off_sheet(sheet: Sheet, box, border) -> str | None:
    """What a box on the sheet runs into: past its border, or over the title block or a table; None if neither."""
    if not (border[0] - 1e-6 <= box[0] and border[1] - 1e-6 <= box[1] and box[2] <= border[2] + 1e-6 and box[3] <= border[3] + 1e-6):
        return "reaches past the sheet's border"
    for kind, _, (a, b, c, d) in sheet.regions:
        if box[0] < c and a < box[2] and box[1] < d and b < box[3]:
            return f"runs over the {'title block' if kind == 'title-block' else kind.replace('-', ' ')}"
    return None


def _feature_dimensions(sheet: Sheet, drawing: Drawing, items, place, paper, scale: float, attached=None, border=None,
                        notes=None, room: "_Room | None" = None) -> list[dict]:
    """Draws a view's measured feature dimensions, each in its own group. `place` maps the view's model mm to paper;
    `paper` is the view's outline on the sheet. Horizontal ones go above the view (or below) and vertical ones to its
    left (or right), stacked shortest nearest. A diameter or radius leader with no side goes up-right, or the first
    other quadrant that stays inside `border` (the sheet's frame) and off the title block and tables (and clear of
    what `room` finds in the way, if one is); one that still doesn't is drawn as placed and listed in `notes`. A linear
    or aligned dimension's text with no text_at that `room` finds in the way moves along its line to the nearest place
    that's clear. `attached`: dimension number → the tolerance frames and datum feature symbols that go with it, drawn
    in its group out from its text. Returns where each went, in the SVG's frame (mm, y down), so the Drawing tab can
    turn a drag into new `offset`, `side` and `text_at` literals."""
    aligned_text = drawing.standard == "ISO"
    x0, y0, x1, y1 = paper
    centre = ((x0 + x1) / 2, (y0 + y1) / 2)
    flip = lambda p: [round(p[0], 3), round(sheet.height - p[1], 3)]  # noqa: E731
    turn = lambda v: [round(v[0], 4), round(-v[1], 4)]  # noqa: E731
    placed = []
    for dim, spec, layout, distance in items:
        kind = spec["type"]
        side = (dim["side"] or _sides(spec)[0]) if _sides(spec) else None
        entry = {"dimension": dim["index"], "view": dim["view"], "type": kind, "side": side, **_measured(dim, spec, drawing.units),
                 **({"round_ends": spec["round_ends"]} if any(spec.get("round_ends", ())) else {})}  # Inside/outside apply
        first_text = len(sheet.texts)

        def stacked(away):  # Its frames and datum feature symbols, out from its text.
            if attached and attached.get(dim["index"]):
                _stack_out(sheet, _text_box(sheet.texts[first_text:]), away, attached[dim["index"]], drawing.style["text"])

        with sheet.group(dim["index"]):
            for sharp in spec.get("sharps", ()):  # A virtual sharp: each straight's line runs on, past where they'd meet.
                (cx, cy), = place([sharp["corner"]])
                for ex, ey in place(sharp["ends"]):
                    length = math.hypot(cx - ex, cy - ey)
                    if length > 1.5:  # On the model: it stays there while the dimension is dragged.
                        ux, uy = (cx - ex) / length, (cy - ey) / length
                        with sheet.tagged('data-anchored=""'):
                            sheet.line([(ex + ux * 1.5, ey + uy * 1.5), (cx + ux * 2, cy + uy * 2)])
            if kind == "linear":
                (ax, ay), (bx, by) = place(spec["at"])
                if spec["axis"] == "x":
                    up = 1 if side == "above" else -1
                    edge = y1 if up > 0 else y0
                    level = edge + up * distance
                    sheet.leader((ax, ay + up * 1.5), (ax, level + up * 2), None)
                    sheet.leader((bx, by + up * 1.5), (bx, level + up * 2), None)
                    a, b, origin, normal, across = (ax, level), (bx, level), (centre[0], edge), (0, up), y1 - y0
                    away = (0, up)
                else:
                    out = -1 if side == "left" else 1
                    edge = x0 if out < 0 else x1
                    level = edge + out * distance
                    sheet.leader((ax + out * 1.5, ay), (level + out * 2, ay), None)
                    sheet.leader((bx + out * 1.5, by), (level + out * 2, by), None)
                    a, b, origin, normal, across = (level, ay), (level, by), (edge, centre[1]), (out, 0), x1 - x0
                    away = (out, 0)
                offset = distance
            elif kind == "aligned":
                (ax, ay), (bx, by) = place(spec["at"])
                span = math.hypot(bx - ax, by - ay) or 1e-9
                nx, ny = -(by - ay) / span, (bx - ax) / span
                if (ax + bx) / 2 * nx + (ay + by) / 2 * ny < centre[0] * nx + centre[1] * ny:
                    nx, ny = -nx, -ny  # Away from the middle of the view.
                if side == "in":
                    nx, ny = -nx, -ny
                off = offset = dim["offset"] or 8.0
                sheet.leader((ax + nx * 1.5, ay + ny * 1.5), (ax + nx * (off + 2), ay + ny * (off + 2)), None)
                sheet.leader((bx + nx * 1.5, by + ny * 1.5), (bx + nx * (off + 2), by + ny * (off + 2)), None)
                a, b, origin, normal, across = (ax + nx * off, ay + ny * off), (bx + nx * off, by + ny * off), (ax, ay), (nx, ny), 0.0
                away = _axis((nx, ny))
            if kind in ("linear", "aligned"):  # Text in the way of something moves along its line, unless text_at puts it.
                _, width, height, _ = layout
                half = (width if aligned_text or abs(b[0] - a[0]) >= abs(b[1] - a[1]) else height) / 2
                tries = [dim["text_at"]] if dim["text_at"] is not None else \
                    [None] + _slides(math.hypot(b[0] - a[0], b[1] - a[1]), half + 2)[1:]

                def write(text_at):
                    written = _linear(sheet, a, b, layout, aligned_text, text_at)
                    stacked(away)
                    return written

                _, text = _first_clear(sheet, room, tries, write)
            elif kind == "round":  # A leader to the circle, pointing at its centre, with the text on a shoulder.
                (cx, cy), = place([spec["centre"]])
                radius = spec["radius"] * scale
                reach = offset = dim["offset"] or 8.0
                _, width, height, _ = layout
                box = lambda quadrant: _round_leader_box((cx, cy), radius, reach, width, height, quadrant)  # noqa: E731
                tries = [side]
                if dim["side"] is None and border is not None:  # The default: the first quadrant that stays on the sheet
                    # and clear of what's there; else the first that stays on the sheet.
                    tries = sorted(QUADRANTS, key=lambda quadrant: _off_sheet(sheet, box(quadrant), border) is not None)

                def leader(side):
                    sx, sy = QUADRANTS[side]
                    tip = (cx + sx * radius * math.sqrt(0.5), cy + sy * radius * math.sqrt(0.5))
                    elbow = (tip[0] + sx * reach * math.sqrt(0.5), tip[1] + sy * reach * math.sqrt(0.5))
                    sheet.leader(tip, elbow)
                    sheet.line([elbow, (elbow[0] + sx * (width + 2), elbow[1])])
                    _put(sheet, (elbow[0] + 1 if sx > 0 else elbow[0] - 1 - width, elbow[1] + 1), layout, 0.0, "left")
                    stacked((0, -1))  # Under the shoulder (ASME Y14.5: a frame below the size it goes with).
                    return elbow

                side, elbow = _first_clear(sheet, room, tries, leader)
                entry["side"] = side
                if border is not None and notes is not None and (problem := _off_sheet(sheet, box(side), border)):
                    notes.append({"dimension": dim["index"], "view": dim["view"], "refs": dim["refs"],
                                  "problem": f"its leader {problem}: give it another side or a shorter offset, or choose "
                                             "a smaller scale or a larger sheet."})
                entry.update(centre=flip((cx, cy)), radius=round(radius, 3), handle=flip(elbow))
            else:  # An angle: an arc between the two legs, from their corner.
                (cx, cy), = place([spec["corner"]])
                legs, reach = spec["legs"], [r * scale for r in spec["reach"]]
                radius = offset = dim["offset"] or max(10.0, min([r for r in reach if r > 0] or [10.0]) * 0.7)
                start = math.atan2(legs[0][1], legs[0][0])
                sweep = math.atan2(legs[1][1], legs[1][0]) - start
                sweep = math.atan2(math.sin(sweep), math.cos(sweep))
                arc = [(cx + radius * math.cos(start + sweep * i / 24), cy + radius * math.sin(start + sweep * i / 24)) for i in range(25)]
                sheet.line(arc)
                sheet.arrow(arc[0], (arc[1][0] - arc[0][0], arc[1][1] - arc[0][1]))
                sheet.arrow(arc[-1], (arc[-2][0] - arc[-1][0], arc[-2][1] - arc[-1][1]))
                for (lx, ly), length in zip(legs, reach):
                    if radius > length + 1.5:  # Extension lines where the arc reaches past the edge.
                        sheet.line([(cx + lx * (length + 1.5), cy + ly * (length + 1.5)), (cx + lx * (radius + 2), cy + ly * (radius + 2))])
                middle = start + sweep / 2
                _, width, height, _ = layout
                sense = 1.0 if sweep >= 0 else -1.0  # Towards the arc's end.
                length = abs(sweep) * radius
                half = width / 2 + 1
                shift = _shift(dim["text_at"], length, half)
                theta = middle + sense * shift / radius
                beyond = (theta - start) / sweep if sweep else 0.5
                if beyond < 0 or beyond > 1:  # Past an arrow: the arc runs out under the text.
                    end = start if beyond < 0 else start + sweep
                    sheet.line([(cx + radius * math.cos(end + (theta - end) * i / 8), cy + radius * math.sin(end + (theta - end) * i / 8))
                                for i in range(9)])
                tx, ty = cx + (radius + 2 + height / 2) * math.cos(theta), cy + (radius + 2 + height / 2) * math.sin(theta)
                tx += math.cos(theta) * width / 2
                _put(sheet, (tx, ty), layout, 0.0, "middle")
                stacked(_axis((math.cos(theta), math.sin(theta))))
                entry.update(centre=flip((cx, cy)), handle=flip((cx + radius * math.cos(theta), cy + radius * math.sin(theta))),
                             middle=turn((math.cos(middle), math.sin(middle))), sense=-sense,  # The SVG's y runs down.
                             text_at=round(shift, 2), text_snaps={"start": round(_shift("start", length, half), 2),
                                                                  "end": round(_shift("end", length, half), 2)})
        if kind in ("linear", "aligned"):
            span = math.hypot(b[0] - a[0], b[1] - a[1]) or 1e-9
            entry.update(origin=flip(origin), normal=turn(normal), across=round(across, 3), handle=flip(text["at"]),
                         along=turn(((b[0] - a[0]) / span, (b[1] - a[1]) / span)), text_at=round(text["shift"], 2),
                         text_snaps={"start": round(text["start"], 2), "end": round(text["end"], 2)})
        entry["offset"] = round(offset, 2)
        entry["sides"] = list(_sides(spec))
        placed.append(entry)
    return placed


# ───────── GD&T: datum feature symbols and feature control frames (ASME Y14.5-2018, ISO 1101, ISO 5459) ─────────

def _axis(v):
    """The paper axis nearest a direction: (±1, 0) or (0, ±1)."""
    return (1 if v[0] >= 0 else -1, 0) if abs(v[0]) >= abs(v[1]) else (0, 1 if v[1] >= 0 else -1)


def _anchor(drawing: Drawing, ref: str, view: str, middle) -> dict:
    """Where a datum or frame meets its feature in a view (model mm on the paper plane): `at` on the feature's
    outline and `out` the way from it to the symbol: a flat face seen edge-on (its outward normal), a straight edge,
    a hole or shaft seen round or side-on; a flat face seen face-on gets a leader ending in a `dot`. `size`: it's a
    feature of size (a hole or shaft). `span`, for a face seen edge-on or a straight edge: the line it shows as (its two
    ends), anywhere along which the symbol may meet it. `middle` is the view's middle. Raises _Problem when it can't be
    shown there."""
    import cadquery as cq
    if view not in drawing.frames:
        raise _Problem(f"the {view} view isn't on this sheet; add it or move this to another view.")
    x, y, n = _view_axes(drawing.frames[view])
    tolerance = max(drawing.shape.BoundingBox().DiagonalLength, 1.0) * 1e-6
    shapes = _resolve(drawing, ref)
    flat = lambda p: (p.dot(x), p.dot(y))  # noqa: E731

    def away(point, across=None):  # From the view's middle: along `across` (either way), else diagonally.
        dx, dy = point[0] - middle[0], point[1] - middle[1]
        if across is not None:
            return across if dx * across[0] + dy * across[1] >= 0 else (-across[0], -across[1])
        return (math.sqrt(0.5) if dx >= 0 else -math.sqrt(0.5), math.sqrt(0.5) if dy >= 0 else -math.sqrt(0.5))

    found = [_round(shape) for shape in shapes]
    if None not in found:
        centre, axis, radius = found[0]
        if any(abs(r - radius) > tolerance or abs(abs(a.dot(axis)) - 1) > 1e-6 or (c - centre).cross(axis).Length > tolerance
               for c, a, r in found):
            raise _Problem(f"{ref!r} is several features now; pick one.")
        facing = abs(axis.dot(n))
        if facing > 1 - 1e-6:  # Seen round: on the circle, out from its centre.
            c = flat(centre)
            out = away(c)
            return {"at": (c[0] + out[0] * radius, c[1] + out[1] * radius), "out": out, "dot": False, "size": True}
        if facing < 1e-6 and all(isinstance(shape, cq.Face) for shape in shapes):  # Side-on: on its outline.
            middle_3d = centre + axis * (shapes[0].Center() - centre).dot(axis)
            along = flat(axis)
            length = math.hypot(*along)
            c = flat(middle_3d)
            out = away(c, (-along[1] / length, along[0] / length))
            return {"at": (c[0] + out[0] * radius, c[1] + out[1] * radius), "out": out, "dot": False, "size": True}
        raise _Problem(f"the {view} view shows this {'circle' if isinstance(shapes[0], cq.Edge) else 'cylinder'} at an "
                       "angle or edge-on; use a view along or across its axis (a cylinder's face, side-on).")
    if len(shapes) != 1:
        raise _Problem(f"{ref!r} is {len(shapes)} pieces of geometry now; pick one face or edge.")
    shape = shapes[0]
    if isinstance(shape, cq.Face) and shape.geomType() == "PLANE":
        normal, c = shape.normalAt(), flat(shape.Center())
        if abs(normal.dot(n)) > 1 - 1e-6:
            return {"at": c, "out": away(c), "dot": True, "size": False}
        if abs(normal.dot(n)) < 1e-6:
            along = flat(normal)
            length = math.hypot(*along)
            out = (along[0] / length, along[1] / length)
            ends = [(p[0] - c[0]) * -out[1] + (p[1] - c[1]) * out[0] for p in (flat(v.Center()) for v in shape.Vertices())]
            span = [(c[0] - out[1] * t, c[1] + out[0] * t) for t in (min(ends, default=0.0), max(ends, default=0.0))]
            return {"at": c, "out": out, "dot": False, "size": False, "span": span}
        raise _Problem(f"the {view} view shows this face at an angle; use a view that shows it edge-on or face-on.")
    if isinstance(shape, cq.Edge) and shape.geomType() == "LINE":
        a, b = shape.startPoint(), shape.endPoint()
        if (b - a).Length <= tolerance or abs((b - a).normalized().dot(n)) > 1e-6:
            raise _Problem(f"this edge runs into the paper in the {view} view; use a view that shows it side-on.")
        along = flat(b - a)
        length = math.hypot(*along)
        c = flat(shape.Center())
        return {"at": c, "out": away(c, (-along[1] / length, along[0] / length)), "dot": False, "size": False,
                "span": [flat(a), flat(b)]}
    raise _Problem("pick a flat face, a straight edge, or a hole's or shaft's cylinder or circle.")


def _cells(frame: dict, units: str) -> list:
    """A feature control frame's compartments, left to right: the characteristic's symbol; the tolerance (⌀ for a
    cylindrical zone) and its modifiers; then each datum with its material boundary. Each is a list of pieces:
    ("text", "0.1") or ("circle", "M") for Ⓜ."""
    tolerance = frame["tolerance"]
    places = max(3, _places(tolerance)) if units == "in" else _places(tolerance)
    pieces = [("text", ("⌀" if frame["zone"] == "diameter" else "") + _figure(tolerance, units, places))]
    if frame["modifier"]:
        pieces.append(("circle", MATERIAL[frame["modifier"]]))
    if frame["projected"] is not None:
        pieces += [("circle", "P"), ("text", _figure(frame["projected"], units))]
    for modifier in frame["modifiers"]:
        letters = ZONE_MODIFIERS[modifier]
        pieces.append(("text", letters) if len(letters) > 1 else ("circle", letters))
    datums = [[("text", letter)] + ([("circle", MATERIAL[condition])] if condition else []) for letter, condition in frame["datums"]]
    return [[("symbol", frame["characteristic"])], pieces, *datums]


def _piece_width(piece, size: float) -> float:
    return 1.1 * size if piece[0] == "circle" else _width(piece[1], size)


def _cell_width(cell, size: float) -> float:
    if cell[0][0] == "symbol":
        return 2 * size
    return max(2 * size, 3 + sum(_piece_width(piece, size) for piece in cell) + 0.8 * (len(cell) - 1))


def _ring(sheet: Sheet, cx: float, cy: float, r: float, kind="thin"):
    """A circle as a polyline, so it moves with the group it's drawn in."""
    sheet.line([(cx + r * math.cos(i * math.pi / 12), cy + r * math.sin(i * math.pi / 12)) for i in range(25)], kind)


def _dot(sheet: Sheet, at, r=0.6):
    sheet.fills.append([(at[0] + r * math.cos(i * math.pi / 4), at[1] + r * math.sin(i * math.pi / 4)) for i in range(8)])


def _symbol(sheet: Sheet, characteristic: str, cx: float, cy: float, h: float):
    """A geometric characteristic's symbol (ISO 1101, ASME Y14.5) drawn as lines in a compartment `h` square, so SVG,
    DXF and print show it the same without a GD&T font."""
    s = 0.3 * h
    line = sheet.line
    if characteristic == "straightness":
        line([(cx - s, cy), (cx + s, cy)])
    elif characteristic == "flatness":
        line([(cx - s, cy - 0.45 * s), (cx + 0.5 * s, cy - 0.45 * s), (cx + s, cy + 0.45 * s), (cx - 0.5 * s, cy + 0.45 * s), (cx - s, cy - 0.45 * s)])
    elif characteristic == "circularity":
        _ring(sheet, cx, cy, 0.8 * s)
    elif characteristic == "cylindricity":
        r, (ux, uy) = 0.6 * s, (0.5, math.sqrt(3) / 2)
        _ring(sheet, cx, cy, r)
        for side in (-1, 1):
            px, py = cx + side * uy * r, cy - side * ux * r
            line([(px - ux * 1.1 * s, py - uy * 1.1 * s), (px + ux * 1.1 * s, py + uy * 1.1 * s)])
    elif characteristic in ("profile_line", "profile_surface"):
        arc = [(cx + s * math.cos(i * math.pi / 12), cy - 0.45 * s + s * math.sin(i * math.pi / 12)) for i in range(13)]
        line(arc + [arc[0]] if characteristic == "profile_surface" else arc)
    elif characteristic == "perpendicularity":
        line([(cx - s, cy - 0.8 * s), (cx + s, cy - 0.8 * s)])
        line([(cx, cy - 0.8 * s), (cx, cy + 0.9 * s)])
    elif characteristic == "parallelism":
        for dx in (-0.35 * s, 0.35 * s):
            line([(cx + dx - 0.35 * s, cy - 0.85 * s), (cx + dx + 0.35 * s, cy + 0.85 * s)])
    elif characteristic == "angularity":
        line([(cx + s, cy + 0.6 * s), (cx - s, cy - 0.8 * s), (cx + s, cy - 0.8 * s)])
    elif characteristic == "position":
        _ring(sheet, cx, cy, 0.6 * s)
        line([(cx - s, cy), (cx + s, cy)])
        line([(cx, cy - s), (cx, cy + s)])
    elif characteristic in ("concentricity", "coaxiality"):
        _ring(sheet, cx, cy, 0.45 * s)
        _ring(sheet, cx, cy, 0.9 * s)
    elif characteristic == "symmetry":
        line([(cx - s, cy), (cx + s, cy)])
        for dy in (-0.5 * s, 0.5 * s):
            line([(cx - 0.6 * s, cy + dy), (cx + 0.6 * s, cy + dy)])
    else:  # Runout: one slanted arrow (circular), or two on a base line (total).
        ux, uy = math.sqrt(0.5), math.sqrt(0.5)
        starts = [(cx - 0.5 * s, cy - 0.8 * s)] if characteristic == "circular_runout" else [(cx - 0.9 * s, cy - 0.8 * s), (cx - 0.1 * s, cy - 0.8 * s)]
        if characteristic == "total_runout":
            line([(starts[0][0] - 0.2 * s, starts[0][1]), (starts[1][0] + 0.8 * s, starts[1][1])])
        for bx, by in starts:
            tip = (bx + ux * 1.4 * s, by + uy * 1.4 * s)
            line([(bx, by), tip])
            back = (tip[0] - ux * 0.5 * s, tip[1] - uy * 0.5 * s)
            sheet.fills.append([tip, (back[0] - uy * 0.22 * s, back[1] + ux * 0.22 * s), (back[0] + uy * 0.22 * s, back[1] - ux * 0.22 * s)])


def _control_frame(sheet: Sheet, cells, x: float, y: float, size: float):
    """A feature control frame from its bottom-left corner: compartments 2 × the text height tall (ISO 1101, ASME
    Y14.5), the symbol's square."""
    h = 2 * size
    left = x
    for cell in cells:
        w = _cell_width(cell, size)
        sheet.rect(left, y, w, h)
        if cell[0][0] == "symbol":
            _symbol(sheet, cell[0][1], left + w / 2, y + h / 2, h)
        else:
            cursor = left + (w - sum(_piece_width(piece, size) for piece in cell) - 0.8 * (len(cell) - 1)) / 2
            for kind, value in cell:
                if kind == "text":
                    sheet.text(cursor, y + h / 2 - size * 0.35, value, size)
                else:  # A circled letter: Ⓜ, Ⓛ, Ⓟ, Ⓕ, Ⓣ.
                    r = 0.55 * size
                    _ring(sheet, cursor + r, y + h / 2, r)
                    sheet.text(cursor + r, y + h / 2 - 0.25 * size, value, 0.7 * size, "middle")
                cursor += _piece_width((kind, value), size) + 0.8
        left += w
    return left - x


def _datum_width(label: str, size: float) -> float:
    return max(2 * size, _width(label, size) + 3)


def _hang(at, out, reach: float, w: float, h: float):
    """A box w × h on a leader `reach` long from `at` along `out`: (the leader's end, the box's bottom-left), the box
    meeting the leader at the middle of its nearest side."""
    end = (at[0] + out[0] * reach, at[1] + out[1] * reach)
    if abs(out[0]) >= abs(out[1]):
        return end, (end[0] if out[0] > 0 else end[0] - w, end[1] - h / 2)
    return end, (end[0] - w / 2, end[1] if out[1] > 0 else end[1] - h)


def _datum_symbol(sheet: Sheet, at, out, label: str, size: float, reach: float, dot=False):
    """A datum feature symbol: a filled triangle with its base on the feature, a leader `reach` long along `out`, and
    the datum's letter in a box. On a surface seen face-on the leader starts at a dot on it, the triangle at its end."""
    ux, uy = out
    w, h = _datum_width(label, size), 2 * size
    end, (left, bottom) = _hang(at, out, reach, w, h)
    base = (end[0] - ux * 2.6, end[1] - uy * 2.6) if dot else at
    if dot:
        _dot(sheet, at)
    sheet.leaders.add(len(sheet.lines))
    sheet.line([at if dot else (base[0] + ux * 2.6, base[1] + uy * 2.6), end])
    sheet.fills.append([(base[0] - uy * 1.5, base[1] + ux * 1.5), (base[0] + uy * 1.5, base[1] - ux * 1.5),
                        (base[0] + ux * 2.6, base[1] + uy * 2.6)])
    sheet.rect(left, bottom, w, h)
    sheet.text(left + w / 2, bottom + h / 2 - size * 0.35, label, size, "middle")


def _annotation_size(kind: str, item: dict, cells, size: float):
    """(width, height) of a frame or a datum feature symbol's box."""
    width = sum(_cell_width(cell, size) for cell in cells) if kind == "frame" else _datum_width(item["label"], size)
    return width, 2 * size


def _on_feature(sheet: Sheet, kind: str, item: dict, cells, at, anchor: dict, size: float, room: "_Room | None" = None,
                on=None, span=None):
    """A datum feature symbol, or a frame on a leader (an arrow on the outline, a dot on a surface seen face-on). With
    no offset, one whose text `room` finds in the way goes further out along its leader, to the first place that's
    clear; where none is (its leader would cross text: an overall dimension's value beside the face), it meets its
    feature elsewhere along `span` (the paper line a face seen edge-on or a straight edge shows as) and tries again. A
    frame with no offset on the same feature as frame `on` (its box: left, bottom, width, height) is stacked on that
    one, out from its leader, with no leader of its own (ASME Y14.5: frames for one feature, one leader), unless
    something's in the way there. Returns a frame's box."""
    w, h = _annotation_size(kind, item, cells, size)

    def draw(t):
        reach, at_ = (t if isinstance(t, tuple) else (t, at))
        return place(reach, at_)

    def place(reach, at):
        if reach is None:  # Stacked on frame `on`: further out along its leader (above it, when that runs sideways).
            left, bottom, width, height = on
            out = anchor["out"]
            down = abs(out[1]) > abs(out[0]) and out[1] < 0
            leftward = abs(out[0]) >= abs(out[1]) and out[0] < 0  # Hung by its right side: stacked flush right
            box = (left + width - w if leftward else left, bottom - h if down else bottom + height, w, h)
            _control_frame(sheet, cells, box[0], box[1], size)
            return box
        if kind == "datum":
            _datum_symbol(sheet, at, anchor["out"], item["label"], size, reach, anchor["dot"])
            return None
        end, (left, bottom) = _hang(at, anchor["out"], reach, w, h)
        sheet.leaders.add(len(sheet.lines))
        sheet.line([at, end])
        if anchor["dot"]:
            _dot(sheet, at)
        else:
            sheet.arrow(at, anchor["out"])
        _control_frame(sheet, cells, left, bottom, size)
        return left, bottom, w, h

    reaches = [item["offset"]] if item["offset"] else \
        [8.0 + k * CLEAR_STEP for k in range(int(OUT_STEPS * (2 * size + 1) / CLEAR_STEP) + 1)]
    tries = list(reaches)
    if on is not None and kind == "frame" and not item["offset"]:
        tries = [None] + tries
    if span is not None and not item["offset"]:  # Then along the feature, nearest its middle first, a short way out.
        (ax, ay), (bx, by) = span
        length = math.hypot(bx - ax, by - ay)
        margin = max(w, h) / 2 if kind == "frame" else 2.0  # The symbol's foot stays on the feature.
        if length > 2 * margin:
            ux, uy = (bx - ax) / length, (by - ay) / length
            shifts = [s for s in _slides(length, margin, max(length / 12, CLEAR_STEP)) if s]
            middle = ((ax + bx) / 2, (ay + by) / 2)
            tries += [(reach, (middle[0] + ux * s, middle[1] + uy * s)) for s in shifts for reach in reaches[:OUT_STEPS]]
    return _first_clear(sheet, room, tries, draw)[1]


def _text_box(texts):
    """The paper a dimension's texts cover (an estimate, as _width), turned as they're written."""
    corners = []
    for x, y, text, size, anchor, rotation, _ in texts:
        w = _width(text, size)
        shift = {"start": 0.0, "middle": -w / 2, "end": -w}[anchor]
        c, s = math.cos(math.radians(rotation)), math.sin(math.radians(rotation))
        corners += [(x + dx * c - dy * s, y + dx * s + dy * c) for dx in (shift, shift + w) for dy in (0.0, 0.8 * size)]
    xs, ys = [p[0] for p in corners] or [0.0], [p[1] for p in corners] or [0.0]
    return min(xs) - 0.5, min(ys) - 0.5, max(xs) + 0.5, max(ys) + 0.5


def _stack_out(sheet: Sheet, box, away, attached, size: float):
    """A dimension's frames, then its datum feature symbols, out from its text (`box`) along the paper axis `away`:
    ASME Y14.5's way of tolerancing a feature of size, or making it a datum, with its size dimension."""
    x0, y0, x1, y1 = box
    h = 2 * size
    for kind, item, cells in attached:
        w, _ = _annotation_size(kind, item, cells, size)
        gap = 1.0 if kind == "frame" else 4.0  # A datum's triangle and stem.
        if away[1]:
            left, bottom = x0, (y1 + gap if away[1] > 0 else y0 - gap - h)
            edge = (left + w / 2, y1 if away[1] > 0 else y0)
        else:
            left, bottom = (x1 + gap if away[0] > 0 else x0 - gap - w), (y0 + y1) / 2 - h / 2
            edge = (x1 if away[0] > 0 else x0, bottom + h / 2)
        if kind == "frame":
            _control_frame(sheet, cells, left, bottom, size)
        else:
            _datum_symbol(sheet, edge, away, item["label"], size, gap)
        x0, y0, x1, y1 = min(x0, left), min(y0, bottom), max(x1, left + w), max(y1, bottom + h)


def _fit(cells, area, fixed: float | None):
    """The scale (paper per model mm) the view grid fits `area` at: the user's, or the largest preferred one. Each
    cell is (width, height, (left, right), (below, above), (factor, own)): the view in model mm, the paper its
    dimensions take, and its scale: `factor` × the sheet's, or its `own`."""
    if all(own is None for *_, (_, own) in cells.values()):  # Every view scales with the sheet: exactly.
        columns, rows = _tracks(cells, 1.0)
        width = sum(w for w, _, _ in columns.values()) or 1e-9
        height = sum(h for h, _, _ in rows.values()) or 1e-9
        room_w = area[2] - area[0] - sum(a + b for _, a, b in columns.values()) - GAP * (len(columns) - 1)
        room_h = area[3] - area[1] - sum(a + b for _, a, b in rows.values()) - GAP * (len(rows) - 1)
        best = min(room_w / width, room_h / height)
    else:  # Some views at their own scale: the largest sheet scale the rest still fit at.
        def spare(scale):
            columns, rows = _tracks(cells, scale)
            return min(area[2] - area[0] - sum(map(sum, columns.values())) - GAP * (len(columns) - 1),
                       area[3] - area[1] - sum(map(sum, rows.values())) - GAP * (len(rows) - 1))
        best = spare(0.0)
        if best >= 0:
            low, high = 0.0, 1.0
            while spare(high) >= 0 and high < 1e6:
                low, high = high, high * 2
            for _ in range(60):
                middle = (low + high) / 2
                low, high = (middle, high) if spare(middle) >= 0 else (low, middle)
            best = low
    if fixed is not None:
        return fixed, best
    for numerator, denominator in SCALES:
        if numerator / denominator <= best:
            return numerator / denominator, best
    return best, best


def _tracks(cells, scale: float):
    """Per grid column and row: (widest view at `scale`, most paper before it, most paper after it)."""
    columns, rows = {}, {}
    for (column, row), (w, h, (left, right), (below, above), (factor, own)) in cells.items():
        view_scale = own if own is not None else factor * scale
        size, before, after = columns.get(column, (0.0, 0.0, 0.0))
        columns[column] = (max(size, w * view_scale), max(before, left), max(after, right))
        size, before, after = rows.get(row, (0.0, 0.0, 0.0))
        rows[row] = (max(size, h * view_scale), max(before, below), max(after, above))
    return columns, rows


def _scale_text(scale: float) -> str:
    for numerator, denominator in SCALES:
        if abs(numerator / denominator - scale) < 1e-9 * max(1.0, scale):
            return f"{numerator}:{denominator}"
    return f"1:{1 / scale:.4g}" if scale < 1 else f"{scale:.4g}:1"


# ───────── Item balloons (ISO 6433) and hole tables (ASME Y14.5 hole charts) ─────────

def _parts(drawing: Drawing) -> dict | None:
    """A design's placed instances where they're placed (name → shape): together they're the sheet's assembly, as
    Design.result places it. Each one's visible lines are what a balloon points at, and what the Drawing tab's Balloon
    tool picks (Sheet.picks), so every design sheet has them."""
    if drawing.design is None:
        return None
    from .design import _instance_shape
    from .links import LinkedInstance
    parts = {}
    for item in drawing.design.instances:
        if isinstance(item["component"], LinkedInstance) and getattr(item["component"].result, "_steve_empty", False):
            continue  # Nothing modelled yet: not in the assembly.
        shape = _instance_shape(item)
        if shape is not None:
            parts[item["name"]] = shape
    return parts or None


def _row_instances(drawing: Drawing) -> list[list[str]]:
    """Each parts list row's placed instances, in the list's order: the design's own rows list theirs; rows written in
    the code are matched by component name (or id)."""
    named: dict[str, list[str]] = {}
    for item in drawing.design.instances:
        part = item["component"]
        for key in {getattr(part, "name", None), getattr(part, "id", None), getattr(part, "alias", None)} - {None}:
            named.setdefault(key, []).append(item["name"])
    return [row["instances"] if row["instances"] is not None else named.get(row["name"], []) for row in drawing.bom]


def _leader_point(lines):
    """Where a balloon's leader starts: the point on an instance's visible lines nearest their middle (model mm on the
    paper plane), so the dot sits on the part itself."""
    points = [p for line in lines for p in line] + [((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) for line in lines for a, b in zip(line, line[1:])]
    cx, cy = sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points)
    return min(points, key=lambda p: (p[0] - cx) ** 2 + (p[1] - cy) ** 2)


def _balloon_targets(drawing: Drawing, own: dict) -> tuple[dict, list, list]:
    """Each balloon to draw, by view: (balloon, its item number in the parts list, where its leader starts); and the
    ones whose instance is gone (dangling) or that can't be drawn as written. A number is never guessed: it's the row
    of the sheet's own parts list that lists the instance. `own`: view → instance → its visible lines there."""
    found: dict[str, list] = {view: [] for view in drawing.frames}
    dangling, problems = [], []
    if not drawing.balloons:
        return found, dangling, problems
    general = {"annotation": "balloon", "index": None, "view": None, "refs": []}
    if drawing.design is None:
        problems.append({**general, "problem": "balloons point at a design's placed instances, numbered from its parts list: "
                                               "put them on a sheet of the design's result."})
        return found, dangling, problems
    if not drawing.bom:
        problems.append({**general, "problem": "balloons take their numbers from the sheet's parts list: turn it on (bom=True, or rows)."})
        return found, dangling, problems
    rows = _row_instances(drawing)
    if drawing.balloons == "all":  # One per item, on its first instance.
        balloons = []
        for number, instances in enumerate(rows, 1):
            if instances:
                balloons.append({"index": None, "instance": instances[0], "view": None, "side": None, "offset": None, "item": number})
            else:
                problems.append({**general, "item": number, "problem": f"item {number} ({drawing.bom[number - 1]['name']}) has no placed "
                                 "instance to point at (a cable, washer or nut, or a row written by hand); note it beside the parts list."})
    else:
        balloons = drawing.balloons
    placed = {item["name"] for item in drawing.design.instances}
    for balloon in balloons:
        name = balloon["instance"]
        entry = {"annotation": "balloon", "index": balloon["index"], "instance": name, "view": balloon["view"], "refs": [name]}
        if name not in placed:
            dangling.append({**entry, "problem": f"{name!r} isn't placed in the design now: pick the instance again, or remove the balloon."})
            continue
        number = balloon.get("item") or next((i + 1 for i, instances in enumerate(rows) if name in instances), None)
        if number is None:
            problems.append({**entry, "problem": f"{name!r} isn't in the sheet's parts list, so it has no item number."})
            continue
        if balloon["view"] and balloon["view"] not in own:  # A section or detail view that isn't drawn.
            problems.append({**entry, "problem": f"its view {balloon['view']} isn't drawn (see dangling_views or view_problems)."})
            continue
        views = [balloon["view"]] if balloon["view"] else drawing.views
        view = next((view for view in views if own.get(view, {}).get(name)), None)
        if view is None:
            problems.append({**entry, "problem": f"none of {name!r} shows in the {balloon['view']} view: balloon it in another view."
                             if balloon["view"] else f"none of {name!r} shows in this sheet's views."})
            continue
        found[view].append(({**balloon, "view": view}, number, _leader_point(own[view][name])))
    return found, dangling, problems


def _balloon_radius(label: str, size: float) -> float:
    return max(1.1 * size, _width(label, size) / 2 + 1.2)


def _balloon_at(at, paper, side, reach: float):
    """(direction, centre) of a balloon whose leader starts at `at` (paper mm): `reach` past the view's outline `paper`,
    on its `side`, else straight out from the view's middle."""
    x0, y0, x1, y1 = paper
    if side in ("above", "below"):
        d = (0.0, 1.0 if side == "above" else -1.0)
    elif side in ("left", "right"):
        d = (-1.0 if side == "left" else 1.0, 0.0)
    elif side in QUADRANTS:
        d = (QUADRANTS[side][0] * math.sqrt(0.5), QUADRANTS[side][1] * math.sqrt(0.5))
    else:
        dx, dy = at[0] - (x0 + x1) / 2, at[1] - (y0 + y1) / 2
        length = math.hypot(dx, dy)
        d = (dx / length, dy / length) if length > 1e-6 else (math.sqrt(0.5), math.sqrt(0.5))
    exits = [((high if d[k] > 0 else low) - at[k]) / d[k] for k, (low, high) in enumerate(((x0, x1), (y0, y1))) if abs(d[k]) > 1e-9]
    t = max(0.0, min(exits)) + reach
    return d, (at[0] + d[0] * t, at[1] + d[1] * t)


def _out_along(start, d, step: float, fits, clearance=None):
    """Where something placed past its view goes: from `start`, a `step` at a time along `d` (OUT_STEPS at most), the
    first place that `fits` (apart from what's placed like it); else the furthest. When that one isn't clear (its
    `clearance`, as _Room.clearance gives it; None: not tested), the nearest place out from `start`, CLEAR_STEP at a
    time and no further than the steps go, that fits and is clear; else the nearest of the clearest, if clearer."""
    places = [(start[0] + d[0] * k * step, start[1] + d[1] * k * step) for k in range(OUT_STEPS + 1)]
    first = next((p for p in places if fits(p)), None)
    if first is None:
        return places[-1]
    if clearance is None:
        return first
    best = (clearance(first), first)
    for k in range(int(OUT_STEPS * step / CLEAR_STEP) + 1):
        if best[0] == CLEAR:
            break
        p = (start[0] + d[0] * k * CLEAR_STEP, start[1] + d[1] * k * CLEAR_STEP)
        if fits(p) and (level := clearance(p)) > best[0]:
            best = (level, p)
    return best[1]


def _balloons(sheet: Sheet, items, place, paper, size: float, taken: list, room: "_Room | None" = None) -> list[dict]:
    """Draws a view's balloons, each in its own group: a dot on the part, a thin leader and the item number in a circle.
    One that would overlap another goes further out; one with no offset also goes further out until it's clear of what
    `room` finds in the way. `taken`: the balloons already on the sheet (centre, radius)."""
    drawn = []
    for balloon, number, point in items:
        label = str(number)
        r = _balloon_radius(label, size)
        at = place([point])[0]
        apart = lambda p: all(math.hypot(p[0] - ox, p[1] - oy) >= r + other + 1.0 for (ox, oy), other in taken)  # noqa: E731
        tested = room is not None and balloon["offset"] is None
        # Its own side, or straight out; with neither side nor offset written, the other sides too when nothing out
        # that way is clear (its leader would cross a dimension's text): the first clear, else the clearest, first.
        sides = [balloon["side"]] + ([side for side in BALLOON_SIDES] if tested and balloon["side"] is None else [])
        best = None
        for side in sides:
            d, start = _balloon_at(at, paper, side, (balloon["offset"] or BALLOON_OFFSET) + r)
            clearance = lambda p, d=d: room.clearance([_box_corners((p[0] - r, p[1] - r, p[0] + r, p[1] + r))],  # noqa: E731
                                                      [(at, (p[0] - d[0] * r, p[1] - d[1] * r))])
            centre = _out_along(start, d, 2 * r + 1, apart, clearance if tested else None)
            level = clearance(centre) if tested else CLEAR
            if best is None or level > best[0]:
                best = (level, centre, d)
            if level == CLEAR:
                break
        _, (cx, cy), d = best
        taken.append(((cx, cy), r))
        with sheet.group(len(taken), "balloon"):
            sheet.leader(at, (cx - d[0] * r, cy - d[1] * r), "dot")
            _ring(sheet, cx, cy, r)
            sheet.text(cx, cy - 0.35 * size, label, size, "middle")
        x0, y0, x1, y1 = paper  # For dragging it on the sheet: where its leader starts and the view's outline it goes past.
        drawn.append({"balloon": len(taken), "index": balloon["index"], "instance": balloon["instance"], "item": number,
                      "view": balloon["view"], "side": balloon["side"], "offset": balloon["offset"] or BALLOON_OFFSET,
                      "centre": [round(cx, 3), round(sheet.height - cy, 3)], "radius": round(r, 3),
                      "at": [round(at[0], 3), round(sheet.height - at[1], 3)],
                      "box": [round(x0, 3), round(sheet.height - y1, 3), round(x1, 3), round(sheet.height - y0, 3)]})
    return drawn


# ───────── Weld symbols (AWS A2.4, ISO 2553 system A) ─────────

def _weld_anchor(drawing: Drawing, ref: str, view: str):
    """Where a weld's arrow touches its joint in a view (model mm on the paper plane): the point of the named edges,
    faces or vertices nearest their middle there. Raises a dangling _Problem when the ref names nothing now."""
    return _middle_point(drawing, _resolve(drawing, ref), ref, view)


def _middle_point(drawing: Drawing, shapes, ref: str, view: str):
    x, y, _ = _view_axes(drawing.frames[view])
    points = [(p.dot(x), p.dot(y)) for shape in shapes for p in _samples(shape)]
    if not points:
        raise _Problem(f"{ref!r} has no geometry to point at in the {view} view.")
    cx, cy = sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points)
    return min(points, key=lambda p: (p[0] - cx) ** 2 + (p[1] - cy) ** 2)


def _note_anchor(drawing: Drawing, ref: str, view: str):
    """Where a leader note's leader ends in a view (model mm on the paper plane), as a weld's arrow does, and whether it
    ends in a dot: on a flat face seen face-on (as a datum's or frame's leader does), else in an arrowhead."""
    import cadquery as cq
    shapes = _resolve(drawing, ref)
    n = _view_axes(drawing.frames[view])[2]
    dot = (len(shapes) == 1 and isinstance(shapes[0], cq.Face) and shapes[0].geomType() == "PLANE"
           and abs(shapes[0].normalAt().dot(n)) > 1 - 1e-6)
    return _middle_point(drawing, shapes, ref, view), dot


def _leader_box(text: str, knee, s: int, size: float):
    """The paper a leader note's shoulder and text cover (x0, y0, x1, y1), from its knee, the text on the `s` side."""
    reach = NOTE_SHOULDER + 1.0 + _width(text, size)
    x0, x1 = (knee[0], knee[0] + reach) if s > 0 else (knee[0] - reach, knee[0])
    return x0, knee[1] - 0.6 * size, x1, knee[1] + 0.6 * size


def _apart(box, boxes: list, balloons: list) -> bool:
    """Whether a paper box is off the boxes (weld symbols, leader notes) and balloons already placed."""
    return all(box[2] < o[0] or o[2] < box[0] or box[3] < o[1] or o[3] < box[1] for o in boxes) and all(
        box[2] < cx - r or cx + r < box[0] or box[3] < cy - r or cy + r < box[1] for (cx, cy), r in balloons)


def _leader_notes(sheet: Sheet, items, place, paper, size: float, balloons: list, boxes: list, placed: list,
                  room: "_Room | None" = None):
    """Draws a view's leader notes, each in its note group: a thin leader from an arrowhead (or a dot) on its geometry
    to a short horizontal shoulder, the text beside it. One placed past its view that would overlap a weld symbol,
    balloon or note already drawn goes further out, and one with no offset until it's clear of what `room` finds in
    the way too; one placed `at` stays where it's put. Each one drawn goes in `placed`: its leader's tip and knee (the
    SVG's frame: mm, y down), for dragging it on the sheet."""
    for note, point, dot in items:
        tip = place([point])[0]
        if note["at"] is not None:
            knee = (tip[0] + note["at"][0], tip[1] + note["at"][1])
            s = 1 if note["at"][0] >= 0 else -1
        else:
            d, knee = _balloon_at(tip, paper, note["side"], note["offset"] or NOTE_OFFSET)
            s = 1 if d[0] >= -1e-9 else -1
            box = _leader_box(note["text"], knee, s, size)
            step = box[3] - box[1] + 1.0 if abs(d[1]) >= abs(d[0]) else box[2] - box[0] + 1.0
            clearance = lambda k: room.clearance([_box_corners(_leader_box(note["text"], k, s, size))],  # noqa: E731
                                                 [(tip, k), (k, (k[0] + s * NOTE_SHOULDER, k[1]))])
            knee = _out_along(knee, d, step, lambda k: _apart(_leader_box(note["text"], k, s, size), boxes, balloons),
                              clearance if room is not None and note["offset"] is None else None)
        box = _leader_box(note["text"], knee, s, size)
        boxes.append(box)
        placed.append({"note": note["index"], "view": note["view"], "tip": [round(tip[0], 3), round(sheet.height - tip[1], 3)],
                       "knee": [round(knee[0], 3), round(sheet.height - knee[1], 3)]})
        end = (knee[0] + s * NOTE_SHOULDER, knee[1])
        with sheet.group(note["index"], "note"):
            sheet.leader(tip, knee, "dot" if dot else "arrow")
            sheet.line([knee, end])
            sheet.text(end[0] + s * 1.0, knee[1] - 0.35 * size, note["text"], size, "start" if s > 0 else "end")


def _pieces(drawing: Drawing) -> dict:
    """What a weld's joint or bead names (name → shape, where it is on the sheet): a design's placed instances, or a
    part's bodies by id. Raises _Problem on plain CadQuery geometry, which has no names."""
    if drawing.design is not None:
        return _parts(drawing) or {}
    if drawing.model is not None:
        return dict(drawing.model.bodies)
    raise _Problem("this drawing shows plain CadQuery geometry, whose bodies have no names: draw a part's or design's "
                   "result, or point at the joint with refs like select(edges, \">Z\").")


def _piece(drawing: Drawing, pieces: dict, name: str):
    shape = pieces.get(name)
    if shape is None:
        what = "placed instance in the design" if drawing.design is not None else "body of the part"
        raise _Problem(f"{name!r} isn't a {what} now: pick it again, or remove the weld.", dangling=True)
    return shape


def _distance(shape, point) -> float:
    """How far a model point is from a shape (0 on it, or inside a solid)."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    from OCP.gp import gp_Pnt
    try:
        measure = BRepExtrema_DistShapeShape(BRepBuilderAPI_MakeVertex(gp_Pnt(point.x, point.y, point.z)).Vertex(), shape.wrapped)
        return measure.Value() if measure.IsDone() else math.inf
    except Exception:
        return math.inf


def _joint_places(a, b, names) -> list:
    """Where two bodies or instances touch (model mm): one point per contact place, its middle when that touches both
    (else its point nearest it), ordered along x, then y, then z. The places are the closest points of the two, joined
    where the pieces touch all the way between them (a wire lying on a bracket: one; a wire across two rails: two).
    Raises a dangling _Problem when they no longer touch."""
    import cadquery as cq
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    size = max(a.BoundingBox().DiagonalLength, b.BoundingBox().DiagonalLength, 1.0)
    touching, close = size * 1e-5, size * 1e-3
    try:
        measure = BRepExtrema_DistShapeShape(a.wrapped, b.wrapped)
        count = measure.NbSolution() if measure.IsDone() else 0
    except Exception:
        count = 0
    if count < 1:
        raise _Problem(f"where {names[0]!r} and {names[1]!r} meet can't be found; point at the joint with refs instead.")
    if measure.Value() > touching:
        raise _Problem(f"{names[0]!r} and {names[1]!r} no longer touch: move them together, or pick the joint again.",
                       dangling=True)
    points = []
    for i in range(1, min(count, 64 * JOINT_POINTS) + 1):
        p = measure.PointOnShape1(i)
        point = cq.Vector(p.X(), p.Y(), p.Z())
        if all((point - q).Length > close for q in points):
            points.append(point)
            if len(points) == JOINT_POINTS:
                break
    on_both = lambda p: _distance(a, p) <= close and _distance(b, p) <= close  # noqa: E731

    def meet(p, q):  # Touching all the way between them: one contact place.
        return all(on_both(p + (q - p) * t) for t in (0.25, 0.5, 0.75))

    groups = []
    for point in points:
        joined = [group for group in groups if any(meet(point, q) for q in group)]
        groups = [group for group in groups if not any(group is other for other in joined)]
        groups.append([point] + [q for group in joined for q in group])
    found = []
    for group in groups:
        middle = sum(group, cq.Vector()) * (1.0 / len(group))
        found.append(middle if len(group) == 1 or on_both(middle) else min(group, key=lambda p: (p - middle).Length))
    return sorted(found, key=lambda p: (round(p.x / close), round(p.y / close), round(p.z / close)))


def _on_lines(point, lines, tolerance: float) -> bool:
    """Whether a paper-plane point lies on any of these polylines."""
    px, py = point
    for line in lines:
        for (ax, ay), (bx, by) in zip(line, line[1:]):
            dx, dy = bx - ax, by - ay
            t = min(1.0, max(0.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) if dx or dy else 0.0
            if math.hypot(ax + t * dx - px, ay + t * dy - py) <= tolerance:
                return True
    return False


def _weld_pieces(drawing: Drawing, weld: dict, view: str, lines: dict, tolerance: float, pieces: dict | None = None) -> list:
    """For a weld that names its joint or bead: (what each arrow points at, for the report; how to find its tip, model
    mm on the view's paper plane). `lines`: each body's or instance's visible lines in the view (empty when the kernel
    couldn't tell them apart: then nothing is reported hidden); `pieces`: the sheet's instances or bodies, when it has
    them already. A joint's arrow goes to each place the two touch (or the ones `places` picks), a bead's to its visible
    lines nearest their middle. Raises _Problem for the whole weld: a name that's gone, or a joint whose pieces no
    longer touch (dangling)."""
    x, y, _ = _view_axes(drawing.frames[view])
    pieces = pieces if pieces is not None else _pieces(drawing)
    if weld["bead"]:
        name = weld["bead"]
        shape = _piece(drawing, pieces, name)

        def bead():
            if lines:
                if not lines.get(name):
                    raise _Problem(f"{name!r} doesn't show in the {view} view (hidden, or outside it); use another view.")
                return _leader_point(lines[name])
            points = [(p.dot(x), p.dot(y)) for p in _samples(shape)]
            cx, cy = sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points)
            return min(points, key=lambda p: (p[0] - cx) ** 2 + (p[1] - cy) ** 2)
        return [({"refs": [name]}, bead)]
    names = weld["joint"]
    a, b = (_piece(drawing, pieces, name) for name in names)
    places = _joint_places(a, b, names)
    seen = [line for name in names for line in lines.get(name, ())]

    def place(i):
        if i >= len(places):
            raise _Problem(f"the joint touches in {len(places)} place{'' if len(places) == 1 else 's'} now (places counts "
                           "from 0): pick its places again.", dangling=True)
        at = (places[i].dot(x), places[i].dot(y))
        if lines and not _on_lines(at, seen, 4 * tolerance):
            raise _Problem(f"the joint is hidden in the {view} view; use another view.")
        return at
    chosen = weld["places"] if weld["places"] is not None else range(min(len(places), WELD_LEADERS))
    found = [({"refs": list(names), "place": i}, lambda i=i: place(i)) for i in chosen]
    if weld["places"] is None and len(places) > WELD_LEADERS:
        def more():
            raise _Problem(f"the joint touches in {len(places)} places; arrows go to the first {WELD_LEADERS}: pick "
                           "the ones to show with places.")
        found.append(({"refs": list(names)}, more))
    return found


def _weld_texts(drawing: Drawing, weld: dict) -> tuple[str, str]:
    """A weld's size (left of its symbol) and length and pitch (right of it) in its standard's order: AWS A2.4
    `3` and `15-50`, a groove's depth and effective throat `6(5)` (`(5)` alone); ISO 2553 `a3` (`z3` for a leg) and
    `15(50)`, a plug's or spot weld's diameter `d`, a slot's width `c`, a groove weld's penetration `s` (its throat
    when given, else its size)."""
    figure = lambda v: _figure(v, drawing.units, _places(v)) if v is not None else ""  # noqa: E731
    size, length, pitch, throat = (figure(weld[key]) for key in ("size", "length", "pitch", "throat"))
    if drawing.standard == "ISO":
        size = throat or size
        if size:
            size = ("s" if weld["type"] in WELD_GROOVES else
                    {"fillet": "z" if weld["leg"] else "a", "plug": "d", "spot": "d", "slot": "c"}[weld["type"]]) + size
        return size, f"{length}({pitch})" if pitch else length
    return size + (f"({throat})" if throat else ""), f"{length}-{pitch}" if length and pitch else length or pitch


# A groove symbol's opening at half its height, where its root opening is written: (the share of the symbol's width
# that's open, and the open part's middle, from the symbol's left end).
WELD_OPENINGS = {"square": (1.0, 0.5), "v": (0.5, 0.5), "bevel": (0.5, 0.25), "u": (0.85, 0.5), "j": (0.85, 0.45),
                 "flare_v": (0.3, 0.5), "flare_bevel": (0.3, 0.15)}


def _weld_extras(drawing: Drawing, weld: dict, size: float) -> tuple[str, list]:
    """A weld's root opening (written inside its symbol) and the marks stacked outward past the symbol, in AWS A2.4's
    order from the reference line: the groove angle, then the contour, then the finish letter on the contour. Each
    mark with how far past the one before it reaches (paper mm, its gap included)."""
    opening = weld["root_opening"]
    root = _figure(opening, drawing.units, _places(opening)) if opening is not None else ""
    marks = []
    if weld["angle"] is not None:
        marks.append(("angle", f"{weld['angle']:g}°", 0.8 + 0.7 * size))
    if weld["contour"]:
        marks.append(("contour", weld["contour"], 0.8 + 0.4 * size))
    if weld["finish"]:
        marks.append(("finish", weld["finish"], 0.6 + 0.7 * size))
    return root, marks


def _weld_layout(drawing: Drawing, weld: dict, size: float) -> dict:
    """A weld symbol's measures along its reference line (paper mm): its texts, the symbol's width and height, the
    room left at the arrow's end (for the field flag and all-around circle), the room before the symbol (its size, or
    a mark wider than the symbol), the content's width, the line's length, the tail's, and how far it reaches above and
    below the line."""
    left, right = _weld_texts(drawing, weld)
    root, marks = _weld_extras(drawing, weld, size)
    h = size
    if weld["type"] in ("plug", "slot"):
        glyph = (1.4 * h, 0.7 * h)
    elif weld["type"] in WELD_GROOVES:  # Wide enough for its root opening, written inside it.
        share = WELD_OPENINGS[weld["type"]][0]
        glyph = (max(0.6 * h if weld["type"] == "square" else h, (_width(root, 0.8 * size) + 0.6) / share if root else 0.0), h)
    else:
        glyph = (h, h)
    overhang = max([(_width(text, size) - glyph[0]) / 2 for kind, text, _ in marks if kind != "contour"] + [0.0])
    gap = 3.0 + (0.6 * 1.6 * size if weld["field"] else 0.0) + (1.5 if weld["all_around"] else 0.0)
    lead = max(_width(left, size) + 1 if left else 0.0, overhang)
    content = lead + glyph[0] + max(1 + _width(right, size) if right else 0.0, overhang)
    tail = 4.0 + _width(weld["tail"], size) if weld["tail"] else 0.0
    # A symbol, its marks and its texts each side; the ISO dashed line under it.
    reach = max(glyph[1] + sum(depth for *_, depth in marks), size) + 2.5
    return {"left": left, "right": right, "root": root, "marks": marks, "glyph": glyph, "gap": gap, "lead": lead,
            "content": content, "length": max(12.0, gap + content + 3.0), "tail": tail,
            "above": max(reach, 1.6 * size if weld["field"] else 0.0), "below": reach}


def _weld_box(layout: dict, junction, s: int):
    """The paper a weld symbol covers, its reference line running from `junction` along x by `s` (1 or -1)."""
    jx, jy = junction
    far = jx + s * (layout["length"] + layout["tail"])
    return min(jx, far) - 1.5, jy - layout["below"], max(jx, far) + 1.5, jy + layout["above"]


def _weld_glyph(sheet: Sheet, kind: str, x: float, base: float, up: int, glyph):
    """A weld's symbol from its left end `x`, standing on the line at `base` (`up` 1) or hung under it (-1): a fillet's
    triangle with its upright leg on the left, a plug or slot weld's rectangle, a spot weld's circle, and the grooves:
    a square groove's two uprights, a V, a bevel (upright and slanted legs), a U and a J (on a short root, the J's
    upright on the left), a flare-V's two arcs back to back and a flare-bevel's upright and arc. As in AWS A2.4, a
    symbol's upright leg is on the left whichever way its line runs."""
    w, h = glyph
    y = lambda d: base + up * d  # noqa: E731  (a height off the line, toward the symbol's side)
    steps = [i / 12 for i in range(13)]
    if kind == "fillet":
        sheet.line([(x, base), (x, base + up * h), (x + w, base)])
    elif kind in ("plug", "slot"):
        sheet.line([(x, base), (x, base + up * h), (x + w, base + up * h), (x + w, base)])
    elif kind == "square":
        sheet.line([(x, base), (x, y(h))])
        sheet.line([(x + w, base), (x + w, y(h))])
    elif kind == "v":
        sheet.line([(x, y(h)), (x + w / 2, base), (x + w, y(h))])
    elif kind == "bevel":
        sheet.line([(x, y(h)), (x, base), (x + w, y(h))])
    elif kind == "u":  # A root, a half ellipse opening away from the line, and its straight sides.
        root, ry, cx = 0.3 * h, 0.35 * h, x + w / 2
        sheet.line([(cx, base), (cx, y(root))])
        sheet.line([(x, y(h))] + [(cx - w / 2 * math.cos(t * math.pi), y(root + ry - ry * math.sin(t * math.pi))) for t in steps]
                   + [(x + w, y(h))])
    elif kind == "j":  # The upright, and a quarter ellipse from its root up to the open side.
        root, ry = 0.3 * h, 0.35 * h
        sheet.line([(x, base), (x, y(h))])
        sheet.line([(x + w * math.sin(t * math.pi / 2), y(root + ry * (1 - math.cos(t * math.pi / 2)))) for t in steps]
                   + [(x + w, y(h))])
    elif kind == "flare_v":  # ")(" : each arc from the line out to the symbol's height, bowed toward the middle.
        bow = 0.35 * w
        sheet.line([(x + bow * math.sin(t * math.pi), y(h * (1 - math.cos(t * math.pi)) / 2)) for t in steps])
        sheet.line([(x + w - bow * math.sin(t * math.pi), y(h * (1 - math.cos(t * math.pi)) / 2)) for t in steps])
    elif kind == "flare_bevel":  # "|(" : the upright, and an arc bowed toward it.
        sheet.line([(x, base), (x, y(h))])
        sheet.line([(x + w - 0.7 * w * math.sin(t * math.pi), y(h * (1 - math.cos(t * math.pi)) / 2)) for t in steps])
    else:
        _ring(sheet, x + w / 2, base + up * h / 2, h / 2)


def _weld_marks(sheet: Sheet, kind: str, layout: dict, x: float, base: float, up: int, size: float):
    """A weld symbol's root opening, inside it at half its height, and its marks stacked outward from it in AWS A2.4's
    order: the groove angle just past the symbol, then the contour (a flush line, or a convex or concave arc), then the
    finish letter outermost, on the contour."""
    w, h = layout["glyph"]
    cx = x + w / 2
    if layout["root"]:
        small = 0.8 * size
        sheet.text(x + w * WELD_OPENINGS[kind][1], base + up * h / 2 - 0.35 * small, layout["root"], small, "middle")
    reach = h
    for mark, value, depth in layout["marks"]:
        inner = reach + depth - (0.4 * size if mark == "contour" else 0.7 * size)  # Its near edge, past its gap.
        if mark == "contour":
            rise = 0.4 * size
            bump = [math.sin(i / 12 * math.pi) for i in range(13)]
            heights = {"flush": [rise / 2] * 13, "convex": [rise * b for b in bump], "concave": [rise * (1 - b) for b in bump]}[value]
            sheet.line([(x + w * i / 12, base + up * (inner + d)) for i, d in enumerate(heights)])
        else:
            sheet.text(cx, base + up * inner if up > 0 else base - inner - 0.7 * size, value, size, "middle")
        reach += depth


def _weld_symbol(sheet: Sheet, drawing: Drawing, weld: dict, arrows, junction, s: int, layout: dict, size: float):
    """A weld symbol: an arrow from each point in `arrows` (paper) to `junction`, the reference line from there along x
    by `s`, the all-around circle and field flag at the junction, the symbol with its texts and marks on the arrow
    side, the other side or both, and the tail with its note. AWS A2.4 puts the arrow side under the line; ISO 2553
    system A puts it on the continuous line, the other side on a dashed identification line under it (left out for
    symmetric welds and spot welds centred on the line)."""
    jx, jy = junction
    end = jx + s * layout["length"]
    sheet.line([(jx, jy), (end, jy)])
    for tip in arrows:
        sheet.leader(tip, junction)
    if weld["all_around"]:
        _ring(sheet, jx, jy, 1.5)
    if weld["field"]:  # A flag on a staff at the junction, pointing to the tail.
        f = 1.6 * size
        sheet.line([(jx, jy), (jx, jy + f)])
        sheet.fills.append([(jx, jy + f), (jx, jy + 0.6 * f), (jx + s * 0.6 * f, jy + 0.8 * f)])
    left = jx + layout["gap"] if s > 0 else jx - layout["gap"] - layout["content"]  # The content reads left to right.
    x = left + layout["lead"]
    w, h = layout["glyph"]
    iso = drawing.standard == "ISO"
    if weld["side"] == "centre":  # A spot weld on the line, its texts above it.
        _ring(sheet, x + w / 2, jy, h / 2)
        baselines = [jy + 0.8]
    else:
        dash = 1.2 if iso and weld["side"] != "both" else 0.0
        if dash:  # ISO 2553's identification line, under the reference line.
            sheet.line([(jx + s * 2.0, jy - dash), (end, jy - dash)], "hidden")
        sides = {"arrow": [(jy, 1)] if iso else [(jy, -1)], "other": [(jy - dash, -1)] if iso else [(jy, 1)],
                 "both": [(jy, 1), (jy, -1)]}[weld["side"]]
        baselines = []
        for base, up in sides:
            _weld_glyph(sheet, weld["type"], x, base, up, layout["glyph"])
            _weld_marks(sheet, weld["type"], layout, x, base, up, size)
            baselines.append(base + up * h / 2 - 0.35 * size)
    for baseline in baselines:
        if layout["left"]:
            sheet.text(x - 1, baseline, layout["left"], size, "end")
        if layout["right"]:
            sheet.text(x + w + 1, baseline, layout["right"], size)
    if weld["tail"]:  # Two short lines opening away from the line's end, and the note past them.
        for dy in (3.0, -3.0):
            sheet.line([(end, jy), (end + s * 3.0, jy + dy)])
        sheet.text(end + s * 4.0, jy - 0.35 * size, weld["tail"], size, "start" if s > 0 else "end")


def _welds(sheet: Sheet, drawing: Drawing, items, place, paper, size: float, balloons: list, boxes: list, placed: list,
           room: "_Room | None" = None) -> int:
    """Draws a view's weld symbols, each in its own group. One placed past its view that would overlap a weld symbol or
    balloon already drawn goes further out, and one with no offset until it's clear of what `room` finds in the way
    too; one placed `at` stays where it's put. Each one drawn goes in `placed`: its first arrow's tip and its reference
    line's start (the SVG's frame: mm, y down), for dragging it on the sheet. Returns how many were drawn."""
    for weld, points in items:
        arrows = place(points)
        layout = _weld_layout(drawing, weld, size)
        if weld["at"] is not None:
            junction = (arrows[0][0] + weld["at"][0], arrows[0][1] + weld["at"][1])
            s = 1 if weld["at"][0] >= 0 else -1
        else:
            d, junction = _balloon_at(arrows[0], paper, weld["place"], weld["offset"] or WELD_OFFSET)
            s = 1 if d[0] >= -1e-9 else -1
            box = _weld_box(layout, junction, s)
            step = box[3] - box[1] + 1.0 if abs(d[1]) >= abs(d[0]) else box[2] - box[0] + 1.0
            clearance = lambda j: room.clearance([_box_corners(_weld_box(layout, j, s))],  # noqa: E731
                                                 [(arrow, j) for arrow in arrows])
            junction = _out_along(junction, d, step, lambda j: _apart(_weld_box(layout, j, s), boxes, balloons),
                                  clearance if room is not None and weld["offset"] is None else None)
        box = _weld_box(layout, junction, s)
        boxes.append(box)
        placed.append({"weld": weld["index"], "view": weld["view"],
                       "tip": [round(arrows[0][0], 3), round(sheet.height - arrows[0][1], 3)],
                       "junction": [round(junction[0], 3), round(sheet.height - junction[1], 3)]})
        with sheet.group(weld["index"], "weld"):
            _weld_symbol(sheet, drawing, weld, arrows, junction, s, layout, size)
    return len(items)


def _letters(n: int) -> str:
    """A hole size's letter: A, B, … Z, AA, AB, …"""
    return (_letters(n // 26 - 1) if n >= 26 else "") + chr(ord("A") + n % 26)


def _hole_refs(drawing: Drawing, table: dict) -> list[tuple]:
    """(reference, hole feature's id or None, hole index, listed) for each hole a table names. Listed: written in
    `holes`, so one that can't be shown is reported rather than left out as by default."""
    model = drawing.model
    if table["holes"] is None:
        if model is None:
            raise _Problem("plain CadQuery geometry has no hole features: list its holes, like "
                           "holes=[\"select(faces, '%CYLINDER')\"].")
        return [(f"{f.id}.wall({i})", f.id, i, False) for f in model.features if f.kind == "hole" for i in range(f.detail.get("holes", 0))]
    refs = []
    for ref in table["holes"]:
        feature = model.feature(ref) if model is not None and HOLE_ID.fullmatch(ref) else None
        if feature is not None and feature.kind == "hole" and feature.detail.get("holes"):
            refs += [(f"{ref}.wall({i})", ref, i, True) for i in range(feature.detail["holes"])]
        elif model is not None and (match := HOLE_WALL.fullmatch(ref)) and getattr(model.feature(match.group(1)), "kind", None) == "hole":
            refs.append((ref, match.group(1), int(match.group(2)), True))
        else:
            refs.append((ref, None, None, True))
    return refs


def _hole_groups(shapes, tolerance: float) -> list:
    """Cylindrical faces grouped into holes (the same axis and radius): [((centre, axis, radius), faces)]."""
    import cadquery as cq
    groups = []
    for shape in shapes:
        found = _round(shape) if isinstance(shape, cq.Face) else None
        if found is None:
            continue
        for (centre, axis, radius), faces in groups:
            if abs(found[2] - radius) <= tolerance and abs(abs(found[1].dot(axis)) - 1) < 1e-6 and (found[0] - centre).cross(axis).Length <= tolerance:
                faces.append(shape)
                break
        else:
            groups.append((found, [shape]))
    return groups


def _hole_size(drawing: Drawing, feature_id: str | None, index: int | None, group) -> dict:
    """A hole's diameter, depth (None: through), counterbore or countersink and thread, from the model's exact
    geometry and its hole feature's names: {id}.floor(i), .cbore(i), .csk(i). Without a feature (a selector), the
    depth is the wall's length."""
    import cadquery as cq
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    (centre, axis, radius), walls = group

    def named(kind):
        try:
            return _resolve(drawing, f"{feature_id}.{kind}({index})")
        except _Problem:  # A simple hole has no counterbore; a through hole no floor.
            return []

    def along(faces):
        return [p.dot(axis) for face in faces for p in _samples(face)]

    floor, cbore, csk = (named(kind) if feature_id else [] for kind in ("floor", "cbore", "csk"))
    cbore = [face for face in cbore if _round(face) is not None]
    csk = [face for face in csk if isinstance(face, cq.Face) and face.geomType() == "CONE"]
    extras = []
    if cbore:
        values = along(cbore)
        extras.append(("cbore", 2 * _round(cbore[0])[2], max(values) - min(values)))
    if csk:
        reach = max(((p - centre) - axis * (p - centre).dot(axis)).Length for face in csk for p in _samples(face))
        extras.append(("csk", 2 * reach, 2 * math.degrees(abs(BRepAdaptor_Surface(csk[0].wrapped).Cone().SemiAngle()))))
    if floor:  # From the floor to the hole's mouth (its counterbore's or countersink's top).
        level = floor[0].Center().dot(axis)
        depth = max(abs(value - level) for value in along(walls + cbore + csk))
    elif feature_id:
        depth = None
    else:
        values = along(walls)
        depth = max(values) - min(values)
    feature = drawing.model.feature(feature_id) if feature_id else None
    return {"diameter": 2 * radius, "depth": depth, "extras": extras, "thread": (feature.detail.get("thread") if feature else None) or ""}


def _hole_table_rows(drawing: Drawing, table: dict, box, clip) -> tuple[list, list, list]:
    """A hole table's holes in its view, tagged by size (A1, A2, B1…) and in tag order: [{tag, at (model mm on the
    paper plane), radius, cells, csv}]; the holes whose geometry is gone (dangling) and the ones that can't be shown
    there. Positions are from `origin`, else the view's lower-left corner. Raises _Problem when the table can't be made."""
    view = table["view"]
    x, y, n = _view_axes(drawing.frames[view])
    tolerance = max(drawing.shape.BoundingBox().DiagonalLength, 1.0) * 1e-6
    if table["origin"] is None:
        origin = (box[0], box[1])
    else:
        point = _point(drawing, table["origin"])
        origin = (point.dot(x), point.dot(y))
    holes, dangling, problems = [], [], []
    for ref, feature_id, index, listed in _hole_refs(drawing, table):
        entry = {"annotation": "hole", "index": table["index"], "view": view, "refs": [ref]}
        try:
            groups = _hole_groups(_resolve(drawing, ref), tolerance)
            if not groups:
                raise _Problem(f"{ref!r} isn't a hole's cylindrical wall now.")
        except _Problem as problem:
            (dangling if problem.dangling else problems).append({**entry, "problem": str(problem)})
            continue
        for group in groups:
            centre, axis, radius = group[0]
            at = (centre.dot(x), centre.dot(y))
            if abs(abs(axis.dot(n)) - 1) > 1e-6:
                if listed:
                    problems.append({**entry, "problem": f"it doesn't show round in the {view} view: tabulate it in the view that looks along it."})
                continue
            if clip and not _inside([at], *clip):
                if listed:
                    problems.append({**entry, "problem": f"it's outside detail {view}'s circle: tabulate it in the parent view."})
                continue
            holes.append((at, radius, _hole_size(drawing, feature_id, index, group)))
    units = drawing.units
    length = lambda mm: _figure(mm / 25.4 if units == "in" else mm, units)  # noqa: E731
    sizes, counts, rows = {}, {}, []
    for at, radius, hole in holes:
        callout = [f"CBORE ⌀{length(d)} × {length(amount)}" if kind == "cbore" else f"CSK ⌀{length(d)} × {amount:.0f}°"
                   for kind, d, amount in hole["extras"]] + ([hole["thread"]] if hole["thread"] else [])
        size = ("⌀" + length(hole["diameter"]), "THRU" if hole["depth"] is None else length(hole["depth"]), "; ".join(callout))
        letter = sizes.setdefault(size, len(sizes))
        counts[letter] = counts.get(letter, 0) + 1
        tag = f"{_letters(letter)}{counts[letter]}"
        dx, dy = at[0] - origin[0], at[1] - origin[1]
        rows.append({"order": (letter, counts[letter]), "tag": tag, "at": at, "radius": radius, "cells": [tag, length(dx), length(dy), *size],
                     "csv": [table["index"], tag, round(dx, 4), round(dy, 4), round(hole["diameter"], 4),
                             "THRU" if hole["depth"] is None else round(hole["depth"], 4), size[2]]})
    return sorted(rows, key=lambda row: row["order"]), dangling, problems


TAG_STEPS = 2  # How far out a hole's tag may go on its leader, in steps of a tag's height


def _hole_tags(sheet: Sheet, number: int, rows, place, scale: float, size: float, room: "_Room | None" = None):
    """A hole table's tags beside its holes in the view, as one group: up-right of each hole, or the first other corner
    of it where `room` finds nothing in the way (the tags before it included); else the first place a little further
    out (TAG_STEPS at most) on a short leader from the hole that's wholly clear (_Room.clearance); else the corner
    whose text is clearest. Too many holes too close for their scale stay where they are, reported (overlaps)."""
    with sheet.group(number, "hole-table"):
        for row in rows:
            (cx, cy), = place([row["at"]])
            edge = row["radius"] * scale * math.sqrt(0.5)  # Across and up from its middle to its edge, diagonally

            def tag(where, cx=cx, cy=cy, edge=edge, text=row["tag"]):
                quadrant, k = where
                sx, sy = QUADRANTS[quadrant]
                reach = edge + 0.6 + k * (0.8 * size + 1.0)
                corner = (cx + sx * reach, cy + sy * reach)  # The tag's corner nearest the hole
                if k:
                    sheet.line([(cx + sx * edge, cy + sy * edge), corner])
                sheet.text(corner[0], corner[1] if sy > 0 else corner[1] - 0.8 * size, text, size, "start" if sx > 0 else "end")

            _first_clear(sheet, room, [(quadrant, k) for k in range(TAG_STEPS + 1) for quadrant in QUADRANTS], tag,
                         lambda where: CLEAR if where[1] else 1)  # A leader only where nothing's in the way


# ───────── Section and detail views ─────────

def _in_time(deadline: float | None, section: bool = False):
    if deadline is not None and time.monotonic() > deadline:
        raise TimeoutError("The drawing's views ran out of build time; draw fewer views or a component at a time"
                           + (" (a section of one component is much quicker than one of a whole assembly)." if section else "."))


def _point(drawing: Drawing, at):
    """A model point: as written, or where a reference is now (a hole's or shaft's axis, a vertex, the middle of a
    face or edge). Raises a dangling _Problem when the reference names nothing."""
    import cadquery as cq
    if isinstance(at, tuple):
        return cq.Vector(*at)
    shapes = _resolve(drawing, at)
    middle = sum((shape.Center() for shape in shapes), cq.Vector()) * (1.0 / len(shapes))
    found = [_round(shape) for shape in shapes]
    if None not in found:  # On the axis, level with the feature.
        centre, axis, _ = found[0]
        return centre + axis * (middle - centre).dot(axis)
    return middle


def _section(drawing: Drawing, child: dict, tolerance: float, hidden: bool, parts: dict | None = None, own: dict | None = None,
             cache: "_Projections | None" = None, keyed=None):
    """A section view: (visible, hidden) lines of the material behind its cutting plane, seen square to it; its cut
    faces' outlines per solid, [(solid's index, segments)] in model mm on its paper plane, to hatch; and the point the
    plane goes through. With a design's `parts` (as project's), each is cut on its own and `own` gets each one's
    visible lines in the section, for balloons. Raises _Problem when the plane's reference is gone or the plane misses
    the model. With a projection `cache`, it's taken from there when `keyed` (render's) finds it, and kept there."""
    import cadquery as cq
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
    point = _point(drawing, child["through"])
    own = {} if own is None else own
    key = keyed("section", child["frame"], point.toTuple(), hidden, tolerance) if cache is not None and keyed else None
    if key and (found := cache.reuse(key, own, section=True)) is not None:
        return found
    u, v, t = _view_axes(child["frame"])
    box = drawing.shape.BoundingBox()
    size = max(box.DiagonalLength, 1.0) * 2
    on = box.center + t * (point.dot(t) - box.center.dot(t))  # The plane's point nearest the model's middle.
    plane = cq.Face.makePlane(2 * size, 2 * size, on, t)
    cuts = []
    for index, solid in enumerate(drawing.shape.Solids()):
        segments = []
        for face in solid.intersect(plane).Faces():
            for edge in face.Edges():
                points = [(p.dot(u), p.dot(v)) for p in _edge_points(edge, tolerance)]
                segments += zip(points, points[1:])
        if segments:
            cuts.append((index, segments))
    if not cuts:
        raise _Problem("its cutting plane misses the model: put `through` on the part.")
    # Everything between the plane and the viewer is taken away (a box past the plane, larger than the model).
    corner = on - u * size - v * size
    cutter = BRepPrimAPI_MakeBox(gp_Ax2(gp_Pnt(*corner.toTuple()), gp_Dir(*t.toTuple()), gp_Dir(*u.toTuple())),
                                 2 * size, 2 * size, size).Shape()
    cutter = cq.Shape.cast(cutter)
    kept = None
    if parts:
        try:  # Each instance's material behind the plane; one wholly in front of it is gone from the section.
            kept = {name: rest for name, part in parts.items() if (rest := part.cut(cutter)).Faces()}
        except Exception:  # The kernel can't cut them one by one: the whole, and balloons report they can't find theirs.
            kept = None
    if kept:
        visible, dashed = project(None, child["frame"], hidden, tolerance, kept, own)
    else:
        visible, dashed = project(drawing.shape.cut(cutter), child["frame"], hidden, tolerance)
    if cache is not None:
        cache.keep(key, visible, dashed, own, cuts, point)
    return visible, dashed, cuts, point


def _hatch(segments, angle: float, spacing: float) -> list:
    """Hatch lines (paper mm) across the region `segments` bound, at `angle`° and `spacing` mm apart. Even-odd, so a
    hole's outline leaves it clear and the order of the segments doesn't matter."""
    c, s = math.cos(math.radians(angle)), math.sin(math.radians(angle))
    edges = [((ay * c - ax * s, ax * c + ay * s), (by * c - bx * s, bx * c + by * s)) for (ax, ay), (bx, by) in segments]
    if not edges:
        return []
    low = min(min(a[0], b[0]) for a, b in edges)
    high = max(max(a[0], b[0]) for a, b in edges)
    lines, level = [], (math.floor(low / spacing) + 1) * spacing
    while level < high:  # Across the hatching, each line's crossings with the outline, paired in from the outside.
        hits = sorted(a[1] + (level - a[0]) * (b[1] - a[1]) / (b[0] - a[0]) for a, b in edges
                      if a[0] <= level < b[0] or b[0] <= level < a[0])
        for start, end in zip(hits[0::2], hits[1::2]):
            if end - start > 1e-9:
                lines.append([(start * c - level * s, level * c + start * s), (end * c - level * s, level * c + end * s)])
        level += spacing
    return lines


def _clip(line, centre, radius: float) -> list:
    """The pieces of a polyline inside a circle (a detail view's)."""
    (cx, cy), pieces, current = centre, [], []
    for (ax, ay), (bx, by) in zip(line, line[1:]):
        dx, dy, fx, fy = bx - ax, by - ay, ax - cx, ay - cy
        a, b, c = dx * dx + dy * dy, 2 * (fx * dx + fy * dy), fx * fx + fy * fy - radius * radius
        if a <= 1e-18:
            continue
        root = b * b - 4 * a * c
        low, high = ((-b - math.sqrt(root)) / (2 * a), (-b + math.sqrt(root)) / (2 * a)) if root > 0 else (1.0, 0.0)
        low, high = max(low, 0.0), min(high, 1.0)
        if low >= high:
            if current:
                pieces.append(current)
                current = []
            continue
        start, end = (ax + dx * low, ay + dy * low), (ax + dx * high, ay + dy * high)
        if not current or low > 1e-9:
            if current:
                pieces.append(current)
            current = [start]
        current.append(end)
        if high < 1 - 1e-9:
            pieces.append(current)
            current = []
    if current:
        pieces.append(current)
    return [piece for piece in pieces if len(piece) >= 2]


# ───────── Shaded views ─────────

def _mesh(shape, deflection: float, deadline: float | None) -> list:
    """`shape`'s triangles (three model points each, wound outward) from a mesh of a copy within `deflection` mm, so
    the model's own mesh isn't touched."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.TopAbs import TopAbs_REVERSED
    from OCP.TopLoc import TopLoc_Location
    copy = shape.copy(mesh=False)
    BRepMesh_IncrementalMesh(copy.wrapped, deflection, False, 0.3, True)
    triangles = []
    for face in copy.Faces():
        _in_time(deadline)
        location = TopLoc_Location()
        mesh = BRep_Tool.Triangulation_s(face.wrapped, location)
        if mesh is None:
            continue
        move = location.Transformation()
        nodes = [(p.X(), p.Y(), p.Z()) for p in (mesh.Node(i).Transformed(move) for i in range(1, mesh.NbNodes() + 1))]
        reverse = face.wrapped.Orientation() == TopAbs_REVERSED
        for i in range(1, mesh.NbTriangles() + 1):
            corner = mesh.Triangle(i)
            a, b, c = (nodes[corner.Value(k) - 1] for k in (1, 2, 3))
            triangles.append((a, c, b) if reverse else (a, b, c))
    return triangles


def _shade(triangles, frame) -> list:
    """A shaded view's faces: (triangle in model mm on its paper plane, grey level, 0 the lightest), farthest first so
    nearer ones paint over them; the ones turned away aren't seen. Flat Lambert shading, lit from over the viewer's
    left shoulder."""
    n, x = _unit(frame[0]), _unit(frame[1])
    y = _cross(n, x)
    light = _unit(tuple(2 * nc + yc - 0.5 * xc for nc, yc, xc in zip(n, y, x)))
    dot = lambda a, b: a[0] * b[0] + a[1] * b[1] + a[2] * b[2]  # noqa: E731
    faces = []
    for a, b, c in triangles:
        normal = _cross((b[0] - a[0], b[1] - a[1], b[2] - a[2]), (c[0] - a[0], c[1] - a[1], c[2] - a[2]))
        length = math.sqrt(dot(normal, normal))
        if length <= 1e-18 or dot(normal, n) <= 1e-9 * length:
            continue
        lit = max(0.0, dot(normal, light) / length)
        faces.append((dot(a, n) + dot(b, n) + dot(c, n), min(SHADES - 1, int((1 - lit) * SHADES)),
                      [(dot(p, x), dot(p, y)) for p in (a, b, c)]))
    faces.sort(key=lambda face: face[0])
    return [(polygon, level) for _, level, polygon in faces]


def _clip_fill(polygon, centre, radius: float, sides: int = 48) -> list:
    """The part of a convex polygon inside a circle (a detail view's), the circle taken as a `sides`-gon in it."""
    (cx, cy) = centre
    if all(math.hypot(px - cx, py - cy) <= radius for px, py in polygon):
        return polygon
    if (max(px for px, _ in polygon) < cx - radius or min(px for px, _ in polygon) > cx + radius
            or max(py for _, py in polygon) < cy - radius or min(py for _, py in polygon) > cy + radius):
        return []
    corners = [(cx + radius * math.cos(2 * math.pi * i / sides), cy + radius * math.sin(2 * math.pi * i / sides)) for i in range(sides)]
    kept = list(polygon)
    for (ax, ay), (bx, by) in zip(corners, corners[1:] + corners[:1]):  # Sutherland–Hodgman, edge by edge.
        source, kept = kept, []
        for p, q in zip(source, source[1:] + source[:1]):  # Each side's sign: >= 0 inside (left of a to b).
            sp = (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax)
            sq = (bx - ax) * (q[1] - ay) - (by - ay) * (q[0] - ax)
            if (sp >= 0) != (sq >= 0):
                t = sp / (sp - sq)
                kept.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
            if sq >= 0:
                kept.append(q)
        if len(kept) < 3:
            return []
    return kept


# ───────── Pickable geometry: what each projected line is on the model ─────────

def _segment_distance(p, a, b) -> float:
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    length = dx * dx + dy * dy
    t = 0.0 if length == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _polyline_distance(p, line) -> float:
    return min(_segment_distance(p, a, b) for a, b in zip(line, line[1:])) if len(line) > 1 else math.hypot(p[0] - line[0][0], p[1] - line[0][1])


def _thin(line, most: int = 12):
    """At most `most` of a polyline's points, its ends included (enough to tell which edge it lies on)."""
    if len(line) <= most:
        return line
    step = (len(line) - 1) / (most - 1)
    return [line[round(i * step)] for i in range(most)]


def _picks(drawing: Drawing, frame, visible, tolerance: float, model=None, shape=None) -> tuple[list, list]:
    """What a sheet's picks are made of, for one orthographic view of a part (model mm on the view's paper plane):
    ([(line, ref, face, kind)], [(point, ref)]). Each visible line is matched to the model edge it lies on (every point
    of it on that edge's own projection: exact HLR splits edges where they're hidden, never moves them), named by its
    persistent name; `face` is the face that line shows edge-on (a plane seen side-on), or a hole's or shaft's wall
    for a circle seen face-on and for a cylinder's silhouette, so dimensions can name the feature rather than its edge.
    Vertices are the visible ones (a line ends there). Plain CadQuery geometry has no persistent names: no picks. The
    flat view's are its blank's (`model` holding it, `shape`)."""
    model, shape = (model, shape) if model is not None else (drawing.model, drawing.shape)
    if model is None:
        return [], []
    from .naming import edge_faces
    x, y, n = _view_axes(frame)
    refs = model.refs(shape)
    face_names, edge_names, vertex_names = refs["faces"], refs["edges"], refs["vertices"]
    adjacent = edge_faces(shape)
    extent = shape.BoundingBox()
    near = max(tolerance * 6, extent.DiagonalLength * 2e-4, 1e-3)
    flat = lambda p: (p.dot(x), p.dot(y))  # noqa: E731

    def seen_edge_on(face) -> bool:
        return face.geomType() == "PLANE" and abs(face.normalAt().dot(n)) < 1e-6

    def wall_along_view(face) -> bool:
        found = _round(face)
        return found is not None and abs(found[1].normalized().dot(n)) > 1 - 1e-6

    candidates = []  # (points, bbox, ref, face, kind, depth)
    for edge, name in edge_names.items():
        solid = _edge_points(edge, tolerance)
        points = [flat(p) for p in solid]
        if len(points) < 2:
            continue
        box = _bounds([points])
        if math.hypot(box[2] - box[0], box[3] - box[1]) < near:
            continue  # Seen end-on: a point here (its vertices are picks).
        circle = edge.geomType() == "CIRCLE" and abs(edge.normal().dot(n)) > 1 - 1e-6
        face = None
        for neighbour in adjacent.get(edge, []):
            named = face_names.get(neighbour)
            if named and ((circle and wall_along_view(neighbour)) or (not circle and seen_edge_on(neighbour))):
                face = named
                break
        depth = sum(p.dot(n) for p in solid) / len(solid)  # Towards the viewer: of edges drawn on the same line, the nearest shows.
        walls = {id(f.wrapped.TShape()) for f in adjacent.get(edge, [])}
        seam = len(walls) == 1 and all(_round(f) is not None for f in adjacent.get(edge, []))  # A cylinder's seam: its wall, not an edge
        candidates.append((points, box, name, face, "seam" if seam else "circle" if circle else "edge", depth))
    # A cylinder seen side-on shows two silhouette lines that are no edge of the model: each is its wall.
    silhouettes = []  # (a line's direction, its offset across it, its extent along it, the wall's name)
    for face, name in face_names.items():
        found = _round(face) if name else None
        if found is None or abs(found[1].normalized().dot(n)) > 1e-6:
            continue
        centre, axis, radius = found
        along = flat(axis.normalized())
        length = math.hypot(*along)
        if length < 1e-9:
            continue
        along = (along[0] / length, along[1] / length)
        across = (-along[1], along[0])
        c = flat(centre)
        spans = [p[0] * along[0] + p[1] * along[1] for p in (flat(v) for v in _samples(face))]
        middle = c[0] * across[0] + c[1] * across[1]
        for offset in (middle - radius, middle + radius):
            silhouettes.append((along, across, offset, (min(spans) - near, max(spans) + near), name))

    lines, ends = [], []
    for line in visible:
        if len(line) < 2:
            continue
        ends += [line[0], line[-1]]
        box = _bounds([line])
        sample = _thin(line)
        best = None
        for points, (x0, y0, x1, y1), ref, face, kind, depth in candidates:
            if box[0] < x0 - near or box[1] < y0 - near or box[2] > x1 + near or box[3] > y1 + near:
                continue
            worst = max(_polyline_distance(p, points) for p in sample)
            if worst <= near and (best is None or (depth, -worst) > (best[0], -best[1])):
                best = (depth, worst, ref, face, kind)
        if best is not None and best[4] != "seam":
            lines.append((line, best[2], best[3], best[4]))
            continue
        for along, across, offset, (low, high), name in silhouettes:
            if all(abs(p[0] * across[0] + p[1] * across[1] - offset) <= near and low <= p[0] * along[0] + p[1] * along[1] <= high
                   for p in sample):
                lines.append((line, None, name, "silhouette"))
                break
    vertices, taken = [], []
    for vertex, name in sorted(vertex_names.items(), key=lambda item: -cq_point(item[0]).dot(n)):  # Nearest the viewer first.
        p = flat(cq_point(vertex))
        if any(math.hypot(p[0] - e[0], p[1] - e[1]) <= near for e in ends) and not any(math.hypot(p[0] - t[0], p[1] - t[1]) <= near for t in taken):
            vertices.append((p, name))
            taken.append(p)
    return lines, vertices


def _flat_picks(drawing: Drawing, tolerance: float) -> tuple[list, list]:
    """The flat view's picks: the developed blank's outline and holes, edge by edge as the named blank has them (the
    drawn outline joins the pieces of a side that runs past a bend), and each bend's centre line ("<bend>.bend.line");
    on a design's sheet with the body's "<instance>:" in front. None when the blank can't be named."""
    from .naming import edge_faces
    try:
        blank, lines, body, _ = _flat_blank(drawing)
    except _Problem:
        return [], []
    shape = blank.bodies[blank.active]
    top = shape.BoundingBox().zmax  # The material plane the view shows: the blank's outline is on its top.
    visible = []
    for edge, faces in edge_faces(shape).items():  # Its outline and holes: top edges of a side or a wall, not a bend's tangent lines.
        points = _edge_points(edge, tolerance)
        if (len(points) > 1 and all(abs(p.z - top) <= tolerance for p in points)
                and any(face.geomType() != "PLANE" or abs(face.normalAt().z) < 1e-6 for face in faces)):
            visible.append([(p.x, p.y) for p in points])
    prefix = f"{body.rsplit(':', 1)[0]}:" if drawing.design is not None else ""
    named = lambda ref: ref and prefix + ref  # noqa: E731
    outline, points = _picks(drawing, FLAT_FRAME, visible, tolerance, blank, shape)
    picks = [(line, named(ref), named(face), kind) for line, ref, face, kind in outline]
    for bend, segments in lines.items():
        ref = f"{prefix}{bend}.bend.line"
        picks += [([(p.x, p.y) for p in (segment.startPoint(), segment.endPoint())], ref, ref, "edge") for segment in segments]
    return picks, [(point, named(ref)) for point, ref in points]


def cq_point(vertex):
    import cadquery as cq
    return cq.Vector(vertex.toTuple())


def _inside(points, centre, radius: float) -> bool:
    return all(math.hypot(x - centre[0], y - centre[1]) <= radius * (1 + 1e-6) + 1e-9 for x, y in points)


def _spec_points(spec: dict) -> list:
    """Where a measured feature dimension touches its view (model mm on the paper plane)."""
    return list(spec.get("at") or [spec.get("centre") or spec.get("corner")])


def _slot(positions: dict, child: dict) -> tuple:
    """The grid cell a section or detail view goes in: a section in projection from its parent (past any view there),
    a detail in the nearest free cell around it (below and right first)."""
    taken = set(positions.values())
    column, row = positions[child["parent"]]
    if child["kind"] == "section":
        dc, dr = child["step"]
        cell = (column + dc, row + dr)
        while cell in taken:
            cell = (cell[0] + dc, cell[1] + dr)
        return cell
    near = sorted(((column + dc, row + dr) for dc in range(-3, 4) for dr in range(-3, 4) if dc or dr),
                  key=lambda p: (max(abs(p[0] - column), abs(p[1] - row)), p[1] > row, p[0] < column,
                                 abs(p[0] - column) + abs(p[1] - row)))
    return next((cell for cell in near if cell not in taken), (max(c for c, _ in taken) + 1, row))


def _placer(cx: float, cy: float, mx: float, my: float, scale: float):
    """Model mm on a view's paper plane → the sheet (mm): (mx, my) goes to (cx, cy)."""
    return lambda points: [(cx + (x - mx) * scale, cy + (y - my) * scale) for x, y in points]


def _projection_report(frame, model_at, sheet_at, scale: float, depth: float | None, clip) -> dict:
    """How a view maps the model onto the sheet, for picking its geometry there (the Drawing tab): paper x, paper y and
    towards the viewer as model directions; the model point on the paper plane (x, y) drawn at the sheet point (the SVG's
    frame: mm, y down); and the sheet mm per model mm. A section's `cut`: the material it shows is at or below that far
    towards the viewer. A detail's `clip`: its circle on the sheet (x, y, radius)."""
    towards, across = frame
    n, x = _unit(towards), _unit(across)
    rounded = lambda values, places=9: [round(v, places) for v in values]  # noqa: E731
    report = {"x": rounded(x), "y": rounded(_cross(n, x)), "towards": rounded(n), "model": rounded(model_at, 6),
              "sheet": rounded(sheet_at, 6), "scale": float(scale)}
    if depth is not None:
        report["cut"] = round(depth, 6)
    if clip:
        report["clip"] = rounded(clip, 6)
    return report


def _view_label(drawing: Drawing, view: str, child: dict | None, view_scale: float, scale: float) -> str | None:
    """What's written under a view: SECTION A-A (with its scale when it isn't the sheet's), DETAIL B (2:1), or a base
    view's own scale. ISO 128-44 and ISO 5455 write the scale in brackets, ASME Y14.3 as SCALE 2:1."""
    own = _scale_text(view_scale)
    differs = abs(view_scale - scale) > 1e-9 * max(1.0, scale)
    written = f"({own})" if drawing.standard == "ISO" else f"SCALE {own}"
    if view == FLAT:
        return "FLAT PATTERN" + (f" {written}" if differs else "")
    if child is None:
        return f"SCALE {own}" if drawing.view_options[view]["scale"] is not None and differs else None
    if child["kind"] == "section":
        return f"SECTION {view}-{view}" + (f" {written}" if differs else "")
    return f"DETAIL {view} {written}"


def _cutting_line(sheet: Sheet, child: dict, at, paper, size: float):
    """A section's cutting plane on its parent (ISO 128-44, ASME Y14.3): a thin long-dash dot line past the view, thick
    at its ends, with arrows the way the section is looked at, and its letter at each end."""
    x0, y0, x1, y1 = paper
    a, b = ((x0 - 6, at[1]), (x1 + 6, at[1])) if child["direction"] == "horizontal" else ((at[0], y0 - 6), (at[0], y1 + 6))
    first = len(sheet.lines)
    sheet.line([a, b], "chain")
    vx, vy = child["looking"]
    for end, other in ((a, b), (b, a)):
        span = math.hypot(other[0] - end[0], other[1] - end[1]) or 1.0
        ux, uy = (other[0] - end[0]) / span, (other[1] - end[1]) / span
        sheet.line([end, (end[0] + ux * 5, end[1] + uy * 5)], "visible")
        tip = (end[0] + ux * 2.5, end[1] + uy * 2.5)
        tail = (tip[0] - vx * 8, tip[1] - vy * 8)
        sheet.line([tail, tip])
        sheet.arrow(tip, (-vx, -vy))
        letter = (tail[0] - vx * (0.6 * size + 1) - ux * 2, tail[1] - vy * (0.6 * size + 1) - uy * 2)
        sheet.text(letter[0], letter[1] - 0.35 * size, child["name"], size, "middle")
    sheet.marks.update(dict.fromkeys(range(first, len(sheet.lines)), child["name"]))


def _detail_circle(sheet: Sheet, name: str, at, radius: float, size: float):
    """A detail's thin circle on its parent (ISO 128-44), lettered."""
    sheet.circles.append((at[0], at[1], radius, "thin"))
    sheet.text(at[0] + (radius + 1.5) * math.sqrt(0.5), at[1] + (radius + 1.5) * math.sqrt(0.5), name, size)


def _bend_lines(sheet: Sheet, lines, notes, units: str, size: float):
    """A flat view's bend lines (paper), thin chain lines, and each bend's note along its line, read from the bottom
    or the right, just beside it."""
    for line in lines:
        sheet.line(line, "chain")
    for (a, b), bend in notes:
        angle = (math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])) + 90) % 180 - 90
        if angle <= -90 + 1e-9:
            angle += 180
        turn = math.radians(angle)
        middle = ((a[0] + b[0]) / 2 - math.sin(turn), (a[1] + b[1]) / 2 + math.cos(turn))
        sheet.text(middle[0], middle[1], _bend_note(bend, units), size, "middle", angle)


OVERLAP_CLEAR = 0.15  # mm each side: text that only touches what's beside it isn't reported
OVERLAPS_LISTED = 50  # A sheet's overlaps listed at most (the count says how many there were)
LEADERS = ("datum", "frame", "balloon", "note", "weld", "hole-table")  # Annotations drawn on a leader: theirs crossing text is reported


def _text_rect(x, y, text, size, anchor, rotation, bold):
    """A text's corners on paper (the same estimate as _width; bold 0.65 em a character), turned as it's written, drawn
    in by OVERLAP_CLEAR so text that only touches isn't counted."""
    w = (0.65 if bold else 0.6) * size * len(text)
    left = {"start": 0.0, "middle": -w / 2, "end": -w}[anchor] + OVERLAP_CLEAR
    right, bottom, top = left + w - 2 * OVERLAP_CLEAR, OVERLAP_CLEAR, 0.8 * size - OVERLAP_CLEAR
    c, s = math.cos(math.radians(rotation)), math.sin(math.radians(rotation))
    return [(x + dx * c - dy * s, y + dx * s + dy * c) for dx, dy in ((left, bottom), (right, bottom), (right, top), (left, top))]


def _convex_overlap(a, b) -> bool:
    """Whether two convex polygons overlap (separating axes)."""
    for polygon in (a, b):
        for i, (px, py) in enumerate(polygon):
            qx, qy = polygon[(i + 1) % len(polygon)]
            nx, ny = qy - py, px - qx
            one, two = [nx * x + ny * y for x, y in a], [nx * x + ny * y for x, y in b]
            if max(one) <= min(two) or max(two) <= min(one):
                return False
    return True


def _crosses(rect, p, q) -> bool:
    """Whether segment p–q passes through a text's rectangle (corners as _text_rect gives them)."""
    (ax, ay), (bx, by), _, (dx, dy) = rect
    ux, uy, vx, vy = bx - ax, by - ay, dx - ax, dy - ay
    lu, lv = ux * ux + uy * uy, vx * vx + vy * vy
    if lu <= 0 or lv <= 0:
        return False
    # The segment in the rectangle's own frame (0..1 along each side), clipped to it (Liang–Barsky).
    s0, t0 = ((p[0] - ax) * ux + (p[1] - ay) * uy) / lu, ((p[0] - ax) * vx + (p[1] - ay) * vy) / lv
    s1, t1 = ((q[0] - ax) * ux + (q[1] - ay) * uy) / lu, ((q[0] - ax) * vx + (q[1] - ay) * vy) / lv
    low, high = 0.0, 1.0
    for start, delta in ((s0, s1 - s0), (t0, t1 - t0)):
        for edge, sign in ((0.0, 1), (1.0, -1)):
            gap = sign * (start - edge)
            if abs(delta) < 1e-12:
                if gap < 0:
                    return False
                continue
            at = -gap / (sign * delta)
            if sign * delta > 0:
                low = max(low, at)
            else:
                high = min(high, at)
            if low > high:
                return False
    return True


class _Segments:
    """Line segments on paper, found by the box around a text (a view's projection is tens of thousands)."""

    def __init__(self):
        self.pieces, self.joined = [], None  # (n, 2, 2) arrays, joined when next tested

    def add(self, lines):
        """Adds each line's segments (lines: point lists)."""
        import numpy as np
        lines = [points for points in lines if len(points) >= 2]
        if lines:  # Every point in one array, paired with the next but for each line's last
            flat = np.asarray([p for points in lines for p in points], dtype=float)
            keep = np.ones(len(flat) - 1, dtype=bool)
            keep[np.cumsum([len(points) for points in lines])[:-1] - 1] = False
            self.pieces.append(np.stack([flat[:-1][keep], flat[1:][keep]], axis=1))
            self.joined = None

    def cross(self, corners, box) -> bool:
        """Whether any segment passes through a text's rectangle (corners, as _text_rect gives them; box: its bounds)."""
        import numpy as np
        if self.joined is None:
            self.joined = np.concatenate(self.pieces) if self.pieces else np.empty((0, 2, 2))
            self.low, self.high = self.joined.min(axis=1), self.joined.max(axis=1)
        near = np.flatnonzero((self.low[:, 0] <= box[2]) & (self.high[:, 0] >= box[0])
                              & (self.low[:, 1] <= box[3]) & (self.high[:, 1] >= box[1]))
        return any(_crosses(corners, tuple(self.joined[k, 0]), tuple(self.joined[k, 1])) for k in near)


CLEAR = 3  # _Room.clearance of a place nothing's in the way of


class _Room:
    """Where automatic placement may write, and how clear a place is (clearance): off the text already on the sheet,
    the views' visible and hidden edges and their cutting-plane marks, the title block and tables, and inside the
    border (what _overlaps reports); then off other annotations' lines, and with its own leaders through no text. Each
    annotation tries its places in turn (_first_clear, _out_along) and keeps the clearest. The sheet's texts and thin
    lines are read as it grows; the views' edges are added as each view draws them."""

    def __init__(self, sheet: Sheet, border):
        self.sheet, self.border = sheet, border
        self.corners, self.bounds, self.boxes = [], [], None  # the sheet's texts read so far: corners, bounds (an array)
        self.lines = 0  # how many of the sheet's lines are read
        self.edges, self.thin = _Segments(), _Segments()  # the views' edges and marks; annotations' (thin) lines

    def add_edges(self, start: int, end: int, marks: bool = False):
        """Adds the sheet's lines start…end that are a view's edges (visible or hidden), or a cutting-plane mark's."""
        self.edges.add(points for points, kind in self.sheet.lines[start:end] if marks or kind in ("visible", "hidden"))

    def _read(self, lines: int, texts: int):
        for item in self.sheet.texts[len(self.corners):texts]:
            corners = _text_rect(*item) if item[2].strip() else None
            self.corners.append(corners)
            self.bounds.append(_bounds([corners]) if corners else (math.inf, math.inf, -math.inf, -math.inf))
            self.boxes = None
        self.thin.add(points for points, kind in self.sheet.lines[self.lines:lines] if kind == "thin")
        self.lines = max(self.lines, lines)

    def clearance(self, rects, segments=(), before=None) -> int:
        """How clear text written in `rects` (corners, as _text_rect gives them; a box, a balloon's ring) would be,
        with lines `segments` ((p, q): its leaders): 0, it's over text, a view's edges or a cutting-plane mark, the
        title block or a table, or past the border; 1, its text is clear; 2, nor do other annotations' lines cross it; CLEAR,
        nor do its own lines cross text. Counting what the sheet had at `before` (Sheet._counts; all it has, if None)."""
        lines, count = (before[0], before[2]) if before is not None else (len(self.sheet.lines), len(self.sheet.texts))
        self._read(lines, count)
        bx0, by0, bx1, by1 = self.border
        boxes = [_bounds([corners]) for corners in rects]
        for corners, box in zip(rects, boxes):
            if box[0] < bx0 or box[1] < by0 or box[2] > bx1 or box[3] > by1 or self.edges.cross(corners, box):
                return 0
            for _, _, (x0, y0, x1, y1) in self.sheet.regions:
                if _convex_overlap(corners, _box_corners((x0, y0, x1, y1))):
                    return 0
            if any(_convex_overlap(corners, self.corners[k]) for k in self._texts_near(box, count)):
                return 0
        if any(self.thin.cross(corners, box) for corners, box in zip(rects, boxes)):
            return 1
        for p, q in segments:
            box = (min(p[0], q[0]), min(p[1], q[1]), max(p[0], q[0]), max(p[1], q[1]))
            if any(_crosses(self.corners[k], p, q) for k in self._texts_near(box, count)):
                return 2
        return CLEAR

    def _texts_near(self, box, count: int):
        """The texts read (of the first `count`) whose bounds meet `box`."""
        import numpy as np
        if self.boxes is None:
            self.boxes = np.asarray(self.bounds, dtype=float).reshape(-1, 4)
        b = self.boxes[:count]
        return np.flatnonzero((b[:, 0] <= box[2]) & (b[:, 2] >= box[0]) & (b[:, 1] <= box[3]) & (b[:, 3] >= box[1]))

    def drawn(self, start) -> int:
        """The clearance of what's been drawn since `start` (Sheet._counts): its text and the boxes it draws round
        text (a frame's cells, a datum's letter, a basic dimension), drawn in as text is (_text_rect), and its lines."""
        sheet = self.sheet
        lines = sheet.lines[start[0]:]
        boxes = [_inset(points[:4], OVERLAP_CLEAR) for points, _ in lines if len(points) == 5 and points[0] == points[-1]]
        return self.clearance([_text_rect(*item) for item in sheet.texts[start[2]:] if item[2].strip()] + boxes,
                              [(p, q) for points, _ in lines for p, q in zip(points, points[1:])], start)


def _inset(corners, by: float):
    """A box's corners, each moved `by` across and `by` up or down towards its middle: the box drawn in."""
    cx, cy = sum(x for x, _ in corners) / len(corners), sum(y for _, y in corners) / len(corners)
    out = []
    for x, y in corners:
        dx, dy = cx - x, cy - y
        out.append((x + math.copysign(min(by, abs(dx)), dx), y + math.copysign(min(by, abs(dy)), dy)))
    return out


def _box_corners(box):
    """A paper box (x0, y0, x1, y1) as corners, as _text_rect gives a text's."""
    x0, y0, x1, y1 = box
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def _first_clear(sheet: Sheet, room: "_Room | None", tries, draw, least=lambda t: 1):
    """Draws `draw(t)` for each of `tries` in turn and keeps the first that `room` finds clear (_Room.clearance); else
    the first of the clearest, if it's at least `least(t)` clear (by default: its text is); else the first try. Returns
    (the try kept, what its draw returned)."""
    tries = list(tries)
    start = sheet._counts()
    best = (0, tries[0])
    for t in tries if room is not None else tries[:1]:
        result = draw(t)
        clearance = room.drawn(start) if room is not None else CLEAR
        if clearance == CLEAR:
            return t, result
        if clearance > best[0] and clearance >= least(t):
            best = (clearance, t)
        sheet.rewind(start)
    return best[1], draw(best[1])


def _slides(span: float, half: float, step: float = 1.0) -> list[float]:
    """Shifts along a line `span` long for text `half` long from its middle: none first, then a step at a time either
    way, as far as it stays between the line's ends."""
    reach = span / 2 - half - 1.0
    return [0.0] + [sign * k * step for k in range(1, int(reach / step) + 1) for sign in (1, -1)]


def _overlaps(sheet: Sheet) -> tuple[list[dict], int]:
    """What would be hard to read on the sheet: an annotation's text (a feature dimension's, a balloon's, a note's…)
    over another's text, a view's label, the title block or a table, or crossed by a view's visible or hidden edges, a
    section's cutting-plane mark or another annotation's leader; or two of one annotation's own texts over each other
    (a hole table's tags).
    Each: what it is ({"dimension": n} or {"annotation": kind, "index": n}, its text and view) and what it's over, with
    the box they share (the SVG's frame: mm, y down). (the first OVERLAPS_LISTED, how many in all)"""
    owners = sheet._owners()
    spans = {(key, i): name for name, start, end in sheet.spans
             for key, a, b in zip(("lines", "texts"), (start[0], start[2]), (end[0], end[2])) for i in range(a, b)}
    groups = {owner: (view, [sheet.texts[i][2] for i in range(start[2], end[2])]) for owner, start, end, view in sheet.groups}

    def what(owner):
        if owner[0] == "view":
            return {"view_label": owner[1]}
        if owner[0] == "overall":
            return {"overall_dimension": owner[1], "text": owner[2]}
        kind, number = owner
        view, texts = groups[owner]
        text = " ".join(texts)
        return {**({"dimension": number} if kind == "dimension" else {"annotation": kind, "index": number}),
                "text": text if len(text) <= 60 else text[:59] + "…", "view": view}

    layered = {i: name for name, start, end in sheet.layers for i in range(start[2], end[2])}
    rects = []  # (owner, corners, bounds): annotations' texts, the views' overall dimensions and their own (labels, letters)
    for i, item in enumerate(sheet.texts):
        owner = owners.get(("texts", i))
        if owner is None and ("texts", i) in spans:
            owner = ("overall", spans["texts", i], item[2]) if layered.get(i) == "dimension" else ("view", spans["texts", i])
        if owner is not None and item[2].strip():
            corners = _text_rect(*item)
            rects.append((owner, corners, _bounds([corners]), item[2]))
    # The views' visible and hidden edges and the cutting-plane marks, as segments (a view's projection is tens of
    # thousands): each text tests exactly only those whose bounds meet its own.
    import numpy as np
    starts, ends, overs = [], [], []
    for i, (points, kind) in enumerate(sheet.lines):
        if len(points) < 2:
            continue
        owner = owners.get(("lines", i))
        if i in sheet.marks:
            over = ("mark", sheet.marks[i])
        elif kind in ("visible", "hidden") and owner is None and ("lines", i) in spans:
            over = ("edges", spans["lines", i])
        elif i in sheet.leaders and owner is not None and owner[0] in LEADERS:
            over = ("leader", owner)
        else:
            continue
        line = np.asarray(points, dtype=float)
        starts.append(line[:-1])
        ends.append(line[1:])
        overs += [over] * (len(line) - 1)
    starts, ends = (np.concatenate(starts), np.concatenate(ends)) if starts else (np.empty((0, 2)), np.empty((0, 2)))
    low, high = np.minimum(starts, ends), np.maximum(starts, ends)
    found: dict[tuple, list] = {}  # (annotation, what it's over) → the box they share

    def note(owner, over, box):
        shared = found.setdefault((owner, over), list(box))
        shared[:] = [min(shared[0], box[0]), min(shared[1], box[1]), max(shared[2], box[2]), max(shared[3], box[3])]

    rects.sort(key=lambda rect: rect[2][0])
    for n, (owner, corners, box, text) in enumerate(rects):
        for other, other_corners, other_box, other_text in rects[n + 1:]:
            if other_box[0] >= box[2]:
                break
            if owner[0] == "view" and other[0] == "view" or other_box[1] >= box[3] or box[1] >= other_box[3]:
                continue
            if _convex_overlap(corners, other_corners):
                if other == owner:  # Two of one annotation's own texts (a hole table's tags, a frame's cells)
                    note(owner, ("own", *sorted((text, other_text))), _bounds([corners, other_corners]))
                else:
                    first, second = (owner, other) if owner[0] != "view" else (other, owner)
                    note(first, ("text", second), _bounds([corners, other_corners]))
        if owner[0] == "view":
            continue
        for kind, index, (x0, y0, x1, y1) in sheet.regions:
            if _convex_overlap(corners, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]):
                note(owner, ("region", kind, index), box)
        near = np.flatnonzero((low[:, 0] <= box[2]) & (high[:, 0] >= box[0]) & (low[:, 1] <= box[3]) & (high[:, 1] >= box[1]))
        seen = set()
        for k in near:
            if overs[k] not in seen and overs[k] != ("leader", owner) and _crosses(corners, tuple(starts[k]), tuple(ends[k])):
                seen.add(overs[k])
                note(owner, overs[k], box)
    out = []
    for (owner, over), (x0, y0, x1, y1) in found.items():
        if over[0] == "text":
            under = what(over[1])
        elif over[0] == "region":
            under = {"region": over[1], **({"index": over[2]} if over[2] is not None else {})}
        elif over[0] == "own":
            under = {"own_texts": list(over[1:])}
        elif over[0] == "mark":
            under = {"cutting_plane": over[1]}
        elif over[0] == "leader":
            under = {"leader_of": what(over[1])}
        else:
            under = {"edges_of": over[1]}
        out.append({**what(owner), "over": under,
                    "box": [round(x0, 2), round(sheet.height - y1, 2), round(x1, 2), round(sheet.height - y0, 2)]})
    out.sort(key=lambda item: (item["box"][1], item["box"][0]))
    return out[:OVERLAPS_LISTED], len(out)


def render(drawing: Drawing, number: int, count: int, deadline: float | None = None) -> tuple[Sheet, dict]:
    """The sheet for a drawing (its views projected now) and what it reports."""
    sheet = Sheet(drawing.size, drawing.style)
    x0, y0, x1, y1 = _frame(sheet, drawing.standard)
    grid = GRID[drawing.projection]
    extent = drawing.shape.BoundingBox()
    tolerance = max(extent.DiagonalLength, 1.0) * 2e-4
    options = drawing.view_options
    projected = {}
    parts, part_lines = _parts(drawing), {}  # With balloons: each instance in the same HLR pass, and its visible lines per view.
    if parts is None and drawing.model is not None and any(weld["joint"] or weld["bead"] for weld in drawing.welds):
        parts = dict(drawing.model.bodies) or None  # A part's bodies, each on its own: what shows of a weld's joint or bead.
    flat_lines, flat_bends, flat_body, flat_box, flat_problem = [], [], None, None, None
    cache, digest = _CACHE, []

    def keyed(kind, *arguments):  # A view's entry in the projection cache: this sheet's geometry, and how it's seen.
        if not digest:
            digest.append(_geometry_digest(drawing.shape, parts))
        return digest[0] and _projection_key(digest[0], kind, *arguments)

    for view in drawing.views:
        _in_time(deadline)
        part_lines[view] = {}
        if view == FLAT:  # The blank as its DXF has it, not projected; one that can't be made is reported below.
            try:
                outline, flat_lines, flat_bends, flat_body, flat_box = _flat_pattern(drawing, tolerance)
            except _Problem as problem:
                flat_problem = problem
            else:
                projected[view] = (outline, [])
            continue
        asked = options[view]["hidden"]  # The iso view has hidden lines only when it asks for them.
        hidden = bool(asked) if view == "iso" else drawing.hidden if asked is None else asked
        key = keyed("view", drawing.frames[view], hidden, tolerance) if cache is not None else None
        projected[view] = cache.reuse(key, part_lines[view]) if key else None
        if projected[view] is None:
            projected[view] = project(drawing.shape, drawing.frames[view], hidden, tolerance, parts, part_lines[view])
            if cache is not None:
                cache.keep(key, *projected[view], part_lines[view])
    boxes = {view: flat_box if view == FLAT else _bounds(visible + dashed) for view, (visible, dashed) in projected.items()}
    margin = DIM_SPACE if drawing.dimensions else 0.0

    # Section and detail views, each from its parent. One whose cutting plane or centre is gone isn't drawn (nor what
    # hangs off it): it's reported, never moved onto other geometry.
    scales = {view: (1.0, options[view]["scale"]) for view in drawing.views}  # (× the sheet's scale, or its own)
    cuts, clips, marks, children, lost, dangling_views, view_problems = {}, {}, {}, [], set(), [], []
    depths = {}  # Sections (and details of them): how far towards the viewer their cutting plane is, in model mm.
    if flat_problem is not None:
        body = options[FLAT]["body"]
        if flat_problem.dangling:  # What's dimensioned on it is gone with it.
            lost.add(FLAT)
        (dangling_views if flat_problem.dangling else view_problems).append(
            {"view": FLAT, "kind": "flat", "parent": None, "refs": [body] if body else [], "problem": str(flat_problem)})
    for child in drawing.children:
        name, parent = child["name"], child["parent"]
        at = child["through"] if child["kind"] == "section" else child["centre"]
        entry = {"view": name, "kind": child["kind"], "parent": parent, "refs": [at] if isinstance(at, str) else []}
        try:
            if parent not in projected:
                raise _Problem(f"its parent view {parent} isn't drawn.", dangling=parent in lost)
            _in_time(deadline, section=True)
            x, y, _ = _view_axes(drawing.frames[parent])
            if child["kind"] == "section":  # No hidden lines unless it asks for them.
                mine = {}
                visible, dashed, cuts[name], point = _section(drawing, child, tolerance, bool(child["hidden"]), parts, mine,
                                                              cache, keyed)
                boxes[name] = _bounds(visible + dashed)
                depths[name] = point.dot(_view_axes(child["frame"])[2])
            else:  # The parent's lines (and hatching) inside the circle.
                point = _point(drawing, child["centre"])
                centre, radius = (point.dot(x), point.dot(y)), child["radius"]
                visible, dashed = ([piece for line in lines for piece in _clip(line, centre, radius)] for lines in projected[parent])
                mine = {instance: pieces for instance, lines in part_lines.get(parent, {}).items()
                        if (pieces := [piece for line in lines for piece in _clip(line, centre, radius)])}
                if parent in cuts:
                    cuts[name] = cuts[parent]
                if parent in depths:
                    depths[name] = depths[parent]
                clips[name] = (centre, radius)
                boxes[name] = (centre[0] - radius, centre[1] - radius, centre[0] + radius, centre[1] + radius)
            marks[name] = (point.dot(x), point.dot(y))
        except _Problem as problem:
            if problem.dangling:
                lost.add(name)
            (dangling_views if problem.dangling else view_problems).append({**entry, "problem": str(problem)})
            continue
        projected[name], part_lines[name] = (visible, dashed), mine
        factor, own = scales[parent]
        if child["kind"] == "detail" and child["scale"] is None:  # Twice its parent's, unless it says.
            factor, own = factor * 2, (own * 2 if own is not None else None)
        scales[name] = (factor, child["scale"] if child["scale"] is not None else own)
        children.append(child)

    def undrawn(view):  # A section or detail view on this sheet that isn't drawn: what's on it isn't either.
        if view in drawing.frames and view not in projected:
            raise _Problem(f"its view {view} isn't drawn (see dangling_views or view_problems).", dangling=view in lost)

    # Feature dimensions, measured on the model; the ones that can't be are reported, never guessed.
    features = {view: [] for view in projected}
    paths, traced_paths = {view: [] for view in projected}, set()  # view → sketch curves dimensioned there (model mm)
    dangling, problems, overridden, fits = [], [], [], []
    for dim in drawing.feature_dimensions:
        try:
            undrawn(dim["view"])
            spec = _measure(drawing, dim)
            if dim["view"] in clips and not _inside(_spec_points(spec), *clips[dim["view"]]):
                raise _Problem(f"it's outside detail {dim['view']}'s circle: dimension it in the parent view, or make the "
                               "circle larger.")
        except _Problem as problem:
            (dangling if problem.dangling else problems).append(
                {"dimension": dim["index"], "view": dim["view"], "refs": dim["refs"], "problem": str(problem)})
            continue
        if problem := _placement_problem(dim, spec):
            problems.append({"dimension": dim["index"], "view": dim["view"], "refs": dim["refs"], "problem": problem})
            continue
        fit = None
        if dim["fit"] is not None:  # ISO 286 limits for the nominal size; a class the tables don't define is reported.
            if spec["type"] == "angle":
                problems.append({"dimension": dim["index"], "view": dim["view"], "refs": dim["refs"],
                                 "problem": "an ISO 286 fit is for a size, not an angle: give the angle a tolerance in degrees."})
                continue
            nominal = _nominal(dim, spec["value"], drawing.units)
            try:
                upper, lower = fit_deviations(dim["fit"], nominal)
            except ValueError as error:
                problems.append({"dimension": dim["index"], "view": dim["view"], "refs": dim["refs"], "problem": str(error)})
                continue
            fit = (nominal, upper, lower)
            fits.append({"dimension": dim["index"], "class": dim["fit"], "nominal_mm": nominal,
                         "upper_mm": float(upper), "lower_mm": float(lower)})
        dual = (drawing.dual_units, dim["dual_precision"] if dim["dual_precision"] is not None else drawing.dual_precision) \
            if dim["dual"] else None
        label, measured = _label(dim, spec["value"], "°" if spec["type"] == "angle" else drawing.units, spec["symbol"], fit, dual)
        if dim["text"]:
            overridden.append({"dimension": dim["index"], "view": dim["view"], "text": dim["text"], "measured": measured})
        layout = _layout(label, drawing.style["text"])
        features[dim["view"]].append([dim, spec, layout, 0.0])
        across, up, _ = _view_axes(drawing.frames[dim["view"]])
        for ref in (half for ref in dim["refs"] for half in _sharp_halves(ref) or [ref]):  # Sketch curves it measures (a
            # wire's path, or a virtual sharp's halves on it): a thin chain line, as ISO 128 draws centre lines.
            if (dim["view"], ref) in traced_paths:
                continue
            traced_paths.add((dim["view"], ref))
            for curve in _sketch_curves(drawing, ref) if dim["view"] != FLAT else ():  # The blank has no sketches.
                line = [(p.dot(across), p.dot(up)) for p in _edge_points(curve, tolerance)]
                paths[dim["view"]] += _clip(line, *clips[dim["view"]]) if dim["view"] in clips else [line]

    # GD&T: datum feature symbols and feature control frames, on named geometry found now or with a drawn dimension.
    # One whose geometry is gone is reported, never moved; a frame whose datum isn't shown is drawn, with a note.
    size = drawing.style["text"]
    drawn = {item[0]["index"]: item[1] for items in features.values() for item in items}
    gone = {item["dimension"] for item in dangling}
    middles = {view: ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2) for view, box in boxes.items()}
    on_geometry = {view: [] for view in projected}  # view → [(kind, item, cells, anchor)]
    attached = {}  # dimension number → [(kind, item, cells)], frames first
    shown, notes = {}, []  # datum letter → shown; frames drawn whose datum isn't
    for kind, items in (("datum", drawing.datums), ("frame", drawing.tolerance_frames)):
        for item in items:
            entry = {"annotation": kind, "index": item["index"], "view": item["view"], "refs": [item["ref"]] if item["ref"] else []}
            if kind == "datum":
                entry["label"] = item["label"]
            if item["dimension_id"]:
                entry["on_dimension"] = item["dimension_id"]
            compartments = _cells(item, drawing.units) if kind == "frame" else None
            try:
                if item["dimension"] is not None:
                    spec = drawn.get(item["dimension"])
                    if spec is None:
                        raise _Problem(f"its dimension {item['dimension_id']!r} isn't drawn (see that dimension).",
                                       dangling=item["dimension"] in gone)
                    if spec["type"] == "angle":
                        raise _Problem("an angle isn't a feature of size: attach it to the feature's geometry (ref) instead.")
                    anchor = None
                else:
                    undrawn(item["view"])
                    anchor = _anchor(drawing, item["ref"], item["view"], middles.get(item["view"], (0.0, 0.0)))
                    if item["view"] in clips and not _inside([anchor["at"]], *clips[item["view"]]):
                        raise _Problem(f"it's outside detail {item['view']}'s circle: put it on the parent view, or make the "
                                       "circle larger.")
                    if kind == "frame" and item["modifier"] and not anchor["size"]:
                        raise _Problem("MMC and LMC apply to a feature of size: attach the frame to its size dimension "
                                       "(dimension) or its hole's or shaft's cylinder.")
            except _Problem as problem:
                (dangling if problem.dangling else problems).append({**entry, "problem": str(problem)})
                if kind == "datum":
                    shown[item["label"]] = False
                continue
            if kind == "datum":
                shown[item["label"]] = True
            missing = [letter for letter, _ in item.get("datums", ()) if not shown.get(letter)]
            if missing:
                notes.append({**entry, "problem": f"datum {', '.join(missing)} isn't drawn on the sheet (see datums): "
                              "the frame refers to it, so fix or re-pick its feature."})
            if anchor is None:
                attached.setdefault(item["dimension"], []).append((kind, item, compartments))
            else:
                on_geometry[item["view"]].append((kind, item, compartments, anchor))
    for stack in attached.values():
        stack.sort(key=lambda entry: entry[0] == "datum")

    # Weld symbols: an arrow to each ref found now, or to each place its joint's pieces touch now, or to its bead. What's
    # gone (or a joint whose pieces no longer touch) is reported (dangling), never moved onto other geometry; the weld is
    # drawn with the arrows that remain.
    welds = {view: [] for view in projected}
    for weld in drawing.welds:
        view = weld["view"]
        entry = {"annotation": "weld", "index": weld["index"], "view": view,
                 **({"joint": weld["joint"]} if weld["joint"] else {"bead": weld["bead"]} if weld["bead"] else {})}
        names = weld["joint"] or ([weld["bead"]] if weld["bead"] else weld["refs"])
        try:
            undrawn(view)
            if view not in projected:
                raise _Problem(f"the {view} view isn't on this sheet; add it or move the weld to another view.")
            arrows = ([({"refs": [ref]}, lambda ref=ref: _weld_anchor(drawing, ref, view)) for ref in weld["refs"]]
                      if weld["refs"] else _weld_pieces(drawing, weld, view, part_lines.get(view) or {}, tolerance, parts))
        except _Problem as problem:
            (dangling if problem.dangling else problems).append({**entry, "refs": list(names), "problem": str(problem)})
            continue
        points, missed = [], []
        for about, find in arrows:
            try:
                point = find()
                if view in clips and not _inside([point], *clips[view]):
                    raise _Problem(f"it's outside detail {view}'s circle: put the weld on the parent view, or make the "
                                   "circle larger.")
            except _Problem as problem:
                missed.append((problem, about))
                continue
            points.append(point)
        for problem, about in missed:
            note = " The weld is drawn with its other arrows." if points else ""
            (dangling if problem.dangling else problems).append({**entry, **about, "problem": str(problem) + note})
        if points:
            welds[view].append((weld, points))

    # Leader notes: a leader to their edge, face or vertex found now. One whose ref is gone is reported (dangling),
    # never moved onto other geometry.
    leaders = {view: [] for view in projected}
    for note in drawing.leader_notes:
        view = note["view"]
        entry = {"annotation": "note", "index": note["index"], "view": view, "refs": [note["ref"]]}
        try:
            undrawn(view)
            if view not in projected:
                raise _Problem(f"the {view} view isn't on this sheet; add it or move the note to another view.")
            point, dot = _note_anchor(drawing, note["ref"], view)
            if view in clips and not _inside([point], *clips[view]):
                raise _Problem(f"it's outside detail {view}'s circle: put the note on the parent view, or make the circle larger.")
        except _Problem as problem:
            (dangling if problem.dangling else problems).append({**entry, "problem": str(problem)})
            continue
        leaders[view].append((note, point, dot))

    # Item balloons on the design's instances, numbered from the parts list; hole tables measured on the model. What
    # can't be drawn is reported (gone: in dangling), never guessed or moved.
    targets, gone_balloons, balloon_problems = _balloon_targets(drawing, part_lines)
    dangling += gone_balloons
    hole_tables, hole_problems = [], []
    for table in drawing.hole_tables:
        view = table["view"]
        entry = {"annotation": "hole", "index": table["index"], "view": view, "refs": [table["origin"]] if isinstance(table["origin"], str) else []}
        try:
            undrawn(view)
            if view not in projected:
                raise _Problem(f"the {view} view isn't on this sheet; add it or put the table on another view.")
            rows, gone_holes, problems_here = _hole_table_rows(drawing, table, boxes[view], clips.get(view))
            if not rows and not gone_holes and not problems_here:
                raise _Problem(f"no holes show round in the {view} view: put the table on the view that looks along them.")
        except _Problem as problem:
            (dangling if problem.dangling else hole_problems).append({**entry, "problem": str(problem)})
            continue
        dangling += gone_holes
        hole_problems += problems_here
        hole_tables.append((table, rows))
    stack_tables = [(table["index"], f"HOLE TABLE ({table['view'].upper()} VIEW)" if table["view"] in VIEWS else f"HOLE TABLE (VIEW {table['view']})",
                     [row["cells"] for row in rows]) for table, rows in hole_tables if rows]
    extra = {number: sum(_annotation_size(kind, item, compartments, size)[1 if drawn[number].get("axis") == "x" else 0]
                         + (1.0 if kind == "frame" else 4.0) for kind, item, compartments in stack)
             for number, stack in attached.items()}

    reserve = {}  # view → side → paper its stacked dimensions, datums and frames take
    for view, items in features.items():
        room = {}
        for axis, sides in (("y", ("left", "right")), ("x", ("above", "below"))):
            for side in sides:
                stack = sorted((item for item in items if item[1]["type"] == "linear" and item[1]["axis"] == axis
                                and (item[0]["side"] or sides[0]) == side),
                               key=lambda item: abs(item[1]["at"][1][0 if axis == "x" else 1] - item[1]["at"][0][0 if axis == "x" else 1]))
                slot = 1 if margin and side in ("right", "below") else 0  # Beyond the overall dimension there.
                for item in stack:  # Shortest nearest the view, so lines don't cross (ISO 129-1).
                    more = extra.get(item[0]["index"], 0.0)  # Its frames and datums, out past its text.
                    if item[0]["offset"] is None:
                        item[3], slot = FIRST_SLOT + SLOT * slot, slot + 1 + math.ceil(more / SLOT)
                    else:
                        item[3] = item[0]["offset"]
                room[side] = max((item[3] + item[2][2] + 3 + extra.get(item[0]["index"], 0.0) for item in stack), default=0.0)
        for dim, spec, layout, _ in items:  # Leaders, as if each hole sat on the view's outline: its reach, shoulder and text.
            if spec["type"] == "round":
                sx, sy = QUADRANTS[dim["side"] or "up-right"]
                reach = (dim["offset"] or 8.0) * math.sqrt(0.5)
                across, up = "right" if sx > 0 else "left", "above" if sy > 0 else "below"
                room[across] = max(room.get(across, 0.0), reach + layout[1] + 2 + 3)
                room[up] = max(room.get(up, 0.0), reach + (1 + layout[2] if sy > 0 else 0.0) + 3)
        for kind, item, compartments, anchor in on_geometry[view]:  # As if each sat on the view's outline: room past it.
            w, h = _annotation_size(kind, item, compartments, size)
            end, (left, bottom) = _hang((0.0, 0.0), anchor["out"], item["offset"] or 8.0, w, h)
            for side, reach in (("left", -min(end[0], left)), ("right", max(end[0], left + w)),
                                ("below", -min(end[1], bottom)), ("above", max(end[1], bottom + h))):
                if reach > 0:
                    room[side] = max(room.get(side, 0.0), reach + 3)
        reserve[view] = {side: room.get(side, 0.0) for side in ("left", "right", "above", "below")}
    for view, items in targets.items():  # Balloons go out past their view, on their side (or any, from its middle).
        for balloon, number, _ in items:
            room = (balloon["offset"] or BALLOON_OFFSET) + 2 * _balloon_radius(str(number), size) + 3
            quadrant = QUADRANTS.get(balloon["side"])
            sides = ((balloon["side"],) if balloon["side"] in ("above", "below", "left", "right")
                     else ("above" if quadrant[1] > 0 else "below", "right" if quadrant[0] > 0 else "left") if quadrant
                     else ("left", "right", "above", "below"))
            for side in sides:
                reserve[view][side] = max(reserve[view][side], room)
    for view, items in welds.items():  # Weld symbols placed past their view: on their side, or the first arrow's.
        for weld, points in items:
            if weld["at"] is not None:
                continue
            layout = _weld_layout(drawing, weld, size)
            reach = (weld["offset"] or WELD_OFFSET) + 3
            quadrant = QUADRANTS.get(weld["place"])
            if weld["place"] in ("above", "below", "left", "right"):
                sides = (weld["place"],)
            else:
                dx, dy = quadrant or (points[0][0] - middles[view][0], points[0][1] - middles[view][1])
                sides = ("above" if dy >= 0 else "below", "right" if dx >= 0 else "left")
            for side in sides:  # Across: its line and tail; up or down: its height.
                room = reach + (layout["length"] + layout["tail"] if side in ("left", "right") else layout["above"] + layout["below"])
                reserve[view][side] = max(reserve[view][side], room)
    for view, items in leaders.items():  # Leader notes placed past their view: on their side, or out from its middle.
        for note, point, _ in items:
            if note["at"] is not None:
                continue
            reach = (note["offset"] or NOTE_OFFSET) + 3
            dx, dy = QUADRANTS.get(note["side"]) or (point[0] - middles[view][0], point[1] - middles[view][1])
            for side in ("above" if dy >= 0 else "below", "right" if dx >= 0 else "left"):  # Across: its text; up or down: a line of it.
                room = reach + (NOTE_SHOULDER + 1.0 + _width(note["text"], size) if side in ("left", "right") else 1.2 * size)
                reserve[view][side] = max(reserve[view][side], room)
    # Base views where the projection method puts them, section and detail views beside their parents. Overall
    # dimensions are the base views'; a section, a detail or a base view at its own scale is labelled underneath.
    # The iso view is pictorial, so it may go anywhere: where the grid puts it, or, when that draws the views larger
    # (a narrow space beside tall tables, a short one above them), above the other views or past them in a row.
    # The flat view isn't projected either: past the other views in a row, or above or below them; it's always labelled.
    labelled = ({child["name"] for child in children} | {view for view in drawing.views if options[view]["scale"] is not None}
                | ({FLAT} & set(projected)))
    overall = {view: margin if view in options and view != "iso" else 0.0 for view in projected}  # The iso view has none.
    below = {view: max(overall[view], reserve[view]["below"]) for view in projected}
    layouts = [{view: grid[view] for view in drawing.views if view in grid}]
    others = [grid[view] for view in drawing.views if view in grid and view != "iso"]
    if "iso" in drawing.views and others:
        layouts += [{**layouts[0], "iso": (others[0][0], max(row for _, row in others) + 1)},
                    {**layouts[0], "iso": (max(column for column, _ in others) + 1, others[0][1])}]
    if FLAT in projected:
        layouts = [{**layout, FLAT: cell} for layout in layouts for cell in _flat_cells(layout)]

    def arrange(positions):
        """Each view's grid cell, its sections and details beside it, and the grid's cells for _fit."""
        positions = dict(positions)
        for child in children:
            positions[child["name"]] = _slot(positions, child)
        return positions, {positions[view]: (box[2] - box[0], box[3] - box[1],
                                             (reserve[view]["left"], max(overall[view], reserve[view]["right"])),
                                             (below[view] + (LABEL_SPACE if view in labelled else 0.0), reserve[view]["above"]),
                                             scales[view])
                           for view, box in boxes.items()}

    arranged = [arrange(positions) for positions in layouts]
    positions, cells = arranged[0]

    # Two ways to share the sheet with the tables; the one that draws the views larger wins.
    block = _title_block(Sheet(drawing.size, drawing.style), drawing, x1, y0, "", number, count)
    revisions = _revision_table(Sheet(drawing.size, drawing.style), drawing, x1, y1)
    stacked = _stack(Sheet(drawing.size, drawing.style), drawing, x1, y0 + block, y1 - revisions, stack_tables)
    pad = 6.0
    above = (x0 + pad, y0 + block + stacked + pad, x1 - pad, y1 - revisions - pad)
    beside = (x0 + pad, y0 + pad, x1 - drawing.table_width - pad, y1 - pad)
    # Views placed by position aren't in the grid's way: it fits, and they can overflow, only on their own.
    by_name = {child["name"]: child for child in children}
    fixed = {view for view in projected if (by_name.get(view) or options[view])["position"] is not None}
    loose = [view for view in projected if view not in fixed]
    if projected:
        # The largest scale; at a given one, the layout whose views fit, then the grid's own, then the most room to spare.
        choices = [(_fit(layout[1], area, drawing.scale), -index, area, layout) for index, layout in enumerate(arranged)
                   for area in (above, beside) if area[2] > area[0] and area[3] > area[1]]
        if not choices:
            raise ValueError(f"Drawing {drawing.name!r}: the {drawing.sheet} sheet has no room left for views; use a larger sheet.")
        (scale, best), _, area, (positions, cells) = max(
            choices, key=lambda choice: (choice[0][0], choice[0][1] >= choice[0][0] * (1 - 1e-9), choice[1], choice[0][1]))
        if best <= 0 and loose:
            raise ValueError(f"Drawing {drawing.name!r}: the {drawing.sheet} sheet has no room left for these views; use a larger "
                             "sheet, fewer views" + (", smaller view scales" if any(own is not None for _, own in scales.values()) else "")
                             + " or a shorter parts list.")
        scale_text = _scale_text(scale)
    else:  # A blank sheet: nothing to fit, so its scale is only the one it's given.
        scale, best, area = drawing.scale, drawing.scale, above
        scale_text = _scale_text(scale) if scale is not None else ""
    with sheet.layer("titleblock"):
        _title_block(sheet, drawing, x1, y0, scale_text, number, count)
        _revision_table(sheet, drawing, x1, y1)
    _stack(sheet, drawing, x1, y0 + block, y1 - revisions, stack_tables)
    for index, text, (x, y) in drawing.placed_notes:  # Each placed note on its own, to pick and move.
        with sheet.group(index, "note"):
            sheet.text(x, y, text, drawing.style["text"])
    room = _Room(sheet, (x0, y0, x1, y1))  # What the annotations placed below keep clear of, as it's drawn

    columns, rows = _tracks(cells, scale)
    total_w = sum(sum(track) for track in columns.values()) + GAP * max(len(columns) - 1, 0)
    total_h = sum(sum(track) for track in rows.values()) + GAP * max(len(rows) - 1, 0)
    left = (area[0] + area[2]) / 2 - total_w / 2
    starts_x, cursor = {}, left
    for column in sorted(columns):
        starts_x[column], cursor = cursor, cursor + sum(columns[column]) + GAP
    bottom = (area[1] + area[3]) / 2 - total_h / 2
    starts_y, cursor = {}, bottom
    for row in sorted(rows):
        starts_y[row], cursor = cursor, cursor + sum(rows[row]) + GAP

    # Each view's centre on the paper: its position, where nothing else moves it; else its grid cell moved by its `at`,
    # a section's or detail's beside its parent wherever that is (so a parent's `at` or position takes it along).
    def cell(view):
        column, row = positions[view]
        return starts_x[column] + columns[column][1] + columns[column][0] / 2, starts_y[row] + rows[row][1] + rows[row][0] / 2
    centres = {}
    for view in projected:  # Parents before their children.
        child = by_name.get(view)
        own = child or options[view]
        (x, y), (dx, dy) = cell(view), own["at"]
        if own["position"] is not None:
            centres[view] = own["position"]
        elif child is None:
            centres[view] = (x + dx, y + dy)
        else:
            (parent_x, parent_y), (at_x, at_y) = cell(child["parent"]), centres[child["parent"]]
            centres[view] = (at_x + x - parent_x + dx, at_y + y - parent_y + dy)
    view_scales = {view: own if own is not None else factor * scale for view, (factor, own) in scales.items() if view in projected}

    # Shaded views: the model meshed once (as fine as the largest of them needs on paper), each one's faces seen from
    # it; a detail view's are its parent's in its circle. Section views show their cut, never shaded.
    shading = {view: view != FLAT and (drawing.shaded if options[view]["shaded"] is None else options[view]["shaded"])
               for view in drawing.views}  # A flat view is its outline and bends, as the DXF.
    for child in children:
        shading[child["name"]] = child["kind"] == "detail" and shading.get(child["parent"], False)
    shaded, shades = [view for view in projected if shading.get(view)], {}
    if shaded:
        _in_time(deadline)
        triangles = _mesh(drawing.shape, max(tolerance, SHADE_DEFLECTION / max(view_scales[view] for view in shaded)), deadline)
        for view in shaded:
            _in_time(deadline)
            if view in clips:
                centre, radius = clips[view]
                shades[view] = [(piece, level) for polygon, level in shades[by_name[view]["parent"]]
                                if (piece := _clip_fill(polygon, centre, radius))]
            else:
                shades[view] = _shade(triangles, drawing.frames[view])

    counts, placed, annotations, views_placed, on_sheet = {}, [], {"datums": {}, "tolerance_frames": {}}, [], {}
    traced = {}  # view → its picks in model mm on its paper plane (_picks); a detail view's are its parent's, clipped
    balloons, taken, weld_boxes, weld_counts, welds_placed, notes_placed = [], [], [], {}, [], []
    for view, (visible, dashed) in projected.items():
        child = by_name.get(view)
        view_scale = view_scales[view]
        bx0, by0, bx1, by1 = boxes[view]
        cx, cy = centres[view]
        mx, my = (bx0 + bx1) / 2, (by0 + by1) / 2
        place = _placer(cx, cy, mx, my, view_scale)
        clip = (place([clips[view][0]])[0], clips[view][1] * view_scale) if view in clips else None
        if view != "iso" and drawing.design is not None:
            for name, lines in part_lines.get(view, {}).items():  # A design's instances: what a balloon points at.
                sheet.picks += [(view, "instance", name, None, place(line)) for line in lines if len(line) > 1]
        if child is None and view not in ("iso", FLAT):
            traced[view] = _picks(drawing, drawing.frames[view], visible, tolerance)
        elif view == FLAT:
            traced[view] = _flat_picks(drawing, tolerance)
        elif child is not None and child["kind"] == "detail" and child["parent"] in traced:
            lines, points = traced[child["parent"]]
            centre, radius = clips[view]
            traced[view] = ([(piece, ref, face, kind) for line, ref, face, kind in lines for piece in _clip(line, centre, radius)],
                            [(p, ref) for p, ref in points if math.hypot(p[0] - centre[0], p[1] - centre[1]) <= radius])
        for line, ref, face, kind in traced.get(view, ([], []))[0]:
            sheet.picks.append((view, kind, ref, face, place(line)))
        for point, ref in traced.get(view, ([], []))[1]:
            sheet.picks.append((view, "vertex", ref, None, place([point])))
        with sheet.view(view, child["parent"] if child else None, part=child is not None):
            sheet.shades += [(place(polygon), level) for polygon, level in shades.get(view, ())]
            first = len(sheet.lines)
            for line in dashed:
                sheet.line(place(line), "hidden")
            for line in visible:
                sheet.line(place(line), "visible")
            room.add_edges(first, len(sheet.lines))
            for line in paths.get(view, ()):
                sheet.line(place(line), "chain")
            if view == FLAT:
                with sheet.layer("bend"):
                    _bend_lines(sheet, [place(line) for line in flat_lines], [(place([bend["start"], bend["end"]]), bend) for bend in flat_bends],
                                drawing.units, drawing.style["small"])
            for index, segments in cuts.get(view, ()):  # The cut faces hatched, on the sheet's paper (ISO 128-50).
                angle, spacing = HATCHES[index % len(HATCHES)]
                for line in _hatch([place(segment) for segment in segments], angle, spacing):
                    for piece in (_clip(line, *clip) if clip else [line]):
                        sheet.line(piece, "hatch")
            if clip:
                sheet.circles.append((clip[0][0], clip[0][1], clip[1], "thin"))
            paper = (cx - (mx - bx0) * view_scale, cy - (my - by0) * view_scale, cx + (bx1 - mx) * view_scale, cy + (by1 - my) * view_scale)
            # Its label, and its sections' cutting planes and its details' circles, each with its letter, before its
            # annotations: they're where they must be, so the annotations keep clear of them (room).
            if label := _view_label(drawing, view, child, view_scale, scale):
                sheet.text((paper[0] + paper[2]) / 2, paper[1] - below[view] - size - 1.5, label, size, "middle")
            for other in children:
                if other["parent"] == view:
                    at = place([marks[other["name"]]])[0]
                    if other["kind"] == "section":
                        first = len(sheet.lines)
                        _cutting_line(sheet, other, at, paper, size)
                        room.add_edges(first, len(sheet.lines), marks=True)
                    else:
                        _detail_circle(sheet, other["name"], at, other["radius"] * view_scale, size)
            if drawing.dimensions and child is None and view != "iso" and bx1 > bx0 and by1 > by0:
                with sheet.layer("dimension"):
                    _dimensions(sheet, paper, (bx1 - bx0, by1 - by0), drawing.units, drawing.standard == "ISO",
                                (drawing.dual_units, drawing.dual_precision) if drawing.dual_units else None, room)
            if features[view]:
                placed += _feature_dimensions(sheet, drawing, features[view], place, paper, view_scale, attached,
                                              (x0, y0, x1, y1), notes, room)
            hung = {}  # A feature's leader (where it starts, which way) → the last frame drawn on it: the next stacks on it
            for kind, item, compartments, anchor in on_geometry[view]:
                at = place([anchor["at"]])[0]
                key = (round(at[0], 3), round(at[1], 3), tuple(anchor["out"]))
                span = place(anchor["span"]) if anchor.get("span") else None
                with sheet.group(item["index"], kind):
                    frame = _on_feature(sheet, kind, item, compartments, at, anchor, size, room, hung.get(key), span)
                if frame is not None:
                    hung[key] = frame
            if targets.get(view):
                balloons += _balloons(sheet, targets[view], place, paper, size, taken, room)
            weld_counts[view] = _welds(sheet, drawing, welds[view], place, paper, size, taken, weld_boxes, welds_placed, room)
            _leader_notes(sheet, leaders[view], place, paper, size, taken, weld_boxes, notes_placed, room)
            for table, tagged in hole_tables:  # (`rows` are the grid's)
                if table["view"] == view and tagged:
                    _hole_tags(sheet, table["index"], tagged, place, view_scale, drawing.style["small"], room)
                    sheet.hole_rows += [row["csv"] for row in tagged]
        on_sheet[view] = (place, paper)
        counts[view] = len(features[view])
        for kind, key in (("datum", "datums"), ("frame", "tolerance_frames")):
            annotations[key][view] = (sum(entry[0] == kind for entry in on_geometry[view])
                                      + sum(entry[0] == kind for item in features[view] for entry in attached.get(item[0]["index"], ())))
        vx, vy, _ = _view_axes(drawing.frames[view])
        origin = place([(0.0, 0.0)])[0]
        views_placed.append({"view": view, "kind": child["kind"] if child else "base", **({"parent": child["parent"]} if child else {}),
                             **({"body": flat_body, "bends": len(flat_bends)} if view == FLAT else {}),
                             # Model ↔ paper: a model point p is at (ox + s·(p·x), oy − s·(p·y)) in the SVG (mm, y down).
                             "map": {"origin": [round(origin[0], 4), round(sheet.height - origin[1], 4)], "scale": view_scale,
                                     "x": [round(c, 9) for c in vx.toTuple()], "y": [round(c, 9) for c in vy.toTuple()]},
                             "at": list(child["at"] if child else options[view]["at"]),
                             # Its centre as position= takes it (paper mm from the lower-left corner, y up); fixed: written so.
                             "position": [round(cx, 3), round(cy, 3)], "fixed": view in fixed,
                             "scale": _scale_text(view_scale), "box": [round(paper[0], 3), round(sheet.height - paper[3], 3),
                                                                       round(paper[2], 3), round(sheet.height - paper[1], 3)],
                             "projection": _projection_report(drawing.frames[view], (mx, my), (cx, sheet.height - cy), view_scale,
                                                              depths.get(view), clip and (clip[0][0], sheet.height - clip[0][1], clip[1]))})
    report ={"name": drawing.name, "title": drawing.title, "standard": drawing.standard, "projection": drawing.projection,
              "sheet": drawing.sheet, "size_mm": [round(v, 1) for v in drawing.size], "scale": scale_text, "views": drawing.views,
              "parts_list": len(drawing.bom or []), "cut_list": len(drawing.cut_list or []), "revisions": len(drawing.revisions),
              "views_placed": views_placed,  # Each view drawn: its kind, parent, scale and box (the SVG's frame: mm, y down)
              # The title block and each table: what it is (a hole table's number too) and its box, the same frame.
              "regions": [{"kind": kind, **({"index": index} if index is not None else {}),
                           "box": [round(a, 3), round(sheet.height - d, 3), round(c, 3), round(sheet.height - b, 3)]}
                          for kind, index, (a, b, c, d) in sheet.regions]}
    # Each argument as it evaluated (the Drawing tab edits one written as a variable or an expression by writing its
    # value), and the arguments with no plain value (their names only).
    report["args"] = drawing.arguments
    if drawing.unwritable:
        report["args_unreadable"] = drawing.unwritable
    if drawing.front != ("front", "top"):  # The master view's orientation, when it isn't the model's own front.
        report["front"] = list(drawing.front)
    if drawing.design is None and getattr(drawing.model, "id", None):  # A component's sheet: views are in its own axes.
        report["component"] = drawing.model.id
    if sheet_bodies := list(_sheet_bodies(drawing)):  # What a flat view can show here (the Drawing tab offers one).
        report["sheet_metal_bodies"] = sheet_bodies
    if loose and scale > best * (1 + 1e-9):
        report["overflow"] = f"At {scale_text} the views are larger than the sheet; choose a smaller scale or a larger sheet."
    off = [view for view in projected if view in fixed and not (x0 - 1e-6 <= on_sheet[view][1][0] <= on_sheet[view][1][2] <= x1 + 1e-6
                                                                and y0 - 1e-6 <= on_sheet[view][1][1] <= on_sheet[view][1][3] <= y1 + 1e-6)]
    if off:  # A view stays where its position puts it, never moved: a problem there is said so.
        report["overflow"] = (f"View {', '.join(off)} {'reach' if len(off) > 1 else 'reaches'} past the sheet's border at "
                              f"{'their positions' if len(off) > 1 else 'its position'}; move {'them' if len(off) > 1 else 'it'} "
                              "or choose a smaller scale.")
    if drawing.feature_dimensions:  # What agents and the Drawing tab check: drawn per view, and what wasn't and why.
        report["feature_dimensions"] = {view: count for view, count in counts.items() if view != "iso"}
    for key in ("datums", "tolerance_frames"):  # GD&T drawn per view (the flat view's: on its dimensions)
        if getattr(drawing, key):
            report[key] = {view: count for view, count in annotations[key].items() if view != "iso"}
    if drawing.balloons:  # Balloons drawn per view, and each one's instance, item number, side and centre (SVG frame).
        report["balloons"] = {view: sum(item["view"] == view for item in balloons) for view in projected}
    if drawing.welds:  # Weld symbols drawn per view (the iso view's too: weldments are often called out there).
        report["welds"] = weld_counts
    if drawing.hole_tables:  # Each table drawn: its view and its holes' tags, in order.
        report["hole_tables"] = [{"index": table["index"], "view": table["view"], "holes": len(tagged), "tags": [row["tag"] for row in tagged]}
                                 for table, tagged in hole_tables]
    # Where each drawn dimension went (the SVG's frame: mm, y down), for dragging it on the sheet. Datums', frames',
    # balloons', hole tables', welds' and leader notes' entries in dangling and dimension_problems say which they are
    # ("annotation": "datum", "frame", "balloon", "hole", "weld" or "note", and "index"); balloons and hole tables that can't be drawn as written have lists
    # of their own.
    for key, items in (("placed", sorted(placed, key=lambda item: item["dimension"])), ("dangling", dangling),
                       ("dimension_problems", problems), ("overridden", overridden), ("fits", fits),
                       ("annotation_notes", notes), ("dangling_views", dangling_views), ("view_problems", view_problems),
                       ("balloons_placed", balloons), ("balloon_problems", balloon_problems), ("hole_problems", hole_problems),
                       ("welds_placed", sorted(welds_placed, key=lambda item: item["weld"])),
                       ("notes_placed", sorted(notes_placed, key=lambda item: item["note"]))):
        if items:
            report[key] = items
    # Text that would be hard to read: over other text, the title block or a table, or crossed by a view's edges.
    overlaps, overlap_count = _overlaps(sheet)
    if overlaps:
        report["overlaps"] = overlaps
        if overlap_count > len(overlaps):
            report["overlaps_count"] = overlap_count
    return sheet, report


def _csv(header, rows) -> str:
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(header)
    writer.writerows(rows)
    return output.getvalue()


def _entry(name: str, data: bytes):
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    return info, data


def write_artifacts(deadline: float | None = None, projections: bool = False) -> dict | None:
    """drawing.svg (sheet 1), drawings.zip (every sheet as SVG and DXF, its tables (parts and cut lists, hole tables)
    as CSV, its title block logos as the image files the DXFs reference, manifest.json) and drawings.pdf (every sheet a
    page, drawing_pdf.py) for the drawings the code declared; what they hold, or why they couldn't be made. Never fails
    the build; a PDF that can't be made leaves the rest (its report says why). With `projections` (the dispatcher asks
    for it), each view's projection is reused from the earlier build's record when nothing it depends on changed, and
    this build's is written (PROJECTIONS) for the next."""
    global _CACHE
    for name in ("drawing.svg", "drawings.zip", "drawings.pdf", PROJECTIONS):
        Path(name).unlink(missing_ok=True)
    if not SHEETS:
        return None
    reports, entries, logos, sheets = [], [], {}, []
    _CACHE = _Projections.load(os.environ.get("STEVE_DRAWING_CACHE")) if projections else None
    try:
        result = _write_sheets(reports, entries, logos, sheets, deadline)
        if _CACHE is not None:  # How many views were drawn from the earlier build's projections, and how many projected.
            result["projections"] = {"reused": _CACHE.reused, "projected": _CACHE.projected}
        return result
    finally:
        cache, _CACHE = _CACHE, None
        if cache is not None:
            try:
                cache.write()
            except Exception as error:  # noqa: BLE001  The next build projects again.
                Path(PROJECTIONS + ".tmp").unlink(missing_ok=True)
                print(f"Warning: the drawing's projections weren't kept for faster redraws: {type(error).__name__}", file=sys.stderr)


def _write_sheets(reports, entries, logos, sheets, deadline) -> dict:
    try:
        for index, drawing in enumerate(SHEETS):
            sheet, report = render(drawing, index + 1, len(SHEETS), deadline)
            sheets.append(sheet)
            for *_, image in sheet.images:  # Each logo once, beside the DXFs that reference it by name.
                logos.setdefault(image["name"], image["data"])
            stem = f"{index + 1:02d}-" + (re.sub(r"[^A-Za-z0-9_.-]+", "_", drawing.name).strip("_.")[:60] or "sheet")
            svg = sheet.svg().encode()
            if index == 0:
                Path("drawing.svg").write_bytes(svg)
            dxf = Path(f"_{stem}.dxf")
            sheet.dxf(dxf)
            entries += [_entry(f"{stem}.svg", svg), _entry(f"{stem}.dxf", dxf.read_bytes())]
            dxf.unlink()
            if drawing.bom:
                entries.append(_entry(f"{stem}-parts-list.csv", _csv(["item", "quantity", "name", "description"],
                    [[i + 1, r["quantity"], r["name"], r["description"]] for i, r in enumerate(drawing.bom)]).encode()))
            if drawing.cut_list:
                entries.append(_entry(f"{stem}-cut-list.csv", _csv(["item", "quantity", "body", "length_mm", "width_mm", "thickness_mm", "material"],
                    [[i + 1, r["quantity"], r["name"], *(round(v, 3) for v in r["size"]), r["material"]] for i, r in enumerate(drawing.cut_list)]).encode()))
            if sheet.hole_rows:
                entries.append(_entry(f"{stem}-hole-table.csv", _csv(["table", "tag", "x_mm", "y_mm", "diameter_mm", "depth_mm", "callout"],
                                                                     sheet.hole_rows).encode()))
            reports.append({**report, "file": stem})
        # The Drawing tab's evaluated arguments stay out of the export: the code says what they are.
        listed = [{key: value for key, value in item.items() if key not in ("args", "args_unreadable")} for item in reports]
        manifest = json.dumps({"version": 1, "units": "mm", "sheets": listed}, indent=1).encode()
        with zipfile.ZipFile("drawings.zip", "w") as archive:
            for info, data in [*entries, *(_entry(name, data) for name, data in sorted(logos.items())), _entry("manifest.json", manifest)]:
                archive.writestr(info, data)
    except Exception as error:
        for name in ("drawing.svg", "drawings.zip"):
            Path(name).unlink(missing_ok=True)
        return {"version": 1, "status": "invalid", "sheets": reports, "error": f"{type(error).__name__}: {error}"[:500]}
    try:
        from . import drawing_pdf
        Path("drawings.pdf").write_bytes(drawing_pdf.pdf(sheets, title=SHEETS[0].name))
    except Exception as error:  # The sheets stand without it.
        Path("drawings.pdf").unlink(missing_ok=True)
        return {"version": 1, "status": "ready", "sheets": reports, "pdf_error": f"{type(error).__name__}: {error}"[:500]}
    return {"version": 1, "status": "ready", "sheets": reports, "pdf": True}
