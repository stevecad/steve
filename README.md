# Steve

Local desktop CAD with the Studio-compatible modeling runtime, a PySide6 desktop
host, and an assistant powered by Pydantic AI. CAD builds run on this machine.

This is pre-release software. Known coverage limits remain documented; not every
CAD operation is certified. See `CONTRIBUTING.md` to set up a development environment.

## Download

Prebuilt releases are published at https://dl.stevecad.studio. You don't need to build
from source to use Steve:

- Windows 10 and 11 (64-bit): the installer, `https://dl.stevecad.studio/windows/Steve-Setup-<version>-windows-x64.exe`
- Linux (x86-64): the AppImage, `https://dl.stevecad.studio/linux/Steve-<version>-linux-x86_64.AppImage`

The current version is in each platform's `latest.json`
(https://dl.stevecad.studio/windows/latest.json, https://dl.stevecad.studio/linux/latest.json).
Signed in to Steve Studio, the account menu's **Steve desktop** lists the same downloads.
Installed copies update themselves from the same place.

## Development on Windows

Use Python 3.13 and Node.js with npm. Create a virtual environment, install
`requirements.txt`, then run `npm ci` and `npm run build` inside `cad-web`.
Install the desktop package with `python -m pip install --no-deps -e .`, then
launch with `python -m steve_desktop`. The CadQuery dependency is pinned to its fork commit.
`docs/UPSTREAM.txt` records the upstream runtime, frontend and solver provenance.

Run focused Python tests with `python -m unittest tests.<test_module>` and the offline
desktop smoke check with `python -m steve_desktop --smoke-test`.

Build the desktop with `powershell -File tools/build.ps1 -Python <venv-python>`.
The executable is `dist/Steve/Steve.exe`. PyInstaller is a build
dependency and is not required to run the source application.

User profiles, credentials, CAD documents, environments and generated builds are
not repository content. Credentials use the operating system credential facilities.
The previous profile is migrated while retaining the original as a recovery copy.

Third-party code retains its notices in `THIRD-PARTY-LICENSES`, `vendor` and the
frontend's public licenses. See `docs/UPSTREAM.txt` before changing vendored components.

## Repository layout

- `src/steve_desktop/`: desktop host, assistant, CAD services, and integrations.
- `cad-web/`: CAD interface and browser assets.
- `tests/`: automated tests; mock MCP server lives in `tests/fixtures/`.
- `checks/`: interactive integration checks.
- `packaging/`: frozen-app entry point, PyInstaller spec, and updater helper.
- `tools/`: developer build tools.
- `assets/`, `pdf-fonts/`, `bundled-skills/`: shipped application resources.
- `vendor/`, `THIRD-PARTY-LICENSES/`: upstream runtime and its notices.
- `docs/`: release notes, operating notes, provenance, and update setup.

`steve_desktop` is the application package. The vendored `steve` package is the
Studio-compatible CAD modeling API; the distinct names prevent import collisions.
Source development uses an editable install; distribution uses the desktop build,
which bundles the frontend, CAD runtime, and resources. A Python wheel alone is
not a complete desktop distribution. Generated caches and build output are ignored.

Windows installer build and release limitations: [docs/INSTALLER.md](docs/INSTALLER.md).
Signed updates from https://dl.stevecad.studio and how a release is produced:
[docs/UPDATE-FEED.txt](docs/UPDATE-FEED.txt).

Linux x64 AppImage/tarball builds, dependencies and verification:
[docs/LINUX.md](docs/LINUX.md). Linux uses the shared PyInstaller spec and a pinned
Linux build environment. Running from source on Apple Silicon:
[docs/MACOS.md](docs/MACOS.md). macOS packaging remains future work.

Studio connection and projects
------------------------------
Use the top-right account menu to sign in to or disconnect from Steve Studio.
Open File > Open > Steve Studio to browse workspaces, download CAD projects,
open local copies and manage sync. Disconnecting leaves downloaded CAD files on
this machine. Studio is optional; local CAD remains available offline.

The account menu displays the consenting Studio user's name, verified email and
HTTPS picture when provided; the stable account ID is the fallback. Sign-in asks
for Studio's published `profile` permission alongside read-only project access.
Existing sessions need one normal **Reconnect to Steve Studio** to consent to the
new permission. No client registration or copied credentials are required. Profile
metadata is encrypted locally, refreshed with the workspace response, and cleared
on disconnect, account changes or a token scope reduction.

Report a bug / Request a feature (the Feedback menu) send the report to STEVE
Studio with the same sign-in; reports are stored only by Studio. Sending needs
Studio's `feedback:write` permission, which sign-in now requests; an older
sign-in is asked to sign in again from the report dialog. Before sending, the
dialog shows exactly what goes with the text: app version, OS, the app's local
log with home-folder paths, the user name, emails and tokens removed (it can be
left out), and a screenshot only when one is attached. See
`docs/STUDIO-INTEGRATION.md`.

The isolated navigation acceptance check uses the built frontend, a temporary
local CAD server and mocked Studio HTTP responses. Install `playwright` in a
**development** Python environment and have Microsoft Edge installed, then run
`PYTHONPATH=src python checks/check_studio_navigation.py --output <evidence-dir>`
(on PowerShell set `$env:PYTHONPATH='src'` first). Real OAuth is blocked in this
check; it does not use the installed application or account credentials.

## Local Blender (Windows and Linux)

Use **Settings → Local Blender** to install the verified official Blender 4.5 LTS
runtime or select an existing 4.5 executable. Blender is optional and downloaded
only when requested; CAD does not require it. Managed downloads support Windows
x64/ARM64 and Linux x64. Other Linux architectures can use a compatible executable.

Create a **Blender scene** from File → New. Python source uses the same `bpy` scene
contract as Studio (one Blender unit is one millimetre). Complete CAD documents and
assemblies can be linked as preview meshes; individual component links are not yet
supported. Meshes do not preserve exact CAD solids. Save source to rebuild the local
preview; unchanged inputs reuse cached results. The Animation ribbon provides
playback, scene-camera inspection, video rendering and cancellation.

The export menu offers **Render scene**, `.blend`, images and source packages.
Render scene provides camera PNGs, inspection views and animation output when the
source has an animated camera. **Open in Blender** saves a full native scene and
launches the local editor without rendering an animation. Saving source never starts
a background render. Changes in that editor do not rewrite Steve's Python
source. Rendering currently uses CPU Cycles, matching Studio's runtime. Local jobs
have no hosted build deadline or video-resolution cap; resource use follows Steve's
CPU setting. Scripts run with the user's permissions, not inside an OS sandbox.

Acceptance checks use temporary profiles: `checks/check_local_blender.py`,
`checks/check_blender_ui.py` and `checks/check_blender_desktop_downloads.py`.
Set `STEVE_BLENDER` to the executable, or use the first check's `--install` option.
A frozen application can verify its actual bundled runtime with
`Steve --blender-smoke <evidence-directory>` and `STEVE_BLENDER` set.

## License

Steve is licensed under the Apache License 2.0; see [LICENSE](LICENSE) and
[NOTICE](NOTICE). Third-party components keep their own licenses, listed in
[THIRD-PARTY-LICENSES](THIRD-PARTY-LICENSES) and beside vendored code in `vendor/`.

## Trademarks

The STEVE name and logo are trademarks of 10-X-eng and are not licensed under the
Apache License 2.0. Forks and redistributions of modified versions must use a
different name and logo.
