#requires -Version 7.0
<# .SYNOPSIS Prove actual Windows Job Object exit-code and child/grandchild teardown using an explicitly synthetic managed fixture. #>
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$sdk = Join-Path $project 'src-tauri/resources/runtimes/dotnet/dotnet.exe'
$hostSource = Join-Path $project 'src-tauri/optimizer-host/OptimizationHost.cs'
$fixtureSource = Join-Path $project 'src-tauri/optimizer-host/LifecycleFixture.cs'
$jobSource = Join-Path $project 'src-tauri/optimizer-host/process_job.cs'
$parentSource = Join-Path $project 'src-tauri/optimizer-host/ValidationParentCrashFixture.cs'
$temporary = Join-Path $project ('artifacts/optimizer-host-tests/' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temporary)
$configuration = Join-Path $temporary 'NuGet.Config'
[IO.File]::WriteAllText($configuration, '<configuration><packageSources><clear/></packageSources><auditSources><clear/></auditSources></configuration>')
$compile = @"
<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><EnableDefaultCompileItems>false</EnableDefaultCompileItems><StartupObject>DotaTel.Optimization.OptimizationHost</StartupObject><UseAppHost>false</UseAppHost></PropertyGroup><ItemGroup><Compile Include="$([Security.SecurityElement]::Escape($hostSource))"/><Compile Include="$([Security.SecurityElement]::Escape($fixtureSource))"/><Compile Include="$([Security.SecurityElement]::Escape($jobSource))"/></ItemGroup></Project>
"@
[IO.File]::WriteAllText((Join-Path $temporary 'Lifecycle.csproj'), $compile)
$workerProject = "<Project Sdk=`"Microsoft.NET.Sdk`"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><EnableDefaultCompileItems>false</EnableDefaultCompileItems><StartupObject>BacktestEngine.Optimizer.Program</StartupObject><UseAppHost>false</UseAppHost></PropertyGroup><ItemGroup><Compile Include=`"$([Security.SecurityElement]::Escape($fixtureSource))`"/></ItemGroup></Project>"
[IO.File]::WriteAllText((Join-Path $temporary 'ProofWorker.csproj'), $workerProject)
# Reuse the already-qualified parent surrogate's exact Win32 job setup; adapt only its test launch vector.
$parentFixture = [IO.File]::ReadAllText($parentSource)
$validationVector = 'new[] { host, "--python", python, "--source", source, "--config", config, "--sdk", Path.GetDirectoryName(sdk)!, "--working", working, "--job", name }'
if (-not $parentFixture.Contains($validationVector)) { throw 'The shared parent proof vector changed; review the optimizer proof projection.' }
$parentFixture = $parentFixture.Replace($validationVector, 'new[] { host, "--job", name, "--", "--config", config }').Replace('"validation-host.pid"', '"optimizer-host.pid"')
[IO.File]::WriteAllText((Join-Path $temporary 'ProofParent.cs'), $parentFixture)
[IO.File]::WriteAllText((Join-Path $temporary 'ProofParent.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><EnableDefaultCompileItems>false</EnableDefaultCompileItems><UseAppHost>false</UseAppHost></PropertyGroup><ItemGroup><Compile Include="ProofParent.cs"/></ItemGroup></Project>')

<# .SYNOPSIS Spawn only the selected owned SDK with a fixed argument vector and hidden window. #>
function Start-HostProof([string[]]$Arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new($sdk)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.WorkingDirectory = $temporary
    $start.Environment['DOTNET_CLI_HOME'] = Join-Path $temporary 'cli-home'
    $start.Environment['DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE'] = 'true'
    $start.Environment['DOTNET_CLI_TELEMETRY_OPTOUT'] = '1'
    $start.Environment['DOTNET_GENERATE_ASPNET_CERTIFICATE'] = 'false'
    $start.Environment['DOTNET_NOLOGO'] = '1'
    $start.Environment['MSBUILDDISABLENODEREUSE'] = '1'
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    [void]$process.Start()
    return $process
}

<# .SYNOPSIS Wait a bounded interval for an owned proof process and preserve diagnostics. #>
function Finish-HostProof([Diagnostics.Process]$Process, [string]$Name, [int]$ExpectedCode) {
    $stdout = $Process.StandardOutput.ReadToEndAsync()
    $stderr = $Process.StandardError.ReadToEndAsync()
    if (-not $Process.WaitForExit(60000)) { $Process.Kill($true); throw "$Name timed out." }
    [IO.File]::WriteAllText((Join-Path $temporary ($Name + '.stdout.log')), $stdout.GetAwaiter().GetResult())
    [IO.File]::WriteAllText((Join-Path $temporary ($Name + '.stderr.log')), $stderr.GetAwaiter().GetResult())
    if ($Process.ExitCode -ne $ExpectedCode) { throw "$Name returned $($Process.ExitCode), expected $ExpectedCode. Evidence: $temporary" }
    $Process.Dispose()
}

$build = Start-HostProof @('build', 'Lifecycle.csproj', '-c', 'Release', "-p:RestoreConfigFile=$configuration", '-p:NuGetAudit=false', '-p:UseSharedCompilation=false', '-nodeReuse:false', '-v:q')
Finish-HostProof $build 'build' 0
$assembly = Join-Path $temporary 'bin/Release/net10.0/Lifecycle.dll'
$workerBuild = Start-HostProof @('build', 'ProofWorker.csproj', '-c', 'Release', "-p:RestoreConfigFile=$configuration", '-p:NuGetAudit=false', '-p:UseSharedCompilation=false', '-nodeReuse:false', '-v:q')
Finish-HostProof $workerBuild 'worker-build' 0
$parentBuild = Start-HostProof @('build', 'ProofParent.csproj', '-c', 'Release', "-p:RestoreConfigFile=$configuration", '-p:NuGetAudit=false', '-p:UseSharedCompilation=false', '-nodeReuse:false', '-v:q')
Finish-HostProof $parentBuild 'parent-build' 0
$parentAssembly = Join-Path $temporary 'bin/Release/net10.0/ProofParent.dll'
$config = Join-Path $temporary 'optimizer-proof.json'

<# .SYNOPSIS Launch only the test surrogate parent, forwarding the production optimizer job envelope unchanged. #>
function Get-OptimizerParentArguments([string]$Mode) {
    return @($parentAssembly, $Mode, $sdk, $assembly, 'unused-python', 'unused-source', $config, $temporary)
}

foreach ($code in @(0, 2)) {
    [IO.File]::WriteAllText($config, (@{mode='exit';code=$code}|ConvertTo-Json))
    $normal = Start-HostProof (Get-OptimizerParentArguments 'forward')
    Finish-HostProof $normal "exit-$code" $code
}
[IO.File]::WriteAllText($config, (@{mode='tree';working=$temporary}|ConvertTo-Json))
$parent = Start-HostProof (Get-OptimizerParentArguments 'crash')
$parentStdout = $parent.StandardOutput.ReadToEndAsync()
$parentStderr = $parent.StandardError.ReadToEndAsync()
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not (Test-Path -LiteralPath (Join-Path $temporary 'grandchild.pid')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
    if (-not (Test-Path -LiteralPath (Join-Path $temporary 'grandchild.pid'))) { throw "The real child/grandchild fixture did not start. Evidence: $temporary" }
    $ownedIds = @('optimizer-host', 'parent', 'child', 'grandchild') | ForEach-Object { [int][IO.File]::ReadAllText((Join-Path $temporary ($_ + '.pid'))) }
    $parent.Kill() # Parent only: host closed its temporary join handle before originalMain; the last-close kernel rule must stop all members.
    [void]$parent.WaitForExit(10000)
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ((Get-Process -Id $ownedIds -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
    if (Get-Process -Id $ownedIds -ErrorAction SilentlyContinue) { throw "Owned descendants survived the direct host termination. Evidence: $temporary" }
    @{ syntheticFixture = $true; exit0 = 'passed'; exit2 = 'passed'; nativeParentCrash = 'passed'; parentSurrogateSourceSha256 = (Get-FileHash -LiteralPath $parentSource -Algorithm SHA256).Hash; hostClosedJoinHandleBeforeOriginalMain = $true; hostChildAndGrandchildTerminated = $true; processIds = $ownedIds; evidenceDirectory = $temporary } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $temporary 'result.json') -Encoding utf8NoBOM
    Write-Output "Optimizer kernel job checks passed: exact exits 0/2; parent crash terminated host, child and grandchild. Evidence: $temporary"
} finally {
    if (-not $parent.HasExited) { $parent.Kill($true); [void]$parent.WaitForExit(10000) }
    if (-not $parentStdout.Wait(10000) -or -not $parentStderr.Wait(10000)) { throw "Parent proof output did not close after owned teardown. Evidence: $temporary" }
    [IO.File]::WriteAllText((Join-Path $temporary 'parent-crash.stdout.log'), $parentStdout.GetAwaiter().GetResult())
    [IO.File]::WriteAllText((Join-Path $temporary 'parent-crash.stderr.log'), $parentStderr.GetAwaiter().GetResult())
    $parent.Dispose()
}
