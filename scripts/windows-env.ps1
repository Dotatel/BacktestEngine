$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$toolchainDirectory = Join-Path (Split-Path -Parent $projectDirectory) '.build-tools'

# Project preparation and tests must not perform SDK first-run certificate setup or telemetry.
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE = 'true'
$env:DOTNET_NOLOGO = '1'

# Use optional portable build tools without editing machine-wide environment or registry settings.
if (Test-Path -LiteralPath (Join-Path $toolchainDirectory 'cargo\bin\cargo.exe')) {
    $env:CARGO_HOME = Join-Path $toolchainDirectory 'cargo'
    $env:RUSTUP_HOME = Join-Path $toolchainDirectory 'rustup'
    $env:PATH = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:PATH
}

$msvcDirectory = Join-Path $toolchainDirectory 'msvc'
if (Test-Path -LiteralPath $msvcDirectory) {
    $compilerDirectory = Get-ChildItem -LiteralPath (Join-Path $msvcDirectory 'VC\Tools\MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1
    $sdkDirectory = Join-Path $msvcDirectory 'Windows Kits\10'
    $sdkVersion = (Get-ChildItem -LiteralPath (Join-Path $sdkDirectory 'Lib') -Directory | Sort-Object Name -Descending | Select-Object -First 1).Name
    $compilerBin = Join-Path $compilerDirectory.FullName 'bin\Hostx64\x64'
    $env:PATH = $compilerBin + ';' + (Join-Path $sdkDirectory "bin\$sdkVersion\x64") + ';' + $env:PATH
    $env:INCLUDE = (Join-Path $compilerDirectory.FullName 'include') + ';' + (Join-Path $sdkDirectory "Include\$sdkVersion\ucrt") + ';' + (Join-Path $sdkDirectory "Include\$sdkVersion\shared") + ';' + (Join-Path $sdkDirectory "Include\$sdkVersion\um") + ';' + (Join-Path $sdkDirectory "Include\$sdkVersion\winrt")
    $env:LIB = (Join-Path $compilerDirectory.FullName 'lib\x64') + ';' + (Join-Path $sdkDirectory "Lib\$sdkVersion\ucrt\x64") + ';' + (Join-Path $sdkDirectory "Lib\$sdkVersion\um\x64")
    $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = Join-Path $compilerBin 'link.exe'
    $env:RC = Join-Path $sdkDirectory "bin\$sdkVersion\x64\rc.exe"
}

$portableDotnet = Join-Path $toolchainDirectory 'dotnet\dotnet.exe'
if (Test-Path -LiteralPath $portableDotnet) {
    $env:DOTNET_ROOT = Split-Path -Parent $portableDotnet
    $env:PATH = $env:DOTNET_ROOT + ';' + $env:PATH
}
