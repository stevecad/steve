/**
 * Designs (docs/MODELING.md §6) in the browser. The open document keeps the file being edited in
 * `doc.code`, so every tool that reads or writes the code works on that file; `doc.files` holds all
 * of a design's files, and `stored()` turns that back into what the API keeps: main.py as `code`
 * and every other file in `files`.
 */
import type { Build, CadDocument, Kind, LinkRef } from '@/lib/api';
import type { DocState } from './store';
import { withoutDrawings } from '@/drawing/code';

export const MAIN = 'main.py';
export const PARAMS = 'params.py';
/** A circuit's entry file (docs/ELECTRONICS.md): `export default () => (<board …>…</board>)`. */
export const CIRCUIT_MAIN = 'main.tsx';

/** Documents made of several Python files (main.py as `code`, the rest in `files`): designs and shops. */
export const hasFiles = (kind: Kind | null | undefined): kind is 'design' | 'shop' => kind === 'design' || kind === 'shop';
/** Documents that link other documents (pinned revisions): designs link parts and designs, a part adds linked parts and
 *  designs as features (`model.add`); shops link shops. */
export const hasLinks = (kind: Kind | null | undefined): kind is 'part' | 'design' | 'shop' => kind === 'part' || kind === 'design' || kind === 'shop';

/** Documents edited in their entry file, their other files (modules, helpers) kept as they are: circuits (main.tsx) and
 *  Blender documents (main.py; agents add helper modules). */
export const keepsFiles = (kind: Kind | null | undefined): kind is 'circuit' | 'blender' => kind === 'circuit' || kind === 'blender';
/** The file a document's `code` is. */
export const entryOf = (kind: Kind | null | undefined): string => (kind === 'circuit' ? CIRCUIT_MAIN : MAIN);

type Open = Pick<DocState, 'kind' | 'code' | 'files' | 'activeFile'> & Partial<Pick<DocState, 'links'>>;

/** A new Blender document (blender/blender_run.py): Blender Python run on an empty scene, 1 Blender unit = 1 mm. */
export const BLENDER_TEMPLATE = `import bpy
from mathutils import Vector

# Blender Python, run in a fresh headless Blender on an empty scene. 1 Blender unit = 1 mm, Z up.
bpy.ops.mesh.primitive_cube_add(size=20, location=(0, 0, 10))
bpy.context.object.name = "Product"

# A ready-to-render camera and soft light; edit these alongside your geometry.
bpy.ops.object.camera_add(location=(45, -55, 45))
camera = bpy.context.object
camera.rotation_euler = (Vector((0, 0, 10)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.clip_end = 10000
scene = bpy.context.scene
scene.camera = camera
scene.render.resolution_x = 1280
scene.render.resolution_y = 720
scene.render.resolution_percentage = 100
scene.cycles.samples = 32
bpy.ops.object.light_add(type='AREA', location=(10, -20, 60))
bpy.context.object.data.energy = 30000
bpy.context.object.data.size = 30
`;

/** A new design: shared parameters, no components yet. */
export const DESIGN_FILES: Record<string, string> = {
  [MAIN]: 'from steve import Design\n\ndesign = Design()\n\nresult = design.result()\n',
  [PARAMS]: '# Shared parameters: every component imports what it needs from here.\n',
};

/**
 * A new shop: the workspace's machines, controllers and tools as code. Building it lists the library records it makes;
 * a build of the saved revision saves them into the manufacturing library.
 */
