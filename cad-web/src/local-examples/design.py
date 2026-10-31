import cadquery as cq

# Part definitions: each is independent geometry.
plate = (
    cq.Workplane("XY").box(80, 50, 6)
    .edges("|Z").fillet(4)
    .faces(">Z").workplane()
    .rect(60, 30, forConstruction=True).vertices().hole(6)
)
spacer = cq.Workplane("XY").circle(5).circle(3).extrude(24)

# Assembly instances preserve their names, colors, and placements.
result = cq.Assembly(name="spacer_stack")
result.add(plate, name="base_plate", color=cq.Color(0.39, 0.72, 0.65))
result.add(
    plate, name="top_plate", loc=cq.Location(cq.Vector(0, 0, 30)),
    color=cq.Color(0.58, 0.66, 0.76),
)
for index, (x, y) in enumerate([(-30, -15), (-30, 15), (30, -15), (30, 15)]):
    result.add(
        spacer, name=f"spacer_{index + 1}",
        loc=cq.Location(cq.Vector(x, y, 3)),
        color=cq.Color(0.91, 0.65, 0.30),
    )
