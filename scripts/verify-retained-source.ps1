#requires -Version 7.0
<#
.SYNOPSIS
Fail when any captured original C# or Python source differs from its recorded SHA256.
.DESCRIPTION
Reads the checked-in provenance manifest and files only. This establishes source
preservation for the captured set, not trading correctness or numerical parity.
#>
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$manifest = Get-Content -LiteralPath (Join-Path $project 'docs/retained-source.json') -Raw | ConvertFrom-Json
if ($manifest.count -le 0 -or $manifest.files.Count -ne $manifest.count) {
    throw 'The retained-source manifest has an invalid file count.'
}
$boundary = (Join-Path $project 'engines') + [IO.Path]::DirectorySeparatorChar
$identities = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $manifest.files) {
    $path = [IO.Path]::GetFullPath((Join-Path $project $entry.file))
    if (-not $path.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase) -or -not $identities.Add($path)) {
        throw "The retained-source manifest contains an invalid or duplicate path: $($entry.file)"
    }
    if ($entry.sha256 -notmatch '^[a-f0-9]{64}$') {
        throw "The retained-source manifest has an invalid hash: $($entry.file)"
    }
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    if ($actual -ne $entry.sha256) { throw "Retained source changed: $($entry.file)" }
}
Write-Output "Retained source integrity passed: $($manifest.count)/$($manifest.count) captured files match SHA256."