export const SHOP_FILES: Record<string, string> = {
  [MAIN]: `from steve.shop import *
from params import *  # noqa: F403

shop = Shop()

# Each item becomes one manufacturing library record, identified by its key (the first argument): renaming an item
# never breaks what uses it. Items refer to each other directly. Lengths are mm, speeds RPM. For example:
#
# model = shop.add(MachineModel.mill("mill_model", "Vertical mill", travel=(500, 400, 400),
#                                    spindle=Spindle(interface="bt30", max_rpm=12_000),
#                                    changer=Changer.magazine(pockets=12, interface="bt30")))
# control = shop.add(Controller("control", "Mill control", dialect="linuxcnc_cartesian_linear_v1"))
# mill = shop.add(Machine("mill", "Vertical mill", model=model, controller=control))
#
# em6 = shop.add(EndMill("em6", "6 mm end mill", diameter=6, flutes=3, flute_length=18, overall_length=50))
# holder = shop.add(Holder("bt30_er20", "BT30 ER20 holder", input_interface="bt30", output_interface="cylindrical_shank"))
# t_em6 = shop.add(Tool("t_em6", "6 mm end mill in ER20", cutter=em6, holders=[holder], stickout=22))
# shop.add(ToolSetup("rack", "Everyday rack", tools={1: t_em6}))
`,
  [PARAMS]: '# Shared values (spindle interfaces, stick-outs, …): main.py and the other files import what they need from here.\n',
};

/** Every file of the open design or shop, the edited one included. Not one: {}. */
export function filesOf(doc: Open): Record<string, string> {
  if (!hasFiles(doc.kind)) return {};
  return { ...doc.files, [doc.activeFile]: doc.code };
}

/**
 * Every source file of the open document as [path, text], the entry file first (main.py, params.py, then the rest by
 * path): one file for a part, all of a design's or circuit's. Paths that could leave the folder they're unpacked in are
 * left out (the server never saves them; an unsaved draft might hold one).
 */
