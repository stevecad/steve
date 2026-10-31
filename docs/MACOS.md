# Running from source on macOS

Apple Silicon only (M-series, native arm64). This is a source checkout of the
desktop app. It is not a Mac application bundle, and it is not a supported
release target. Windows and Linux packages are unchanged.

## Prerequisites

- An Apple Silicon Mac running macOS 14 or later. The pinned PySide6 wheels are
  tagged `macosx_14_0`. Intel Macs, and Apple Silicon running under Rosetta,
  are not a target: `update_platform()` stays `None` there.
- Python 3.13 (`python3.13` from python.org or Homebrew). The project requires
  Python 3.13 (`requires-python` in `pyproject.toml`).
- Node.js with npm, to build the frontend in `cad-web`.
- A logged-in macOS user whose login keychain is available. Encrypted settings
  use Keychain through the `keyring` package. There is no plaintext credential
  fallback. The process must be able to read and write the `Steve` keychain item.
- Blender 4.5 LTS, only if you open Blender scenes. CAD itself does not need
  Blender. Download the macOS Apple Silicon build from blender.org and drag
  `Blender.app` to `/Applications` or to `~/Applications`.

## Install

From the source checkout:

```sh
python3.13 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m pip install --no-deps -e .
npm ci --prefix cad-web
npm run --prefix cad-web build
```

`requirements.txt` installs the desktop host, the pinned CadQuery fork, and
`cadquery-ocp`. The editable install does not pull those dependencies again.

## Run

```sh
.venv/bin/python -m steve_desktop
```

User data is stored in `~/Library/Application Support/Steve` (via `platformdirs`),
separate from the checkout. Replacing the checkout does not delete projects.
The encryption key stays in the login keychain.

Confirm the platform id. On native Apple Silicon this prints `macos-arm64 False`:

```sh
.venv/bin/python -c "from steve_desktop.local_updates import update_platform, supports_portable_updates; print(update_platform(), supports_portable_updates())"
```

`macos-arm64` follows the existing ids `windows-x64` and `linux-x64`: an
operating-system name plus an architecture. `False` means portable updates are
off. Focused tests:

```sh
.venv/bin/python -m unittest tests.test_blender_runtime tests.test_launch_services
```

The offline smoke check needs a GUI session and the keychain:

```sh
.venv/bin/python -m steve_desktop --smoke-test
```

## How Blender is found

Settings → Local Blender, or startup discovery, probes candidates in this order
and keeps the first executable that reports Blender 4.5:

1. The path saved in settings.
2. `STEVE_BLENDER`, when set to the executable.
3. A previously unpacked `blender-4.5.*` directory under
   `~/Library/Application Support/Steve/runtimes/blender`.
4. `blender` on `PATH` (for example a Homebrew binary).
5. `/Applications/Blender.app/Contents/MacOS/Blender`
6. `~/Applications/Blender.app/Contents/MacOS/Blender`

The standard install is the `.app` bundle. The binary inside it is
`Contents/MacOS/Blender`, not the `.app` folder itself. Other versions are
rejected. If the app was renamed (for example `Blender 4.5.app`), set
`STEVE_BLENDER` or the settings path to that bundle's `Contents/MacOS/Blender`.

Automatic installation is unavailable on macOS. There is no pinned Darwin
archive in the runtime downloader. Windows and Linux keep their existing
packages. Install Blender.app yourself.

## Known limitations

- No `.app` bundle. You run `python -m steve_desktop` from the checkout.
- No code signing and no notarization.
- No Mac update feed. `supports_portable_updates()` is false on `macos-arm64`,
  so Steve does not download or install updates. Update by pulling this
  checkout and rebuilding the frontend when it changes. Windows and Linux feeds
  are unchanged.
- Desktop features that need a platform id, including Studio bug reports, send
  `macos-arm64`. This checkout only stops the desktop from treating Apple
  Silicon as an unknown platform. Studio has to accept that id on its side.
- Intel macOS (`x86_64`), including Rosetta, stays unidentified.
- Blender 4.5 is not downloaded for you.
- This path is not built or tested by the existing Windows and Linux CI.
- Git import of a repository under `/tmp` fails on macOS with "Repository source path escapes its document folder" because `/tmp` and `/var` are symlinks to `/private`. An upstream fix for symlinks above the checkout is already open; it is not in this branch.
