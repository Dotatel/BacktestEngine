#requires -Version 7.0
<#
.SYNOPSIS
Stage pinned official Windows x64 runtimes, preserving verified installed components.
.DESCRIPTION
Accepts optional offline ZIP archives. Downloads have time/size bounds; every extracted
file is verified against the authenticated archive. Scratch and backups stay outside
bundled resources. Exact component boundaries and link checks precede moves/removal.
#>
param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$DotnetArchive = '',
    [string]$PythonArchive = '',
    [switch]$SkipDotnet,
    [switch]$SkipPython
)
$ErrorActionPreference = 'Stop'

<# .SYNOPSIS Return reviewed official archive identities; inputs cannot override trusted hashes. #>
function Get-RuntimeSpecifications {
    @(
        @{ Name = 'dotnet'; Version = '10.0.402'; Executable = 'dotnet.exe'; Algorithm = 'SHA512'
           Hash = 'ae4fd528cb7e9f6af6aaf7de36715a69f761f183744f1bb3025d19f5a92447090ec561410e46266c1d10a63781ed6f3de771760bc76c876d87daabc367b898cd'
           Url = 'https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.402/dotnet-sdk-10.0.402-win-x64.zip'
           EvidenceUrl = 'https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json'
           ArchiveName = 'dotnet-sdk-10.0.402-win-x64.zip'; MaxArchiveBytes = 512MB; MaxExpandedBytes = 2GB
           Licenses = @('LICENSE.txt', 'ThirdPartyNotices.txt') },
        @{ Name = 'python'; Version = '3.14.9'; Executable = 'python.exe'; Algorithm = 'SHA256'
           Hash = '3c01d7cfc666f746a6f064f60fb2156ab0ec464d3d738ab796371a46a9bb24a2'
           Url = 'https://www.python.org/ftp/python/3.14.9/python-3.14.9-embed-amd64.zip'
           EvidenceUrl = 'https://www.python.org/downloads/release/python-3149/'
           ArchiveName = 'python-3.14.9-embed-amd64.zip'; MaxArchiveBytes = 32MB; MaxExpandedBytes = 128MB
           Licenses = @('LICENSE.txt') }
    )
}

<# .SYNOPSIS Resolve a strict descendant using a separator-aware boundary, rejecting root/prefix siblings. #>
function Assert-RuntimeChild([string]$Path, [string]$Root) {
    $full = [IO.Path]::GetFullPath($Path)
    $boundary = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) { throw "Path is outside its intended boundary: $full" }
    return $full
}

<# .SYNOPSIS Refuse links in every existing ancestor before reading or mutating an intended path. #>
function Assert-RuntimeAncestors([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Refusing redirected runtime path: $current" }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

<# .SYNOPSIS Refuse any link within a tree; PowerShell's enumeration does not follow links. #>
function Assert-RuntimeTree([string]$Path) {
    Assert-RuntimeAncestors $Path
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $link = Get-ChildItem -LiteralPath $Path -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | Select-Object -First 1
    if ($link) { throw "Refusing linked runtime content: $($link.FullName)" }
}

<# .SYNOPSIS Move only one verified descendant tree between explicitly supplied ownership boundaries. #>
function Move-RuntimeTree([string]$Source, [string]$SourceRoot, [string]$Destination, [string]$DestinationRoot) {
    $from = Assert-RuntimeChild $Source $SourceRoot
    $to = Assert-RuntimeChild $Destination $DestinationRoot
    Assert-RuntimeTree $from
    Assert-RuntimeAncestors $to
    if (-not [IO.Directory]::Exists($from) -or (Test-Path -LiteralPath $to)) { throw "Runtime move requires an existing source and a new destination: $from -> $to" }
    [IO.Directory]::Move($from, $to)
}

<# .SYNOPSIS Remove only an exact verified scratch descendant; runtime component roots are never cleanup targets. #>
function Remove-RuntimeScratch([string]$Path, [string]$ScratchParent) {
    $full = Assert-RuntimeChild $Path $ScratchParent
    if ([IO.Path]::GetFileName($full) -notmatch '^[a-f0-9]{32}$') { throw "Unexpected scratch identity: $full" }
    Assert-RuntimeTree $full
    if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force }
}

<# .SYNOPSIS Fail as soon as a download or expanded archive exceeds its reviewed byte limit. #>
function Assert-RuntimeByteLimit([long]$Length, [long]$Maximum) {
    if ($Length -gt $Maximum) { throw "Runtime archive exceeds its $Maximum byte limit." }
}

<# .SYNOPSIS Copy a cancellable HTTP body into a fresh file, bounding bytes before each write. #>
function Copy-RuntimeDownload([IO.Stream]$InputStream, [string]$Destination, [long]$Maximum, [Threading.CancellationToken]$Token) {
    $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew)
    $buffer = [byte[]]::new(65536)
    $length = 0L
    try {
        while (($read = $InputStream.ReadAsync($buffer, 0, $buffer.Length, $Token).GetAwaiter().GetResult()) -gt 0) {
            $length += $read
            Assert-RuntimeByteLimit $length $Maximum
            $output.Write($buffer, 0, $read)
        }
    } finally { $output.Dispose() }
}