export function sourceFiles(doc: Open): [string, string][] {
  if (!hasFiles(doc.kind) && !keepsFiles(doc.kind)) return [[MAIN, doc.code]];
  const files = keepsFiles(doc.kind) ? { ...doc.files, [entryOf(doc.kind)]: doc.code } : filesOf(doc);
  const rank = (path: string) => (path === MAIN || path === CIRCUIT_MAIN ? 0 : path === PARAMS ? 1 : 2);
  return Object.entries(files)
    .filter(([path]) => path && !path.startsWith('/') && !path.includes(':') && !path.includes('\\') && !path.split('/').includes('..'))
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

/** The open document as the API stores it. */
export function stored(doc: Open): { code: string; files: Record<string, string>; links: Record<string, LinkRef> } {
  // A circuit edits main.tsx, a Blender document main.py; their other files (subcircuits, helpers) are kept as they are.
  if (keepsFiles(doc.kind)) return { code: doc.code, files: { ...doc.files }, links: {} };
  if (!hasFiles(doc.kind)) return { code: doc.code, files: {}, links: hasLinks(doc.kind) ? doc.links ?? {} : {} };
  const { [MAIN]: main = '', ...rest } = filesOf(doc);
  return { code: main, files: rest, links: doc.links ?? {} };
}

/** Open-document fields for a document loaded from the server: designs and shops open on main.py. */
export function opened(doc: Pick<CadDocument, 'kind' | 'code' | 'files' | 'links'>): Pick<DocState, 'code' | 'files' | 'activeFile' | 'links'> {
  if (keepsFiles(doc.kind)) return { code: doc.code, files: { ...(doc.files ?? {}) }, activeFile: entryOf(doc.kind), links: {} };
  return hasFiles(doc.kind)
    ? { code: doc.code, files: { ...(doc.files ?? {}), [MAIN]: doc.code }, activeFile: MAIN, links: doc.links ?? {} }
    : { code: doc.code, files: {}, activeFile: MAIN, links: hasLinks(doc.kind) ? doc.links ?? {} : {} };
}

const sortedJson = (files: Record<string, string> | undefined) => JSON.stringify(Object.entries(files ?? {}).sort(([a], [b]) => a.localeCompare(b)));

/** Whether a build was made from exactly the open document's source (every file of a design or shop). */
export function builtFrom(build: Pick<Build, 'code' | 'files' | 'links'> | null | undefined, doc: Open): boolean {
  if (!build) return false;
  const { code, files, links } = stored(doc);
  if (keepsFiles(doc.kind)) return build.code === code && sortedJson(build.files) === sortedJson(files);
  const sameLinks = () => JSON.stringify(Object.entries(build.links ?? {}).map(([k, v]) => [k, v.document_id, v.revision, v.component ?? null]).sort())
    === JSON.stringify(Object.entries(links).map(([k, v]) => [k, v.document_id, v.revision, v.component ?? null]).sort());
  return build.code === code && (!hasFiles(doc.kind) || sortedJson(build.files) === sortedJson(files)) && sameLinks();
}

/** Code without its drawing sheets (drawing/code.ts withoutDrawings), remembered for the last few texts: the staleness
 *  checks ask on every change to the app's state. */
const sheetless = new Map<string, string>();
function withoutSheets(code: string): string {
  let out = sheetless.get(code);
  if (out === undefined) {
    out = withoutDrawings(code);
    sheetless.set(code, out);
    while (sheetless.size > 16) sheetless.delete(sheetless.keys().next().value!);
  }
  return out;
}

/** A document's files without their drawing sheets; tables as they are. */
const unsheeted = (files: Record<string, string> | undefined) =>
  Object.fromEntries(Object.entries(files ?? {}).map(([path, text]) => [path, path.endsWith('.py') ? withoutSheets(text) : text]));

/**
 * Whether a build is of the open document's model: its source, but for the `Drawing(...)` sheets, which don't change
 * the model. A drawing edit leaves the 3D build current (state/store.ts isPreviewStale) and redraws only the sheets
 * (drawing/DrawingTab.tsx); saving, exports and anything that needs the exact source still use builtFrom.
 */
export function modelBuiltFrom(build: Pick<Build, 'code' | 'files' | 'links'> | null | undefined, doc: Open): boolean {
  if (builtFrom(build, doc)) return true;
  if (!build || build.code === undefined || (doc.kind !== 'part' && doc.kind !== 'design')) return false;
  const { code, files, links } = stored(doc);
  const main = withoutSheets(code);
  return builtFrom({ ...build, code: withoutSheets(build.code), files: unsheeted(build.files) },
    { kind: doc.kind, code: main, files: { ...unsheeted(files), [MAIN]: main }, activeFile: MAIN, links });
}

/** Whether a build has a model to show: a sheet build (mode `drawing`) draws only the Drawing tab's sheets. */
export const showsModel = (build: Pick<Build, 'mode'>) => build.mode !== 'drawing';

/** Whether a build belongs to Manufacture (a shop or a CAM program): it has no model and never opens in Design. */
export const manufactureBuild = (build: Pick<Build, 'kind'>) => build.kind === 'shop' || build.kind === 'cam';

/** The build the app opens on start-up when no document is newer: the latest succeeded model that isn't a document's
 *  own preview, and never a sheet build or a Manufacture one. */
export const latestModelBuild = <B extends Pick<Build, 'id' | 'status' | 'mode' | 'kind'>>(builds: B[], previews: Set<string | null | undefined>) =>
  builds.find((build) => build.status === 'succeeded' && showsModel(build) && !manufactureBuild(build) && !previews.has(build.id));

/** A design's table: plain-text data beside main.py (holes.csv), read with steve.table, never a Python module. */
export const isTable = (path: string) => /^[a-z][a-z0-9_]{0,63}\.csv$/.test(path);

/** A design's logo image: a PNG or JPEG beside main.py (logo.png), kept as base64 text, drawn only by a title
 *  block cell (`{"image": "logo.png"}`); never code, never opened in the editor. */
export const isImage = (path: string) => /^[a-z][a-z0-9_]{0,63}\.(?:png|jpe?g)$/.test(path);

/** The path a logo of `name` (a picked file's name) is kept at, its extension from its bytes' kind: "ACME Logo.PNG" →
 *  "acme_logo.png". */
export function imagePath(name: string, kind: 'png' | 'jpeg'): string | null {
  const stem = name.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'i_$1').slice(0, 60);
  return stem ? `${stem}.${kind === 'png' ? 'png' : 'jpg'}` : null;
}

