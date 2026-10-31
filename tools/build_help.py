"""Build the offline CAD manual from a STEVE Studio documentation checkout; no network access.

Usage: python tools/build_help.py --source /path/to/studio-checkout [--revision <expected commit>]
Build-time dependencies: markdown-it-py and PyYAML. The desktop reads only JSON/images.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import unquote, urlsplit

import yaml
from markdown_it import MarkdownIt

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'cad-web/public/help'
GROUPS = {'local': 'Working locally', 'design': 'Parts & modeling', 'assemblies': 'Assemblies & motion', 'drawing': 'Engineering drawings'}
ALIASES = {'/docs/': '/docs/local/start/', '/docs/start/': '/docs/local/start/',
           '/docs/start/first-part/': '/docs/local/first-part/', '/docs/collaborate/': '/docs/local/history/',
           '/docs/concepts/revisions-and-branches/': '/docs/local/history/', '/docs/steve/': '/docs/local/assistant/',
           '/docs/agents/': '/docs/local/assistant/', '/docs/reference/settings/': '/docs/local/settings/',
           '/docs/reference/keyboard-shortcuts/': '/docs/local/shortcuts/', '/docs/reference/commands/': '/docs/local/shortcuts/',
           '/docs/integrations/mcp-servers/': '/docs/local/settings/#tools--mcp'}

LOCAL = {
    'start': ('Steve CAD', 'Build, inspect, edit and export on this machine.', '''
## Start with a part
Use **File → New part**, then sketch and add features, or ask Steve to build one.
The model, its feature history and its Python source describe the same design.
Start with [your first part](/docs/local/first-part/) or browse the [modeling tools](/docs/design/features/).

## Work with an assembly
A **design** combines components, shared parameters and links to other saved documents.
Use the [assembly tools](/docs/assemblies/) to place components, add joints and inspect fit.
Linked documents use a specific saved revision, so changing a part doesn't silently change every assembly.

## Inspect before exporting
Select faces and edges in the view. Use **Measure**, **Section analysis**, the Inspector and the feature history
to check the result. Create [engineering drawings](/docs/drawing/) when you need dimensions and manufacturing notes.
Export STEP for CAD exchange, STL or 3MF for printing, and PDF, SVG or DXF for drawings.

## Keep your work
**Ctrl+S** saves a local document revision. **Save with message…** adds a note to the revision.
[Version history](/docs/local/history/) lets you inspect and restore earlier work.
Keep exported source and imported geometry together when moving a project between machines.

## This desktop workspace
CAD computation and saved documents stay on this machine. Chat uses your connected subscription;
configured remote MCP services communicate with their own servers. Manage these in [Settings](/docs/local/settings/).
The modeling reference follows the Studio CAD runtime shipped with this build. This manual is available offline.
'''),
    'first-part': ('Your first part', 'A plate with a hole, made with the human tools.', '''
## Create the plate
1. Choose **File → New part** and give the part a useful name.
2. Click **Sketch** and choose the **XY** plane.
3. Draw a closed rectangle. Use dimensions to set its width and depth.
4. Finish the sketch. Select it and click **Extrude**.
5. Set the distance to **6 mm**, then click **OK**.

## Add a hole
1. Select the plate's top face and click **Hole**.
2. Set the hole diameter and its position on the face.
3. Leave **Depth** empty for a through hole, or enter a depth for a blind hole, then click **OK**.
See [Hole](/docs/design/features/#hole) for the available fields.

## Inspect and change it
Use **Fit all** to frame the model. Select the plate or a face to inspect its dimensions and properties.
Select the feature in the history and choose **Edit** to change its inputs; **Cancel** discards an uncommitted preview.
Read [selection](/docs/design/selecting/) and [feature history](/docs/design/history/) for the detailed controls.

## Save and export
Press **Ctrl+S**. To describe a milestone, use **File → Save with message…**.
Choose **Export STEP** and select a destination on your machine.
Use **Download source** as well if you need to keep editing the feature-based model elsewhere.
'''),
    'history': ('Save & version history', 'Inspect an earlier model or restore it without deleting later revisions.', '''
## Save a revision
**Ctrl+S** saves the name, source files and links. **Save with message…** also records a short description.
Geometry is attached only when it was built successfully from that revision's source. Saving unbuilt edits
does not attach an older model as if it were the new one.

## View an earlier revision
Open **Versions** with **Ctrl+Shift+H**. Select a revision, then choose **Source** to read its code or **View**
to show its saved model. The viewport banner identifies the revision being previewed. The Inspector reports
that model's dimensions, material and mass. **Back to current** returns to your current model.
**View** is unavailable when a revision has no matching saved geometry.

## Restore
Save or discard current edits before restoring. Select an earlier revision and choose **Restore** or **Make current**.
Steve saves it as a new revision. Later revisions remain in history, so you can restore them again.

## Local scope
The desktop currently keeps a linear revision history. Branching and merging are not implemented locally.
Document revision history is separate from the feature timeline and the source editor's undo history.
'''),
    'assistant': ('Work with Steve', 'Use the assistant alongside the CAD viewport.', '''
## Connect your account
Open **Settings → STEVE** and sign in with ChatGPT. The sign-in flow opens in your browser.
After connecting, choose a model and an effort level in the assistant.

## Ask for a CAD change
Describe the geometry, units, constraints and intended result. Keep the relevant document open.
Steve can use the local CAD tools to read, build, inspect, edit and export it. Ask for explicit inspection
of dimensions or clearances when they matter, and review the resulting model.
**Ctrl+Enter** sends a message; **Enter** inserts a new line. Use **Stop** to cancel a running response.

## Show Steve an image
Paste with **Ctrl+V** in the message field, drop an image, or use **Attach images**.
Use **Attach the current view** to capture the CAD viewport. You can attach up to four images,
with or without a written message. Click a sent image to open it full size.
Images are stored encrypted locally and sent to the selected model with your conversation.

## Diagnose a failed request
Open **Settings → STEVE → Diagnostics** for the failure's reference ID, original error details and
stack locations. Recent records persist encrypted on this device. **Copy diagnostics** copies the
records for review and sharing. Failures from builds without logging cannot be recovered.

## Instructions, skills and memory
**Settings → Instructions** controls the system prompt. **Skills** configures trusted instruction libraries.
**Memory** lets you review and edit the local notes available to Steve.
These guide future requests; they do not change an existing CAD document by themselves.

## Tools and services
Enable file/script tools and configure MCP servers in **Settings → Tools & MCP**.
A remote service may ask you to authenticate with that service. Connecting to the hosted Studio MCP
is optional and separate from your ChatGPT subscription and local CAD runtime.
'''),
    'settings': ('Settings', 'Configure the local workspace and assistant.', '''
## Navigation and display
Open Settings with **Ctrl+,** or the gear in the top bar. **Navigation** controls view interaction.
**Display** controls the appearance of the workspace. **Code editor** controls editor behavior.

## Performance
**Performance** sets the shared CPU budget for local CAD work. The default is **80%**.
Warm workers reduce startup latency; each job runs in its own process and retires afterward.
Independent jobs and supported native geometry operations can run in parallel. A single build may still have
serial phases, so the CPU budget is a ceiling rather than a promised utilization level. Use **Stop build** to cancel.

## Tools & MCP
Configure local stdio or remote HTTP MCP servers in **Tools & MCP**. Use the server's sign-in control when
authentication is required. A remote server's account is separate from your ChatGPT account.
Enable only the services and local capabilities you intend Steve to use.

## Instructions, skills and memory
Use **Instructions** for the system prompt and script settings, **Skills** for instruction libraries,
and **Memory** for Steve's local notes. Account connection lives in **STEVE**.
'''),
    'shortcuts': ('Commands & shortcuts', 'Find a tool by name and keep your hands on the keyboard.', '''
## Find any command
Press **Ctrl+K** to open the command palette. Search by a tool's name, such as **Fillet**, **Section analysis**,
**Save with message**, or **Export drawing**. Unavailable commands explain what they need.
Press **?** to see the current keyboard shortcut reference inside the workspace.

| Action | Shortcut |
|---|---|
| Save | Ctrl+S |
| Open documents | Ctrl+O |
| Version history | Ctrl+Shift+H |
| Settings | Ctrl+, |
| Help | F1 |
| Assistant | Ctrl+I |
| Send a chat message | Ctrl+Enter |
| Extrude | E |
| Fillet | Shift+F |
| New sketch | Shift+S |

Single-letter modeling shortcuts do not run while typing in a text field. Sketching has its own tool shortcuts.
'''),
}


def slug(text):
    return re.sub(r'[^\w\- ]', '', text.lower()).replace(' ', '-')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--revision', help='fail unless the checkout is at this commit')
    args = parser.parse_args()
    if args.revision:
        revision = subprocess.run(['git', '-C', str(args.source), 'rev-parse', 'HEAD'], check=True, capture_output=True, text=True).stdout.strip()
        if revision != args.revision:
            raise ValueError(f'Expected Studio revision {args.revision}; this checkout is {revision}.')
    docs = args.source / 'docs/site/src/content/docs'
    site = args.source / 'docs/site/src'
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'media').mkdir(exist_ok=True)
    pages = []
    for order, (key, (title, description, body)) in enumerate(LOCAL.items()):
        pages.append(dict(path=f'/docs/local/{key}/', title=title, description=description, group=GROUPS['local'], order=order, body=body, file=None))
    for area in ('design', 'assemblies', 'drawing'):
        for file in sorted((docs / area).glob('*.md')):
            if file.stem in ('blender-scenes', 'circuit-boards'):
                continue
            raw = file.read_text(encoding='utf-8')
            _, front, body = raw.split('---', 2)
            meta = yaml.safe_load(front)
            body = re.sub(r'<!--.*?-->', '', body, flags=re.S)
            body = re.sub(r'A \[share link\].*?its explodes too\.', '', body, flags=re.S)
            # Adapt concrete hosted-only instructions, leaving CAD procedures intact.
            body = re.sub(r'\n- \[Circuit boards in designs\].*?(?=\n\n|\n- )', '', body, flags=re.S)
            body = re.sub(r'\n- \[Blender scenes\].*?(?=\n\n|\n- )', '', body, flags=re.S)
            body = body.replace(' **Share link…** at the bottom of the menu is described in [Collaborate](/docs/collaborate/).', '')
            body = body.replace('A library in a team workspace is there for everyone in the team. ', '')
            body = body.replace('Your browser downloads', 'Choose a local destination for').replace('your browser downloads', 'choose a local destination for')
            body = body.replace('remembered in this browser', 'remembered in this workspace').replace('stays chosen in this browser', 'stays chosen in this workspace')
            if area == 'drawing' and file.stem == 'export':
                body = body.replace('2. The sheets open in a new tab, one page per sheet at its own paper size.\n3. Print at 100 %.',
                    '2. The sheets open in a full-window preview inside Steve. Use the sheet arrows, zoom and **Fit sheet**.\n3. Choose **Save PDF**, then print that PDF at 100% in your PDF application. Close the preview to return to the model.')
                body = re.sub(r'\s*\(A model generated before PDFs existed.*?makes the PDF\.\)', '', body, flags=re.S)
                body = body.replace(' (or a circuit)', '').replace('Each document builds within your usual build limits, only when you click.', 'Documents build locally when you request the package.')
                body = re.sub(r'\nAn AI agent gets the same PDF.*?starting over\.\n', '\n', body, flags=re.S)
            path = f'/docs/{area}/' + ('' if file.stem == 'index' else file.stem + '/')
            pages.append(dict(path=path, title=meta['title'], description=meta.get('description', ''), group=GROUPS[area], order=meta.get('sidebar', {}).get('order', 50), body=body, file=file))
    known = {page['path'] for page in pages}
    md = MarkdownIt('commonmark', {'html': False}).enable('table')
    media = {}
    unresolved = set()
    for page in pages:
        tokens = md.parse(page.pop('body'))
        headings, used = [], {}
        for i, token in enumerate(tokens):
            if token.type == 'heading_open':
                title = tokens[i + 1].content.replace('`', '').replace('**', '')
                base = slug(title); n = used.get(base, 0); used[base] = n + 1
                identifier = base + (f'-{n}' if n else '')
                token.attrSet('id', identifier)
                headings.append({'id': identifier, 'title': title, 'level': int(token.tag[1:])})
            if not token.children:
                continue
            for child in token.children:
                if child.type == 'image':
                    original = child.attrGet('src')
                    if not page['file'] or urlsplit(original).scheme:
                        raise ValueError(f'Only bundled images are allowed: {original}')
                    asset = (page['file'].parent / unquote(original)).resolve()
                    if not asset.is_relative_to(site.resolve()) or not asset.is_file():
                        raise ValueError(f'Missing/outside documentation asset: {asset}')
                    digest = hashlib.sha256(asset.read_bytes()).hexdigest()
                    filename = digest[:20] + asset.suffix.lower()
                    shutil.copy2(asset, OUT / 'media' / filename)
                    child.attrSet('src', '/help/media/' + filename)
                    child.attrSet('loading', 'lazy')
                    media[filename] = {'source': str(asset.relative_to(site.resolve())), 'sha256': digest}
                if child.type == 'link_open':
                    href = child.attrGet('href') or ''
                    target = urlsplit(href)
                    path = target.path or page['path']
                    alias = ALIASES.get(path, path)
                    if path.startswith('/docs/') or href.startswith('#'):
                        normalized = alias + (('#' + target.fragment) if target.fragment and '#' not in alias else '')
                        if urlsplit(normalized).path in known:
                            child.attrSet('href', normalized)
                            continue
                    unresolved.add(href)
                    # Unsupported topics/references remain readable text, never dead buttons or external fetches.
                    child.tag = 'span'; child.attrs = {'class': 'reference', 'title': href}
            # Balance spans replacing unsupported anchors (links cannot nest).
            spans = []
            for child in token.children:
                if child.type == 'link_open': spans.append(child.tag == 'span')
                elif child.type == 'link_close' and spans:
                    if spans.pop(): child.tag = 'span'
        page['html'] = md.renderer.render(tokens, md.options, {})
        page['search'] = ' '.join(t.content for t in tokens if t.type in ('inline', 'fence'))
        page['headings'] = headings
        file = page.pop('file')
        page['source'] = str(file.relative_to(args.source)).replace('\\', '/') if file else 'Steve local guide'
        page['source_sha256'] = hashlib.sha256(file.read_bytes()).hexdigest() if file else None
    pages.sort(key=lambda p: (list(GROUPS.values()).index(p['group']), p['order'], p['title']))
    result = {'version': 1, 'aliases': ALIASES, 'groups': list(GROUPS.values()), 'pages': pages}
    (OUT / 'content.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    (OUT / 'SOURCES.json').write_text(json.dumps({'pages': {p['path']: {'source': p['source'], 'sha256': p['source_sha256']} for p in pages}, 'media': media, 'plain_text_references': sorted(unresolved)}, indent=2), encoding='utf-8')
    print(f'Built {len(pages)} offline pages and {len(media)} images; {len(unresolved)} unbundled references rendered as text.')


if __name__ == '__main__':
    main()