<# .SYNOPSIS Download an official pinned archive with a five-minute total timeout and size cap. #>
function Save-RuntimeDownload([string]$Url, [string]$Destination, [long]$Maximum) {
    $client = [Net.Http.HttpClient]::new()
    $cancellation = [Threading.CancellationTokenSource]::new([TimeSpan]::FromMinutes(5))
    $response = $null
    try {
        $response = $client.GetAsync($Url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancellation.Token).GetAwaiter().GetResult()
        [void]$response.EnsureSuccessStatusCode()
        $stream = $response.Content.ReadAsStreamAsync($cancellation.Token).GetAwaiter().GetResult()
        Copy-RuntimeDownload $stream $Destination $Maximum $cancellation.Token
    } finally {
        if ($response) { $response.Dispose() }
        $cancellation.Dispose()
        $client.Dispose()
    }
}

<# .SYNOPSIS Select an offline/cache archive or bounded official download, then enforce the pinned full-archive hash. #>
function Get-RuntimeArchive([hashtable]$Specification, [string]$Requested, [string]$Project, [string]$Scratch) {
    $archive = $Requested
    if (-not $archive) { $archive = Join-Path $Project ('artifacts/runtime-provenance/' + $Specification.ArchiveName) }
    if (-not (Test-Path -LiteralPath $archive) -and $Requested) { throw "The requested offline archive is missing: $Requested" }
    if (-not (Test-Path -LiteralPath $archive)) {
        $archive = Join-Path $Scratch $Specification.ArchiveName
        Save-RuntimeDownload $Specification.Url $archive $Specification.MaxArchiveBytes
    }
    $archive = [IO.Path]::GetFullPath($archive)
    Assert-RuntimeAncestors $archive
    Assert-RuntimeByteLimit (Get-Item -LiteralPath $archive).Length $Specification.MaxArchiveBytes
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm $Specification.Algorithm).Hash.ToLowerInvariant()
    if ($actual -ne $Specification.Hash) { throw "Pinned official archive hash mismatch: $archive" }
    return $archive
}

