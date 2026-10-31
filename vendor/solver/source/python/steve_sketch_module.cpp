// CPython binding of the STEVE sketch solver core (same API as the WebAssembly build).
//
//   import steve_sketch
//   result_json = steve_sketch.solve(sketch_json, options_json="{}")
//   s = steve_sketch.Session(sketch_json, options_json="{}")
//   s.drag(ref, x, y); s.end_drag(); s.set_value(id, value); s.solve(); s.diagnose(); s.snapshot()
//
// All methods take and return JSON strings. Invalid input raises steve_sketch.SketchInputError
// (a ValueError). The GIL is released while solving.
//
// Copyright (C) 2026 STEVE contributors. LGPL-2.1-or-later (links planegcs); see solver/NOTICE.
#include <pybind11/pybind11.h>

#include "steve_sketch.h"

namespace py = pybind11;
using steve_sketch::Session;

PYBIND11_MODULE(steve_sketch, m)
{
    m.doc() = "STEVE 2D sketch constraint solver (FreeCAD planegcs), Solver JSON in/out";
    m.attr("__version__") = STEVE_SKETCH_PY_VERSION;
    m.attr("build_info") = steve_sketch::version();

    py::register_exception<steve_sketch::InputError>(m, "SketchInputError", PyExc_ValueError);

    m.def("solve",
          &steve_sketch::solve,
          py::arg("sketch_json"),
          py::arg("options_json") = "{}",
          py::call_guard<py::gil_scoped_release>(),
          "Solve a sketch (Solver JSON string) and return the result JSON string.");

    py::class_<Session>(m, "Session")
        .def(py::init<const std::string&, const std::string&>(),
             py::arg("sketch_json"),
             py::arg("options_json") = "{}",
             py::call_guard<py::gil_scoped_release>(),
             "Build, diagnose and solve a sketch for interactive editing.")
        .def("drag",
             &Session::drag,
             py::arg("ref"),
             py::arg("x"),
             py::arg("y"),
             py::call_guard<py::gil_scoped_release>(),
             "Drag a point ref or entity towards (x, y); returns {status, entities} JSON.")
        .def("end_drag",
             &Session::end_drag,
             py::call_guard<py::gil_scoped_release>(),
             "End the drag gesture; returns the full result JSON.")
        .def("set_value",
             &Session::set_value,
             py::arg("constraint_id"),
             py::arg("value"),
             "Change a driving dimension value (applied on the next solve()).")
        .def("solve",
             &Session::solve,
             py::call_guard<py::gil_scoped_release>(),
             "Solve from the current geometry; returns the full result JSON.")
        .def("diagnose",
             &Session::diagnose,
             py::call_guard<py::gil_scoped_release>(),
             "Re-run the conflict/redundancy/DOF diagnosis; returns the full result JSON.")
        .def("snapshot",
             &Session::snapshot,
             py::call_guard<py::gil_scoped_release>(),
             "Full result JSON for the current state.");
}
