// STEVE sketch solver core. See steve_sketch.h and solver/README.md.
//
// Copyright (C) 2026 STEVE contributors.
// Distributed under the GNU Lesser General Public License version 2.1 or later
// (it is linked with planegcs from FreeCAD); see solver/NOTICE.
//
// ---------------------------------------------------------------------------------------------
// Deterministic system construction (identical on the native and WebAssembly builds)
// ---------------------------------------------------------------------------------------------
// Every solver parameter (unknown or fixed) lives in ONE contiguous arena that is reserved up
// front and never reallocates. planegcs orders parameters by pointer value in several places
// (SubSystem parameter sets, the SQP drag solver's std::sort), so a single arena makes that
// order equal to the allocation order below on every platform.
//
//  1. Built-in reference geometry (fixed): origin (x, y), x_axis end (1, 0), y_axis end (0, 1).
//  2. Entities in array order. Parameters per entity, FreeCAD's order:
//       point           x y
//       line            start.x start.y end.x end.y
//       circle          center.x center.y radius
//       arc             start.x start.y end.x end.y center.x center.y radius a0 a1
//       ellipse         center.x center.y focus1.x focus1.y minor_radius
//       elliptical_arc  start.x start.y end.x end.y center.x center.y focus1.x focus1.y
//                       minor_radius a0 a1
//       bspline         pole0.x pole0.y ... poleN.x poleN.y, weights..., knots...
//     External entities, B-spline weights and knots are fixed parameters.
//  3. Groups: entities linked (transitively) by constraints share a group, numbered in order of
//     their first entity; each group owns one GCS::System. Constraints touching only fixed
//     geometry form one extra, last group.
//  4. Per group, in order: internal "arc rules" (tag 0) of its arcs / elliptical arcs in entity
//     order, then its constraints in array order (tag = constraint index + 1). Driving dimension
//     values and `fix` targets are fixed parameters appended to the arena in constraint order;
//     point-on-B-spline curve parameters are unknowns appended likewise. Reference
//     (driving: false) dimensions are measured only and never enter a system.
//  5. Per group: declareUnknowns(its non-fixed parameters in arena order), no driven parameters,
//     initSolution(LevenbergMarquardt) -> SparseQR diagnosis (dof, conflicting, redundant,
//     dependent parameters; LM is only used by planegcs' redundancy re-solve).
//  6. Per group: DogLeg, then LevenbergMarquardt, then BFGS; each attempt starts from the same
//     reference configuration and the first valid success is applied. If the diagnosis had
//     reported conflicting/redundant constraints and the solve succeeded, the group is
//     re-diagnosed at the solution. Any failure restores the input geometry of all groups.
// ---------------------------------------------------------------------------------------------

#include "steve_sketch.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <functional>
#include <limits>
#include <map>
#include <numbers>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <Eigen/Core>

#include "GCS.h"
#include "nlohmann/json.hpp"

static_assert(EIGEN_WORLD_VERSION == 3 && EIGEN_MAJOR_VERSION == 4 && EIGEN_MINOR_VERSION == 0,
              "steve_sketch is parity-tested against Eigen 3.4.0; build both targets with it");

#define STEVE_SKETCH_VERSION "0.1.0"

