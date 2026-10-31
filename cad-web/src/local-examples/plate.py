import cadquery as cq

# Dimensions are in millimeters.
length = 80
width = 50
thickness = 6
hole_diameter = 6
edge_offset = 10

result = (
    cq.Workplane("XY")
    .box(length, width, thickness)
    .edges("|Z").fillet(4)
    .faces(">Z").workplane()
    .rect(length - 2 * edge_offset, width - 2 * edge_offset, forConstruction=True)
    .vertices()
    .hole(hole_diameter)
)

