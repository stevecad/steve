// Minimal C API over the STEVE sketch solver core for the WebAssembly build (no embind, so the
// generated glue needs no eval / new Function). Used by web/src/sketch/solver/index.ts.
//
// Strings are UTF-8 and NUL-terminated. Functions returning `const char*` return JSON owned by
// the module and valid until the next call; NULL means failure, with the message available from
// steve_last_error() and its kind from steve_last_error_kind() (1 = invalid input, 2 = internal).
//
// Copyright (C) 2026 STEVE contributors. LGPL-2.1-or-later (links planegcs); see solver/NOTICE.
#include <emscripten/emscripten.h>
#include <malloc.h>

#include <map>
#include <memory>
#include <new>
#include <string>

#include "steve_sketch.h"

namespace
{

std::string g_result;
std::string g_error;
int g_error_kind = 0;
std::map<int, std::unique_ptr<steve_sketch::Session>> g_sessions;
int g_next_handle = 1;

template<typename F>
bool guarded(F&& f)
{
    try {
        f();
        g_error.clear();
        g_error_kind = 0;
        return true;
    }
    catch (const steve_sketch::InputError& e) {
        g_error = e.what();
        g_error_kind = 1;
    }
    catch (const std::bad_alloc&) {
        g_error = "out of memory";
        g_error_kind = 2;
    }
    catch (const std::exception& e) {
        g_error = e.what();
        g_error_kind = 2;
    }
    return false;
}

template<typename F>
const char* returning_json(F&& f)
{
    return guarded([&] { g_result = f(); }) ? g_result.c_str() : nullptr;
}

steve_sketch::Session& session(int handle)
{
    auto it = g_sessions.find(handle);
    if (it == g_sessions.end()) {
        throw steve_sketch::InputError("unknown or disposed session handle");
    }
    return *it->second;
}

std::string text(const char* s)
{
    return s ? std::string(s) : std::string();
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* steve_version()
{
    return steve_sketch::version();
}

EMSCRIPTEN_KEEPALIVE const char* steve_last_error()
{
    return g_error.c_str();
}

EMSCRIPTEN_KEEPALIVE int steve_last_error_kind()
{
    return g_error_kind;
}

EMSCRIPTEN_KEEPALIVE const char* steve_solve(const char* sketch, const char* options)
{
    return returning_json([&] { return steve_sketch::solve(text(sketch), text(options)); });
}

EMSCRIPTEN_KEEPALIVE int steve_session_new(const char* sketch, const char* options)
{
    int handle = 0;
    guarded([&] {
        auto s = std::make_unique<steve_sketch::Session>(text(sketch), text(options));
        handle = g_next_handle++;
        g_sessions.emplace(handle, std::move(s));
    });
    return handle;
}

EMSCRIPTEN_KEEPALIVE void steve_session_free(int handle)
{
    g_sessions.erase(handle);
}

EMSCRIPTEN_KEEPALIVE const char* steve_session_drag(int handle, const char* ref, double x, double y)
{
    return returning_json([&] { return session(handle).drag(text(ref), x, y); });
}

EMSCRIPTEN_KEEPALIVE const char* steve_session_end_drag(int handle)
{
    return returning_json([&] { return session(handle).end_drag(); });
}

EMSCRIPTEN_KEEPALIVE int steve_session_set_value(int handle, const char* constraint_id, double value)
{
    return guarded([&] { session(handle).set_value(text(constraint_id), value); }) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE const char* steve_session_solve(int handle)
{
    return returning_json([&] { return session(handle).solve(); });
}

EMSCRIPTEN_KEEPALIVE const char* steve_session_diagnose(int handle)
{
    return returning_json([&] { return session(handle).diagnose(); });
}

EMSCRIPTEN_KEEPALIVE const char* steve_session_snapshot(int handle)
{
    return returning_json([&] { return session(handle).snapshot(); });
}

// {"heap_bytes": linear memory size, "in_use_bytes": allocated by malloc, "sessions": count}
EMSCRIPTEN_KEEPALIVE const char* steve_memory_stats()
{
    struct mallinfo mi = mallinfo();
    const unsigned long long heap =
        static_cast<unsigned long long>(__builtin_wasm_memory_size(0)) * 65536ULL;
    g_result = "{\"heap_bytes\":" + std::to_string(heap)
        + ",\"in_use_bytes\":" + std::to_string(static_cast<unsigned long long>(mi.uordblks))
        + ",\"sessions\":" + std::to_string(g_sessions.size()) + "}";
    return g_result.c_str();
}

}  // extern "C"
