#requires -Version 7.0
<# .SYNOPSIS Stage the app-owned Windows containment host without modifying retained Python/C# numerical sources. #>
param([string]$ProjectRoot=(Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath($ProjectRoot)
$resourceRoot=Join-Path $project 'src-tauri/resources'
$destination=Join-Path $resourceRoot 'validation/host'
$scratchRoot=Join-Path $project 'artifacts/validation-host-preparation'
$scratch=Join-Path $scratchRoot ([guid]::NewGuid().ToString('N'))
$sdk=Join-Path $resourceRoot 'runtimes/dotnet/dotnet.exe'
$sourceRoot=Join-Path $project 'src-tauri/optimizer-host'

<# .SYNOPSIS Reject every existing redirected ancestor/content entry before staging or moving owned paths. #>
function Assert-PlainValidationTree([string]$Path) {
    $current=[IO.Path]::GetFullPath($Path)
    while($current){
        $item=Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "Refusing redirected validation-host path: $current"}
        $current=[IO.Path]::GetDirectoryName($current)
    }
    if(-not(Test-Path -LiteralPath $Path)){return}
    $redirected=Get-ChildItem -LiteralPath $Path -Recurse -Force | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint} | Select-Object -First 1
    if($redirected){throw "Refusing redirected validation-host content: $($redirected.FullName)"}
}

<# .SYNOPSIS Validate exact source/destination boundaries; no caller chooses a recursive cleanup location. #>
function Assert-ValidationHostBoundaries {
    if($destination -ne (Join-Path $project 'src-tauri/resources/validation/host')){throw 'Unexpected validation-host destination.'}
    if(-not $scratch.StartsWith($scratchRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Validation-host scratch escaped its root.'}
    if([IO.Path]::GetFileName($scratch) -notmatch '^[a-f0-9]{32}$'){throw 'Validation-host scratch identity is invalid.'}
    Assert-PlainValidationTree $destination
    Assert-PlainValidationTree $scratch
    Assert-PlainValidationTree $sourceRoot
}

<# .SYNOPSIS Run only the bundled SDK with offline restore, no compiler server, hidden window and a fixed timeout. #>
function Build-ValidationHost {
    $start=[Diagnostics.ProcessStartInfo]::new($sdk)
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.WorkingDirectory=$scratch
    $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $start.Environment['DOTNET_CLI_HOME']=Join-Path $scratch 'cli-home'
    $start.Environment['NUGET_PACKAGES']=Join-Path $scratch 'nuget-packages'
    $start.Environment['DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE']='true'
    $start.Environment['DOTNET_CLI_TELEMETRY_OPTOUT']='1'
    $start.Environment['DOTNET_GENERATE_ASPNET_CERTIFICATE']='false'
    $start.Environment['DOTNET_NOLOGO']='1'
    $start.Environment['MSBUILDDISABLENODEREUSE']='1'
    foreach($argument in @('publish','ValidationHost.csproj','-c','Release','--self-contained','false','-p:UseAppHost=false',('-p:RestoreConfigFile='+(Join-Path $scratch 'NuGet.Config')),'-p:NuGetAudit=false','-p:UseSharedCompilation=false','-nodeReuse:false','-o','next','-v:q')){$start.ArgumentList.Add($argument)}
    $process=[Diagnostics.Process]::new();$process.StartInfo=$start
    try{
        [void]$process.Start();$stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit(180000)){$process.Kill($true);[void]$process.WaitForExit(10000);throw 'Validation-host build timed out.'}
        [IO.File]::WriteAllText((Join-Path $scratch 'build.stdout.log'),$stdout.GetAwaiter().GetResult())
        [IO.File]::WriteAllText((Join-Path $scratch 'build.stderr.log'),$stderr.GetAwaiter().GetResult())
        if($process.ExitCode -ne 0){throw "Validation-host compilation failed. Evidence: $scratch"}
    }finally{$process.Dispose()}
}

if(-not(Test-Path -LiteralPath $sdk)){throw 'Stage the verified bundled SDK before validation-host preparation.'}
Assert-ValidationHostBoundaries
[void][IO.Directory]::CreateDirectory($scratch)
$sourceHashes=[ordered]@{}
foreach($name in @('ValidationHost.cs','process_job.cs','ValidationOutput.py')){
    $path=Join-Path $sourceRoot $name
    Copy-Item -LiteralPath $path -Destination (Join-Path $scratch $name)
    $sourceHashes[$name]=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
[IO.File]::WriteAllText((Join-Path $scratch 'NuGet.Config'),'<configuration><packageSources><clear/></packageSources><auditSources><clear/></auditSources><fallbackPackageFolders><clear/></fallbackPackageFolders></configuration>')
[IO.File]::WriteAllText((Join-Path $scratch 'ValidationHost.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>ValidationHost</AssemblyName><ImplicitUsings>enable</ImplicitUsings><Nullable>disable</Nullable><EnableDefaultCompileItems>false</EnableDefaultCompileItems><StartupObject>DotaTel.Validation.ValidationHost</StartupObject></PropertyGroup><ItemGroup><Compile Include="ValidationHost.cs"/><Compile Include="process_job.cs"/><EmbeddedResource Include="ValidationOutput.py" LogicalName="DotaTel.ValidationOutput.py"/></ItemGroup></Project>')
Build-ValidationHost
$next=Join-Path $scratch 'next'
Copy-Item -LiteralPath (Join-Path $project 'LICENSE') -Destination (Join-Path $next 'LICENSE-app.txt')
$files=[ordered]@{}
foreach($name in @('ValidationHost.dll','ValidationHost.deps.json','ValidationHost.runtimeconfig.json')){$files[$name]=(Get-FileHash -LiteralPath (Join-Path $next $name) -Algorithm SHA256).Hash.ToLowerInvariant()}
$manifest=[ordered]@{files=$files;sourceSha256=$sourceHashes;processBoundary='Windows kill-on-close job;16 active processes;2 GiB committed job memory';retainedNumericalSourcesModified=$false}
[IO.File]::WriteAllText((Join-Path $next 'manifest.json'),($manifest|ConvertTo-Json -Depth 5))
Assert-ValidationHostBoundaries
Assert-PlainValidationTree $next
[void][IO.Directory]::CreateDirectory((Split-Path -Parent $destination))
$backup=Join-Path $scratch 'previous'
if(Test-Path -LiteralPath $destination){[IO.Directory]::Move($destination,$backup)}
try{[IO.Directory]::Move($next,$destination)}
catch{if(Test-Path -LiteralPath $backup){[IO.Directory]::Move($backup,$destination)};throw}
Write-Output "Staged validation host with evidence retained at $scratch"
