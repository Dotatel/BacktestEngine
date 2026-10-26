#requires -Version 7.0
<#
.SYNOPSIS
Package an exact prebuilt review executable without sharing mutable Cargo build output.
.DESCRIPTION
Requires the executable SHA256 and a review app folder containing all five resource
groups. Resources must match the current Tauri resource inputs before and after
bundling. Uses Tauri's bundle-only command and a fresh isolated target directory.
This does not build, install, sign, publish or establish product acceptance.
#>
param(
    [Parameter(Mandatory)][string]$ApplicationDirectory,
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExecutableSha256
)
$ErrorActionPreference = 'Stop'
$packageProject = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$resourceGroups = @('engine', 'enginesrc', 'validation', 'optimizer', 'runtimes')

<# .SYNOPSIS Refuse linked ancestors and require the requested existing local filesystem object. #>
function Assert-PackagePath([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $ancestor = $absolute
    while ($ancestor) {
        $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Redirected packaging path: $ancestor" }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    return $absolute
}

<# .SYNOPSIS Hash one complete resource group, rejecting links and recording exact relative names and bytes. #>
function Get-PackageGroupRecords([string]$Directory, [string]$Group) {
    $root = Assert-PackagePath (Join-Path $Directory $Group)
    if (-not [IO.Directory]::Exists($root)) { throw "Missing frozen resource group: $root" }
    $records = [Collections.Generic.List[string]]::new()
    foreach ($item in Get-ChildItem -LiteralPath $root -Recurse -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Redirected resource: $($item.FullName)" }
        if ($item.PSIsContainer) { continue }
        $relative = [IO.Path]::GetRelativePath($root, $item.FullName).Replace('\', '/')
        $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $records.Add("$Group/$relative=$hash")
    }
    if (-not $records.Count) { throw "Empty frozen resource group: $Group" }
    return $records.ToArray()
}

<# .SYNOPSIS Produce a deterministic aggregate digest over every declared resource, with no implicit exclusions. #>
function Get-PackageResourceIdentity([string]$Directory) {
    $records = [Collections.Generic.List[string]]::new()
    foreach ($group in $resourceGroups) { $records.AddRange([string[]](Get-PackageGroupRecords $Directory $group)) }
    $records.Sort([StringComparer]::Ordinal)
    $bytes = [Text.Encoding]::UTF8.GetBytes(($records -join "`n"))
    return [pscustomobject]@{ count = $records.Count; sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() }
}

<# .SYNOPSIS Fail when the Tauri inputs differ from the frozen resources actually reviewed. #>
function Assert-PackageResourceIdentity($Expected, [string]$Directory) {
    $actual = Get-PackageResourceIdentity $Directory
    if ($actual.count -ne $Expected.count -or $actual.sha256 -ne $Expected.sha256) { throw 'Tauri resources differ from the frozen reviewed resources; rebuild and verify a new candidate.' }
}

$applicationRoot = Assert-PackagePath $ApplicationDirectory
$application = Join-Path $applicationRoot 'BacktestEngine.exe'
if ((Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash -ne $ExecutableSha256) { throw 'The review executable differs from the required SHA256.' }
$frozenResources = Get-PackageResourceIdentity $applicationRoot
$resourceSource = Join-Path $packageProject 'src-tauri/resources'
Assert-PackageResourceIdentity $frozenResources $resourceSource

$packageRoot = Assert-PackagePath (Join-Path $packageProject ('artifacts/frozen-packaging/' + [guid]::NewGuid().ToString('N')))
if (Test-Path -LiteralPath $packageRoot) { throw 'Packaging destination already exists.' }
$target = Join-Path $packageRoot 'target'
$binary = Join-Path $target 'debug/dotatel-backtest-engine.exe'
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($binary))
[IO.File]::Copy($application, $binary, $false)
if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $ExecutableSha256) { throw 'Frozen executable copy failed its SHA256 check.' }

$packageRecord = [ordered]@{
    version = 1
    status = 'preparing'
    application = $application
    executableSha256 = $ExecutableSha256.ToLowerInvariant()
    resources = $frozenResources
    isolatedTarget = $target
    binaryPatching = $false
    productAcceptanceEstablished = $false
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
}
$recordPath = Join-Path $packageRoot 'packaging.json'
$packageRecord | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $recordPath -Encoding utf8NoBOM
$previousTarget = $env:CARGO_TARGET_DIR
Push-Location $packageProject
try {
    . (Join-Path $PSScriptRoot 'windows-env.ps1')
    $env:CARGO_TARGET_DIR = $target
    # This public CLI operation consumes the tested binary; it never compiles current source.
    & pnpm tauri bundle --debug --bundles nsis --no-binary-patching --no-sign *> (Join-Path $packageRoot 'bundle.log')
    if ($LASTEXITCODE -ne 0) { throw "Tauri bundling failed. Evidence: $packageRoot" }
    if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $ExecutableSha256) { throw 'Bundling changed the frozen executable.' }
    Assert-PackageResourceIdentity $frozenResources $resourceSource
    $installers = @(Get-ChildItem -LiteralPath (Join-Path $target 'debug/bundle/nsis') -Filter '*-setup.exe' -File)
    if ($installers.Count -ne 1) { throw 'Expected exactly one new NSIS installer.' }
    $packageRecord.status = 'packaged'
    $packageRecord.installer = $installers[0].FullName
    $packageRecord.installerSha256 = (Get-FileHash -LiteralPath $installers[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $packageRecord.installerBytes = $installers[0].Length
} catch {
    $packageRecord.status = 'failed'
    $packageRecord.error = $_.Exception.Message
    throw
} finally {
    $env:CARGO_TARGET_DIR = $previousTarget
    Pop-Location
    $packageRecord | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $recordPath -Encoding utf8NoBOM
}
$packageRecord | ConvertTo-Json -Depth 8
