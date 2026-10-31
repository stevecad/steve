# Linux desktop packages

The initial Linux target is **Ubuntu 24.04 x86_64** and compatible desktop
environments. The build produces an AppImage and a tarball from the same
PyInstaller directory. Python, Qt WebEngine, the frontend, CAD runtime, fonts,
skills and third-party notices are bundled. Users do not need Python or Node.js.
The package includes Node for constrained sketches, and its startup verification
performs a real constraint solve, including in the clean Ubuntu runtime container.

This is a pre-release Linux package. Other distributions, Wayland sessions and
hardware GPU drivers need desktop validation before they are advertised as
supported. Build on the oldest supported OS: AppImage does not remove native
glibc requirements. The first build uses Ubuntu 24.04's glibc 2.39. Alpine/musl
and Linux ARM are not targets of this build.

## Running a package

Make the downloaded AppImage executable, then run it:

```sh
chmod +x Steve-0.4.3-linux-x86_64.AppImage
./Steve-0.4.3-linux-x86_64.AppImage
```

Use an ordinary desktop user session with a running, unlocked Secret Service
(for example GNOME Keyring). Steve requires Secret Service for encrypted storage;
there is no plaintext credential fallback. An unsupported or locked keyring needs
to be configured/unlocked through the desktop before Steve can save credentials.
Git connections additionally require a host Git installation. External MCP
programs and agent commands use tools installed on the host.
The MCP configuration shown in Settings uses the original AppImage path rather
than its temporary mount path, so it remains usable after relaunching Steve.

If FUSE mounting is unavailable, use extraction mode:

```sh
./Steve-0.4.3-linux-x86_64.AppImage --appimage-extract-and-run
```

Alternatively, extract the tarball on a filesystem that supports symbolic links:

```sh
tar -xzf Steve-0.4.3-linux-x86_64.tar.gz
./Steve/AppRun
```

Keep the whole extracted directory together. The tarball preserves PyInstaller's
library symlinks and executable modes. Steve reads bundled resources relative to
its executable, so it can run from a different working directory.

User data lives in `$XDG_DATA_HOME/Steve`, or `~/.local/share/Steve` when unset.
It remains separate from the application directory and survives replacing or
deleting an AppImage. Removing the application does not delete projects or the
encryption key held by Secret Service.

## Automatic updates

Linux updates are enabled by default. Both the AppImage and extracted tarball
consume the same **signed (ECDSA P-384, SHA-384) Linux tarball feed** at
`https://dl.stevecad.studio/linux/latest.json`. Steve checks after startup
and every six hours, downloads in the background, and applies the update after
normal exit. Settings retains the opt-out and explicit install-on-exit control.
Once an update is ready, "Restart and update" closes Steve normally, activates
the update and starts the original AppImage or extracted installation again;
Steve is reopened only when the new version activated successfully.
No credential is needed or sent. The Linux feed has its own trust keys
(`platforms.linux-x64.public_keys` in `assets/update-channel.json`); see
UPDATE-FEED.txt for the manifest (including its signed expiry), key rotation and
how a release is produced.

The AppImage/extracted installation remains a stable launcher. Complete new
versions are unpacked under `$XDG_DATA_HOME/Steve/updates/bundles` (or
`~/.local/share/Steve/updates/bundles`). This works without overwriting the original
download or requiring administrator access. The entire Python/Qt/CAD/frontend
runtime updates together.

Before staging, Steve verifies the release signature, platform and archive hash.
Extraction rejects traversal, escaping links, hard links, special files and
oversized archives while preserving internal Qt/OCP symlinks. A file inventory
is bound to authenticated local update state. Activation verifies every file,
checks the executable's version, and runs the new runtime's offline frontend and
assistant smoke test. It waits for the old process to exit and acquires the
profile lock before changing the active version.

The active-version selection is saved using a flushed temporary file and atomic
replacement in the OS-backed encrypted vault. The running bundle and previous
complete bundle are retained. On launch, the stable launcher verifies the active
bundle and monitors the updated GUI until the frontend renders (or MCP becomes
ready). Corruption or an early startup failure automatically selects the previous
bundle, falling back to the original package for the first update. A release that
fails validation is quarantined by digest so it is not downloaded repeatedly.
Startup checks and monitored relaunch allow one fresh-process retry for a transient
failure before rejecting a bundle. Integrity/signature failures are rejected immediately.

Interrupted downloads leave the working version intact. A complete staged update
survives restarts, and the next GUI launch completes activation if shutdown was
interrupted. Reopening Steve while activation is pending defers the switch.
Projects and credentials remain outside versioned bundles. Old unreferenced
bundles are pruned; the active and previous versions remain available.

Linux reads only Linux manifests: a manifest for another platform, an expired
manifest, a package URL outside the feed's host or an older version is refused.
Publishing and signing are documented in `docs/UPDATE-FEED.txt`; native `.deb`
packaging remains future work.

