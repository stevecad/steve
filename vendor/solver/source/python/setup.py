"""Build the `steve_sketch` CPython extension from the shared C++ core.

Build a wheel from the repository root (in-tree build; the sources live in solver/src and
solver/vendor, one level above this directory):

    pip wheel --no-deps -w dist solver/python

Needs a C++20 compiler plus the Eigen 3.4.0 and Boost (graph) headers, e.g. on Debian/Ubuntu:
`apt-get install g++ libeigen3-dev libboost-dev`. EIGEN3_INCLUDE_DIR overrides the Eigen path.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from pybind11.setup_helpers import ParallelCompile, Pybind11Extension, build_ext
from setuptools import setup

# Compile the translation units in parallel (STEVE_BUILD_JOBS overrides the CPU count).
ParallelCompile("STEVE_BUILD_JOBS").install()

HERE = Path(__file__).resolve().parent
SOLVER = HERE.parent
VERSION = "0.1.0"


def rel(path: Path) -> str:
    return os.path.relpath(path, HERE)


def flags(name: str) -> list[str]:
    return [
        line.strip()
        for line in (SOLVER / name).read_text().splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]


# Same flags as the WebAssembly build (parity depends on it).
core_flags = flags("cflags.txt")
musl_flags = flags("cflags-musl.txt") + ["-fPIC"]

# License texts shipped inside the wheel (LGPL obligations: see solver/README.md).
licenses = HERE / "LICENSES"
licenses.mkdir(exist_ok=True)
shutil.copyfile(SOLVER / "vendor/planegcs/LICENSE", licenses / "LGPL-2.1.txt")
shutil.copyfile(SOLVER / "vendor/nlohmann/LICENSE.MIT", licenses / "nlohmann-json-MIT.txt")
shutil.copyfile(SOLVER / "vendor/musl-math/COPYRIGHT", licenses / "musl-MIT.txt")
shutil.copyfile(SOLVER / "NOTICE", licenses / "NOTICE.txt")

planegcs = SOLVER / "vendor" / "planegcs"
musl = SOLVER / "vendor" / "musl-math"

# musl's sin/cos/atan/atan2/pow (hidden symbols) so results match the WebAssembly build bit for
# bit; linked into the extension by build_ext.
musl_math = (
    "steve_musl_math",
    {
        "sources": sorted(rel(p) for p in musl.glob("*.c")),
        "include_dirs": [rel(musl)],
        "cflags": musl_flags,
    },
)
sources = [HERE / "steve_sketch_module.cpp", SOLVER / "src" / "steve_sketch.cpp"] + [
    planegcs / f"{name}.cpp" for name in ("GCS", "Geo", "Constraints", "SubSystem", "qp_eq")
]

ext = Pybind11Extension(
    "steve_sketch",
    sources=[rel(p) for p in sources],
    include_dirs=[
        rel(SOLVER / "src"),
        rel(SOLVER / "vendor"),
        rel(planegcs),
        rel(planegcs / "headers"),
        os.environ.get("EIGEN3_INCLUDE_DIR", "/usr/include/eigen3"),
    ],
    define_macros=[("STEVE_SKETCH_PY_VERSION", f'"{VERSION}"')],
    extra_compile_args=core_flags,
    cxx_std=20,
)

setup(libraries=[musl_math], ext_modules=[ext], cmdclass={"build_ext": build_ext}, zip_safe=False)
