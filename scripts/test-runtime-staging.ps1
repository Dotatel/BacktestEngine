#requires -Version 7.0
<# .SYNOPSIS Exercise staging boundaries, archive integrity, rollback and manifest preservation using synthetic temporary files. #>
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'prepare-runtimes.ps1'
$tokens = $null
$parseErrors = $null
$tree = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors.Message -join "`n") }
$functions = $tree.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)
. ([scriptblock]::Create(($functions | ForEach-Object { $_.Extent.Text }) -join "`n"))

<# .SYNOPSIS Fail a focused synthetic assertion without introducing a test framework dependency. #>
function Assert-RuntimeCheck([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

<# .SYNOPSIS Require a boundary operation to reject input with its actionable diagnostic. #>
function Assert-RuntimeThrows([scriptblock]$Operation, [string]$Contains) {
    $message = ''
    try { & $Operation | Out-Null }
    catch { $message = $_.Exception.Message }
    Assert-RuntimeCheck ($message.Contains($Contains)) "Expected rejection containing '$Contains', got '$message'."
}

<# .SYNOPSIS Write one synthetic ZIP entry; these archives are never accepted as official runtimes. #>
function Write-SyntheticZipEntry([IO.Compression.ZipArchive]$Zip, [string]$Name, [string]$Text) {
    $stream = $Zip.CreateEntry($Name).Open()
    try { $stream.Write([Text.Encoding]::UTF8.GetBytes($Text)) }
    finally { $stream.Dispose() }
}

<# .SYNOPSIS Create a tiny archive for traversal/hash/full-tree tests with deterministic entry content. #>
function New-SyntheticRuntimeZip([string]$Path, [hashtable]$Entries) {
    $zip = [IO.Compression.ZipFile]::Open($Path, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in $Entries.Keys) { Write-SyntheticZipEntry $zip $name $Entries[$name] }
    } finally { $zip.Dispose() }
}

$temporary = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temporary)
$junction = Join-Path $temporary 'linked'
try {
    $runtimeRoot = Join-Path $temporary 'runtime'
    $scratch = Join-Path $temporary 'scratch'
    [void][IO.Directory]::CreateDirectory($runtimeRoot)
    [void][IO.Directory]::CreateDirectory($scratch)
    Assert-RuntimeThrows { Assert-RuntimeChild ($runtimeRoot + '-sibling/file') $runtimeRoot } 'outside'
    Assert-RuntimeThrows { Assert-RuntimeChild (Join-Path $runtimeRoot '../escape') $runtimeRoot } 'outside'
    Assert-RuntimeThrows { Assert-RuntimeChild $runtimeRoot $runtimeRoot } 'outside'

    $archive = Join-Path $temporary 'synthetic.zip'
    New-SyntheticRuntimeZip $archive @{ 'python.exe' = 'synthetic executable'; 'LICENSE.txt' = 'synthetic license' }
    $stage = Join-Path $scratch 'verified'
    $inventory = Get-RuntimeArchiveInventory $archive $stage 1MB
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $stage)
    Assert-RuntimeCheck (Test-RuntimeTreeMatches $stage $inventory) 'Exact synthetic archive extraction must match.'
    [IO.File]::WriteAllText((Join-Path $stage 'LICENSE.txt'), 'changed')
    Assert-RuntimeCheck (-not (Test-RuntimeTreeMatches $stage $inventory)) 'Changed files must invalidate the whole-tree check.'
    Assert-RuntimeThrows { Get-RuntimeArchive @{ ArchiveName = 'synthetic.zip'; MaxArchiveBytes = 1MB; Algorithm = 'SHA256'; Hash = ('0' * 64) } $archive $temporary $scratch } 'hash mismatch'
    $escape = Join-Path $temporary 'escape.zip'
    New-SyntheticRuntimeZip $escape @{ '../escape.txt' = 'not allowed' }
    Assert-RuntimeThrows { Get-RuntimeArchiveInventory $escape (Join-Path $scratch 'escaped') 1MB } 'outside'
    Assert-RuntimeThrows { Assert-RuntimeByteLimit 1025 1024 } 'byte limit'
    $oversizedStream = [IO.MemoryStream]::new([byte[]]::new(1025))
    try { Assert-RuntimeThrows { Copy-RuntimeDownload $oversizedStream (Join-Path $scratch 'bounded-download') 1024 ([Threading.CancellationToken]::None) } 'byte limit' }
    finally { $oversizedStream.Dispose() }
    Assert-RuntimeCheck ((Get-Item -LiteralPath (Join-Path $scratch 'bounded-download')).Length -eq 0) 'Oversized body bytes must be rejected before the first disk write.'

    $target = Join-Path $temporary 'outside-sentinel'
    [void][IO.Directory]::CreateDirectory($target)
    [IO.File]::WriteAllText((Join-Path $target 'keep.txt'), 'keep')
    New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
    Assert-RuntimeThrows { Assert-RuntimeAncestors (Join-Path $junction 'child') } 'redirected'
    Assert-RuntimeThrows { Assert-RuntimeTree $temporary } 'linked'
    [void](Assert-RuntimeChild $junction $temporary)
    Remove-Item -LiteralPath $junction -Force
    Assert-RuntimeCheck ([IO.File]::ReadAllText((Join-Path $target 'keep.txt')) -eq 'keep') 'Removing the test junction must not change its target.'

    $destination = Join-Path $runtimeRoot 'python'
    $next = Join-Path $scratch 'python-next'
    [void][IO.Directory]::CreateDirectory($destination)
    [void][IO.Directory]::CreateDirectory($next)
    [IO.File]::WriteAllText((Join-Path $destination 'identity.txt'), 'old')
    [IO.File]::WriteAllText((Join-Path $next 'identity.txt'), 'new')
    $plan = @{ Name = 'python'; Replace = $true; Stage = $next; Destination = $destination; Backup = (Join-Path $scratch 'python-previous'); Failed = (Join-Path $scratch 'python-failed') }
    [void][IO.Directory]::CreateDirectory((Join-Path $runtimeRoot 'manifest.json'))
    Assert-RuntimeThrows { Publish-RuntimeTransaction @($plan) @{ python = @{ version = 'synthetic' } } $runtimeRoot $scratch } 'exist'
    Assert-RuntimeCheck ([IO.File]::ReadAllText((Join-Path $destination 'identity.txt')) -eq 'old') 'A manifest-publication failure must restore the prior component.'
    Assert-RuntimeCheck ([IO.File]::ReadAllText((Join-Path $plan.Failed 'identity.txt')) -eq 'new') 'Rollback must retain the uncommitted replacement outside resources.'

    $project = Join-Path $temporary 'project'
    [void][IO.Directory]::CreateDirectory((Join-Path $project 'src-tauri/resources/runtimes'))
    [IO.File]::WriteAllText((Join-Path $project 'src-tauri/tauri.conf.json'), '{}')
    $manifestPath = Join-Path $project 'src-tauri/resources/runtimes/manifest.json'
    $original = '{"dotnet":{"version":"preserved-sdk"},"python":{"version":"preserved-python"}}'
    [IO.File]::WriteAllText($manifestPath, $original)
    & $scriptPath -ProjectRoot $project -SkipDotnet -SkipPython | Out-Null
    Assert-RuntimeCheck ([IO.File]::ReadAllText($manifestPath) -eq $original) 'Skipping both components must preserve exact manifest bytes.'
    Write-Output 'Runtime staging checks passed: separator boundaries, links, ZIP traversal, full-tree hashes, download bounds, rollback and skipped provenance.'
} finally {
    if (Test-Path -LiteralPath $junction) { Remove-Item -LiteralPath $junction -Force }
    Remove-RuntimeScratch $temporary ([IO.Path]::GetTempPath())
}