For diagnosis, the packaged executable accepts `--update-status` and
`--update-check`. The latter uses the same download and install-on-exit path as
the GUI. `--update-info` reports the executable's own bundle version without
delegating to a newer cached version.

## Building on Ubuntu 24.04 x86_64

Use Python 3.13.14 and Node.js 24. Install the desktop libraries and test tools:

```sh
sudo apt-get update
sudo apt-get install -y xvfb xauth dbus-x11 gnome-keyring desktop-file-utils \
  libegl1 libgl1 libopengl0 libnss3 libasound2t64 libxkbcommon-x11-0 \
  libxcb-cursor0 libxcb-icccm4 libxcb-keysyms1 libxcb-shape0 libxcb-xinerama0 \
  libxcomposite1 libxdamage1 libxrandr2 libxtst6 libxss1
python3.13 -m venv .venv
.venv/bin/python -m pip install -r packaging/requirements-linux.lock
.venv/bin/python -m pip install --no-deps -e .
```

Install frontend dependencies in `cad-web` with `npm ci`. From the repository root:

```sh
.venv/bin/python tools/build.py --headless
.venv/bin/python tools/build_appimage.py --headless
```

The first command builds the frontend and freezes and verifies `dist/Steve`.
The second creates a relocatable AppDir with version metadata, verifies it, and
packages and tests the actual AppImage. Its tarball is also the Linux update
bundle. It downloads appimagetool and the AppImage runtime from official
versioned releases and verifies their SHA-256 hashes against
`packaging/appimage-tools.json` before execution. A changed download fails closed;
update those pins deliberately when upgrading the packaging tools.

Outputs in `dist/linux/`:

- `Steve-<version>-linux-x86_64.AppImage`
- `Steve-<version>-linux-x86_64.tar.gz`
- `SHA256SUMS`
- `build-info.json`, recording the source commit, dirty-tree status, Python,
  glibc, tool pins and successful package checks.

SHA256SUMS records integrity checksums, not a release signature. Publication and
signing are separate release steps. These scripts do not publish releases.

The checked-in Linux lock includes runtime and PyInstaller build dependencies.
Refresh it deliberately from a fresh environment after changing `requirements.txt`:

```sh
uv pip freeze --python .venv/bin/python --exclude-editable > packaging/requirements-linux.lock
```

Do not regenerate it from the Windows environment. The Git-pinned CadQuery fork
must remain pinned to the same commit in both dependency files.

## Verification

Package checks compare bundled Python/frontend/vendor/skill content with source,
wait for the React frontend to render in Qt WebEngine, exercise offline assistant
tools, and test frozen MCP discovery, CAD build/inspect/STEP export, cancellation,
worker crashes and recovery. The AppImage itself repeats frontend and MCP tests
in extraction mode. Logs and evidence are written to `build/verification/`.

Automatic updates have a separate two-version integration check. Build an older
private fixture without editing the working checkout, then exercise both launch
formats against a real local HTTPS feed:

```sh
.venv/bin/python tools/build_update_fixture.py --version 0.3.4 --appimage
.venv/bin/python tools/linux_session.py -- .venv/bin/python checks/check_linux_updates.py \
  --old-package build/update-fixture/dist/Steve \
  --old-appimage build/update-fixture/dist/linux/Steve-0.3.4-linux-x86_64.AppImage \
  --new-bundle dist/linux/Steve-0.4.3-linux-x86_64.tar.gz
```

The check uses disposable signing/TLS keys and a private test profile. It verifies
the actual old executable downloading a signed newer tarball over verified TLS,
automatic activation after process exit, relaunch through the original package,
preserved projects, unchanged launcher bytes and rollback after deliberate bundle
corruption. It also checks that feed credentials do not reach the artifact host.
The result is `build/verification/linux-auto-updates.json`. Fixtures stay under
the ignored `build/` directory and are never published.

`tools/linux_session.py` creates a disposable home, keyring, D-Bus session and
Xvfb display. It uses software rendering for the headless checks and leaves the
Chromium sandbox enabled. It does not touch the developer's real credentials or
profile. These checks do not certify native Wayland, physical GPU performance,
clipboard interoperability, or browser sign-in on a real desktop.

The GitHub Actions workflow `.github/workflows/linux-package.yml` runs the same
build and verification on Ubuntu 24.04, then launches the AppImage in a clean
Ubuntu runtime container using `packaging/linux/Dockerfile.runtime-check`.
The container has desktop libraries and test helpers, with no Python 3.13,
development environment or CAD packages; Steve uses its bundled runtime.
The workflow uploads successful packages and verification logs. It can be started
manually or runs for pull requests changing packaging or application code.

References: [PyInstaller Linux compatibility](https://pyinstaller.org/en/stable/usage.html#making-gnu-linux-apps-forward-compatible),
[symbolic links in frozen applications](https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html#requirements-imposed-by-symbolic-links-in-frozen-application),
[AppImage packaging](https://docs.appimage.org/packaging-guide/manual.html).
