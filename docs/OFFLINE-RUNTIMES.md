# Offline runtime checkpoint — 24 October 2026

Official Windows x64 runtimes are staged locally and verified. This is packaging preparation, not evidence of an installed application on a clean Windows machine. Installer build, installation, upgrade and uninstall acceptance remain pending.

| Component          | Verified version | Files | Extracted bytes | Bundled destination |
| ------------------ | ---------------- | ----: | --------------: | ------------------- |
| .NET SDK           | 10.0.402         | 5,577 |     807,617,264 | `runtimes/dotnet/`  |
| CPython embeddable | 3.14.9           |    37 |      24,426,836 | `runtimes/python/`  |

The generated `src-tauri/resources/runtimes/manifest.json` records the official source, checksum source, pinned full-archive digest, every-file aggregate SHA256, executable digest, counts and retained license names. Generated runtimes and manifests are ignored by Git and Prettier.

## Official provenance

.NET comes from the [official 10.0.402 Windows x64 SDK archive](https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.402/dotnet-sdk-10.0.402-win-x64.zip). Its SHA512 is pinned from [Microsoft's release metadata](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json):

```text
ae4fd528cb7e9f6af6aaf7de36715a69f761f183744f1bb3025d19f5a92447090ec561410e46266c1d10a63781ed6f3de771760bc76c876d87daabc367b898cd
```

Root QA previously restored an incomplete SDK tree from that verified archive. The replacement staging script independently compared every one of the 5,577 files with the same archive and reported `replacement required: False`; it kept the restored SDK tree in place. No owner toolchain directory is copied, replaced or deleted.

Python 3.14.9 is the [official 3.14 maintenance release dated 21 October 2026](https://www.python.org/downloads/release/python-3149/), superseding the worker's stale 3.14.8 selection. The [Windows x64 embeddable archive](https://www.python.org/ftp/python/3.14.9/python-3.14.9-embed-amd64.zip) matches the release page's SHA256:

```text
3c01d7cfc666f746a6f064f60fb2156ab0ec464d3d738ab796371a46a9bb24a2
```

The official [Sigstore bundle](https://www.python.org/ftp/python/3.14.9/python-3.14.9-embed-amd64.zip.sigstore) records the same SHA256 in `messageSignature.messageDigest`. Its captured bundle SHA256 is `cd661a3fc9f67eb38f2adf1816d9016455da802dae3a0934c64ac3ebb17ec00d`. This establishes agreement with published HTTPS metadata; independent Fulcio certificate/Rekor log verification is not claimed. No pip, system Python, Codex runtime or third-party Python package is copied into the app.

The complete official archives retain .NET `LICENSE.txt` and `ThirdPartyNotices.txt` and Python `LICENSE.txt`, including all packaged runtime libraries and notices.

## Staging and recovery

Run `pwsh -File scripts/prepare-runtimes.ps1`. Optional `-DotnetArchive` and `-PythonArchive` parameters accept offline ZIP files, still subject to fixed official hashes. The default first checks the corresponding `artifacts/runtime-provenance/` archive, then downloads with a five-minute limit and a size limit of 512 MiB for .NET or 32 MiB for Python. PowerShell 7 is required. Machine configuration is unchanged.

Both requested components are fully prepared before publication. Scratch and recovery copies live under `artifacts/runtime-staging/<uuid>/`, outside Tauri's resource map. Separator-aware descendant checks, exact component destinations, ancestor/tree reparse-point checks and safe ZIP entries precede extraction, moves and recursive scratch removal. No retry loop or broad cache cleanup exists.

Every staged file's name, size and SHA256 must match the archive; missing, changed, extra or linked files fail verification. Exact existing components are reused without moving them. Replacements use directory renames with rollback. The manifest is atomically replaced after successful component publication; failure restores prior components. Failed scratch remains recoverable outside bundled resources, and cleanup refuses redirected trees.

`-SkipDotnet` and `-SkipPython` retain the skipped component's existing manifest entry and require that provenance to exist. Skipping both leaves exact manifest bytes and runtime files unchanged. Malformed manifests are rejected rather than reset. The script does not install, sign or publish anything.

## Source builds without remote feeds

Each build snapshot gets `NuGet.Config` clearing package, audit and fallback sources. The build passes the documented [`RestoreConfigFile` property](https://learn.microsoft.com/en-us/nuget/reference/msbuild-targets#restore-properties) explicitly, excluding ancestor/user feeds. [`NuGetAudit=false`](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-restore#audit-for-security-vulnerabilities) is limited to this offline, package-free compile. The retained runner/shim have only local project references; framework packs come from the bundled SDK.

CLI home, package cache and HTTP cache are snapshot-owned. Telemetry and [background workload advertising downloads](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-environment-variables#dotnet_cli_workload_update_notify_disable) are disabled for these processes. User feeds/caches are never cleared or edited. External packages would require a separately reviewed offline dependency strategy.

Compiler discovery honors explicit `DOTNET_ROOT`, then installed app SDK paths before machine SDKs. The owner-local portable fallback is debug-only and derived from the repository; no hardcoded owner drive path remains in release discovery/errors.

## Verified and pending

`scripts/test-runtime-staging.ps1` passed synthetic boundary, junction, ZIP traversal, hash, bounded-stream, rollback and skipped-manifest checks. Actual staging passed full archive, every-file, version, standard-library and license checks. An actual bundled SDK test compiled/reflected the retained strategy with a fresh CLI home, empty package cache and an unreachable ancestor feed. Generated assets identify only the explicit snapshot configuration and no external package libraries.

All seven native validation tests passed again with staged CPython 3.14.9 and unchanged Python sources, including real subprocess processing and the honest non-finite-output regression. Synthetic fixtures do not establish a real trading replay or broker parity.

Tauri maps `resources/engine/`, `resources/enginesrc/`, `resources/validation/` and `resources/runtimes/` to the corresponding installed paths. WebView2 remains configured as `offlineInstaller`. Resource/configuration checks do not replace pending installer and clean-Windows acceptance. The owner's running review copy remains untouched.
