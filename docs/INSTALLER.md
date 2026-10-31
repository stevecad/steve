# Windows installer

The per-user installer targets Windows 11 x64. It installs to
`%LOCALAPPDATA%/Programs/Steve`, creates a Start menu shortcut, offers an optional
desktop shortcut, and registers an uninstaller in Windows Settings.

CAD profiles stay in `%LOCALAPPDATA%/Steve/CAD`. Uninstall preserves profiles,
credentials, documents, memory, and workspace files. Existing legacy profiles
are copied on first launch, with the originals retained for recovery.

Setup refuses to replace a running copy at the destination. Save and close Steve
first. Silent installation never force-closes Steve. The installation folder
must be named `Steve` for automatic updates to work.

Build the desktop with `tools/build.ps1`, then compile with Inno Setup 7:

```powershell
./tools/build-installer.ps1 -Compiler 'C:/path/to/ISCC.exe'
```

`-PackageDir`, `-OutputDir`, and `-Version` can override the defaults. Regenerate
installer artwork from the existing vector logo with `python tools/build_installer_art.py`.
Inno Setup: https://jrsoftware.org/ (compiler license permits commercial use).

Repeat package checks using the development Python environment:

```powershell
python checks/check_package.py dist/Steve
python checks/check_frozen_cad.py dist/Steve/Steve.exe
```

The current installer is an unsigned pre-release for evaluation. Production
Authenticode signing requires the release owner's certificate/service. No
certificate is fabricated. Updates come from https://dl.stevecad.studio and must be
signed by a key listed in `assets/update-channel.json` (the app has no setting to
change either). See UPDATE-FEED.txt for signed update manifests.

Portable updates preserve installer-owned `uninstall/` records. Update ZIPs must
not contain that directory. Uninstall removes bundled dependencies added by later
updates while retaining the separate CAD profile. Upgrade/repair installation is
supported at the same application directory.
