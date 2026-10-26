$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-env.ps1')
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    if (-not (Test-Path -LiteralPath 'src-tauri\resources\engine\BacktestEngine.Run.exe')) {
        & (Join-Path $PSScriptRoot 'prepare-engine.ps1')
    }
    pnpm tauri dev
    if ($LASTEXITCODE -ne 0) { throw 'The desktop app failed to start.' }
} finally { Pop-Location }
