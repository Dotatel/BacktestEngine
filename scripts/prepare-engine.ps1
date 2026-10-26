param([string]$DotnetPath = 'dotnet')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-env.ps1')
$projectDirectory = Split-Path -Parent $PSScriptRoot
$engineProject = Join-Path $projectDirectory 'engines\csharp\src\BacktestEngine.Run\BacktestEngine.Run.csproj'
$engineOutput = Join-Path $projectDirectory 'src-tauri\resources\engine'
& $DotnetPath publish $engineProject -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false -o $engineOutput
if ($LASTEXITCODE -ne 0) { throw 'C# engine publishing failed.' }
& (Join-Path $engineOutput 'BacktestEngine.Run.exe') --describe-strategy ExampleStrategy
if ($LASTEXITCODE -ne 0) { throw 'The bundled C# engine did not return strategy metadata.' }

# Stage the preserved engine source (retained engines stay untouched) for source-linked
# workspace builds bundled as read-only app resources: only .cs and .csproj files.
$sourceRoot = Join-Path $projectDirectory 'engines\csharp\src'
$stagedRoot = [System.IO.Path]::GetFullPath((Join-Path $projectDirectory 'src-tauri\resources\enginesrc'))
$expectedStagedRoot = Join-Path (Resolve-Path -LiteralPath $projectDirectory).Path 'src-tauri\resources\enginesrc'
if ($stagedRoot -ne $expectedStagedRoot) { throw 'Engine source staging must stay inside the project resources directory.' }
foreach ($stageBoundary in @((Join-Path $projectDirectory 'src-tauri'), (Join-Path $projectDirectory 'src-tauri\resources'), $stagedRoot)) {
    if ((Test-Path -LiteralPath $stageBoundary) -and ((Get-Item -LiteralPath $stageBoundary).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'Engine source staging cannot pass through a link or junction.'
    }
}
if (Test-Path -LiteralPath $stagedRoot) {
    $resolvedStagedRoot = (Resolve-Path -LiteralPath $stagedRoot).Path
    if ($resolvedStagedRoot -ne $expectedStagedRoot) { throw 'Refusing to clear an unexpected staging directory.' }
    Remove-Item -LiteralPath $resolvedStagedRoot -Recurse -Force
}
$engineProjectNames = @('BacktestEngine.Run', 'BacktestEngine.CAlgoShim')
foreach ($projectName in $engineProjectNames) {
    $sourceDirectory = Join-Path $sourceRoot $projectName
    $stagedDirectory = Join-Path $stagedRoot $projectName
    New-Item -ItemType Directory -Force -Path $stagedDirectory | Out-Null
    Get-ChildItem -LiteralPath $sourceDirectory -Include *.cs, *.csproj -Recurse -File |
        Where-Object { $_.FullName -notmatch '\\(bin|obj)\\' } |
        ForEach-Object {
            $relative = $_.FullName.Substring($sourceDirectory.Length).TrimStart('\')
            $destination = Join-Path $stagedDirectory $relative
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
            Copy-Item -LiteralPath $_.FullName -Destination $destination
        }
}
$stagedCount = (Get-ChildItem -LiteralPath $stagedRoot -Include *.cs, *.csproj -Recurse -File).Count
if ($stagedCount -eq 0) { throw 'The preserved engine source staging produced no files.' }
New-Item -ItemType Directory -Force -Path (Join-Path $stagedRoot 'examples') | Out-Null
Copy-Item (Join-Path $sourceRoot '..\examples\ExampleStrategy.cs') (Join-Path $stagedRoot 'examples\ExampleStrategy.cs')
