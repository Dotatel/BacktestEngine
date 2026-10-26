#requires -Version 7.0
<# .SYNOPSIS Actual bundled Python/dotnet child-tree teardown behind the staged validation host; all workflow inputs are synthetic. #>
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
$resources=Join-Path $project 'src-tauri/resources'
$sdk=Join-Path $resources 'runtimes/dotnet/dotnet.exe'
$python=Join-Path $resources 'runtimes/python/python.exe'
$hostRoot=Join-Path $resources 'validation/host'
$hostAssembly=Join-Path $hostRoot 'ValidationHost.dll'
$temporary=Join-Path $project ('artifacts/validation-host-tests/'+[guid]::NewGuid().ToString('N'))
$fixture=Join-Path $project 'src-tauri/optimizer-host/ValidationLifecycleFixture.cs'
$parentFixture=Join-Path $project 'src-tauri/optimizer-host/ValidationParentCrashFixture.cs'
$manifest=Get-Content -LiteralPath (Join-Path $hostRoot 'manifest.json') -Raw | ConvertFrom-Json
foreach($name in @('ValidationHost.dll','ValidationHost.deps.json','ValidationHost.runtimeconfig.json')){
    if((Get-FileHash -LiteralPath (Join-Path $hostRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.files.$name){throw "Staged validation-host hash mismatch: $name"}
}
[void][IO.Directory]::CreateDirectory($temporary)
$package=Join-Path $temporary 'package/ValidationEngine';[void][IO.Directory]::CreateDirectory($package)
$source=Split-Path -Parent $package
[IO.File]::WriteAllText((Join-Path $package '__init__.py'),'')
$cli=@'
import argparse,json,os,subprocess,sys,time
parser=argparse.ArgumentParser();parser.add_argument('--config',required=True)
config=json.load(open(parser.parse_args().config,encoding='utf-8'))
if config['mode']=='exit':sys.exit(config['code'])
with open(os.path.join(config['working'],'python.pid'),'w') as output:output.write(str(os.getpid()))
subprocess.Popen([config['sdk'],config['assembly'],'parent',config['working']],stdin=subprocess.DEVNULL)
while True:time.sleep(1)
'@
[IO.File]::WriteAllText((Join-Path $package 'Cli.py'),$cli)
[IO.File]::WriteAllText((Join-Path $temporary 'NuGet.Config'),'<configuration><packageSources><clear/></packageSources><auditSources><clear/></auditSources></configuration>')
$escaped=[Security.SecurityElement]::Escape($fixture)
[IO.File]::WriteAllText((Join-Path $temporary 'ProofTree.csproj'),"<Project Sdk=`"Microsoft.NET.Sdk`"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><EnableDefaultCompileItems>false</EnableDefaultCompileItems><UseAppHost>false</UseAppHost></PropertyGroup><ItemGroup><Compile Include=`"$escaped`"/></ItemGroup></Project>")
$escapedParent=[Security.SecurityElement]::Escape($parentFixture)
[IO.File]::WriteAllText((Join-Path $temporary 'ProofParent.csproj'),"<Project Sdk=`"Microsoft.NET.Sdk`"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><EnableDefaultCompileItems>false</EnableDefaultCompileItems><UseAppHost>false</UseAppHost></PropertyGroup><ItemGroup><Compile Include=`"$escapedParent`"/></ItemGroup></Project>")

<# .SYNOPSIS Start only the explicit bundled SDK with a hidden fixed vector and isolated offline caches. #>
function Start-ValidationProof([string[]]$Arguments) {
    $start=[Diagnostics.ProcessStartInfo]::new($sdk)
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.WorkingDirectory=$temporary
    $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $start.Environment['DOTNET_CLI_HOME']=Join-Path $temporary 'cli-home'
    $start.Environment['NUGET_PACKAGES']=Join-Path $temporary 'nuget-packages'
    $start.Environment['DOTNET_CLI_TELEMETRY_OPTOUT']='1'
    $start.Environment['DOTNET_GENERATE_ASPNET_CERTIFICATE']='false'
    $start.Environment['DOTNET_NOLOGO']='1'
    $start.Environment['DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE']='true'
    foreach($argument in $Arguments){$start.ArgumentList.Add($argument)}
    $process=[Diagnostics.Process]::new();$process.StartInfo=$start;[void]$process.Start();return $process
}

<# .SYNOPSIS Capture exact normal exits without accepting a planned/missing process as successful. #>
function Finish-ValidationProof([Diagnostics.Process]$Process,[string]$Name,[int]$Code) {
    $stdout=$Process.StandardOutput.ReadToEndAsync();$stderr=$Process.StandardError.ReadToEndAsync()
    if(-not $Process.WaitForExit(180000)){$Process.Kill($true);[void]$Process.WaitForExit(10000);throw "Validation proof $Name timed out."}
    [IO.File]::WriteAllText((Join-Path $temporary "$Name.stdout.log"),$stdout.GetAwaiter().GetResult())
    [IO.File]::WriteAllText((Join-Path $temporary "$Name.stderr.log"),$stderr.GetAwaiter().GetResult())
    if($Process.ExitCode -ne $Code){throw "Validation proof $Name returned $($Process.ExitCode), expected $Code. Evidence: $temporary"}
    $Process.Dispose()
}

<# .SYNOPSIS Return the fixed production host vector for a fresh synthetic configuration. #>
function Get-ValidationParentArguments([string]$Mode) {
    return @((Join-Path $temporary 'bin/Debug/net10.0/ProofParent.dll'),$Mode,$sdk,$hostAssembly,$python,$source,(Join-Path $temporary 'validation-config.json'),$temporary)
}

$build=Start-ValidationProof @('build','ProofTree.csproj',('-p:RestoreConfigFile='+(Join-Path $temporary 'NuGet.Config')),'-p:NuGetAudit=false','-p:UseSharedCompilation=false','-nodeReuse:false','-v:q')
Finish-ValidationProof $build 'build' 0
$parentBuild=Start-ValidationProof @('build','ProofParent.csproj',('-p:RestoreConfigFile='+(Join-Path $temporary 'NuGet.Config')),'-p:NuGetAudit=false','-p:UseSharedCompilation=false','-nodeReuse:false','-v:q')
Finish-ValidationProof $parentBuild 'parent-build' 0
foreach($code in @(0,2)){
    [IO.File]::WriteAllText((Join-Path $temporary 'validation-config.json'),(@{mode='exit';code=$code}|ConvertTo-Json))
    $normal=Start-ValidationProof (Get-ValidationParentArguments 'forward')
    Finish-ValidationProof $normal "exit-$code" $code
}
$assembly=Join-Path $temporary 'bin/Debug/net10.0/ProofTree.dll'
[IO.File]::WriteAllText((Join-Path $temporary 'validation-config.json'),(@{mode='tree';working=$temporary;sdk=$sdk;assembly=$assembly}|ConvertTo-Json))
$hostProcess=Start-ValidationProof (Get-ValidationParentArguments 'crash')
$owned=@()
try{
    $deadline=[DateTime]::UtcNow.AddSeconds(20)
    while(-not(Test-Path -LiteralPath (Join-Path $temporary 'grandchild.pid')) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 50}
    if(-not(Test-Path -LiteralPath (Join-Path $temporary 'grandchild.pid'))){throw "Actual validation descendant tree did not start. Evidence: $temporary"}
    $owned=@('validation-host','python','parent','child','grandchild')|ForEach-Object{[int][IO.File]::ReadAllText((Join-Path $temporary "$_.pid"))}
    $hostId=$hostProcess.Id
    $hostProcess.Kill() # Native parent only; the host must have closed its temporary job handle before Python started.
    [void]$hostProcess.WaitForExit(10000)
    $deadline=[DateTime]::UtcNow.AddSeconds(10)
    while((Get-Process -Id $owned -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 50}
    if(Get-Process -Id $owned -ErrorAction SilentlyContinue){throw "Owned validation descendants survived. Evidence: $temporary"}
    $report=@{syntheticLifecycleFixture=$true;realBundledPython=$python;realBundledSdk=$sdk;hostPath=$hostAssembly;hostSha256=(Get-FileHash -LiteralPath $hostAssembly -Algorithm SHA256).Hash;exit0='passed';exit2='passed';nativeParentCrash='passed';hostClosedJoinHandleBeforePython=$true;hostPythonAndDotnetDescendantsStopped=$true;ownedNativeParentPid=$hostId;ownedDescendantPids=$owned;evidenceDirectory=$temporary}
    $reportPath=Join-Path $temporary 'result.json';[IO.File]::WriteAllText($reportPath,($report|ConvertTo-Json -Depth 5))
    [IO.File]::WriteAllText((Join-Path $temporary 'result.sha256'),(Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash.ToLowerInvariant())
    Write-Output "Validation containment proof passed (synthetic workflow, real Python/dotnet). Evidence: $reportPath"
}finally{
    if(-not $hostProcess.HasExited){$hostProcess.Kill($true);[void]$hostProcess.WaitForExit(10000)}
    $hostProcess.Dispose()
}
