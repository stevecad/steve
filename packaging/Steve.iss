; Build with tools/build-installer.ps1 after the desktop package passes checks.
#ifndef PackageDir
  #define PackageDir "..\dist\Steve"
#endif
#ifndef ReleaseDir
  #define ReleaseDir "..\dist\installer"
#endif
#ifndef AppVersion
  #define AppVersion "0.4.3"
#endif
#ifndef InstallerAppId
  #define InstallerAppId "{{759EF3A7-5048-44D4-B75C-3BDF8DE3FB66}"
#endif
#ifndef InstallerAppName
  #define InstallerAppName "Steve"
#endif

[Setup]
AppId={#InstallerAppId}
AppName={#InstallerAppName}
AppVersion={#AppVersion}
AppPublisher=Steve
DefaultDirName={localappdata}\Programs\Steve
DefaultGroupName=Steve
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.22000
OutputDir={#ReleaseDir}
OutputBaseFilename=Steve-Setup-{#AppVersion}-windows-x64
SetupIconFile=..\assets\steve.ico
UninstallDisplayIcon={app}\Steve.exe
UninstallFilesDir={app}\uninstall
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
DisableWelcomePage=no
WizardImageFile=..\assets\installer-banner.bmp
WizardSmallImageFile=..\assets\installer-icon.bmp
VersionInfoDescription=Steve CAD desktop installer

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#PackageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#InstallerAppName}"; Filename: "{app}\Steve.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\{#InstallerAppName}"; Filename: "{app}\Steve.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Steve.exe"; Description: "Open Steve"; Flags: nowait postinstall skipifsilent unchecked

[UninstallDelete]
; This directory contains only bundled application dependencies, never profiles.
Type: filesandordirs; Name: "{app}\_internal"

[Code]
function SteveRunning: Boolean;
var Services, Processes, Process: Variant;
    I: Integer;
begin
  Result := False;
  try
    Services := CreateOleObject('WbemScripting.SWbemLocator');
    Services := Services.ConnectServer('', 'root\cimv2');
    Processes := Services.ExecQuery('SELECT ExecutablePath FROM Win32_Process WHERE Name=''Steve.exe''');
    for I := 0 to Processes.Count - 1 do begin
      Process := Processes.ItemIndex(I);
      if not VarIsNull(Process.ExecutablePath) then
        if CompareText(Process.ExecutablePath, ExpandConstant('{app}\Steve.exe')) = 0 then Result := True;
    end;
  except
    // File-in-use checks still prevent replacing locked binaries.
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if CompareText(ExtractFileName(RemoveBackslash(ExpandConstant('{app}'))), 'Steve') <> 0 then
    Result := 'Choose an installation folder named Steve so automatic updates can work.'
  else if SteveRunning then
    Result := 'Save your work and close Steve before installing. Setup will not close it for you.';
end;

function InitializeUninstall: Boolean;
begin
  Result := not SteveRunning;
  if not Result then
    MsgBox('Save your work and close Steve before uninstalling. Your CAD documents and account settings will be kept.', mbInformation, MB_OK);
end;
