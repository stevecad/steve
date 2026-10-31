param([string]$Python='python')
$ErrorActionPreference='Stop'
$project=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath (Join-Path $project 'cad-web')
try { npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' } } finally { Pop-Location }
Push-Location -LiteralPath $project
try {
    # The sketch solver's Node runtime is downloaded and SHA-256 verified, never committed.
    & $Python (Join-Path $project 'tools/fetch_node.py')
    if ($LASTEXITCODE -ne 0) { throw 'Node.js runtime download or verification failed' }
    # Analysis may have read a module before an edit made during a previous build.
    # Do not let its subsequently newer PYZ timestamp hide that changed module.
    $archiveToc=Join-Path $project 'build/Steve/PYZ-00.toc'
    if (Test-Path -LiteralPath $archiveToc) { Remove-Item -LiteralPath $archiveToc }
    & $Python -m PyInstaller --noconfirm --distpath dist --workpath build packaging/Steve.spec
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
    & $Python (Join-Path $project 'checks/check_package.py') (Join-Path $project 'dist/Steve')
    if ($LASTEXITCODE -ne 0) { throw 'Packaged verification failed' }
} finally { Pop-Location }
