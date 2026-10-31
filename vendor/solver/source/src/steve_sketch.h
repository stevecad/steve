// STEVE sketch solver core: FreeCAD planegcs behind the "Solver JSON" contract
// (docs/MODELING.md, section 2). The same translation unit is compiled to WebAssembly
// (web/src/sketch/solver) and to a CPython extension (solver/python), so both platforms build
// the identical GCS system and run the identical algorithm.
//
// Copyright (C) 2026 STEVE contributors.
// This file links against planegcs and is distributed under the GNU Lesser General Public
// License version 2.1 or later; see solver/NOTICE.
#ifndef STEVE_SKETCH_H
#define STEVE_SKETCH_H

#include <memory>
#include <stdexcept>
#include <string>

namespace steve_sketch
{

// Raised for input that violates the Solver JSON contract: malformed JSON, unknown entity or
// constraint types, dangling refs, unsupported geometry combinations, invalid options or values.
// Solver outcomes (conflicts, non-convergence) are never exceptions; they are reported in the
// result JSON with status "failed".
class InputError: public std::runtime_error
{
public:
    using std::runtime_error::runtime_error;
};

// Library identification, e.g. "steve-sketch 0.1.0 (planegcs FreeCAD 5f8eac49, Eigen 3.4.0)".
const char* version();

// One-shot solve. `sketch_json` follows the Solver JSON contract; `options_json` is an object
// with optional keys (see solver/README.md):
//   max_iterations (int, default 100), convergence (number, default 1e-10),
//   fallback (bool, default true: DogLeg -> LevenbergMarquardt -> BFGS),
//   drag_convergence (number, default 1e-5 mm: SQP step size that ends a drag frame),
//   qr ("sparse" | "dense", default "sparse": QR algorithm used by the diagnosis).
// Returns the result JSON:
//   {status, dof, conflicting, redundant, partially_redundant, entities, free, values,
//    algorithm, message?}
std::string solve(const std::string& sketch_json, const std::string& options_json = "{}");

// Interactive session over one sketch. The GCS system is built once; drags add temporary
// (tag -1) soft constraints whose target parameters are updated in place every frame, the same
// mechanism FreeCAD's Sketcher uses. Not thread-safe: use one session per thread.
class Session
{
public:
    // Builds, diagnoses and solves the sketch (snapshot() then equals solve(sketch_json)).
    explicit Session(const std::string& sketch_json, const std::string& options_json = "{}");
    ~Session();
    Session(const Session&) = delete;
    Session& operator=(const Session&) = delete;

    // Drags `ref` towards (x, y) and returns {"status", "entities"}.
    //  - point refs (point id, <id>.start|end|center, <bspline>.pole<i>) follow the cursor;
    //  - circle/arc ids pull the rim through the cursor (radius drag, centre held softly);
    //  - line, ellipse, elliptical_arc and bspline ids translate with the cursor motion since
    //    the first drag() call of the gesture.
    // A drag with a different ref starts a new gesture. Each frame starts from the previous
    // frame's solution.
    std::string drag(const std::string& ref, double x, double y);

    // Ends the current drag gesture (removes the temporary constraints) and returns snapshot().
    std::string end_drag();

    // Changes the value of a driving dimensional constraint in place. Takes effect on the next
    // solve(); raises InputError for unknown ids, reference or non-dimensional constraints.
    void set_value(const std::string& constraint_id, double value);

    // Ends any drag, solves from the current geometry and returns the full result JSON.
    std::string solve();

    // Ends any drag, re-runs the rank/conflict diagnosis at the current geometry and returns
    // the full result JSON (geometry unchanged).
    std::string diagnose();

    // Full result JSON for the current state, without solving.
    std::string snapshot() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace steve_sketch

#endif  // STEVE_SKETCH_H