<# .SYNOPSIS Read one ZIP entry's exact hash and safe relative identity, rejecting traversal and links before extraction. #>
function Get-RuntimeZipRecord([IO.Compression.ZipArchiveEntry]$Entry, [string]$Stage) {
    $relative = $Entry.FullName.Replace('\', '/')
    if ([IO.Path]::IsPathRooted($relative) -or $relative.Contains(':')) { throw "Unsafe runtime archive entry: $relative" }
    [void](Assert-RuntimeChild (Join-Path $Stage $relative) $Stage)
    if ((($Entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw "Runtime archive contains a symbolic link: $relative" }
    if ($relative.EndsWith('/')) { return }
    $stream = $Entry.Open()
    try { $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant() }
    finally { $stream.Dispose() }
    return [pscustomobject]@{ RelativePath = $relative; Length = $Entry.Length; Sha256 = $digest }
}

<# .SYNOPSIS Inventory every authenticated ZIP file for full-tree verification, not executable-only checks. #>
function Get-RuntimeArchiveInventory([string]$Archive, [string]$Stage, [long]$MaximumExpanded) {
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try { $records = @($zip.Entries | ForEach-Object { Get-RuntimeZipRecord $_ $Stage }) }
    finally { $zip.Dispose() }
    $map = @{}
    $length = 0L
    foreach ($record in $records) {
        $map.Add($record.RelativePath, $record)
        $length += $record.Length
        Assert-RuntimeByteLimit $length $MaximumExpanded
    }
    if ($map.Count -eq 0 -or $map.Count -gt 10000) { throw 'Runtime archive has an invalid file count.' }
    $lines = ($records | Sort-Object RelativePath | ForEach-Object { "$($_.RelativePath)`t$($_.Length)`t$($_.Sha256)" }) -join "`n"
    return @{ Files = $map; FileCount = $map.Count; SizeBytes = $length; TreeSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($lines))).ToLowerInvariant() }
}

<# .SYNOPSIS Compare all names, sizes and SHA256 values, rejecting missing, modified, extra or linked files. #>
function Test-RuntimeTreeMatches([string]$Directory, [hashtable]$Inventory) {
    if (-not [IO.Directory]::Exists($Directory)) { return $false }
    Assert-RuntimeTree $Directory
    $files = @(Get-ChildItem -LiteralPath $Directory -File -Recurse -Force)
    if ($files.Count -ne $Inventory.FileCount) { return $false }
    foreach ($record in $Inventory.Files.Values) {
        $path = Join-Path $Directory $record.RelativePath
        if (-not [IO.File]::Exists($path)) { return $false }
        if ((Get-Item -LiteralPath $path).Length -ne $record.Length) { return $false }
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $record.Sha256) { return $false }
    }
    return $true
}

<# .SYNOPSIS Run a verified runtime probe hidden with an isolated CLI home and a thirty-second timeout. #>
function Invoke-RuntimeProbe([string]$Executable, [string[]]$Arguments, [string]$HomeDirectory) {
    $start = [Diagnostics.ProcessStartInfo]::new($Executable)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $start.Environment['DOTNET_CLI_HOME'] = $HomeDirectory
    $start.Environment['DOTNET_CLI_TELEMETRY_OPTOUT'] = '1'
    $start.Environment['DOTNET_GENERATE_ASPNET_CERTIFICATE'] = 'false'
    $start.Environment['DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE'] = 'true'
    $start.Environment['DOTNET_NOLOGO'] = '1'
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) { $process.Kill($true); throw 'Runtime capability probe timed out.' }
        if ($process.ExitCode -ne 0) { throw "Runtime capability probe failed: $($stderr.GetAwaiter().GetResult())" }
        return $stdout.GetAwaiter().GetResult().Trim()
    } finally { $process.Dispose() }
}

<# .SYNOPSIS Verify pinned runtime version and retained licenses; Python needs only its original standard library. #>
function Assert-RuntimeCapability([hashtable]$Specification, [string]$Directory, [string]$Scratch) {
    foreach ($license in $Specification.Licenses) {
        if (-not [IO.File]::Exists((Join-Path $Directory $license))) { throw "Missing retained runtime license: $license" }
    }
    $executable = Join-Path $Directory $Specification.Executable
    $version = Invoke-RuntimeProbe $executable @('--version') (Join-Path $Scratch 'cli-home')
    $expected = $Specification.Version
    if ($Specification.Name -eq 'python') { $expected = "Python $expected" }
    if ($version -ne $expected) { throw "Unexpected runtime version '$version'; expected '$expected'." }
    if ($Specification.Name -eq 'python') { [void](Invoke-RuntimeProbe $executable @('-I', '-B', '-c', 'import json,hashlib,sqlite3,ssl,runpy; print("stdlib-ok")') (Join-Path $Scratch 'cli-home')) }
}

