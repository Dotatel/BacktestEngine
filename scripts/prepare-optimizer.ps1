#requires -Version 7.0
<# .SYNOPSIS Build the unchanged original optimizer behind the tested Windows process-tree host using the bundled SDK. #>
param([string]$ProjectRoot=(Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath($ProjectRoot)
$resources=Join-Path $project 'src-tauri/resources'
$destination=Join-Path $resources 'optimizer'
$scratchParent=Join-Path $project 'artifacts/optimizer-preparation'
$scratch=Join-Path $scratchParent ([guid]::NewGuid().ToString('N'))
$sdk=Join-Path $resources 'runtimes/dotnet/dotnet.exe'
$source=Join-Path $project 'engines/csharp/src/BacktestEngine.Optimizer'
$hostSourcePath=Join-Path $project 'src-tauri/optimizer-host/OptimizationHost.cs'

<# .SYNOPSIS Refuse links in ancestors/content before any recursive move or scratch removal. #>
function Assert-OptimizerTree([string]$Path){
    $current=[IO.Path]::GetFullPath($Path)
    while($current){
        $item=Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "Refusing redirected optimizer path: $current"}
        $current=[IO.Path]::GetDirectoryName($current)
    }
    if(-not(Test-Path -LiteralPath $Path)){return}
    $link=Get-ChildItem -LiteralPath $Path -Recurse -Force|Where-Object{$_.Attributes -band [IO.FileAttributes]::ReparsePoint}|Select-Object -First 1
    if($link){throw "Refusing linked optimizer content: $($link.FullName)"}
}

<# .SYNOPSIS Require the exact resource destination and a fresh, separator-bounded scratch identity. #>
function Assert-OptimizerBoundaries{
    if($destination -ne (Join-Path $project 'src-tauri/resources/optimizer')){throw 'Unexpected optimizer resource destination.'}
    if(-not $scratch.StartsWith($scratchParent+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Optimizer scratch is outside its intended root.'}
    if([IO.Path]::GetFileName($scratch) -notmatch '^[a-f0-9]{32}$'){throw 'Optimizer scratch identity is invalid.'}
    Assert-OptimizerTree $destination
    Assert-OptimizerTree $scratch
}

<# .SYNOPSIS Publish the source-linked host with a fixed hidden SDK argument vector and isolated offline caches. #>
function Build-OptimizerHost([string]$ProjectFile,[string]$Configuration,[string]$Output){
    $start=[Diagnostics.ProcessStartInfo]::new($sdk)
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $start.WorkingDirectory=$scratch
    $start.Environment['DOTNET_CLI_HOME']=Join-Path $scratch 'cli-home'
    $start.Environment['DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE']='true'
    $start.Environment['DOTNET_CLI_TELEMETRY_OPTOUT']='1'
    $start.Environment['DOTNET_GENERATE_ASPNET_CERTIFICATE']='false'
    $start.Environment['DOTNET_NOLOGO']='1'
    $start.Environment['MSBUILDDISABLENODEREUSE']='1'
    $start.Environment['NUGET_PACKAGES']=Join-Path $scratch 'nuget-packages'
    foreach($argument in @('publish',$ProjectFile,'-c','Release','--self-contained','false','-p:UseAppHost=false',"-p:RestoreConfigFile=$Configuration",'-p:NuGetAudit=false','-p:UseSharedCompilation=false','-nodeReuse:false','-o',$Output,'-v:q')){$start.ArgumentList.Add($argument)}
    $process=[Diagnostics.Process]::new();$process.StartInfo=$start
    try{
        [void]$process.Start();$stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit(180000)){$process.Kill($true);throw 'Optimizer host compilation timed out.'}
        [IO.File]::WriteAllText((Join-Path $scratch 'build.stdout.log'),$stdout.GetAwaiter().GetResult())
        [IO.File]::WriteAllText((Join-Path $scratch 'build.stderr.log'),$stderr.GetAwaiter().GetResult())
        if($process.ExitCode -ne 0){throw "Optimizer host compilation failed. Evidence: $scratch"}
    }finally{$process.Dispose()}
}

if(-not [IO.File]::Exists($sdk)-or -not [IO.File]::Exists($hostSourcePath)){throw 'Prepare the verified bundled SDK and retain the optimizer host source before staging.'}
Assert-OptimizerBoundaries
Assert-OptimizerTree $source
[void][IO.Directory]::CreateDirectory($scratch)
$copied=Join-Path $scratch 'source';[void][IO.Directory]::CreateDirectory($copied)
$hashes=[ordered]@{}
foreach($file in Get-ChildItem -LiteralPath $source -Filter '*.cs' -File){
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $copied $file.Name)
    $hashes[$file.Name]=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
Copy-Item -LiteralPath $hostSourcePath -Destination (Join-Path $scratch 'OptimizationHost.cs')
Copy-Item -LiteralPath (Join-Path $project 'src-tauri/optimizer-host/CandidateBindings.cs') -Destination (Join-Path $scratch 'CandidateBindings.cs')
Copy-Item -LiteralPath (Join-Path $project 'src-tauri/optimizer-host/process_job.cs') -Destination (Join-Path $scratch 'process_job.cs')
$configuration=Join-Path $scratch 'NuGet.Config'
[IO.File]::WriteAllText($configuration,'<configuration><packageSources><clear/></packageSources><auditSources><clear/></auditSources><fallbackPackageFolders><clear/></fallbackPackageFolders></configuration>')
$projectFile=Join-Path $scratch 'OptimizationHost.csproj'
[IO.File]::WriteAllText($projectFile,'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>OptimizationHost</AssemblyName><ImplicitUsings>enable</ImplicitUsings><Nullable>disable</Nullable><StartupObject>DotaTel.Optimization.OptimizationHost</StartupObject><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup><Compile Include="source/*.cs"/><Compile Include="OptimizationHost.cs"/><Compile Include="CandidateBindings.cs"/><Compile Include="process_job.cs"/></ItemGroup></Project>')
$next=Join-Path $scratch 'next'
Build-OptimizerHost $projectFile $configuration $next
Copy-Item -LiteralPath (Join-Path $project 'LICENSE') -Destination (Join-Path $next 'LICENSE-retained-engine.txt')
$files=[ordered]@{}
foreach($name in @('OptimizationHost.dll','OptimizationHost.deps.json','OptimizationHost.runtimeconfig.json')){$files[$name]=(Get-FileHash -LiteralPath (Join-Path $next $name) -Algorithm SHA256).Hash.ToLowerInvariant()}
$appSourceHashes=[ordered]@{}
foreach($name in @('OptimizationHost.cs','CandidateBindings.cs','process_job.cs')){$appSourceHashes[$name]=(Get-FileHash -LiteralPath (Join-Path $project "src-tauri/optimizer-host/$name") -Algorithm SHA256).Hash.ToLowerInvariant()}
$manifest=[ordered]@{generatedAtUtc=[DateTime]::UtcNow.ToString('o');files=$files;hostSourceSha256=(Get-FileHash -LiteralPath $hostSourcePath -Algorithm SHA256).Hash.ToLowerInvariant();appSourceSha256=$appSourceHashes;retainedSourceSha256=$hashes;bindingVersion=3;processBoundary='Native parent-owned Windows job;16 active processes;2 GiB committed memory;member-signaled and direct-host exit before reuse';numericalSourcesChanged=$false}
[IO.File]::WriteAllText((Join-Path $next 'manifest.json'),($manifest|ConvertTo-Json -Depth 8))
$backup=Join-Path $scratch 'previous'
Assert-OptimizerBoundaries
Assert-OptimizerTree $next
if(Test-Path -LiteralPath $destination){[IO.Directory]::Move($destination,$backup)}
try{[IO.Directory]::Move($next,$destination)}
catch{
    if(Test-Path -LiteralPath $backup){[IO.Directory]::Move($backup,$destination)}
    throw
}
Assert-OptimizerBoundaries
Remove-Item -LiteralPath $scratch -Recurse -Force
Write-Output "Staged original optimizer with tested process-tree host: $destination"