namespace steve_sketch
{
namespace
{

using json = nlohmann::ordered_json;

constexpr double kPi = std::numbers::pi;
constexpr double kTwoPi = 2.0 * std::numbers::pi;
constexpr int kInternalTag = 0;
constexpr int kTempTag = GCS::DefaultTemporaryConstraint;

[[noreturn]] void fail(const std::string& message)
{
    throw InputError(message);
}

// Eigen's matrix-product blocking depends on the detected CPU cache sizes. Pin them so the
// native and WebAssembly builds block (and therefore sum) identically.
void init_numeric_environment()
{
    static const bool done = [] {
        Eigen::setCpuCacheSizes(32 * 1024, 256 * 1024, 2 * 1024 * 1024);
        return true;
    }();
    (void)done;
}

// ---------------------------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------------------------

json parse_document(const std::string& text, const char* what)
{
    try {
        return json::parse(text);
    }
    catch (const json::parse_error& e) {
        fail(std::string(what) + ": invalid JSON (" + e.what() + ")");
    }
}

std::string quote_id(const std::string& s)
{
    return "\"" + s + "\"";
}

const json& require(const json& obj, const char* key, const std::string& ctx)
{
    auto it = obj.find(key);
    if (it == obj.end()) {
        fail(ctx + ": missing \"" + key + "\"");
    }
    return *it;
}

double as_number(const json& v, const std::string& ctx)
{
    if (!v.is_number()) {
        fail(ctx + ": expected a number");
    }
    double d = v.get<double>();
    if (!std::isfinite(d)) {
        fail(ctx + ": expected a finite number");
    }
    return d;
}

double number_at(const json& obj, const char* key, const std::string& ctx)
{
    return as_number(require(obj, key, ctx), ctx + " \"" + key + "\"");
}

std::array<double, 2> as_vec2(const json& v, const std::string& ctx)
{
    if (!v.is_array() || v.size() != 2) {
        fail(ctx + ": expected [x, y]");
    }
    return {as_number(v[0], ctx), as_number(v[1], ctx)};
}

std::array<double, 2> vec2_at(const json& obj, const char* key, const std::string& ctx)
{
    return as_vec2(require(obj, key, ctx), ctx + " \"" + key + "\"");
}

bool bool_at(const json& obj, const char* key, bool fallback, const std::string& ctx)
{
    auto it = obj.find(key);
    if (it == obj.end()) {
        return fallback;
    }
    if (!it->is_boolean()) {
        fail(ctx + ": \"" + key + "\" must be true or false");
    }
    return it->get<bool>();
}

std::string string_at(const json& obj, const char* key, const std::string& ctx)
{
    const json& v = require(obj, key, ctx);
    if (!v.is_string() || v.get_ref<const std::string&>().empty()) {
        fail(ctx + ": \"" + key + "\" must be a non-empty string");
    }
    return v.get<std::string>();
}

int int_value(const json& v, const std::string& ctx)
{
    double d = as_number(v, ctx);
    if (d != std::floor(d) || std::fabs(d) > 1e9) {
        fail(ctx + ": expected an integer");
    }
    return static_cast<int>(d);
}

json vec2_json(double x, double y)
{
    return json::array({x, y});
}

json vec2_json(const GCS::Point& p)
{
    return vec2_json(*p.x, *p.y);
}

// ---------------------------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------------------------

// Into (-pi, pi]. std::remainder is exact, so this is bit-identical on every platform.
double wrap_pi(double a)
{
    double r = std::remainder(a, kTwoPi);
    if (r <= -kPi) {
        r += kTwoPi;
    }
    return r;
}

// Counter-clockwise angular span into (0, 2*pi].
double normalize_span(double span)
{
    double r = std::fmod(span, kTwoPi);
    if (r <= 0.0) {
        r += kTwoPi;
    }
    return r;
}

// The representative of `a` (mod 2*pi) closest to `target`.
double wrap_near(double a, double target)
{
    return target + wrap_pi(a - target);
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

struct Options
{
    int max_iterations = 100;
    double convergence = 1e-10;
    double drag_convergence = 1e-5;  // SQP step size (mm) that ends a drag frame
    bool fallback = true;
    bool dense_qr = false;
};

Options parse_options(const std::string& text)
{
    Options o;
    if (text.empty()) {
        return o;
    }
    json j = parse_document(text, "options");
    if (j.is_null()) {
        return o;
    }
    if (!j.is_object()) {
        fail("options: expected a JSON object");
    }
    for (auto it = j.begin(); it != j.end(); ++it) {
        const std::string& key = it.key();
        const std::string ctx = "options \"" + key + "\"";
        if (key == "max_iterations") {
            o.max_iterations = int_value(it.value(), ctx);
            if (o.max_iterations < 1) {
                fail(ctx + ": must be >= 1");
            }
        }
        else if (key == "convergence") {
            o.convergence = as_number(it.value(), ctx);
            if (!(o.convergence > 0.0)) {
                fail(ctx + ": must be > 0");
            }
        }
        else if (key == "drag_convergence") {
            o.drag_convergence = as_number(it.value(), ctx);
            if (!(o.drag_convergence > 0.0)) {
                fail(ctx + ": must be > 0");
            }
        }
        else if (key == "fallback") {
            if (!it.value().is_boolean()) {
                fail(ctx + ": must be true or false");
            }
            o.fallback = it.value().get<bool>();
        }
        else if (key == "qr") {
            if (it.value() == "sparse") {
                o.dense_qr = false;
            }
            else if (it.value() == "dense") {
                o.dense_qr = true;
            }
            else {
                fail(ctx + ": must be \"sparse\" or \"dense\"");
            }
        }
        else {
            fail("options: unknown key \"" + key + "\"");
        }
    }
    return o;
}

// ---------------------------------------------------------------------------------------------
// Parameter arena
// ---------------------------------------------------------------------------------------------

class Arena
{
public:
    void reserve(std::size_t n)
    {
        values_.reserve(n);
        fixed_.reserve(n);
    }
    double* add(double value, bool fixed)
    {
        if (values_.size() == values_.capacity()) {
            // Reallocation would invalidate every pointer held by planegcs.
            throw std::logic_error("steve_sketch: parameter arena capacity exceeded");
        }
        values_.push_back(value);
        fixed_.push_back(fixed ? 1 : 0);
        return &values_.back();
    }
    std::size_t size() const
    {
        return values_.size();
    }
    double* at(std::size_t i)
    {
        return &values_[i];
    }
    bool fixed(std::size_t i) const
    {
        return fixed_[i] != 0;
    }
    std::size_t index(const double* p) const
    {
        return static_cast<std::size_t>(p - values_.data());
    }
    bool contains(const double* p) const
    {
        return !values_.empty() && p >= values_.data() && p < values_.data() + values_.size();
    }

private:
    std::vector<double> values_;
    std::vector<char> fixed_;
};

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

enum class Kind
{
    Point,
    Line,
    Circle,
    Arc,
    Ellipse,
    EllipticalArc,
    BSpline
};

const char* kind_name(Kind k)
{
    switch (k) {
        case Kind::Point:
            return "point";
        case Kind::Line:
            return "line";
        case Kind::Circle:
            return "circle";
        case Kind::Arc:
            return "arc";
        case Kind::Ellipse:
            return "ellipse";
        case Kind::EllipticalArc:
            return "elliptical_arc";
        case Kind::BSpline:
            return "bspline";
    }
    return "?";
}

struct Entity
{
    std::string id;
    Kind kind = Kind::Point;
    bool external = false;
    bool builtin = false;
    std::size_t index = 0;  // position in Sketch::entities_
    int group = -1;         // constraint group (-1: fixed geometry)
    json source;

    // Initial parameter values in the documented order and how many of them are fixed
    // regardless of `external` (B-spline weights and knots, always at the end).
    std::vector<double> init;
    std::size_t always_fixed_tail = 0;
    std::size_t pbegin = 0, pend = 0;  // arena range of this entity's parameters

    GCS::Point pt;
    GCS::Line line;
    GCS::Circle circle;
    GCS::Arc arc;
    GCS::Ellipse ellipse;
    GCS::ArcOfEllipse earc;
    GCS::BSpline bsp;

    double rotation_hint = 0.0;  // ellipse rotation, used if the foci collapse onto the centre
    bool clamped = false;        // B-spline passes through its first and last pole
    std::size_t num_poles = 0;

    GCS::Curve* curve()
    {
        switch (kind) {
            case Kind::Line:
                return &line;
            case Kind::Circle:
                return &circle;
            case Kind::Arc:
                return &arc;
            case Kind::Ellipse:
                return &ellipse;
            case Kind::EllipticalArc:
                return &earc;
            case Kind::BSpline:
                return &bsp;
            case Kind::Point:
                break;
        }
        return nullptr;
    }

    bool has_center() const
    {
        return kind == Kind::Circle || kind == Kind::Arc || kind == Kind::Ellipse
            || kind == Kind::EllipticalArc;
    }

    GCS::Point center_point()
    {
        switch (kind) {
            case Kind::Circle:
                return circle.center;
            case Kind::Arc:
                return arc.center;
            case Kind::Ellipse:
                return ellipse.center;
            case Kind::EllipticalArc:
                return earc.center;
            default:
                break;
        }
        return {};
    }

    // Points that lie on the curve by construction (end points).
    std::vector<GCS::Point> on_curve_points()
    {
        switch (kind) {
            case Kind::Line:
                return {line.p1, line.p2};
            case Kind::Arc:
                return {arc.start, arc.end};
            case Kind::EllipticalArc:
                return {earc.start, earc.end};
            case Kind::BSpline:
                if (clamped) {
                    return {bsp.poles.front(), bsp.poles.back()};
                }
                break;
            default:
                break;
        }
        return {};
    }

    // Parameters pinned by an entity-level `fix` (the entity's independent parameters).
    std::vector<double*> defining_params()
    {
        switch (kind) {
            case Kind::Point:
                return {pt.x, pt.y};
            case Kind::Line:
                return {line.p1.x, line.p1.y, line.p2.x, line.p2.y};
            case Kind::Circle:
                return {circle.center.x, circle.center.y, circle.rad};
            case Kind::Arc:
                return {arc.center.x, arc.center.y, arc.rad, arc.startAngle, arc.endAngle};
            case Kind::Ellipse:
                return {ellipse.center.x,
                        ellipse.center.y,
                        ellipse.focus1.x,
                        ellipse.focus1.y,
                        ellipse.radmin};
            case Kind::EllipticalArc:
                return {earc.center.x,
                        earc.center.y,
                        earc.focus1.x,
                        earc.focus1.y,
                        earc.radmin,
                        earc.startAngle,
                        earc.endAngle};
            case Kind::BSpline: {
                std::vector<double*> out;
                for (auto& p : bsp.poles) {
                    out.push_back(p.x);
                    out.push_back(p.y);
                }
                return out;
            }
        }
        return {};
    }

    std::size_t defining_param_count() const
    {
        switch (kind) {
            case Kind::Point:
                return 2;
            case Kind::Line:
                return 4;
            case Kind::Circle:
                return 3;
            case Kind::Arc:
                return 5;
            case Kind::Ellipse:
                return 5;
            case Kind::EllipticalArc:
                return 7;
            case Kind::BSpline:
                return 2 * num_poles;
        }
        return 0;
    }
};

// Parses and validates one entity; fills `init` (no allocation yet).
void parse_entity(const json& j, Entity& e)
{
    const std::string ctx = "entity " + quote_id(e.id);
    const std::string type = string_at(j, "type", ctx);
    e.external = bool_at(j, "external", false, ctx);
    (void)bool_at(j, "construction", false, ctx);  // validated, echoed, no solver meaning

    if (type == "point") {
        e.kind = Kind::Point;
        auto at = vec2_at(j, "at", ctx);
        e.init = {at[0], at[1]};
    }
    else if (type == "line") {
        e.kind = Kind::Line;
        auto s = vec2_at(j, "start", ctx);
        auto t = vec2_at(j, "end", ctx);
        e.init = {s[0], s[1], t[0], t[1]};
    }
    else if (type == "circle") {
        e.kind = Kind::Circle;
        auto c = vec2_at(j, "center", ctx);
        double r = number_at(j, "radius", ctx);
        if (!(r > 0.0)) {
            fail(ctx + ": radius must be > 0");
        }
        e.init = {c[0], c[1], r};
    }
    else if (type == "arc") {
        e.kind = Kind::Arc;
        auto c = vec2_at(j, "center", ctx);
        double r = number_at(j, "radius", ctx);
        double a0 = number_at(j, "start_angle", ctx);
        double a1 = number_at(j, "end_angle", ctx);
        if (!(r > 0.0)) {
            fail(ctx + ": radius must be > 0");
        }
        if (a1 == a0) {
            fail(ctx + ": start_angle and end_angle are equal");
        }
        a1 = a0 + normalize_span(a1 - a0);
        e.init = {c[0] + r * std::cos(a0),
                  c[1] + r * std::sin(a0),
                  c[0] + r * std::cos(a1),
                  c[1] + r * std::sin(a1),
                  c[0],
                  c[1],
                  r,
                  a0,
                  a1};
    }
    else if (type == "ellipse" || type == "elliptical_arc") {
        const bool is_arc = type == "elliptical_arc";
        e.kind = is_arc ? Kind::EllipticalArc : Kind::Ellipse;
        auto c = vec2_at(j, "center", ctx);
        double a = number_at(j, "major_radius", ctx);
        double b = number_at(j, "minor_radius", ctx);
        double rot = j.contains("rotation") ? number_at(j, "rotation", ctx) : 0.0;
        if (!(b > 0.0) || !(a > b)) {
            fail(ctx + ": requires major_radius > minor_radius > 0 (use a circle otherwise)");
        }
        e.rotation_hint = rot;
        const double cr = std::cos(rot), sr = std::sin(rot);
        const double fc = std::sqrt(a * a - b * b);
        const double fx = c[0] + fc * cr, fy = c[1] + fc * sr;
        if (!is_arc) {
            e.init = {c[0], c[1], fx, fy, b};
        }
        else {
            double u0 = number_at(j, "start_angle", ctx);
            double u1 = number_at(j, "end_angle", ctx);
            if (u1 == u0) {
                fail(ctx + ": start_angle and end_angle are equal");
            }
            u1 = u0 + normalize_span(u1 - u0);
            auto at = [&](double u) {
                const double ca = a * std::cos(u), sb = b * std::sin(u);
                return std::array<double, 2>{c[0] + ca * cr - sb * sr, c[1] + ca * sr + sb * cr};
            };
            auto s = at(u0), t = at(u1);
            e.init = {s[0], s[1], t[0], t[1], c[0], c[1], fx, fy, b, u0, u1};
        }
    }
    else if (type == "bspline") {
        e.kind = Kind::BSpline;
        const json& poles = require(j, "poles", ctx);
        if (!poles.is_array() || poles.size() < 2) {
            fail(ctx + ": \"poles\" must be an array of at least two [x, y] points");
        }
        const std::size_t n = poles.size();
        const int degree = j.contains("degree") ? int_value(j["degree"], ctx + " \"degree\"") : 3;
        const bool periodic = bool_at(j, "periodic", false, ctx);
        if (degree < 1) {
            fail(ctx + ": degree must be >= 1");
        }
        if (n < static_cast<std::size_t>(degree) + 1) {
            fail(ctx + ": a degree " + std::to_string(degree) + " B-spline needs at least "
                 + std::to_string(degree + 1) + " poles");
        }
        std::vector<double> weights(n, 1.0);
        if (j.contains("weights")) {
            const json& w = j["weights"];
            if (!w.is_array() || w.size() != n) {
                fail(ctx + ": \"weights\" must have one entry per pole");
            }
            for (std::size_t i = 0; i < n; ++i) {
                weights[i] = as_number(w[i], ctx + " \"weights\"");
                if (!(weights[i] > 0.0)) {
                    fail(ctx + ": weights must be > 0");
                }
            }
        }
        std::vector<double> knots;
        std::vector<int> mults;
        if (j.contains("knots") || j.contains("multiplicities")) {
            const json& k = require(j, "knots", ctx);
            const json& m = require(j, "multiplicities", ctx);
            if (!k.is_array() || !m.is_array() || k.size() != m.size() || k.size() < 2) {
                fail(ctx + ": \"knots\" and \"multiplicities\" must be arrays of equal length >= 2");
            }
            for (std::size_t i = 0; i < k.size(); ++i) {
                knots.push_back(as_number(k[i], ctx + " \"knots\""));
                mults.push_back(int_value(m[i], ctx + " \"multiplicities\""));
                if (mults.back() < 1 || mults.back() > degree + 1) {
                    fail(ctx + ": multiplicities must be in [1, degree + 1]");
                }
                if (i > 0 && !(knots[i] > knots[i - 1])) {
                    fail(ctx + ": knots must be strictly increasing");
                }
            }
            long sum = 0;
            for (int v : mults) {
                sum += v;
            }
            if (!periodic && sum != static_cast<long>(n) + degree + 1) {
                fail(ctx + ": sum(multiplicities) must equal poles + degree + 1");
            }
            if (periodic && (sum - mults.back() != static_cast<long>(n) || mults.front() != mults.back())) {
                fail(ctx + ": periodic B-spline requires sum(multiplicities) - last = poles and "
                           "equal first/last multiplicities");
            }
        }
        else if (!periodic) {  // clamped, uniform
            const std::size_t distinct = n - degree + 1;
            for (std::size_t i = 0; i < distinct; ++i) {
                knots.push_back(static_cast<double>(i));
                mults.push_back(i == 0 || i + 1 == distinct ? degree + 1 : 1);
            }
        }
        else {  // periodic, uniform
            for (std::size_t i = 0; i <= n; ++i) {
                knots.push_back(static_cast<double>(i));
                mults.push_back(1);
            }
        }
        e.num_poles = n;
        e.bsp.degree = degree;
        e.bsp.periodic = periodic;
        e.bsp.mult = mults;
        e.clamped = !periodic && mults.front() > degree && mults.back() > degree;
        e.init.clear();
        for (std::size_t i = 0; i < n; ++i) {
            auto p = as_vec2(poles[i], ctx + " \"poles\"");
            e.init.push_back(p[0]);
            e.init.push_back(p[1]);
        }
        e.init.insert(e.init.end(), weights.begin(), weights.end());
        e.init.insert(e.init.end(), knots.begin(), knots.end());
        e.always_fixed_tail = weights.size() + knots.size();
    }
    else {
        fail(ctx + ": unknown entity type " + quote_id(type));
    }
}

// ---------------------------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------------------------

struct Constraint
{
    std::string id;
    std::string type;
    int tag = 0;
    bool driving = true;
    bool dimensional = false;
    bool angular = false;
    bool positive = false;          // driving value must be > 0
    double* value_param = nullptr;  // driving dimension value (fixed arena parameter)
    double hint = 0.0;              // reference angle: branch hint (the stored value)
    std::function<double()> measure;
};

enum class PointRole
{
    Self,
    Start,
    End,
    Center,
    Pole
};

struct PointHandle
{
    GCS::Point p;
    Entity* owner = nullptr;
    PointRole role = PointRole::Self;
};

double point_distance(const GCS::Point& a, const GCS::Point& b)
{
    const double dx = *b.x - *a.x, dy = *b.y - *a.y;
    return std::sqrt(dx * dx + dy * dy);
}

// ---------------------------------------------------------------------------------------------
// Sketch: independent constraint groups, each with its own GCS system
// ---------------------------------------------------------------------------------------------
//
// Entities linked (directly or transitively) by constraints form a group, and each group gets
// its own GCS::System. Groups cannot influence each other (only fixed geometry is shared), so
// this is mathematically the same as one big system, but the QR diagnosis and every drag frame
// only touch the affected group. Groups are numbered in order of their first entity.
// Constraints that only reference fixed geometry (external entities, origin, axes) form a last
// group; without unknowns their residual decides: satisfied = redundant, otherwise conflicting.

constexpr std::pair<GCS::Algorithm, const char*> kAlgorithms[] = {
    {GCS::DogLeg, "dogleg"},
    {GCS::LevenbergMarquardt, "lm"},
    {GCS::BFGS, "bfgs"},
};

// Algorithm used by the diagnosis to decide whether a dependent constraint set is merely
// redundant (planegcs solves the system without the suspected constraints). Levenberg-Marquardt
// copes with the rank-deficient systems that remain in that step; DogLeg frequently stalls.
constexpr GCS::Algorithm kDiagnosisAlgorithm = GCS::LevenbergMarquardt;

struct Group
{
    GCS::System sys;
    std::vector<std::size_t> entities;    // indices into Sketch::entities_
    std::vector<int> tags;                // tags (index + 1) of constraints in this system
    std::vector<std::size_t> aux_params;  // arena indices of B-spline curve parameters
    std::vector<double*> unknowns;        // arena order
    bool values_changed = false;
    int algorithm = -1;  // index into kAlgorithms of the last successful solve

    // Diagnosis
    int dof = 0;
    GCS::VEC_I conflicting, redundant, partially_redundant;
    GCS::VEC_pD dependent;
    bool all_free = false;

    bool has_problems() const
    {
        return !conflicting.empty() || !redundant.empty() || !partially_redundant.empty();
    }
};

class Sketch
{
public:
    Sketch(const std::string& sketch_json, const Options& options);
    Sketch(const Sketch&) = delete;
    Sketch& operator=(const Sketch&) = delete;

    void solve_now();
    void diagnose_now();
    json drag(const std::string& ref, double x, double y);
    void end_drag();
    void set_value(const std::string& constraint_id, double value);
    json result() const;

private:
    struct MoveSlot
    {
        enum Mode
        {
            AbsX,
            AbsY,
            RelX,
            RelY,
            Hold
        } mode;
        double init;
    };
    struct DragState
    {
        std::string ref;
        int group = -1;
        double ax = 0.0, ay = 0.0;
        std::vector<MoveSlot> slots;
        std::vector<double> last;  // targets of the last solved frame
    };

    // construction
    void build(const json& doc);
    void configure(GCS::System& sys) const;
    void add_constraint(const json& j, std::size_t index, Group& g);
    void add_point_on(const PointHandle& p, Entity* curve, int tag, Group& g);
    void add_tangent(Constraint& c, Entity* a, Entity* b, const json& j, Group& g);
    Entity* find_entity(const std::string& id);
    Entity* entity_of_ref(const std::string& ref);
    Entity* resolve_curve(const std::string& ref, const std::string& ctx);
    Entity* curve_or_null(const std::string& ref);
    PointHandle resolve_point(const std::string& ref, const std::string& ctx);
    double closest_bspline_param(Entity& e, double px, double py);

    // coincidence classes (explicit coincident constraints), keyed by the x parameter index
    std::size_t uf_find(std::size_t i);
    void uf_union(std::size_t a, std::size_t b);
    bool same_point(const GCS::Point& a, const GCS::Point& b);

    // diagnosis and solving
    void prepare_group(Group& g, bool force_diagnosis);
    void aggregate();
    bool run_solvers(Group& g);
    bool geometry_valid(const Group& g) const;
    void begin_drag(const std::string& ref, double x, double y);
    double* move_param(double value, MoveSlot::Mode mode);
    bool drag_step(Group& g, const std::vector<double>& targets);

    // reporting
    json entities_json() const;
    json entity_json(const Entity& e) const;
    std::vector<std::string> tags_to_ids(std::vector<int> tags) const;

    Options opts_;
    Arena arena_;
    std::vector<std::unique_ptr<Entity>> entities_;  // pointer-stable (constraints keep refs)
    std::unordered_map<std::string, Entity*> by_id_;
    Entity* origin_ = nullptr;
    std::vector<Constraint> constraints_;
    std::unordered_map<std::string, std::size_t> constraint_index_;
    std::vector<int> constraint_group_;
    std::vector<std::size_t> uf_parent_;
    std::vector<double> moves_;  // drag targets (reserved per gesture, never reallocated)
    std::optional<DragState> drag_;
    std::vector<std::unique_ptr<Group>> groups_;  // declared after the geometry they point to

    // aggregated state
    int dof_ = 0;
    std::vector<std::string> conflicting_, redundant_, partially_redundant_;
    std::vector<char> free_;  // per entity
    bool solved_ok_ = false;
    int algorithm_ = -1;
    std::string message_;
};

Sketch::Sketch(const std::string& sketch_json, const Options& options)
    : opts_(options)
{
    init_numeric_environment();
    build(parse_document(sketch_json, "sketch"));
}

void Sketch::configure(GCS::System& sys) const
{
    sys.maxIter = opts_.max_iterations;
    sys.maxIterRedundant = opts_.max_iterations;
    sys.sketchSizeMultiplier = false;
    sys.sketchSizeMultiplierRedundant = false;
    sys.convergence = opts_.convergence;
    sys.convergenceRedundant = opts_.convergence;
    sys.qrAlgorithm = opts_.dense_qr ? GCS::EigenDenseQR : GCS::EigenSparseQR;
    sys.debugMode = GCS::NoDebug;
}

Entity* Sketch::find_entity(const std::string& id)
{
    auto it = by_id_.find(id);
    return it == by_id_.end() ? nullptr : it->second;
}

// Entity named by a ref (curve id, point entity id or <entity>.<point>), or null. Never throws.
Entity* Sketch::entity_of_ref(const std::string& ref)
{
    if (Entity* e = find_entity(ref)) {
        return e;
    }
    const auto dot = ref.rfind('.');
    return dot == std::string::npos ? nullptr : find_entity(ref.substr(0, dot));
}

void Sketch::build(const json& doc)
{
    if (!doc.is_object()) {
        fail("sketch: expected a JSON object with \"entities\" and \"constraints\"");
    }
    static const json kEmpty = json::array();
    const json& ents = doc.contains("entities") ? doc["entities"] : kEmpty;
    const json& cons = doc.contains("constraints") ? doc["constraints"] : kEmpty;
    if (!ents.is_array()) {
        fail("sketch: \"entities\" must be an array");
    }
    if (!cons.is_array()) {
        fail("sketch: \"constraints\" must be an array");
    }

    // Built-in reference geometry.
    auto make_builtin = [&](const char* id, Kind kind, std::vector<double> init) {
        auto e = std::make_unique<Entity>();
        e->id = id;
        e->kind = kind;
        e->external = true;
        e->builtin = true;
        e->init = std::move(init);
        e->index = entities_.size();
        by_id_[e->id] = e.get();
        entities_.push_back(std::move(e));
    };
    make_builtin("origin", Kind::Point, {0.0, 0.0});
    make_builtin("x_axis", Kind::Line, {1.0, 0.0});  // start shares the origin parameters
    make_builtin("y_axis", Kind::Line, {0.0, 1.0});

    // Pass A: parse entities.
    for (std::size_t i = 0; i < ents.size(); ++i) {
        const json& j = ents[i];
        const std::string ctx = "entities[" + std::to_string(i) + "]";
        if (!j.is_object()) {
            fail(ctx + ": expected an object");
        }
        auto e = std::make_unique<Entity>();
        e->id = string_at(j, "id", ctx);
        if (by_id_.count(e->id)) {
            fail(ctx + ": duplicate or reserved entity id " + quote_id(e->id));
        }
        e->source = j;
        parse_entity(j, *e);
        e->index = entities_.size();
        by_id_[e->id] = e.get();
        entities_.push_back(std::move(e));
    }

    // Reserve the arena: entity parameters + an upper bound for constraint parameters.
    std::size_t capacity = 0;
    for (auto& e : entities_) {
        capacity += e->builtin ? 2 : e->init.size();
    }
    for (const json& j : cons) {
        std::size_t need = 2;
        if (j.is_object() && j.value("type", json()) == "fix") {
            auto refs = j.find("refs");
            if (refs != j.end() && refs->is_array() && refs->size() == 1 && (*refs)[0].is_string()) {
                if (Entity* e = find_entity((*refs)[0].get<std::string>())) {
                    need = std::max(need, e->defining_param_count());
                }
            }
        }
        capacity += need;
    }
    arena_.reserve(capacity);

    // Pass B: allocate parameters in the documented order and wire GCS geometry.
    for (auto& ep : entities_) {
        Entity& e = *ep;
        e.pbegin = arena_.size();
        if (e.builtin) {
            if (e.kind == Kind::Point) {
                e.pt.x = arena_.add(e.init[0], true);
                e.pt.y = arena_.add(e.init[1], true);
                origin_ = &e;
            }
            else {
                e.line.p1 = origin_->pt;
                e.line.p2.x = arena_.add(e.init[0], true);
                e.line.p2.y = arena_.add(e.init[1], true);
            }
            e.pend = arena_.size();
            continue;
        }
        std::vector<double*> p;
        const std::size_t fixed_from = e.init.size() - e.always_fixed_tail;
        for (std::size_t i = 0; i < e.init.size(); ++i) {
            p.push_back(arena_.add(e.init[i], e.external || i >= fixed_from));
        }
        e.pend = arena_.size();
        switch (e.kind) {
            case Kind::Point:
                e.pt = GCS::Point(p[0], p[1]);
                break;
            case Kind::Line:
                e.line.p1 = GCS::Point(p[0], p[1]);
                e.line.p2 = GCS::Point(p[2], p[3]);
                break;
            case Kind::Circle:
                e.circle.center = GCS::Point(p[0], p[1]);
                e.circle.rad = p[2];
                break;
            case Kind::Arc:
                e.arc.start = GCS::Point(p[0], p[1]);
                e.arc.end = GCS::Point(p[2], p[3]);
                e.arc.center = GCS::Point(p[4], p[5]);
                e.arc.rad = p[6];
                e.arc.startAngle = p[7];
                e.arc.endAngle = p[8];
                break;
            case Kind::Ellipse:
                e.ellipse.center = GCS::Point(p[0], p[1]);
                e.ellipse.focus1 = GCS::Point(p[2], p[3]);
                e.ellipse.radmin = p[4];
                break;
            case Kind::EllipticalArc:
                e.earc.start = GCS::Point(p[0], p[1]);
                e.earc.end = GCS::Point(p[2], p[3]);
                e.earc.center = GCS::Point(p[4], p[5]);
                e.earc.focus1 = GCS::Point(p[6], p[7]);
                e.earc.radmin = p[8];
                e.earc.startAngle = p[9];
                e.earc.endAngle = p[10];
                break;
            case Kind::BSpline: {
                const std::size_t n = e.num_poles;
                e.bsp.poles.clear();
                for (std::size_t i = 0; i < n; ++i) {
                    e.bsp.poles.emplace_back(p[2 * i], p[2 * i + 1]);
                }
                e.bsp.weights.assign(p.begin() + 2 * n, p.begin() + 3 * n);
                e.bsp.knots.assign(p.begin() + 3 * n, p.end());
                // Clamped splines interpolate their end poles: start/end alias those poles
                // (no extra parameters or coincidence constraints).
                e.bsp.start = e.bsp.poles.front();
                e.bsp.end = e.bsp.poles.back();
                e.bsp.knotpointGeoids.assign(e.bsp.knots.size(), -2000);
                e.bsp.setupFlattenedKnots();
                break;
            }
        }
    }

    uf_parent_.resize(arena_.size());
    for (std::size_t i = 0; i < uf_parent_.size(); ++i) {
        uf_parent_[i] = i;
    }

    // Constraint pre-pass: ids, coincidence classes (for tangent-at-point) and entity links.
    std::vector<std::size_t> link(entities_.size());
    for (std::size_t i = 0; i < link.size(); ++i) {
        link[i] = i;
    }
    auto link_find = [&](std::size_t i) {
        while (link[i] != i) {
            link[i] = link[link[i]];
            i = link[i];
        }
        return i;
    };
    std::vector<Entity*> anchor(cons.size(), nullptr);  // first non-fixed entity per constraint
    for (std::size_t i = 0; i < cons.size(); ++i) {
        const json& j = cons[i];
        const std::string ctx = "constraints[" + std::to_string(i) + "]";
        if (!j.is_object()) {
            fail(ctx + ": expected an object");
        }
        const std::string id = j.contains("id") ? string_at(j, "id", ctx) : "k" + std::to_string(i + 1);
        if (constraint_index_.count(id)) {
            fail(ctx + ": duplicate constraint id " + quote_id(id));
        }
        constraint_index_[id] = i;
        std::vector<std::string> names;
        if (auto r = j.find("refs"); r != j.end() && r->is_array()) {
            for (const json& s : *r) {
                if (s.is_string()) {
                    names.push_back(s.get<std::string>());
                }
            }
        }
        if (auto a = j.find("at"); a != j.end() && a->is_string()) {
            names.push_back(a->get<std::string>());
        }
        for (const std::string& n : names) {
            Entity* e = entity_of_ref(n);
            if (!e || e->external) {
                continue;
            }
            if (!anchor[i]) {
                anchor[i] = e;
            }
            else {
                std::size_t a = link_find(anchor[i]->index), b = link_find(e->index);
                if (a != b) {
                    link[std::max(a, b)] = std::min(a, b);
                }
            }
        }
        if (j.value("type", json()) == "coincident" && names.size() == 2) {
            const std::string cctx = "constraint " + quote_id(id);
            PointHandle a = resolve_point(names[0], cctx);
            PointHandle b = resolve_point(names[1], cctx);
            uf_union(arena_.index(a.p.x), arena_.index(b.p.x));
        }
    }

    // Groups in order of their first entity; constraints on fixed geometry only go last.
    std::vector<int> group_of_root(entities_.size(), -1);
    for (auto& ep : entities_) {
        if (ep->external) {
            continue;
        }
        const std::size_t root = link_find(ep->index);
        if (group_of_root[root] < 0) {
            group_of_root[root] = static_cast<int>(groups_.size());
            groups_.push_back(std::make_unique<Group>());
            configure(groups_.back()->sys);
        }
        ep->group = group_of_root[root];
        groups_[ep->group]->entities.push_back(ep->index);
    }
    int fixed_group = -1;
    constraint_group_.assign(cons.size(), -1);
    for (std::size_t i = 0; i < cons.size(); ++i) {
        if (anchor[i]) {
            constraint_group_[i] = anchor[i]->group;
        }
        else {
            if (fixed_group < 0) {
                fixed_group = static_cast<int>(groups_.size());
                groups_.push_back(std::make_unique<Group>());
                configure(groups_.back()->sys);
            }
            constraint_group_[i] = fixed_group;
        }
    }

    // Internal constraints (tag 0), then user constraints (tag = index + 1), in order.
    for (auto& ep : entities_) {
        Entity& e = *ep;
        if (e.external) {
            continue;
        }
        if (e.kind == Kind::Arc) {
            groups_[e.group]->sys.addConstraintArcRules(e.arc, kInternalTag);
        }
        else if (e.kind == Kind::EllipticalArc) {
            groups_[e.group]->sys.addConstraintArcOfEllipseRules(e.earc, kInternalTag);
        }
    }
    constraints_.reserve(cons.size());
    for (std::size_t i = 0; i < cons.size(); ++i) {
        add_constraint(cons[i], i, *groups_[constraint_group_[i]]);
    }

    // Unknowns per group, in arena order.
    for (auto& gp : groups_) {
        Group& g = *gp;
        std::vector<std::size_t> idx = g.aux_params;
        for (std::size_t ei : g.entities) {
            const Entity& e = *entities_[ei];
            for (std::size_t k = e.pbegin; k < e.pend; ++k) {
                if (!arena_.fixed(k)) {
                    idx.push_back(k);
                }
            }
        }
        std::sort(idx.begin(), idx.end());
        for (std::size_t k : idx) {
            g.unknowns.push_back(arena_.at(k));
        }
        g.sys.declareUnknowns(g.unknowns);
        GCS::VEC_pD driven;
        g.sys.declareDrivenParams(driven);
    }
    free_.assign(entities_.size(), 0);
}

std::size_t Sketch::uf_find(std::size_t i)
{
    while (uf_parent_[i] != i) {
        uf_parent_[i] = uf_parent_[uf_parent_[i]];
        i = uf_parent_[i];
    }
    return i;
}

void Sketch::uf_union(std::size_t a, std::size_t b)
{
    a = uf_find(a);
    b = uf_find(b);
    if (a != b) {
        uf_parent_[std::max(a, b)] = std::min(a, b);
    }
}

bool Sketch::same_point(const GCS::Point& a, const GCS::Point& b)
{
    return a.x == b.x || uf_find(arena_.index(a.x)) == uf_find(arena_.index(b.x));
}

PointHandle Sketch::resolve_point(const std::string& ref, const std::string& ctx)
{
    if (Entity* e = find_entity(ref)) {
        if (e->kind != Kind::Point) {
            fail(ctx + ": " + quote_id(ref) + " is a " + kind_name(e->kind)
                 + ", expected a point (e.g. " + ref + ".start)");
        }
        return {e->pt, e, PointRole::Self};
    }
    const auto dot = ref.rfind('.');
    if (dot == std::string::npos || dot == 0 || dot + 1 == ref.size()) {
        fail(ctx + ": unknown point ref " + quote_id(ref));
    }
    const std::string base = ref.substr(0, dot), part = ref.substr(dot + 1);
    Entity* e = find_entity(base);
    if (!e) {
        fail(ctx + ": unknown entity " + quote_id(base) + " in ref " + quote_id(ref));
    }
    auto bad = [&]() -> PointHandle {
        fail(ctx + ": " + kind_name(e->kind) + " " + quote_id(base) + " has no point " + quote_id(part));
    };
    if (part == "start" || part == "end") {
        const bool s = part == "start";
        const PointRole role = s ? PointRole::Start : PointRole::End;
        switch (e->kind) {
            case Kind::Line:
                return {s ? e->line.p1 : e->line.p2, e, role};
            case Kind::Arc:
                return {s ? e->arc.start : e->arc.end, e, role};
            case Kind::EllipticalArc:
                return {s ? e->earc.start : e->earc.end, e, role};
            case Kind::BSpline:
                if (!e->clamped) {
                    fail(ctx + ": B-spline " + quote_id(base)
                         + " is periodic or unclamped; use .pole<i> refs");
                }
                return {s ? e->bsp.poles.front() : e->bsp.poles.back(), e, role};
            default:
                return bad();
        }
    }
    if (part == "center") {
        if (!e->has_center()) {
            return bad();
        }
        return {e->center_point(), e, PointRole::Center};
    }
    if (part.rfind("pole", 0) == 0 && e->kind == Kind::BSpline && part.size() > 4) {
        std::size_t idx = 0;
        for (std::size_t k = 4; k < part.size(); ++k) {
            if (part[k] < '0' || part[k] > '9' || idx > 1000000) {
                return bad();
            }
            idx = idx * 10 + static_cast<std::size_t>(part[k] - '0');
        }
        if (idx >= e->num_poles) {
            fail(ctx + ": " + quote_id(ref) + " is out of range (B-spline has "
                 + std::to_string(e->num_poles) + " poles)");
        }
        return {e->bsp.poles[idx], e, PointRole::Pole};
    }
    return bad();
}

Entity* Sketch::curve_or_null(const std::string& ref)
{
    Entity* e = find_entity(ref);
    return (e && e->kind != Kind::Point) ? e : nullptr;
}

Entity* Sketch::resolve_curve(const std::string& ref, const std::string& ctx)
{
    Entity* e = find_entity(ref);
    if (!e) {
        fail(ctx + ": unknown entity " + quote_id(ref));
    }
    if (e->kind == Kind::Point) {
        fail(ctx + ": " + quote_id(ref) + " is a point, expected a curve");
    }
    return e;
}

// Closest curve parameter to (px, py): dense sampling per knot span, then Gauss-Newton.
// Only +, -, *, / and sqrt are involved, so the result is identical on every platform.
double Sketch::closest_bspline_param(Entity& e, double px, double py)
{
    GCS::BSpline& b = e.bsp;
    const double u0 = *b.knots.front(), u1 = *b.knots.back();
    auto dist2 = [&](double u) {
        GCS::DeriVector2 v = b.Value(u, 1.0);
        const double dx = v.x - px, dy = v.y - py;
        return dx * dx + dy * dy;
    };
    const int samples = 16 * static_cast<int>(b.knots.size());
    double best_u = u0, best = dist2(u0);
    for (int i = 1; i <= samples; ++i) {
        const double u = u0 + (u1 - u0) * static_cast<double>(i) / samples;
        const double d = dist2(u);
        if (d < best) {
            best = d;
            best_u = u;
        }
    }
    double u = best_u;
    for (int it = 0; it < 30; ++it) {
        GCS::DeriVector2 v = b.Value(u, 1.0);
        const double tx = v.dx, ty = v.dy;
        const double tt = tx * tx + ty * ty;
        if (!(tt > 0.0)) {
            break;
        }
        double next = u + ((px - v.x) * tx + (py - v.y) * ty) / tt;
        if (!b.periodic) {
            next = std::min(u1, std::max(u0, next));
        }
        if (dist2(next) > dist2(u)) {
            break;
        }
        const bool done = std::fabs(next - u) <= 1e-15 * (1.0 + std::fabs(u));
        u = next;
        if (done) {
            break;
        }
    }
    return u;
}

void Sketch::add_point_on(const PointHandle& ph, Entity* c, int tag, Group& g)
{
    GCS::Point p = ph.p;
    switch (c->kind) {
        case Kind::Line:
            g.sys.addConstraintPointOnLine(p, c->line, tag);
            break;
        case Kind::Circle:
            g.sys.addConstraintPointOnCircle(p, c->circle, tag);
            break;
        case Kind::Arc:
            g.sys.addConstraintPointOnArc(p, c->arc, tag);
            break;
        case Kind::Ellipse:
            g.sys.addConstraintPointOnEllipse(p, c->ellipse, tag);
            break;
        case Kind::EllipticalArc:
            g.sys.addConstraintPointOnEllipse(p, c->earc, tag);
            break;
        case Kind::BSpline: {
            double* u = arena_.add(closest_bspline_param(*c, *p.x, *p.y), false);
            g.aux_params.push_back(arena_.index(u));
            g.sys.addConstraintPointOnBSpline(p, c->bsp, u, tag);
            break;
        }
        case Kind::Point:
            break;
    }
}

void Sketch::add_tangent(Constraint& c, Entity* a, Entity* b, const json& j, Group& g)
{
    const std::string ctx = "constraint " + quote_id(c.id);
    const int tag = c.tag;
    GCS::System& sys = g.sys;
    auto it = j.find("at");
    if (it == j.end() || it->is_null()) {
        // Edge tangency (FreeCAD's "simple tangency").
        Kind ka = a->kind, kb = b->kind;
        if (kb == Kind::Line && ka != Kind::Line) {
            std::swap(a, b);
            std::swap(ka, kb);
        }
        if (ka == Kind::Line) {
            switch (kb) {
                case Kind::Line:  // collinear
                    sys.addConstraintPointOnLine(b->line.p1, a->line, tag);
                    sys.addConstraintPointOnLine(b->line.p2, a->line, tag);
                    return;
                case Kind::Circle:
                    sys.addConstraintTangent(a->line, b->circle, tag);
                    return;
                case Kind::Arc:
                    sys.addConstraintTangent(a->line, b->arc, tag);
                    return;
                case Kind::Ellipse:
                    sys.addConstraintTangent(a->line, b->ellipse, tag);
                    return;
                case Kind::EllipticalArc:
                    sys.addConstraintTangent(a->line, static_cast<GCS::Ellipse&>(b->earc), tag);
                    return;
                default:
                    break;
            }
        }
        if (ka == Kind::Arc && kb == Kind::Circle) {
            std::swap(a, b);
            std::swap(ka, kb);
        }
        if (ka == Kind::Circle && kb == Kind::Circle) {
            sys.addConstraintTangent(a->circle, b->circle, tag);
            return;
        }
        if (ka == Kind::Circle && kb == Kind::Arc) {
            sys.addConstraintTangent(a->circle, b->arc, tag);
            return;
        }
        if (ka == Kind::Arc && kb == Kind::Arc) {
            sys.addConstraintTangent(a->arc, b->arc, tag);
            return;
        }
        fail(ctx + ": edge tangency between " + kind_name(ka) + " and " + kind_name(kb)
             + " is not supported; give \"at\" (a point on both curves)");
    }

    // Tangency at a point (FreeCAD's endpoint / via-point tangency: angle_via_point).
    if (!it->is_string()) {
        fail(ctx + ": \"at\" must be a point ref");
    }
    PointHandle at = resolve_point(it->get<std::string>(), ctx + " \"at\"");
    GCS::Point poa_a = at.p, poa_b = at.p;
    auto prepare = [&](Entity* e, GCS::Point& poa) {
        std::vector<GCS::Point> own = e->on_curve_points();
        if (e->kind == Kind::BSpline) {
            // planegcs only knows B-spline normals at the clamped end poles.
            for (const GCS::Point& q : own) {
                if (same_point(at.p, q)) {
                    poa = q;
                    return;
                }
            }
            fail(ctx + ": tangency on B-spline " + quote_id(e->id)
                 + " must be at its start or end (or a point coincident with it)");
        }
        for (const GCS::Point& q : own) {
            if (same_point(at.p, q)) {
                return;  // already on the curve
            }
        }
        add_point_on(at, e, tag, g);
    };
    prepare(a, poa_a);
    prepare(b, poa_b);

    double* angle = arena_.add(0.0, true);
    GCS::Curve& ca = *a->curve();
    GCS::Curve& cb = *b->curve();
    const bool two_points = a->kind == Kind::BSpline && b->kind == Kind::BSpline;
    GCS::Point poa = a->kind == Kind::BSpline ? poa_a : (b->kind == Kind::BSpline ? poa_b : at.p);
    // Co- or counter-directed tangency is auto-detected from the input geometry (FreeCAD rule).
    double err = two_points ? sys.calculateAngleViaPoint(ca, cb, poa_a, poa_b)
                            : sys.calculateAngleViaPoint(ca, cb, poa);
    *angle = std::fabs(wrap_pi(err)) > kPi / 2 ? kPi : 0.0;
    if (two_points) {
        sys.addConstraintAngleViaTwoPoints(ca, cb, poa_a, poa_b, angle, tag);
    }
    else {
        sys.addConstraintAngleViaPoint(ca, cb, poa, angle, tag);
    }
}

void Sketch::add_constraint(const json& j, std::size_t index, Group& g)
{
    GCS::System& sys = g.sys;
    Constraint c;
    c.tag = static_cast<int>(index) + 1;
    const std::string pctx = "constraints[" + std::to_string(index) + "]";
    c.id = j.contains("id") ? string_at(j, "id", pctx) : "k" + std::to_string(index + 1);
    const std::string ctx = "constraint " + quote_id(c.id);
    c.type = string_at(j, "type", ctx);
    const std::string& type = c.type;

    const json& refs_json = require(j, "refs", ctx);
    if (!refs_json.is_array()) {
        fail(ctx + ": \"refs\" must be an array of strings");
    }
    std::vector<std::string> refs;
    for (const json& r : refs_json) {
        if (!r.is_string()) {
            fail(ctx + ": \"refs\" must be an array of strings");
        }
        refs.push_back(r.get<std::string>());
    }
    auto want = [&](std::size_t lo, std::size_t hi) {
        if (refs.size() < lo || refs.size() > hi) {
            fail(ctx + ": " + type + " takes " + std::to_string(lo)
                 + (lo == hi ? "" : "-" + std::to_string(hi)) + " refs, got "
                 + std::to_string(refs.size()));
        }
    };

    static const std::vector<std::string> kDimensional = {"distance",
                                                          "length",
                                                          "horizontal_distance",
                                                          "vertical_distance",
                                                          "angle",
                                                          "radius",
                                                          "diameter"};
    c.dimensional = std::find(kDimensional.begin(), kDimensional.end(), type) != kDimensional.end();
    c.driving = bool_at(j, "driving", true, ctx);
    if (!c.driving && !c.dimensional) {
        fail(ctx + ": only dimensional constraints can be reference (driving: false)");
    }
    double value = 0.0;
    if (c.dimensional) {
        if (c.driving) {
            value = number_at(j, "value", ctx);
        }
        else if (j.contains("value") && !j["value"].is_null()) {
            value = number_at(j, "value", ctx);
        }
        c.hint = value;
    }
    const int tag = c.tag;
    const bool add = c.driving;  // reference dimensions are measured only
    auto value_param = [&]() -> double* {
        c.value_param = arena_.add(value, true);
        return c.value_param;
    };
    auto require_positive = [&]() {
        c.positive = true;
        if (c.driving && !(value > 0.0)) {
            fail(ctx + ": value must be > 0");
        }
    };
    auto line_of = [&](const std::string& r) -> Entity* {
        Entity* e = resolve_curve(r, ctx);
        if (e->kind != Kind::Line) {
            fail(ctx + ": " + quote_id(r) + " is a " + kind_name(e->kind) + ", expected a line");
        }
        return e;
    };
    auto round_of = [&](const std::string& r) -> Entity* {
        Entity* e = resolve_curve(r, ctx);
        if (e->kind != Kind::Circle && e->kind != Kind::Arc) {
            fail(ctx + ": " + quote_id(r) + " is a " + kind_name(e->kind) + ", expected a circle or arc");
        }
        return e;
    };
    auto is_line_ref = [&](const std::string& r) {
        Entity* e = find_entity(r);
        return e && e->kind == Kind::Line;
    };

    if (type == "coincident") {
        want(2, 2);
        PointHandle a = resolve_point(refs[0], ctx), b = resolve_point(refs[1], ctx);
        sys.addConstraintP2PCoincident(a.p, b.p, tag);
    }
    else if (type == "point_on") {
        want(2, 2);
        PointHandle p = resolve_point(refs[0], ctx);
        add_point_on(p, resolve_curve(refs[1], ctx), tag, g);
    }
    else if (type == "horizontal" || type == "vertical") {
        want(1, 2);
        const bool h = type == "horizontal";
        if (refs.size() == 1) {
            Entity* l = line_of(refs[0]);
            h ? sys.addConstraintHorizontal(l->line, tag) : sys.addConstraintVertical(l->line, tag);
        }
        else {
            PointHandle a = resolve_point(refs[0], ctx), b = resolve_point(refs[1], ctx);
            h ? sys.addConstraintHorizontal(a.p, b.p, tag) : sys.addConstraintVertical(a.p, b.p, tag);
        }
    }
    else if (type == "parallel") {
        want(2, 2);
        sys.addConstraintParallel(line_of(refs[0])->line, line_of(refs[1])->line, tag);
    }
    else if (type == "perpendicular") {
        want(2, 2);
        Entity* a = resolve_curve(refs[0], ctx);
        Entity* b = resolve_curve(refs[1], ctx);
        if (a->kind != Kind::Line) {
            std::swap(a, b);
        }
        if (a->kind == Kind::Line && b->kind == Kind::Line) {
            sys.addConstraintPerpendicular(a->line, b->line, tag);
        }
        else if (a->kind == Kind::Line && (b->kind == Kind::Circle || b->kind == Kind::Arc)) {
            GCS::Point center = b->center_point();
            sys.addConstraintPointOnLine(center, a->line, tag);
        }
        else {
            fail(ctx + ": perpendicular needs two lines (or a line and a circle/arc)");
        }
    }
    else if (type == "collinear") {
        want(2, 2);
        Entity* a = line_of(refs[0]);
        Entity* b = line_of(refs[1]);
        sys.addConstraintPointOnLine(b->line.p1, a->line, tag);
        sys.addConstraintPointOnLine(b->line.p2, a->line, tag);
    }
    else if (type == "tangent") {
        want(2, 2);
        add_tangent(c, resolve_curve(refs[0], ctx), resolve_curve(refs[1], ctx), j, g);
    }
    else if (type == "equal") {
        want(2, 2);
        Entity* a = resolve_curve(refs[0], ctx);
        Entity* b = resolve_curve(refs[1], ctx);
        auto round = [](Kind k) { return k == Kind::Circle || k == Kind::Arc; };
        auto conic = [](Kind k) { return k == Kind::Ellipse || k == Kind::EllipticalArc; };
        if (a->kind == Kind::Line && b->kind == Kind::Line) {
            sys.addConstraintEqualLength(a->line, b->line, tag);
        }
        else if (round(a->kind) && round(b->kind)) {
            double* ra = a->kind == Kind::Circle ? a->circle.rad : a->arc.rad;
            double* rb = b->kind == Kind::Circle ? b->circle.rad : b->arc.rad;
            sys.addConstraintEqual(ra, rb, tag);
        }
        else if (conic(a->kind) && conic(b->kind)) {
            GCS::Ellipse& ea = a->kind == Kind::Ellipse ? a->ellipse : a->earc;
            GCS::Ellipse& eb = b->kind == Kind::Ellipse ? b->ellipse : b->earc;
            sys.addConstraintEqualRadii(ea, eb, tag);
        }
        else {
            fail(ctx + ": equal needs two lines, two circles/arcs or two ellipses");
        }
    }
    else if (type == "symmetric") {
        want(3, 3);
        PointHandle p = resolve_point(refs[0], ctx), q = resolve_point(refs[1], ctx);
        if (is_line_ref(refs[2])) {
            sys.addConstraintP2PSymmetric(p.p, q.p, find_entity(refs[2])->line, tag);
        }
        else {
            PointHandle m = resolve_point(refs[2], ctx);
            sys.addConstraintP2PSymmetric(p.p, q.p, m.p, tag);
        }
    }
    else if (type == "midpoint") {
        want(2, 2);
        std::string pref = refs[0], lref = refs[1];
        if (is_line_ref(pref) && !is_line_ref(lref)) {
            std::swap(pref, lref);
        }
        PointHandle p = resolve_point(pref, ctx);
        Entity* l = line_of(lref);
        sys.addConstraintP2PSymmetric(l->line.p1, l->line.p2, p.p, tag);
    }
    else if (type == "concentric") {
        want(2, 2);
        Entity* a = resolve_curve(refs[0], ctx);
        Entity* b = resolve_curve(refs[1], ctx);
        if (!a->has_center() || !b->has_center()) {
            fail(ctx + ": concentric needs circles, arcs, ellipses or elliptical arcs");
        }
        GCS::Point ca = a->center_point(), cb = b->center_point();
        sys.addConstraintP2PCoincident(ca, cb, tag);
    }
    else if (type == "fix") {
        want(1, 1);
        Entity* e = find_entity(refs[0]);
        // Target [x, y] in "value"; "at" is accepted as an alias (Code API: fix(ref, at=...)).
        const bool has_value = j.contains("value") && !j["value"].is_null();
        const bool has_at = j.contains("at") && !j["at"].is_null();
        if (has_value && has_at) {
            fail(ctx + ": give either \"value\" or \"at\", not both");
        }
        const char* target_key = has_at ? "at" : "value";
        if (e && e->kind != Kind::Point) {
            if (has_value || has_at) {
                fail(ctx + ": a target position is only allowed when fixing a point");
            }
            for (double* p : e->defining_params()) {
                sys.addConstraintEqual(p, arena_.add(*p, true), tag);
            }
        }
        else {
            PointHandle p = resolve_point(refs[0], ctx);
            double x = *p.p.x, y = *p.p.y;
            if (has_value || has_at) {
                auto v = vec2_at(j, target_key, ctx);
                x = v[0];
                y = v[1];
            }
            sys.addConstraintCoordinateX(p.p, arena_.add(x, true), tag);
            sys.addConstraintCoordinateY(p.p, arena_.add(y, true), tag);
        }
    }
    else if (type == "distance") {
        want(1, 2);
        require_positive();
        if (refs.size() == 1) {
            GCS::Line ln = line_of(refs[0])->line;
            if (add) {
                sys.addConstraintP2PDistance(ln.p1, ln.p2, value_param(), tag);
            }
            c.measure = [ln] { return point_distance(ln.p1, ln.p2); };
        }
        else if (is_line_ref(refs[0]) || is_line_ref(refs[1])) {
            const bool first_is_line = is_line_ref(refs[0]);
            Entity* l = line_of(first_is_line ? refs[0] : refs[1]);
            PointHandle p = resolve_point(first_is_line ? refs[1] : refs[0], ctx);
            GCS::Line ln = l->line;
            GCS::Point pt = p.p;
            if (add) {
                sys.addConstraintP2LDistance(pt, l->line, value_param(), tag);
            }
            c.measure = [ln, pt] {
                const double dx = *ln.p2.x - *ln.p1.x, dy = *ln.p2.y - *ln.p1.y;
                const double len = std::sqrt(dx * dx + dy * dy);
                const double area = std::fabs(-*pt.x * dy + *pt.y * dx + *ln.p1.x * *ln.p2.y
                                              - *ln.p2.x * *ln.p1.y);
                return area / len;
            };
        }
        else {
            GCS::Point a = resolve_point(refs[0], ctx).p, b = resolve_point(refs[1], ctx).p;
            if (add) {
                sys.addConstraintP2PDistance(a, b, value_param(), tag);
            }
            c.measure = [a, b] { return point_distance(a, b); };
        }
    }
    else if (type == "length") {
        want(1, 1);
        require_positive();
        Entity* e = resolve_curve(refs[0], ctx);
        if (e->kind == Kind::Line) {
            GCS::Line ln = e->line;
            if (add) {
                sys.addConstraintP2PDistance(ln.p1, ln.p2, value_param(), tag);
            }
            c.measure = [ln] { return point_distance(ln.p1, ln.p2); };
        }
        else if (e->kind == Kind::Arc) {
            GCS::Arc arc = e->arc;
            if (add) {
                sys.addConstraintArcLength(e->arc, value_param(), tag);
            }
            c.measure = [arc] { return *arc.rad * normalize_span(*arc.endAngle - *arc.startAngle); };
        }
        else {
            fail(ctx + ": length needs a line or an arc");
        }
    }
    else if (type == "horizontal_distance" || type == "vertical_distance") {
        want(1, 2);
        const bool h = type == "horizontal_distance";
        GCS::Point a, b;
        if (refs.size() == 1) {
            Entity* l = line_of(refs[0]);
            a = l->line.p1;
            b = l->line.p2;
        }
        else {
            a = resolve_point(refs[0], ctx).p;
            b = resolve_point(refs[1], ctx).p;
        }
        double* pa = h ? a.x : a.y;
        double* pb = h ? b.x : b.y;
        if (add) {
            sys.addConstraintDifference(pa, pb, value_param(), tag);
        }
        c.measure = [pa, pb] { return *pb - *pa; };
    }
    else if (type == "angle") {
        want(1, 2);
        c.angular = true;
        if (refs.size() == 1) {
            GCS::Line ln = line_of(refs[0])->line;
            if (add) {
                sys.addConstraintP2PAngle(ln.p1, ln.p2, value_param(), tag);
            }
            c.measure = [ln] { return std::atan2(*ln.p2.y - *ln.p1.y, *ln.p2.x - *ln.p1.x); };
        }
        else {
            GCS::Line l1 = line_of(refs[0])->line, l2 = line_of(refs[1])->line;
            if (add) {
                sys.addConstraintL2LAngle(l1, l2, value_param(), tag);
            }
            c.measure = [l1, l2] {
                const double dx1 = *l1.p2.x - *l1.p1.x, dy1 = *l1.p2.y - *l1.p1.y;
                const double dx2 = *l2.p2.x - *l2.p1.x, dy2 = *l2.p2.y - *l2.p1.y;
                return std::atan2(dx1 * dy2 - dy1 * dx2, dx1 * dx2 + dy1 * dy2);
            };
        }
    }
    else if (type == "radius" || type == "diameter") {
        want(1, 1);
        require_positive();
        Entity* e = round_of(refs[0]);
        const bool diameter = type == "diameter";
        double* r = e->kind == Kind::Circle ? e->circle.rad : e->arc.rad;
        if (add) {
            if (e->kind == Kind::Circle) {
                diameter ? sys.addConstraintCircleDiameter(e->circle, value_param(), tag)
                         : sys.addConstraintCircleRadius(e->circle, value_param(), tag);
            }
            else {
                diameter ? sys.addConstraintArcDiameter(e->arc, value_param(), tag)
                         : sys.addConstraintArcRadius(e->arc, value_param(), tag);
            }
        }
        c.measure = [r, diameter] { return diameter ? 2.0 * *r : *r; };
    }
    else {
        fail(ctx + ": unknown constraint type " + quote_id(type));
    }
    if (j.contains("at") && type != "tangent" && type != "fix") {
        fail(ctx + ": \"at\" is only valid for tangent and fix");
    }
    if (c.driving) {
        g.tags.push_back(tag);
    }
    constraints_.push_back(std::move(c));
}

// ---------------------------------------------------------------------------------------------
// Diagnosis and solving
// ---------------------------------------------------------------------------------------------

std::vector<std::string> Sketch::tags_to_ids(std::vector<int> tags) const
{
    std::sort(tags.begin(), tags.end());
    std::vector<std::string> out;
    for (int t : tags) {
        if (t >= 1 && static_cast<std::size_t>(t) <= constraints_.size()) {
            out.push_back(constraints_[t - 1].id);
        }
    }
    return out;
}

// Sets the group's reference configuration to the current geometry and (re)diagnoses it when
// needed. Changing a dimension value never changes the Jacobian's structure, but whether a
// dependent constraint set is conflicting or merely redundant depends on the values, so a
// value change only triggers a new diagnosis if the last one found such a set.
void Sketch::prepare_group(Group& g, bool force_diagnosis)
{
    if (g.unknowns.empty()) {
        // Constraints between fixed geometry: satisfied means redundant, else conflicting.
        g.values_changed = false;
        g.dof = 0;
        g.conflicting.clear();
        g.redundant.clear();
        g.partially_redundant.clear();
        g.dependent.clear();
        g.all_free = false;
        for (int tag : g.tags) {
            const double err = g.sys.calculateConstraintErrorByTag(tag);
            if (std::isnan(err)) {
                continue;
            }
            (err * err > opts_.convergence ? g.conflicting : g.redundant).push_back(tag);
        }
        return;
    }
    if (force_diagnosis || (g.values_changed && g.has_problems())) {
        g.sys.invalidatedDiagnosis();
    }
    g.values_changed = false;
    g.sys.initSolution(kDiagnosisAlgorithm);  // reference := current geometry; diagnoses if needed
    g.dof = g.sys.dofsNumber();
    g.sys.getConflicting(g.conflicting);
    g.sys.getRedundant(g.redundant);
    g.sys.getPartiallyRedundant(g.partially_redundant);
    g.sys.getDependentParams(g.dependent);
    g.all_free = g.sys.isEmptyDiagnoseMatrix();
}

void Sketch::aggregate()
{
    dof_ = 0;
    std::vector<int> conflicting, redundant, partial;
    std::vector<char> dependent(arena_.size(), 0);
    for (const auto& gp : groups_) {
        const Group& g = *gp;
        dof_ += g.dof;
        conflicting.insert(conflicting.end(), g.conflicting.begin(), g.conflicting.end());
        redundant.insert(redundant.end(), g.redundant.begin(), g.redundant.end());
        partial.insert(partial.end(), g.partially_redundant.begin(), g.partially_redundant.end());
        for (double* p : g.dependent) {
            if (arena_.contains(p)) {
                dependent[arena_.index(p)] = 1;
            }
        }
    }
    conflicting_ = tags_to_ids(conflicting);
    redundant_ = tags_to_ids(redundant);
    partially_redundant_ = tags_to_ids(partial);
    for (std::size_t i = 0; i < entities_.size(); ++i) {
        const Entity& e = *entities_[i];
        char f = 0;
        if (e.group >= 0) {
            const bool all_free = groups_[e.group]->all_free;
            for (std::size_t k = e.pbegin; k < e.pend && !f; ++k) {
                f = !arena_.fixed(k) && (all_free || dependent[k]);
            }
        }
        free_[i] = f;
    }
}

bool Sketch::geometry_valid(const Group& g) const
{
    for (const double* p : g.unknowns) {
        if (!std::isfinite(*p)) {
            return false;
        }
    }
    for (std::size_t ei : g.entities) {
        const Entity& e = *entities_[ei];
        switch (e.kind) {
            case Kind::Circle:
                if (!(*e.circle.rad > 0.0)) {
                    return false;
                }
                break;
            case Kind::Arc:
                if (!(*e.arc.rad > 0.0)) {
                    return false;
                }
                break;
            case Kind::Ellipse:
                if (!(*e.ellipse.radmin > 0.0)) {
                    return false;
                }
                break;
            case Kind::EllipticalArc:
                if (!(*e.earc.radmin > 0.0)) {
                    return false;
                }
                break;
            default:
                break;
        }
    }
    return true;
}

bool Sketch::run_solvers(Group& g)
{
    const int attempts = opts_.fallback ? 3 : 1;
    for (int i = 0; i < attempts; ++i) {
        // System::solve() first resets every parameter to the reference configuration, so each
        // attempt starts from the same state.
        if (g.sys.solve(true, kAlgorithms[i].first) == GCS::Success) {
            g.sys.applySolution();
            if (geometry_valid(g)) {
                g.algorithm = i;
                return true;
            }
            g.sys.undoSolution();
        }
    }
    g.algorithm = -1;
    return false;
}

void Sketch::solve_now()
{
    end_drag();
    std::vector<double> backup(arena_.size());
    for (std::size_t i = 0; i < backup.size(); ++i) {
        backup[i] = *arena_.at(i);
    }
    bool ok = true, conflict = false;
    algorithm_ = -1;
    for (auto& gp : groups_) {
        Group& g = *gp;
        prepare_group(g, false);
        if (g.unknowns.empty()) {
            conflict |= !g.conflicting.empty();
            ok &= g.conflicting.empty();
            continue;
        }
        const bool suspicious = g.has_problems();
        bool solved = run_solvers(g);
        if (solved && suspicious) {
            // The diagnosis ran on unsolved geometry, where a redundant set can be mistaken for
            // a conflicting one (planegcs re-solves without the suspects from that state). The
            // solution satisfies every constraint: diagnose again there.
            const int alg = g.algorithm;
            prepare_group(g, true);
            g.algorithm = alg;
        }
        if (!g.conflicting.empty()) {
            conflict = true;
            solved = false;
        }
        ok &= solved;
        if (solved) {
            algorithm_ = std::max(algorithm_, g.algorithm);
        }
    }
    if (!ok) {
        // All or nothing: a failed solve leaves the input geometry untouched.
        for (std::size_t i = 0; i < backup.size(); ++i) {
            *arena_.at(i) = backup[i];
        }
        algorithm_ = -1;
    }
    aggregate();
    solved_ok_ = ok;
    message_ = ok ? "" : (conflict ? "conflicting constraints" : "solver did not converge");
}

void Sketch::diagnose_now()
{
    end_drag();
    for (auto& gp : groups_) {
        prepare_group(*gp, true);
    }
    aggregate();
    if (!conflicting_.empty()) {
        message_ = "conflicting constraints";
    }
}

void Sketch::set_value(const std::string& constraint_id, double value)
{
    auto it = constraint_index_.find(constraint_id);
    if (it == constraint_index_.end()) {
        fail("set_value: unknown constraint " + quote_id(constraint_id));
    }
    Constraint& c = constraints_[it->second];
    if (!c.dimensional) {
        fail("set_value: constraint " + quote_id(c.id) + " (" + c.type + ") has no value");
    }
    if (!c.driving || !c.value_param) {
        fail("set_value: constraint " + quote_id(c.id) + " is a reference dimension");
    }
    if (!std::isfinite(value) || (c.positive && !(value > 0.0))) {
        fail("set_value: invalid value for constraint " + quote_id(c.id));
    }
    if (*c.value_param != value) {
        *c.value_param = value;
        groups_[constraint_group_[it->second]]->values_changed = true;
    }
}

// ---------------------------------------------------------------------------------------------
// Dragging (temporary constraints, tag -1)
// ---------------------------------------------------------------------------------------------

void Sketch::end_drag()
{
    if (drag_) {
        if (drag_->group >= 0) {
            groups_[drag_->group]->sys.clearByTag(kTempTag);
        }
        drag_.reset();
    }
}

double* Sketch::move_param(double value, MoveSlot::Mode mode)
{
    if (moves_.size() == moves_.capacity()) {
        throw std::logic_error("steve_sketch: drag parameter capacity exceeded");
    }
    moves_.push_back(value);
    drag_->slots.push_back({mode, value});
    return &moves_.back();
}

void Sketch::begin_drag(const std::string& ref, double x, double y)
{
    end_drag();
    Entity* e = curve_or_null(ref);
    std::optional<PointHandle> point;
    if (!e) {
        point = resolve_point(ref, "drag");
    }
    Entity* owner = e ? e : point->owner;
    drag_.emplace();
    drag_->ref = ref;
    drag_->ax = x;
    drag_->ay = y;
    drag_->group = owner && !owner->external ? owner->group : -1;
    if (drag_->group < 0) {
        return;  // fixed geometry: every frame reports failure
    }
    Group& g = *groups_[drag_->group];
    moves_.clear();
    moves_.reserve(8 + (e && e->kind == Kind::BSpline ? 2 * e->num_poles : 0));

    using M = MoveSlot::Mode;
    auto hold_center = [&](GCS::Point center) {
        GCS::Point h(move_param(*center.x, M::Hold), move_param(*center.y, M::Hold));
        int i = g.sys.addConstraintP2PCoincident(h, center, kTempTag);
        g.sys.rescaleConstraint(i - 1, 0.01);
        g.sys.rescaleConstraint(i, 0.01);
    };
    auto follow = [&](GCS::Point target, M mx, M my) {
        GCS::Point m(move_param(*target.x, mx), move_param(*target.y, my));
        g.sys.addConstraintP2PCoincident(m, target, kTempTag);
    };

    if (point) {
        follow(point->p, M::AbsX, M::AbsY);
        if ((point->role == PointRole::Start || point->role == PointRole::End)
            && (owner->kind == Kind::Arc || owner->kind == Kind::EllipticalArc)) {
            hold_center(owner->center_point());
        }
    }
    else {
        switch (e->kind) {
            case Kind::Line:
                follow(e->line.p1, M::RelX, M::RelY);
                follow(e->line.p2, M::RelX, M::RelY);
                break;
            case Kind::Circle:
            case Kind::Arc: {
                GCS::Point rim(move_param(x, M::AbsX), move_param(y, M::AbsY));
                if (e->kind == Kind::Circle) {
                    g.sys.addConstraintPointOnCircle(rim, e->circle, kTempTag);
                }
                else {
                    g.sys.addConstraintPointOnArc(rim, e->arc, kTempTag);
                }
                hold_center(e->center_point());
                break;
            }
            case Kind::Ellipse:
            case Kind::EllipticalArc:
                follow(e->center_point(), M::RelX, M::RelY);
                break;
            case Kind::BSpline:
                for (auto& pole : e->bsp.poles) {
                    follow(pole, M::RelX, M::RelY);
                }
                break;
            case Kind::Point:
                break;
        }
    }
    drag_->last = moves_;
    prepare_group(g, false);  // reference := current geometry (diagnosis is cached)
    aggregate();
}

// One SQP solve towards `targets`; on success the result becomes the next reference.
bool Sketch::drag_step(Group& g, const std::vector<double>& targets)
{
    std::copy(targets.begin(), targets.end(), moves_.begin());  // in place: no reallocation
    // The SQP stops once the hard constraints hold (sum of squares <= 1e-20) and its last step
    // is below `convergence`; a drag frame does not need the 1e-10 polish of a full solve.
    const double convergence = g.sys.convergence;
    g.sys.convergence = std::max(convergence, opts_.drag_convergence);
    const int status = g.sys.solve(true, GCS::DogLeg);
    g.sys.convergence = convergence;
    if (status != GCS::Success) {
        return false;
    }
    g.sys.applySolution();
    if (!geometry_valid(g)) {
        g.sys.undoSolution();
        return false;
    }
    g.sys.rebaseReference();
    drag_->last = targets;
    return true;
}

json Sketch::drag(const std::string& ref, double x, double y)
{
    if (!std::isfinite(x) || !std::isfinite(y)) {
        fail("drag: coordinates must be finite");
    }
    if (!drag_ || drag_->ref != ref) {
        begin_drag(ref, x, y);
    }
    const char* message = nullptr;
    if (drag_->group < 0) {
        message = "fixed geometry cannot be dragged";
    }
    else if (!groups_[drag_->group]->conflicting.empty()) {
        message = "conflicting constraints";
    }
    else {
        Group& g = *groups_[drag_->group];
        std::vector<double> targets(moves_.size());
        for (std::size_t i = 0; i < drag_->slots.size(); ++i) {
            const MoveSlot& s = drag_->slots[i];
            switch (s.mode) {
                case MoveSlot::AbsX:
                    targets[i] = x;
                    break;
                case MoveSlot::AbsY:
                    targets[i] = y;
                    break;
                case MoveSlot::RelX:
                    targets[i] = s.init + (x - drag_->ax);
                    break;
                case MoveSlot::RelY:
                    targets[i] = s.init + (y - drag_->ay);
                    break;
                case MoveSlot::Hold:
                    targets[i] = s.init;
                    break;
            }
        }
        // Hard constraints (tag >= 0) and the soft drag targets (tag -1) are solved together by
        // planegcs' SQP; components of the group without drag targets use DogLeg. The SQP can
        // stall on large jumps near singular configurations: then approach the target from the
        // last solved frame in sub-steps and keep the furthest valid one.
        bool moved = drag_step(g, targets);
        for (int n : {4, 16}) {
            if (moved) {
                break;
            }
            const std::vector<double> from = drag_->last;
            std::vector<double> t(targets.size());
            for (int k = 1; k <= n; ++k) {
                const double f = static_cast<double>(k) / n;
                for (std::size_t i = 0; i < t.size(); ++i) {
                    t[i] = from[i] + (targets[i] - from[i]) * f;
                }
                if (!drag_step(g, t)) {
                    break;
                }
                moved = true;
            }
        }
        if (!moved) {
            message = "solver did not converge";
        }
    }
    json r = json::object();
    r["status"] = message ? "failed" : "ok";
    r["entities"] = entities_json();
    if (message) {
        r["message"] = message;
    }
    return r;
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

json Sketch::entity_json(const Entity& e) const
{
    if (e.external) {
        return e.source;  // fixed geometry is echoed exactly
    }
    json out = e.source;
    switch (e.kind) {
        case Kind::Point:
            out["at"] = vec2_json(e.pt);
            break;
        case Kind::Line:
            out["start"] = vec2_json(e.line.p1);
            out["end"] = vec2_json(e.line.p2);
            break;
        case Kind::Circle:
            out["center"] = vec2_json(e.circle.center);
            out["radius"] = *e.circle.rad;
            break;
        case Kind::Arc: {
            const double a0 = wrap_pi(*e.arc.startAngle);
            out["center"] = vec2_json(e.arc.center);
            out["radius"] = *e.arc.rad;
            out["start_angle"] = a0;
            out["end_angle"] = a0 + normalize_span(*e.arc.endAngle - *e.arc.startAngle);
            break;
        }
        case Kind::Ellipse:
        case Kind::EllipticalArc: {
            const GCS::Ellipse& el = e.kind == Kind::Ellipse ? e.ellipse : e.earc;
            const double fx = *el.focus1.x - *el.center.x, fy = *el.focus1.y - *el.center.y;
            out["center"] = vec2_json(el.center);
            out["major_radius"] = el.getRadMaj();
            out["minor_radius"] = *el.radmin;
            out["rotation"] = (fx != 0.0 || fy != 0.0) ? std::atan2(fy, fx) : e.rotation_hint;
            if (e.kind == Kind::EllipticalArc) {
                const double u0 = wrap_pi(*e.earc.startAngle);
                out["start_angle"] = u0;
                out["end_angle"] = u0 + normalize_span(*e.earc.endAngle - *e.earc.startAngle);
            }
            break;
        }
        case Kind::BSpline: {
            json poles = json::array();
            for (const GCS::Point& p : e.bsp.poles) {
                poles.push_back(vec2_json(p));
            }
            out["poles"] = std::move(poles);
            break;
        }
    }
    return out;
}

json Sketch::entities_json() const
{
    json out = json::array();
    for (const auto& e : entities_) {
        if (!e->builtin) {
            out.push_back(entity_json(*e));
        }
    }
    return out;
}

json Sketch::result() const
{
    const bool ok = solved_ok_ && conflicting_.empty();
    json r = json::object();
    r["status"] = ok ? "ok" : "failed";
    r["dof"] = dof_;
    r["conflicting"] = conflicting_;
    r["redundant"] = redundant_;
    r["partially_redundant"] = partially_redundant_;
    r["entities"] = entities_json();
    json free = json::object();
    for (std::size_t i = 0; i < entities_.size(); ++i) {
        if (!entities_[i]->builtin) {
            free[entities_[i]->id] = free_[i] != 0;
        }
    }
    r["free"] = std::move(free);
    json values = json::object();
    for (const Constraint& c : constraints_) {
        if (!c.dimensional || !c.measure) {
            continue;
        }
        double m = c.measure();
        if (c.angular) {
            m = wrap_near(m, c.value_param ? *c.value_param : c.hint);
        }
        values[c.id] = m;
    }
    r["values"] = std::move(values);
    r["algorithm"] = ok && algorithm_ >= 0 ? json(kAlgorithms[algorithm_].second) : json(nullptr);
    if (!ok) {
        r["message"] = message_.empty() ? "conflicting constraints" : message_;
    }
    return r;
}

std::string dump(const json& j)
{
    return j.dump(-1, ' ', false, json::error_handler_t::replace);
}

}  // namespace

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

const char* version()
{
    return "steve-sketch " STEVE_SKETCH_VERSION
           " (planegcs FreeCAD 5f8eac49f316, Eigen 3.4.0, nlohmann/json 3.12.0)";
}

std::string solve(const std::string& sketch_json, const std::string& options_json)
{
    Sketch sketch(sketch_json, parse_options(options_json));
    sketch.solve_now();
    return dump(sketch.result());
}

struct Session::Impl
{
    Impl(const std::string& sketch_json, const std::string& options_json)
        : sketch(sketch_json, parse_options(options_json))
    {}
    Sketch sketch;
};

Session::Session(const std::string& sketch_json, const std::string& options_json)
    : impl_(std::make_unique<Impl>(sketch_json, options_json))
{
    impl_->sketch.solve_now();
}

Session::~Session() = default;

std::string Session::drag(const std::string& ref, double x, double y)
{
    return dump(impl_->sketch.drag(ref, x, y));
}

std::string Session::end_drag()
{
    impl_->sketch.end_drag();
    return snapshot();
}

void Session::set_value(const std::string& constraint_id, double value)
{
    impl_->sketch.set_value(constraint_id, value);
}

std::string Session::solve()
{
    impl_->sketch.solve_now();
    return snapshot();
}

std::string Session::diagnose()
{
    impl_->sketch.diagnose_now();
    return snapshot();
}

std::string Session::snapshot() const
{
    return dump(impl_->sketch.result());
}

}  // namespace steve_sketch
