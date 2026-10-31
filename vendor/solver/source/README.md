# STEVE sketch solver

FreeCAD's **planegcs** 2D constraint solver behind the *Solver JSON* contract of
[docs/MODELING.md §2](../docs/MODELING.md#solver-json-shared-by-browser-and-server-mm-radians).
One C++ core (`src/steve_sketch.cpp`) is compiled twice from the same sources and flags:

| Target | Output | Used by |
|---|---|---|
| WebAssembly (Emscripten 6.0.10) | `web/src/sketch/solver/steve-sketch.{mjs,wasm}` + typed wrapper `index.ts` | browser main thread / Web Worker, drag sessions; Node tests |
| CPython 3.12 extension | wheel `steve_sketch-0.1.0-cp312-cp312-linux_x86_64.whl` | server (runtime image) |

Both builds produce **bit-identical** results (see *Parity* below).

```
solver/
  src/steve_sketch.{h,cpp}   core: JSON parsing, deterministic GCS construction, solve, sessions
  wasm/steve_sketch_wasm.cpp minimal C API for the WebAssembly module (no embind, no eval)
  python/                    pybind11 module + setuptools packaging (pyproject.toml, setup.py)
  vendor/planegcs/           FreeCAD planegcs (LGPL-2.1+), pinned snapshot, see NOTICE
  vendor/musl-math/          musl libm subset (MIT): sin/cos/atan/atan2/pow for both builds
  vendor/nlohmann/           nlohmann/json 3.12.0 (MIT)
  cflags.txt, cflags-musl.txt  compile flags shared by both builds
  build-wasm.sh, Dockerfile.wasm   WebAssembly build (Docker)
  Dockerfile.stage           multi-stage snippet for runtime/Dockerfile (wheel)
  NOTICE                     provenance, modifications, third-party licenses
```

## Building

**WebAssembly** (needs Docker; ~30 s): `solver/build-wasm.sh`. It builds a pinned builder image
(`Dockerfile.wasm`: `emscripten/emsdk:6.0.10@sha256:e077d54e…`, Eigen 3.4.0, Boost headers), compiles
with `-O3 -fwasm-exceptions` and links with `MODULARIZE EXPORT_ES6 ENVIRONMENT=web,worker,node
ALLOW_MEMORY_GROWTH=1 (16 MiB initial, 2 GiB max) DYNAMIC_EXECUTION=0 FILESYSTEM=0`, then fails if the
glue contains `eval`/`new Function` and prints sizes. The artifacts are committed:

| file | bytes | gzip -9 |
|---|---:|---:|
| `steve-sketch.wasm` | 556,303 | 199,557 |
| `steve-sketch.mjs` (glue) | 9,711 | 3,335 |

CSP: no `unsafe-eval`; WebAssembly compilation needs `script-src 'wasm-unsafe-eval'` (verified in
headless Chromium with `script-src 'self' 'wasm-unsafe-eval'`, main thread and module worker).
With Vite the `.wasm` is emitted as a hashed asset automatically (`new URL(…, import.meta.url)`).

**Python**: `pip wheel --no-deps -w dist solver/python` (in-tree build; needs `g++`,
`libeigen3-dev`, `libboost-dev`). For the runtime image use the stage in `Dockerfile.stage`
(`FROM python:3.12-slim AS sketch-solver`, builds and smoke-tests the wheel) and add to the runtime
stage, before `USER`:

```dockerfile
COPY --from=sketch-solver /wheels/ /tmp/sketch-wheels/
RUN pip install --no-cache-dir /tmp/sketch-wheels/steve_sketch-*.whl && rm -rf /tmp/sketch-wheels
```

Eigen must be 3.4.0 on both sides (a `static_assert` enforces it): Debian trixie and Ubuntu 24.04 both
ship it.

## API

All calls take and return JSON (the contract is MODELING.md §2). Result:
`{status, dof, conflicting, redundant, partially_redundant, entities, free, values, algorithm, message?}`
— `status` is `"failed"` when constraints conflict or no algorithm converged (geometry is then
returned unchanged), `free[id]` is true while any parameter of the entity is undetermined
(planegcs dependent parameters), `values` holds the measured value of every dimensional constraint
(driving and reference; mm, radians), `algorithm` is the most robust algorithm that was needed.

Options (all optional): `max_iterations` (100), `convergence` (1e-10), `fallback` (true: DogLeg →
Levenberg-Marquardt → BFGS), `qr` (`"sparse"`|`"dense"`, diagnosis), `drag_convergence` (1e-5 mm).
Contract violations raise an input error (`SketchInputError`, a `ValueError`, in Python;
`SolverInputError` in TypeScript) with a message naming the entity/constraint.

**TypeScript** (`web/src/sketch/solver/index.ts`, framework-free, main thread / Web Worker / Node):

```ts
import { loadSolver, solve } from './sketch/solver';
const solver = await loadSolver();             // cached; loadSolver({wasmUrl}|{wasmBinary}) to override
const result = solver.solve(sketch, options);  // or module-level solve(sketch) once loaded
const session = solver.createSession(sketch);  // builds + diagnoses + solves once
session.drag('l1.end', x, y);                  // per pointer move -> {status, entities, message?}
session.endDrag();                             // -> full result
session.setValue('w', 70); session.solve();    // dimension edit without rebuilding
session.diagnose(); session.snapshot(); session.dispose();
```

**Python**: `steve_sketch.solve(sketch_json, options_json="{}") -> str`,
`steve_sketch.Session(sketch_json, options_json="{}")` with `drag(ref, x, y)`, `end_drag()`,
`set_value(id, value)`, `solve()`, `diagnose()`, `snapshot()` (JSON strings; the GIL is released
while solving; one session per thread). **C++**: `solver/src/steve_sketch.h` (same shape).
**WebAssembly C API**: `solver/wasm/steve_sketch_wasm.cpp` (`steve_solve`, `steve_session_*`,
`steve_last_error[_kind]`, `steve_memory_stats`).

### Semantics worth knowing

- **Drag** (FreeCAD's mechanism): the first `drag(ref, …)` of a gesture adds temporary tag −1
  constraints to the ref's constraint group and re-initialises that group only; later frames just
  update the target parameters in place and run planegcs' SQP (hard constraints exact, targets
  soft), starting from the previous frame. Point refs follow the cursor (arc end points also hold
  the centre softly); circle/arc ids pull the rim through the cursor; line/ellipse/bspline ids
  translate with the cursor motion since the gesture's first call. If a frame stalls it is retried
  in 4 then 16 sub-steps from the last solved frame. `status: "failed"` = geometry kept at the
  previous frame. Frames stop at `drag_convergence` (step size) instead of the 1e-10 polish.
- **Groups**: entities linked by constraints form independent groups, each its own `GCS::System`
  (mathematically identical to one system). Diagnosis and drags only touch the affected group:
  a 320-entity sketch of 64 independent cells solves in 20 ms instead of 600 ms.
- **Diagnosis** runs before solving (DOF, conflicting/redundant, free params). planegcs classifies a
  dependent set by re-solving without the suspects from the *current* geometry, which misfires on
  far-from-solved input; if the first diagnosis reports problems and the solve still succeeds, the
  group is re-diagnosed at the solution. Redundant-but-consistent sketches solve (`status: "ok"`).
- **Tangent `at`**: the point where the curves touch (endpoint tangency via angle_via_point). If
  `at` is not already on a curve (its own end point, or coincident with one through `coincident`
  constraints) a point-on constraint is added under the same id; co-/counter-directed tangency is
  auto-detected from the input geometry (FreeCAD rule). B-spline tangency must be at the spline's
  start/end.
- **Arcs** come back normalised: `start_angle ∈ (−π, π]`, `end_angle ∈ (start, start + 2π]`.
  Ellipses need `major_radius > minor_radius`; elliptical-arc angles are parametric angles from the
  major axis. B-splines: non-rational uniform clamped by default; optional `weights`, `knots` +
  `multiplicities`; `.start/.end` exist for clamped splines, `.pole<i>` always.
- `fix` pins a point (`value` or its alias `at`: `[x, y]`, default: current position) or all
  defining parameters of an entity. External entities are fixed and echoed unchanged. Reference
  dimensions (`driving: false`) are measured only; angles are reported on the branch nearest their
  `value`.

### Deterministic construction

Documented at the top of `src/steve_sketch.cpp`: one parameter arena in a fixed order (planegcs
orders parameters by pointer, so this fixes that order on every platform), groups by first entity,
internal arc rules (tag 0) then constraints (tag = index + 1), Eigen cache sizes pinned (GEMM
blocking), scalar Eigen (no vectorisation), `-ffp-contract=off`, and the musl implementations of
`sin/cos/atan/atan2/pow` compiled into both builds (`-fno-builtin-*` so compilers neither fold nor
fuse them).

## Tests (`tests/solver/`)

| command | what |
|---|---|
| `python3 tests/solver/make_fixtures.py` | regenerates the 16 JSON fixtures (+ scripted session steps) |
| `tests/solver/run_parity.sh [--build]` | every fixture, session script and 19 error cases through the Python wheel (throwaway image `steve-sketch-test:local` = `steve-cad-runtime:0.2` + wheel) and the WebAssembly build (Node ≥ 22); expectations + parity at 1e-9 |
| `node tests/solver/drag_bench.mjs` | drag frame times at 20/50/100 entities vs the 16.7 ms budget |
| `node tests/solver/memory.mjs` | 330-entity sketch and a connected 300-line chain; 2,000 create/drag/solve/dispose cycles without growth |

Results (2026-09-30, Node 24.21, x86-64): parity **5,365/5,365 numbers bit-identical** (16 fixtures,
55 session steps incl. drags, identical messages for 19 error cases). Drag, mean (p95) ms/frame in
WebAssembly, 120 frames:

| sketch | 20 entities | 50 | 100 |
|---|---:|---:|---:|
| open chain, every line free to rotate (all move each frame) | 1.1 (1.4) | 10.0 (14.8) | 66 (87) |
| N/4 dimensioned rectangles, one dragged (typical) | 0.12 (0.16) | 0.34 (0.37) | 0.57 (0.67) |

The 100-line free chain misses the 16.7 ms budget: planegcs' SQP is dense, O(n³) in the size of the
dragged group. Memory: a 330-entity sketch solves in 59 ms, a single connected 300-line chain
(1,200 unknowns) in 1.4 s with linear memory growing 16 → 25 MiB; 2,000 create/drag/solve/dispose
cycles leave malloc'd bytes and linear memory unchanged.

## Updating planegcs

Replace `vendor/planegcs/*` with the new FreeCAD `src/Mod/Sketcher/App/planegcs` files, re-apply
the changes listed in `NOTICE` (each changed file has a `MODIFIED FILE` header), update the commit
ids in `NOTICE` and `version()`, rebuild both targets and run `tests/solver/run_parity.sh --build`.

## Licensing: shipping LGPL code in a web app

planegcs is LGPL (2.0-or-later headers; used under **LGPL-2.1**, text in `vendor/planegcs/LICENSE`).
The core and bindings in this directory link it statically and are therefore distributed under the
same LGPL-2.1-or-later terms; the rest of STEVE only *uses* the library through the separate
`steve-sketch.wasm` / `steve_sketch` module and its JSON interface. To stay compliant:

1. **Keep it a separate, replaceable module.** Load `steve-sketch.wasm` as its own file (never
   inline it into a JS bundle or use Emscripten `SINGLE_FILE`), don't obfuscate it or pin it with an
   integrity check that would stop a user from substituting a rebuilt module with the same C API.
   The same applies to the Python extension in the runtime image.
2. **Offer the complete corresponding source** of the shipped module: `solver/` (sources, vendored
   libraries, `build-wasm.sh`, `Dockerfile.wasm`, `cflags*.txt`) at the exact commit that was
   built — e.g. a link from the app's About/licenses page to the repository tag, or an equivalent
   written offer valid for three years.
3. **Show the notices.** The licenses page must state that STEVE uses planegcs (FreeCAD) under the
   LGPL-2.1, include the LGPL-2.1 text, and list the other components with their licenses
   (`NOTICE`): nlohmann/json (MIT), musl libm (MIT), Eigen (MPL-2.0: say where its source is
   available, e.g. eigen.tuxfamily.org 3.4.0), Boost (BSL-1.0), Emscripten runtime (MIT/NCSA).
   The Python wheel carries `LICENSES/` inside its `.dist-info`.
4. **Mark modifications.** Changed planegcs files carry a dated `MODIFIED FILE` header and are
   listed in `NOTICE`; keep doing that for future changes.