/** The path a table file of `name` (a picked file's name) is kept at: "Hole Positions.CSV" → "hole_positions.csv". */
export function tablePath(name: string): string | null {
  const stem = name.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 't_$1').slice(0, 60);
  return stem ? `${stem}.csv` : null;
}

/**
 * What main.py can place: the components it imports (`from components.pin import pin` → `pin`) and the documents it
 * links (`from links import bolt` → `bolt()`), as the Python each placement passes to design.add or design.pattern.
 */
export function placeables(main: string): { label: string; source: string }[] {
  const out: { label: string; source: string }[] = [];
  for (const line of main.split('\n')) {
    const match = /^from\s+(components\.[\w.]+|links)\s+import\s+([^()#]+?)\s*(#.*)?$/.exec(line);
    if (!match) continue;
    for (const item of match[2].split(',')) {
      const name = item.trim().split(/\s+as\s+/).pop()!;
      if (!/^[A-Za-z_]\w*$/.test(name)) continue;
      out.push({ label: name, source: match[1] === 'links' ? `${name}()` : name });
    }
  }
  return out;
}

/**
 * Adds one statement to main.py just before `result = …` (at the end when there's none), importing `table` from steve
 * when the statement reads one and main.py doesn't import it yet. The rest of main.py is kept as it is.
 */
export function withMainStatement(main: string, statement: string): string {
  const lines = main.replace(/\n$/, '').split('\n');
  if (/\btable\(/.test(statement) && !lines.some((line) => /^from\s+steve\s+import\s+(\*|.*\btable\b)/.test(line))) {
    const single = lines.findIndex((line) => /^from\s+steve\s+import\s+[^()#\\]+$/.test(line.trimEnd()));
    if (single >= 0) lines[single] = `${lines[single].trimEnd()}, table`;
    else lines.splice(lines.reduce((last, line, index) => (/^(from|import) /.test(line) ? index : last), -1) + 1, 0, 'from steve import table');
  }
  const result = lines.findIndex((line) => /^result\s*=/.test(line));
  lines.splice(result >= 0 ? result : lines.length, 0, statement);
  return `${lines.join('\n')}\n`;
}

/** Which file a path names for people: "components/blade.py" → "blade". */
export const fileLabel = (path: string) => (path === MAIN ? 'main' : path.replace(/^components\//, '').replace(/\.py$/, ''));

/** A component file for a new component id. */
export const componentPath = (id: string) => `components/${id}.py`;

/** Adds `components/<id>.py` with one Component, imported and placed in main.py (as STEVE's create_component). */
export function withComponent(files: Record<string, string>, id: string, name: string): Record<string, string> {
  const path = componentPath(id);
  const params = PARAMS in files ? 'from params import *  # noqa: F403\n' : '';
  const source = `from steve import Component\n${params}\n${id} = Component(${JSON.stringify(id)}, name=${JSON.stringify(name)})\n`;
  const lines = (files[MAIN] ?? DESIGN_FILES[MAIN]).replace(/\n$/, '').split('\n');
  const imports = lines.reduce((last, line, index) => (/^(from|import) /.test(line) ? index : last), -1);
  lines.splice(imports + 1, 0, `from components.${id} import ${id}`);
  const result = lines.findIndex((line) => /^\s*result\s*=/.test(line));
  lines.splice(result >= 0 ? result : lines.length, 0, `design.add(${id})`);
  return { ...files, [path]: source, [MAIN]: `${lines.join('\n')}\n` };
}

/**
 * Removes a component: its file, its `from components.<module> import …` line in main.py and the top-level
 * `design.add(<name>…)` lines that place it. Any other use of it (joints, mates, other components, placements inside
 * loops or across several lines) is left for the person to remove first: returns the files that still use it then.
 */
export function withoutComponent(files: Record<string, string>, path: string, id?: string): { files: Record<string, string> } | { users: string[] } {
  const module = path.replace(/^components\//, '').replace(/\.py$/, '').replace(/\//g, '.');
  const imported = new RegExp(String.raw`^from\s+components\.${module.replace(/\./g, '\\.')}\s+import\s+([^()#]+?)\s*(#.*)?$`);
  const names: string[] = [];
  let main = (files[MAIN] ?? '').split('\n').filter((line) => {
    const match = imported.exec(line);
    if (match) names.push(...match[1].split(',').map((name) => name.trim().split(/\s+as\s+/).pop()!).filter((name) => /^\w+$/.test(name)));
    return !match;
  });
  const placed = (line: string) => names.some((name) => new RegExp(String.raw`^\w+\.add\(\s*${name}\b[^()]*(\([^()]*\)[^()]*)*\)\s*(#.*)?$`).test(line));
  main = main.filter((line) => !placed(line));
  const next: Record<string, string> = { ...files, [MAIN]: main.join('\n') };
  delete next[path];
  // Joints and mates in main.py name instances by the component's id, which may differ from its variable; a file
  // imported some other way (`from components import x`) is caught by its module name.
  const ids = [id, names.length ? undefined : module.split('.').pop()].filter((word): word is string => !!word && /^\w+$/.test(word) && !names.includes(word));
  const uses = (code: string, words: string[]) => code.split('\n').some((line) => !line.trim().startsWith('#')
    && (new RegExp(String.raw`\bcomponents\.${module.replace(/\./g, '\\.')}\b`).test(line) || words.some((word) => new RegExp(String.raw`\b${word}\b`).test(line))));
  const users = Object.keys(next).filter((file) => file.endsWith('.py') && uses(next[file], file === MAIN ? [...names, ...ids] : names)).map(fileLabel);
  return users.length ? { users } : { files: next };
}

const RESERVED_ALIASES = ['design', 'result', 'steve', 'params', 'components', 'links', 'cq', 'cadquery'];

/**
 * Links another saved design or part into a design's main.py, pinned to `revision`, and places one instance at
 * `position`: `design.add(<alias>())` with steve.Design, or `result.add(<alias>.result, …)` when main.py builds its
 * own cq.Assembly (e.g. a former assembly). Reuses the alias already linking that whole document at that revision
 * (never one linking a single component of it).
 */
export function withLink(files: Record<string, string>, current: Record<string, LinkRef>, documentId: string, name: string, revision: number,
  position: [number, number, number]): { files: Record<string, string>; links: Record<string, LinkRef>; alias: string } {
  const links = { ...current };
  let alias = Object.keys(links).find((key) => links[key].document_id === documentId && links[key].revision === revision && !links[key].component);
  if (!alias) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'l_$1').slice(0, 40) || 'linked';
    alias = base;
    for (let n = 2; links[alias] || RESERVED_ALIASES.includes(alias); n++) alias = `${base}_${n}`;
    links[alias] = { document_id: documentId, revision };
  }
  let main = files[MAIN] ?? '';
  if (!new RegExp(`^\\s*from\\s+links\\s+import\\b.*\\b${alias}\\b`, 'm').test(main)) {
    const lines = main.replace(/\n$/, '').split('\n');
    const last = lines.reduce((found, text, index) => (/^(from|import) /.test(text) ? index : found), -1);
    lines.splice(last + 1, 0, `from links import ${alias}`);
    main = `${lines.join('\n')}\n`;
  }
  if (/\bDesign\(/.test(main) || !/\bAssembly\(/.test(main)) {
    const place = position.some((v) => v !== 0) ? `, at=(${position.join(', ')})` : '';
    main = /^\s*result\s*=/m.test(main) ? main.replace(/^(\s*result\s*=)/m, `design.add(${alias}()${place})\n$1`) : `${main}design.add(${alias}()${place})\n`;
  } else {
    if (!/^import cadquery as _cq$/m.test(main)) main = `import cadquery as _cq\n${main}`;
    let index = 1;
    while (main.includes(`"${alias}_${index}"`)) index++;
    main = `${main.replace(/\n*$/, '\n')}result.add(${alias}.result, name="${alias}_${index}", loc=_cq.Location(_cq.Vector(${position.join(', ')})))\n`;
  }
  return { files: { ...files, [MAIN]: main }, links, alias };
}
