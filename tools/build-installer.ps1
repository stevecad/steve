param(
    [Parameter(Mandatory=$true)][string]$Compiler,
    [string]$PackageDir,
    [string]$OutputDir,
    [string]$Version='0.4.3'
)
$ErrorActionPreference='Stop'
$project=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $PackageDir) { $PackageDir=Join-Path $project 'dist/Steve' }
if (-not $OutputDir) { $OutputDir=Join-Path $project 'dist/installer' }
$PackageDir=(Resolve-Path -LiteralPath $PackageDir).Path
if (-not (Test-Path -LiteralPath (Join-Path $PackageDir 'Steve.exe'))) { throw 'Build and verify Steve.exe first' }
& $Compiler "/DPackageDir=$PackageDir" "/DReleaseDir=$OutputDir" "/DAppVersion=$Version" (Join-Path $project 'packaging/Steve.iss')
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed' }