<# .SYNOPSIS Prepare a fully verified replacement, or reuse the exact existing official tree without moving it. #>
function Prepare-RuntimeComponent([hashtable]$Specification, [string]$Archive, [string]$Project, [string]$RuntimeRoot, [string]$Scratch) {
    $archivePath = Get-RuntimeArchive $Specification $Archive $Project $Scratch
    $stage = Join-Path $Scratch ($Specification.Name + '-next')
    $destination = Join-Path $RuntimeRoot $Specification.Name
    $inventory = Get-RuntimeArchiveInventory $archivePath $stage $Specification.MaxExpandedBytes
    $replace = -not (Test-RuntimeTreeMatches $destination $inventory)
    $verified = $destination
    if ($replace) {
        [void](Assert-RuntimeChild $stage $Scratch)
        Assert-RuntimeAncestors $stage
        if (Test-Path -LiteralPath $stage) { throw "Runtime staging requires a fresh directory: $stage" }
        [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $stage)
        if (-not (Test-RuntimeTreeMatches $stage $inventory)) { throw 'Extracted runtime differs from its pinned official archive.' }
        $verified = $stage
    }
    Assert-RuntimeCapability $Specification $verified $Scratch
    $entry = [ordered]@{ version = $Specification.Version; source = $Specification.Url; checksumSource = $Specification.EvidenceUrl; archiveHashAlgorithm = $Specification.Algorithm; archiveHash = $Specification.Hash; sourceTreeSha256 = $inventory.TreeSha256; destination = 'runtimes/' + $Specification.Name; executable = $Specification.Executable; executableSha256 = (Get-FileHash -LiteralPath (Join-Path $verified $Specification.Executable) -Algorithm SHA256).Hash.ToLowerInvariant(); fileCount = $inventory.FileCount; sizeBytes = $inventory.SizeBytes; licenseFiles = $Specification.Licenses; verification = 'All archive entries compared by path, size and SHA256; pinned version and license checks passed.' }
    return @{ Name = $Specification.Name; Stage = $stage; Destination = $destination; Backup = (Join-Path $Scratch ($Specification.Name + '-previous')); Failed = (Join-Path $Scratch ($Specification.Name + '-failed')); Replace = $replace; Entry = $entry }
}

<# .SYNOPSIS Publish one exact component; a failed second rename restores its original tree immediately. #>
function Publish-RuntimeComponent([hashtable]$Plan, [string]$RuntimeRoot, [string]$Scratch) {
    if (-not $Plan.Replace) { return }
    if ($Plan.Name -notin @('dotnet', 'python') -or $Plan.Destination -ne (Join-Path $RuntimeRoot $Plan.Name)) { throw 'Unexpected runtime component destination.' }
    Assert-RuntimeTree $Plan.Stage
    if (Test-Path -LiteralPath $Plan.Destination) { Move-RuntimeTree $Plan.Destination $RuntimeRoot $Plan.Backup $Scratch }
    try { Move-RuntimeTree $Plan.Stage $Scratch $Plan.Destination $RuntimeRoot }
    catch {
        if (Test-Path -LiteralPath $Plan.Backup) { Move-RuntimeTree $Plan.Backup $Scratch $Plan.Destination $RuntimeRoot }
        throw
    }
}

<# .SYNOPSIS Restore already-published components after a transaction failure, retaining replacements in scratch. #>
function Restore-RuntimeComponents([object[]]$Plans, [string]$RuntimeRoot, [string]$Scratch) {
    foreach ($plan in $Plans) {
        Move-RuntimeTree $plan.Destination $RuntimeRoot $plan.Failed $Scratch
        if (Test-Path -LiteralPath $plan.Backup) { Move-RuntimeTree $plan.Backup $Scratch $plan.Destination $RuntimeRoot }
    }
}

