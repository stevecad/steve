// Type declarations for the Emscripten-generated glue (steve-sketch.mjs). Generated code is built
// by solver/build-wasm.sh from solver/wasm/steve_sketch_wasm.cpp; keep in sync with that C API.

export interface SteveSketchModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  _steve_version(): number;
  _steve_last_error(): number;
  _steve_last_error_kind(): number;
  _steve_solve(sketch: number, options: number): number;
  _steve_session_new(sketch: number, options: number): number;
  _steve_session_free(handle: number): void;
  _steve_session_drag(handle: number, ref: number, x: number, y: number): number;
  _steve_session_end_drag(handle: number): number;
  _steve_session_set_value(handle: number, constraintId: number, value: number): number;
  _steve_session_solve(handle: number): number;
  _steve_session_diagnose(handle: number): number;
  _steve_session_snapshot(handle: number): number;
  _steve_memory_stats(): number;
  UTF8ToString(ptr: number, maxBytesToRead?: number): string;
  stringToUTF8(str: string, outPtr: number, maxBytesToWrite: number): number;
  lengthBytesUTF8(str: string): number;
}

export interface SteveSketchModuleOptions {
  locateFile?: (path: string, scriptDirectory: string) => string;
  wasmBinary?: ArrayBuffer | Uint8Array;
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    receiveInstance: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void,
  ) => object | Promise<object>;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}

export default function createSteveSketch(options?: SteveSketchModuleOptions): Promise<SteveSketchModule>;
