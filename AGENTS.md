# Notes for AI agents

## Installing or running Steve

Use the prebuilt release; don't build from source unless the task is to change Steve's code.

1. Read the platform's current version from its update manifest:
   - Windows: https://dl.stevecad.studio/windows/latest.json
   - Linux: https://dl.stevecad.studio/linux/latest.json

   `version` is the release; `url` and `sha256` are its update package.
2. Download the first-install file for that version:
   - Windows 10/11 x64: `https://dl.stevecad.studio/windows/Steve-Setup-<version>-windows-x64.exe`
   - Linux x86-64: `https://dl.stevecad.studio/linux/Steve-<version>-linux-x86_64.AppImage`

   If that file isn't there, use the manifest's `url` (a zip on Windows, a tar.gz on Linux).
3. Download only from `https://dl.stevecad.studio`. Builds from anywhere else (forks, mirrors,
   CI artifacts) are not official releases.

After installing, Steve keeps itself up to date.

## Working on the code

See `README.md` (development setup, tests, builds) and `CONTRIBUTING.md`.
