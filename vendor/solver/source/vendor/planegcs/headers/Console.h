// Portable replacement for FreeCAD's <Base/Console.h>, used by planegcs/GCS.cpp.
//
// Written for STEVE (2026-09-30); replaces the Emscripten-only version shipped by
// github.com/Salusoft89/planegcs. Solver diagnostics are discarded by default so that the
// native and WebAssembly builds behave identically and never write to stdout. Define
// STEVE_PLANEGCS_LOG at compile time to route them to stderr while debugging.
//
// This file is part of the modified planegcs library and is distributed under the terms of
// the GNU Lesser General Public License version 2.1 or later (see ../LICENSE).
#ifndef STEVE_PLANEGCS_CONSOLE_H
#define STEVE_PLANEGCS_CONSOLE_H

#include <cstdarg>
#include <cstdio>

class Console
{
public:
    static void Log(const char* format, ...)
    {
#ifdef STEVE_PLANEGCS_LOG
        va_list args;
        va_start(args, format);
        std::vfprintf(stderr, format, args);
        va_end(args);
#else
        (void)format;
#endif
    }
};

#endif  // STEVE_PLANEGCS_CONSOLE_H
