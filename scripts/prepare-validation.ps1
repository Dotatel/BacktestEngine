<#
.SYNOPSIS
Stage the unchanged preserved Python package for offline report-only validation.
.DESCRIPTION
Copies only package Python sources and verifies hashes. Swaps app-owned staging folders
with rollback; refuses links or unexpected destinations before any recursive removal.
#>
param([string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$projectFull = [System.IO.Path]::GetFullPath($ProjectRoot)
$source = Join-Path $projectFull 'engines\validation\ValidationEngine'
$resources = Join-Path $projectFull 'src-tauri\resources'
$target = Join-Path $resources 'validation'
$staging = Join-Path $resources ('validation-stage-' + [guid]::NewGuid().ToString('N'))
$backup = Join-Path $resources ('validation-backup-' + [guid]::NewGuid().ToString('N'))

# Verify the actual target boundary before copying, moving or recursively removing anything.
function Assert-AppOwnedPath([string]$Path) {
    $resolved = [System.IO.Path]::GetFullPath($Path)
    if ((Split-Path -Parent $resolved) -ne $resources -or (Split-Path -Leaf $resolved) -notmatch '^validation(?:-(?:stage|backup)-[a-f0-9]{32})?$') {
        throw "Refusing unexpected validation destination: $resolved"
    }
    foreach ($ancestor in @($resources, (Split-Path -Parent $resources), $resolved)) {
        if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing linked validation destination: $ancestor"
        }
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $source 'Cli.py'))) { throw 'Preserved ValidationEngine/Cli.py was not found.' }
New-Item -ItemType Directory -Path $resources -Force | Out-Null
Assert-AppOwnedPath $target
Assert-AppOwnedPath $staging
Assert-AppOwnedPath $backup
$packageTarget = Join-Path $staging 'ValidationEngine'
New-Item -ItemType Directory -Path $packageTarget | Out-Null
$files = Get-ChildItem -LiteralPath $source -Filter '*.py' -File -Recurse
try {
    foreach ($file in $files) {
        if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing linked package source: $($file.FullName)" }
        $relative = [IO.Path]::GetRelativePath($source, $file.FullName)
        $destination = Join-Path $packageTarget $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $destination
        if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash) { throw "Staged source hash mismatch: $relative" }
    }
    if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $backup }
    try { Move-Item -LiteralPath $staging -Destination $target }
    catch {
        if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $target }
        throw
    }
    if (Test-Path -LiteralPath $backup) { Assert-AppOwnedPath $backup; Remove-Item -LiteralPath $backup -Recurse -Force }
    Write-Output "Staged $($files.Count) unchanged Python sources in $target"
} finally {
    if (Test-Path -LiteralPath $staging) { Assert-AppOwnedPath $staging; Remove-Item -LiteralPath $staging -Recurse -Force }
}
