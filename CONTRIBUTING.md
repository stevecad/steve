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
