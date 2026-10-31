/* Shim for musl's internal <features.h> (STEVE, 2026-09-30): pulls in the platform's public
 * features.h (glibc or Emscripten's musl) and adds the `hidden` visibility macro that musl's
 * libm sources expect. See solver/NOTICE. */
#ifndef STEVE_MUSL_FEATURES_H
#define STEVE_MUSL_FEATURES_H
#include_next <features.h>
#ifndef hidden
#define hidden __attribute__((__visibility__("hidden")))
#endif
#endif
