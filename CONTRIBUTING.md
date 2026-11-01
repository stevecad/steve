# Contributing to Steve

Thank you for helping. Contributions are accepted under the Apache License 2.0
(see `LICENSE`); by submitting a change you agree it may be distributed under it.

## Set up (Windows, PowerShell in the source folder)

```powershell
py -3.13 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m pip install --no-deps -e .
cd cad-web; npm ci; npm run build; cd ..
.venv\Scripts\python.exe -m steve_desktop
```

You need Python 3.13 and Node.js with npm. On Linux use the same steps with
`python3.13` and `.venv/bin/python`; see `docs/LINUX.md` for system packages
(a working Secret Service is required; there is no plaintext credential fallback).
On Apple Silicon use the same steps; see `docs/MACOS.md`.

## Tests

Run focused tests with `python -m unittest tests.<test_module>`, for example
`python -m unittest tests.test_service tests.test_runtime tests.test_features`,
and the offline desktop smoke check with `python -m steve_desktop --smoke-test`.
Interactive and packaging checks live in `checks/`; each describes its own inputs.
Run the tests that cover the files you change before opening a pull request.

## Build

`powershell -File tools/build.ps1 -Python .venv\Scripts\python.exe` (Windows) or
`python tools/build.py` builds and verifies the frozen app in `dist/Steve/`.
The Windows build downloads the sketch solver's Node.js runtime with
`tools/fetch_node.py` and checks its pinned SHA-256; it is never committed.
`docs/environment-lock.txt` records a verified Windows build environment;
`docs/INSTALLER.md` and `docs/LINUX.md` cover installers and Linux bundles.

## Guidelines

- Keep user data out of the repository: profiles, credentials, CAD documents,
  environments and build output are ignored on purpose.
- Vendored code (`vendor/`, `pdf-fonts/`, `bundled-skills/`) keeps its original
  notices. Read `docs/UPSTREAM.txt` before changing it, and record third-party
  additions in `THIRD-PARTY-LICENSES/`.
- Never add real signing keys, tokens or personal data, including in tests;
  use disposable keys and neutral example names.
- The STEVE name and logo are trademarks and are not licensed under Apache 2.0
  (see `README.md`).

## Issues and pull requests

Steve Desktop is a local CAD app, and it gets fixes for things that don't work. We don't add new features to it; for
more features, try Steve Studio (https://stevecad.studio). Support for a new platform (another operating system or
architecture) is welcome, but please open an issue to discuss it before you start: a maintainer decides each one.

**One problem per issue.** If you've found several things, open one issue for each. An issue that covers several
unrelated problems will be asked to be split before anything else happens.

**One change per pull request.** Keep each pull request to a single fix with its tests, and within these limits:

- at most **400 changed lines** (additions plus deletions), and
- at most **25 changed files**.

Lockfiles, vendored code (`vendor/`, `pdf-fonts/`, `bundled-skills/`, `THIRD-PARTY-LICENSES/`) and generated files
don't count toward either limit. A pull request over a limit, or one that bundles unrelated changes, will be asked to be
split; it stays open meanwhile.

Pull requests contain **text files only**: no binaries, images, archives, fonts, compiled or minified files, and no
long encoded strings. Changes to dependencies, `.github/` workflows, packaging and installers, the updater and its
signing, the version, or vendored code are reviewed by a maintainer by hand; please open an issue first if you'd like
to change any of those. Every pull request is reviewed and merged by a person.