<# .SYNOPSIS Atomically publish a manifest after component publication; a failed transaction restores previous components. #>
function Publish-RuntimeTransaction([object[]]$Plans, [hashtable]$Manifest, [string]$RuntimeRoot, [string]$Scratch) {
    $published = [Collections.Generic.List[object]]::new()
    $manifestPath = Join-Path $RuntimeRoot 'manifest.json'
    Assert-RuntimeAncestors $manifestPath
    $next = Join-Path $Scratch 'manifest-next.json'
    [IO.File]::WriteAllText($next, ($Manifest | ConvertTo-Json -Depth 12))
    try {
        foreach ($plan in $Plans | Where-Object Replace) { Publish-RuntimeComponent $plan $RuntimeRoot $Scratch; $published.Insert(0, $plan) }
        if ([IO.File]::Exists($manifestPath)) { [IO.File]::Replace($next, $manifestPath, (Join-Path $Scratch 'manifest-previous.json')) }
        else { [IO.File]::Move($next, $manifestPath) }
    } catch {
        Restore-RuntimeComponents $published.ToArray() $RuntimeRoot $Scratch
        throw
    }
}

<# .SYNOPSIS Stage only requested components and retain skipped provenance; malformed existing manifests are never reset. #>
function Invoke-RuntimePreparation {
    $project = [IO.Path]::GetFullPath($ProjectRoot)
    if (-not [IO.File]::Exists((Join-Path $project 'src-tauri/tauri.conf.json'))) { throw 'Select the BacktestEngine workspace containing src-tauri/tauri.conf.json.' }
    $runtimes = Join-Path $project 'src-tauri/resources/runtimes'
    $scratchParent = Join-Path $project 'artifacts/runtime-staging'
    Assert-RuntimeAncestors $runtimes
    Assert-RuntimeAncestors $scratchParent
    $manifestPath = Join-Path $runtimes 'manifest.json'
    $manifest = @{}
    if ([IO.File]::Exists($manifestPath)) { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -AsHashtable }
    if ($manifest -isnot [hashtable]) { throw 'The existing runtime manifest is malformed; preserve it and repair its provenance before staging.' }
    if ($SkipDotnet -and $SkipPython) { Write-Output 'Both components skipped; runtime files and manifest are unchanged.'; return }
    $scratch = Join-Path $scratchParent ([guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $scratch) { throw "Fresh runtime scratch already exists: $scratch" }
    [void][IO.Directory]::CreateDirectory($scratch)
    [void][IO.Directory]::CreateDirectory($runtimes)
    $plans = [Collections.Generic.List[object]]::new()
    try {
        foreach ($specification in Get-RuntimeSpecifications) { Prepare-RequestedRuntime $specification $project $runtimes $scratch $manifest $plans }
        $manifest.generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        Publish-RuntimeTransaction $plans.ToArray() $manifest $runtimes $scratch
    } catch {
        Write-Error "Runtime preparation stopped. Recovery copies, if any, remain outside bundled resources at $scratch. $($_.Exception.Message)" -ErrorAction Continue
        throw
    }
    Remove-RuntimeScratch $scratch $scratchParent
    Write-Output "Verified offline runtime manifest: $manifestPath"
}

<# .SYNOPSIS Prepare one requested runtime or require and preserve its skipped existing manifest entry. #>
function Prepare-RequestedRuntime([hashtable]$Specification, [string]$Project, [string]$Runtimes, [string]$Scratch, [hashtable]$Manifest, [Collections.Generic.List[object]]$Plans) {
    $skip = ($Specification.Name -eq 'dotnet' -and $SkipDotnet) -or ($Specification.Name -eq 'python' -and $SkipPython)
    if ($skip) {
        if (-not $Manifest[$Specification.Name]) { throw "Skipped $($Specification.Name) has no previous provenance. Stage it first." }
        return
    }
    $archive = $DotnetArchive
    if ($Specification.Name -eq 'python') { $archive = $PythonArchive }
    $plan = Prepare-RuntimeComponent $Specification $archive $Project $Runtimes $Scratch
    $Plans.Add($plan)
    $Manifest[$Specification.Name] = $plan.Entry
    Write-Output "Verified $($Specification.Name) $($Specification.Version): $($plan.Entry.fileCount) files; replacement required: $($plan.Replace)"
}

Invoke-RuntimePreparation
