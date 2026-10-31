#!/usr/bin/env bash
# Builds the WebAssembly solver into web/src/sketch/solver/steve-sketch.{mjs,wasm}.
#
# Emscripten runs in Docker (solver/Dockerfile.wasm, emsdk 6.0.10 pinned by digest), compiling the
# same sources and core flags (solver/cflags.txt) as the Python module. The generated glue is
# checked for dynamic code evaluation (eval / new Function) so the page can keep a strict CSP
# without 'unsafe-eval'.
#
# Usage: solver/build-wasm.sh            (requires Docker; ~1-2 minutes)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
image="steve-sketch-wasm-builder:emsdk-6.0.10"
out_rel="web/src/sketch/solver"

docker build --quiet -t "$image" -f "$here/Dockerfile.wasm" "$here" >/dev/null

core_flags="$(grep -v '^[[:space:]]*#' "$here/cflags.txt" | tr '\n' ' ')"
musl_flags="$(grep -v '^[[:space:]]*#' "$here/cflags-musl.txt" | tr '\n' ' ')"

docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$root:/src" -w /src "$image" bash -euo pipefail -c "
  obj=\$(mktemp -d)
  inc='-Isolver/src -Isolver/vendor -Isolver/vendor/planegcs -Isolver/vendor/planegcs/headers -I/usr/include/eigen3 -I/opt/boost-include'
  cflags='$core_flags -fwasm-exceptions'
  for src in solver/vendor/planegcs/GCS.cpp solver/vendor/planegcs/Geo.cpp \
             solver/vendor/planegcs/Constraints.cpp solver/vendor/planegcs/SubSystem.cpp \
             solver/vendor/planegcs/qp_eq.cpp solver/src/steve_sketch.cpp \
             solver/wasm/steve_sketch_wasm.cpp; do
    em++ \$cflags \$inc -c \"\$src\" -o \"\$obj/\$(basename \"\$src\" .cpp).o\" &
    pids=\"\${pids:-} \$!\"
  done
  for src in solver/vendor/musl-math/*.c; do
    emcc $musl_flags -Isolver/vendor/musl-math -c \"\$src\" -o \"\$obj/musl_\$(basename \"\$src\" .c).o\" &
    pids=\"\$pids \$!\"
  done
  for pid in \$pids; do wait \$pid; done
  em++ -O3 -fwasm-exceptions \"\$obj\"/*.o -o $out_rel/steve-sketch.mjs \
    --no-entry \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createSteveSketch \
    -sENVIRONMENT=web,worker,node \
    -sDYNAMIC_EXECUTION=0 \
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16MB -sMAXIMUM_MEMORY=2GB -sSTACK_SIZE=1MB \
    -sFILESYSTEM=0 -sTEXTDECODER=2 \
    -sINCOMING_MODULE_JS_API=locateFile,wasmBinary,instantiateWasm,print,printErr \
    -sEXPORTED_FUNCTIONS=_malloc,_free,_steve_version,_steve_last_error,_steve_last_error_kind,_steve_solve,_steve_session_new,_steve_session_free,_steve_session_drag,_steve_session_end_drag,_steve_session_set_value,_steve_session_solve,_steve_session_diagnose,_steve_session_snapshot,_steve_memory_stats \
    -sEXPORTED_RUNTIME_METHODS=UTF8ToString,stringToUTF8,lengthBytesUTF8
  rm -rf \"\$obj\"
  em++ --version | head -1
"

glue="$root/$out_rel/steve-sketch.mjs"
wasm="$root/$out_rel/steve-sketch.wasm"

# The Node branch of the glue imports node:module; hide that specifier from bundlers so browser
# builds (Vite) do not warn about externalizing a Node built-in. Behaviour is unchanged.
node_import='await import("node:module")'
if [[ "$(grep -o "$node_import" "$glue" | wc -l)" != 1 ]]; then
  echo "error: expected exactly one $node_import in the glue" >&2
  exit 1
fi
sed -i 's|await import("node:module")|await import(/* @vite-ignore */ ["node", "module"].join(":"))|' "$glue"

# No dynamic code evaluation in the glue (CSP without 'unsafe-eval').
if grep -nE '(^|[^A-Za-z0-9_$.])eval\(|new Function|[^A-Za-z0-9_$]Function\(' "$glue"; then
  echo "error: generated glue uses eval/Function" >&2
  exit 1
fi

printf '%-22s %9s %9s\n' file bytes gzip
for f in "$glue" "$wasm"; do
  printf '%-22s %9d %9d\n' "$(basename "$f")" "$(wc -c <"$f")" "$(gzip -9 -c "$f" | wc -c)"
done
