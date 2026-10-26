//! Real saved-source C# build service for the Build workspace.
//!
//! Design (verified end to end in artifacts/native-proto-2026-10-24.md): a generated wrapper
//! project links the preserved engine runner sources via the existing `StrategySource` /
//! `StrategyHelperSources` properties of `BacktestEngine.Run.csproj`, swaps `Program.cs` for a
//! generated metadata entry, and compiles the project's C# files with the installed .NET SDK.
//! Compiler diagnostics come from the official Roslyn `/errorlog` SARIF capture; strategy
//! schemas come from the engine's own `StrategyMetadata.Print` markers, never from source
//! parsing. Everything is written to app-owned snapshot directories; user source is copied, so
//! failed builds preserve it unchanged.

use crate::workspace::ProjectRoot;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::time::Duration;
use std::{fs, path::Path, path::PathBuf, time::Instant};
use tauri::Manager;
#[cfg(test)]
use tokio::process::Command;
use tokio::sync::oneshot;

#[path = "workspace_compile_inputs.rs"]
pub(crate) mod compile_inputs;

/// Marker printed by the engine metadata path before each single-line JSON payload.
pub const METADATA_MARKER: &str = "BACKTESTENGINE_STRATEGY_METADATA";

/// Error message shared by every cancellation path so callers can recognize it.
pub const CANCELLATION_MESSAGE: &str = "The build was canceled.";

/// Maximum seconds one compile run may take before the process is canceled.
pub const COMPILE_TIMEOUT_SECONDS: u64 = 180;

/// Maximum seconds the metadata run may take before the process is canceled.
///
/// Measured cold runs complete in well under a second; the larger bound covers
/// first-run .NET host startup, antivirus scanning of a freshly built assembly
/// and slow disks without masking a genuinely hung process.
pub const METADATA_TIMEOUT_SECONDS: u64 = 60;

/// Maximum seconds the SDK probe may take before that candidate is rejected.
pub const SDK_PROBE_TIMEOUT_SECONDS: u64 = 15;

/// Maximum number of project C# files one build snapshot accepts.
pub const MAX_SNAPSHOT_SOURCES: usize = 256;

/// Maximum bytes one C# source file may contribute to the snapshot.
pub const MAX_SOURCE_BYTES: u32 = 1024 * 1024;

/// Maximum bytes one preserved engine source file may contribute to the snapshot.
const MAX_ENGINE_FILE_BYTES: u64 = 1024 * 1024;

/// Maximum number of diagnostics reported from one SARIF log.
const MAX_DIAGNOSTICS: usize = 200;

/// Maximum captured process-output characters passed to the editor output panel.
const MAX_OUTPUT_CHARS: usize = 12_000;

/// Snapshot-only restore policy: retained projects use local references and bundled framework packs.
const OFFLINE_NUGET_CONFIG: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources><clear /></packageSources>
  <auditSources><clear /></auditSources>
  <fallbackPackageFolders><clear /></fallbackPackageFolders>
</configuration>
"#;

/// A compiler-produced diagnostic; line/column are one-based and absent without a source span.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BuildDiagnostic {
    pub severity: DiagnosticSeverity,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
}

/// Diagnostic severity matching the bridge contract.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
}

/// Reflection evidence from an actually compiled strategy.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StrategyParameter {
    pub name: String,
    pub display_name: String,
    #[serde(default)]
    pub group: String,
    pub value_type: String,
    #[serde(default)]
    pub default: Option<Value>,
    #[serde(default)]
    pub min: Option<Value>,
    #[serde(default)]
    pub max: Option<Value>,
    #[serde(default)]
    pub step: Option<Value>,
    #[serde(default, deserialize_with = "options_from_null_or_list")]
    pub options: Vec<String>,
}

/// The preserved engine's reflected schema for a compiled robot type.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompiledStrategy {
    pub strategy: String,
    pub strategy_type: String,
    pub parameters: Vec<StrategyParameter>,
}

/// Actual compiler outcome with honest capability failures.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBuild {
    pub success: bool,
    pub diagnostics: Vec<BuildDiagnostic>,
    pub output: String,
    pub duration_ms: u64,
    pub strategies: Vec<CompiledStrategy>,
    /// Required in the JSON shape; failures serialize `artifactPath: null`.
    pub artifact_path: Option<String>,
    /// Native-only proof captured while compiler input files were locked against writes/deletion.
    #[serde(skip)]
    pub(crate) source_manifest: Option<crate::replay_receipt::ApprovedSourceManifest>,
}

/// Host-recorded approved build artifact for execution.
#[derive(Clone, Debug)]
pub struct ApprovedBuild {
    pub project_root: String,
    pub artifact_path: String,
    pub revision: String,
    pub artifact_sha256: String,
    /// Exact host-recorded hashes of the shim and the CLR dependency/configuration inputs.
    pub runtime_sha256: std::collections::BTreeMap<String, String>,
    pub strategies: Vec<String>,
    /// Parameter schemas reflected from the same successfully compiled approved assembly.
    pub parameter_schemas: Vec<CompiledStrategy>,
    /// Exact locked source bytes used by the approved successful compilation.
    pub(crate) source_manifest: crate::replay_receipt::ApprovedSourceManifest,
}

/// A verified dotnet compiler able to build the snapshot (SDK probes already ran).
#[derive(Clone, Debug)]
pub struct DotnetCompiler {
    pub executable: PathBuf,
}

/// One assembled immutable build snapshot and the mapping to project-relative ids.
#[derive(Debug)]
pub struct SourceSet {
    /// App-owned snapshot directory containing engine copy, strategies and generated wrapper.
    /// The directory name embeds the SHA-256 source revision; `revision.json` records it durably.
    pub snapshot: PathBuf,
    /// Compiler-side flat source names mapped back to project-relative ids.
    pub reserved: Vec<(String, String)>,
}

/// The engine metadata marker payload, covering both success and engine-side error variants.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataPayload {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    strategy: Option<String>,
    #[serde(default)]
    strategy_type: Option<String>,
    #[serde(default)]
    parameters: Option<Vec<StrategyParameter>>,
}

/// Minimal SARIF subset for the Roslyn compiler log.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SarifReport {
    #[serde(default)]
    runs: Vec<SarifRun>,
}

/// One SARIF run holding the compiler results.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SarifRun {
    #[serde(default)]
    results: Vec<SarifResult>,
}

/// One SARIF error or warning result.
///
/// Accepts the shapes actual Roslyn/MSBuild logs emit: the Csc SARIF-1.0 log with plain-string
/// messages and `resultFile` locations, and downstream SARIF-2.1 logs with `physicalLocation`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SarifResult {
    #[serde(default)]
    level: Option<String>,
    #[serde(default)]
    rule_id: Option<String>,
    #[serde(default)]
    message: Option<SarifMessage>,
    #[serde(default)]
    locations: Vec<SarifLocation>,
}

/// A SARIF message text, plain string or the `{"text": ...}` object form.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum SarifMessage {
    Plain(String),
    Detailed {
        #[serde(default)]
        text: Option<String>,
    },
}

impl SarifMessage {
    /// The human-readable text of the message, if any.
    fn text(&self) -> Option<&str> {
        match self {
            SarifMessage::Plain(text) => Some(text),
            SarifMessage::Detailed { text } => text.as_deref(),
        }
    }
}

/// One SARIF result location; the compiler log uses `resultFile`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SarifLocation {
    #[serde(default)]
    physical_location: Option<SarifPhysical>,
    #[serde(default)]
    result_file: Option<SarifPhysical>,
}

/// A SARIF artifact location with an optional one-based region.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SarifPhysical {
    #[serde(default)]
    uri: Option<String>,
    #[serde(default)]
    region: Option<SarifRegion>,
}

/// A SARIF one-based source region.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SarifRegion {
    #[serde(default)]
    start_line: Option<u32>,
    #[serde(default)]
    start_column: Option<u32>,
}

/// Maps `null` or a list to a plain list so engine `options: null` stays valid.
fn options_from_null_or_list<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let options: Option<Vec<String>> = serde::Deserialize::deserialize(deserializer)?;
    Ok(options.unwrap_or_default())
}

/// Generated build entry: reflects every concrete Robot subclass linked into this assembly
/// and prints one metadata marker line per user strategy. Engine-internal probe robots
/// (the `BacktestEngine.*` namespace) are excluded so they never appear as user strategies.
const ENTRY_TEMPLATE: &str = r#"// Generated by the workspace build service; do not edit by hand.
using System;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using cAlgo.API;

internal static class WorkspaceStrategyEntry
{
    private const string Marker = "BACKTESTENGINE_STRATEGY_METADATA";

    /// <summary>
    /// Build-time invocation (no arguments) reflects every concrete Robot subclass.
    /// Runtime invocation (arguments present) forwards to the original engine entry point
    /// in BacktestEngine.Run.Program without modifying that source file.
    /// </summary>
    private static int Main(string[] args)
    {
        args = args ?? Array.Empty<string>();
        if (args.Length == 0 || args.All(string.IsNullOrWhiteSpace))
        {
            var robotTypes = typeof(WorkspaceStrategyEntry).Assembly
                .GetTypes()
                .Where(type => !type.IsAbstract && !type.IsInterface && typeof(Robot).IsAssignableFrom(type))
                .Where(type => !type.FullName.StartsWith("BacktestEngine.", StringComparison.Ordinal))
                .OrderBy(type => type.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();
            foreach (var robotType in robotTypes)
            {
                try
                {
                    BacktestEngine.Run.StrategyMetadata.Print(robotType.FullName);
                }
                catch (Exception error)
                {
                    Console.WriteLine(Marker + " " + JsonSerializer.Serialize(
                        new { error = "The robot type '" + robotType.FullName + "' did not initialize: " + error.Message }));
                }
            }
            return 0;
        }

        try
        {
            Type programType = Type.GetType("BacktestEngine.Run.Program");
            if (programType == null)
            {
                foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
                {
                    programType = assembly.GetType("BacktestEngine.Run.Program");
                    if (programType != null)
                        break;
                }
            }
            MethodInfo mainMethod = programType?.GetMethod(
                "Main",
                BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
            if (mainMethod == null)
            {
                Console.Error.WriteLine("BACKTESTENGINE_EXECUTION_ERROR The original engine entry point is unavailable.");
                return 1;
            }
            object result = mainMethod.Invoke(null, new object[] { args });
            return result is int code ? code : 0;
        }
        catch (Exception error)
        {
            Exception actual = error is TargetInvocationException tie && tie.InnerException != null ? tie.InnerException : error;
            Console.Error.WriteLine("BACKTESTENGINE_EXECUTION_ERROR " + actual.GetType().Name + ": " + actual.Message);
            return 1;
        }
    }
}
"#;

/// Builds the generated wrapper project, importing the preserved runner csproj with the
/// project's sources linked through the existing `StrategySource`/`StrategyHelperSources`
/// properties and replacing `Program.cs` with the generated metadata entry.
///
/// The runner csproj is SDK-style, so its own import chain covers `Sdk.props`/`Sdk.targets`
/// for the wrapper; adding those imports again here only produced MSB4011 noise.
fn wrapper_project(name: &str, helpers: &[&str]) -> String {
    let helper_list = helpers
        .iter()
        .map(|helper| format!("$(MSBuildThisFileDirectory)strategies\\{helper}"))
        .collect::<Vec<String>>()
        .join(";");
    format!(
        r#"<Project>
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>disable</Nullable>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <AssemblyName>{name}</AssemblyName>
    <RootNamespace>WorkspaceCompile</RootNamespace>
    <StartupObject>WorkspaceStrategyEntry</StartupObject>
  </PropertyGroup>
  <PropertyGroup>
    <EngineSourceDir>$(MSBuildThisFileDirectory)engine\</EngineSourceDir>
    <StrategySource>$(MSBuildThisFileDirectory)strategies\f0.cs</StrategySource>
    <StrategyHelperSources>{helper_list}</StrategyHelperSources>
  </PropertyGroup>
  <Import Project="$(EngineSourceDir)BacktestEngine.Run\BacktestEngine.Run.csproj" />
  <ItemGroup>
    <Compile Include="$(MSBuildThisFileDirectory)entry\WorkspaceStrategyEntry.cs" />
  </ItemGroup>
</Project>
"#
    )
}

/// Decodes the minimal percent-encoding that appears in SARIF file URIs.
fn decode_percent_encoding(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if let Some(byte) = percent_encoded_byte(bytes, index) {
            decoded.push(byte);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8_lossy(&decoded).to_string()
}

/// Decode one complete percent triplet; malformed or incomplete input stays literal in its caller.
fn percent_encoded_byte(bytes: &[u8], index: usize) -> Option<u8> {
    let encoded = bytes.get(index..index.checked_add(3)?)?;
    if encoded[0] != b'%' {
        return None;
    }
    u8::from_str_radix(std::str::from_utf8(&encoded[1..]).ok()?, 16).ok()
}

/// Converts a SARIF `file:///C:/...` URI into a plain Windows path; other forms pass through.
fn uri_to_path(uri: &str) -> String {
    let prefix_candidates = ["file:///", "file:/"];
    for prefix in prefix_candidates {
        if let Some(rest) = uri.strip_prefix(prefix) {
            return decode_percent_encoding(rest);
        }
    }
    decode_percent_encoding(uri)
}

/// Looks for a plain-path snapshot prefix match, case-insensitively on separators normalized.
fn normalized_prefix(base: &Path) -> String {
    base.to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase()
}

/// Maps a diagnostic artifact path back to project-relative space when possible.
fn map_diagnostic_path(
    uri: &str,
    snapshot: &Path,
    reserved: &[(String, String)],
) -> Option<String> {
    let full = uri_to_path(uri);
    let snapshot_prefix = normalized_prefix(snapshot);
    let normalized_full = full.replace('\\', "/");
    let lowered = normalized_full.to_ascii_lowercase();
    if !lowered.starts_with(&snapshot_prefix) {
        return Some(full);
    }
    let remainder = normalized_full
        .get(snapshot_prefix.len()..)
        .unwrap_or_default()
        .trim_start_matches('/');
    if let Some((_source, id)) = reserved
        .iter()
        .find(|(flat, _)| remainder.ends_with(&format!("strategies/{flat}")))
    {
        return Some(id.clone());
    }
    Some(remainder.to_string())
}

/// Converts SARIF results into bridge diagnostics with one-based line/column when present.
///
/// MSBuild may emit the log with a UTF-8 byte-order mark; it is stripped before parsing so
/// real compiler results are never silently discarded.
fn diagnostics_from_sarif(
    bytes: &[u8],
    snapshot: &Path,
    reserved: &[(String, String)],
) -> Vec<BuildDiagnostic> {
    let payload = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let report: SarifReport = match serde_json::from_slice(payload) {
        Ok(report) => report,
        Err(_) => return Vec::new(),
    };
    report
        .runs
        .iter()
        .flat_map(|run| &run.results)
        .take(MAX_DIAGNOSTICS)
        .map(|result| diagnostic_from_sarif_result(result, snapshot, reserved))
        .collect()
}

/// Map one actual compiler result, preserving optional locations, fallback text and one-based positions.
fn diagnostic_from_sarif_result(
    result: &SarifResult,
    snapshot: &Path,
    reserved: &[(String, String)],
) -> BuildDiagnostic {
    let message = result
        .message
        .as_ref()
        .and_then(SarifMessage::text)
        .map(str::to_owned)
        .unwrap_or_else(|| "The compiler reported a diagnostic without a message.".to_string());
    let severity = match result.level.as_deref() {
        Some("error") => DiagnosticSeverity::Error,
        Some("warning") => DiagnosticSeverity::Warning,
        _ => DiagnosticSeverity::Info,
    };
    let physical = result.locations.first().and_then(|location| {
        location
            .physical_location
            .as_ref()
            .or(location.result_file.as_ref())
    });
    let path = physical
        .and_then(|physical| physical.uri.as_deref())
        .and_then(|uri| map_diagnostic_path(uri, snapshot, reserved));
    let (line, column) = physical
        .and_then(|physical| physical.region.as_ref())
        .map(|region| (region.start_line, region.start_column))
        .unwrap_or((None, None));
    BuildDiagnostic {
        severity,
        message,
        code: result.rule_id.clone(),
        path,
        line,
        column,
    }
}

/// Assembles one fresh immutable build snapshot; user source is copied, never modified.
///
/// Result includes the deterministic revision over sorted source ids and content revisions.
/// Errors are honest: no staged sources, oversized inputs or engine-copy failures skip the
/// whole build instead of faking success.
pub fn assemble(
    root: &ProjectRoot,
    engine_source: &Path,
    snapshots_base: &Path,
) -> Result<SourceSet, String> {
    let ids = crate::workspace::collect_source_files(root)?;
    if ids.is_empty() {
        return Err(
            "The project has no C# source files. Add a .cs file with a Robot subclass and retry."
                .into(),
        );
    }
    if ids.len() > MAX_SNAPSHOT_SOURCES {
        return Err(format!(
            "The project has {} C# source files; the workspace build supports up to {MAX_SNAPSHOT_SOURCES}.",
            ids.len()
        ));
    }
    let mut staged: Vec<(String, String, Vec<u8>)> = Vec::with_capacity(ids.len());
    let mut hasher = Sha256::new();
    for id in &ids {
        let bytes = read_project_source(root, id)?;
        hasher.update(b"c:");
        hasher.update(id.as_bytes());
        hasher.update(b"=");
        hasher.update(crate::workspace::content_revision(&bytes).as_bytes());
        hasher.update(b"\n");
        staged.push((id.clone(), format!("f{}.cs", staged.len()), bytes));
    }
    let revision = format!("{:x}", hasher.finalize());
    let revision_prefix = revision.get(0..12).unwrap_or(&revision).to_string();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let snapshot = snapshots_base.join(format!("{revision_prefix}-{stamp}"));
    fs::create_dir_all(&snapshot)
        .map_err(|error| format!("The app build folder could not be created ({error})."))?;
    let staged_engine_files = copy_engine_source(engine_source, &snapshot.join("engine"))?;
    if staged_engine_files == 0 {
        return Err(
            "The preserved engine source is empty; run the documented engine preparation step."
                .into(),
        );
    }
    fs::create_dir_all(snapshot.join("strategies")).map_err(|error| {
        format!("The snapshot strategies folder could not be created ({error}).")
    })?;
    let mut reserved = Vec::with_capacity(staged.len());
    for (id, flat_name, bytes) in &staged {
        fs::write(snapshot.join("strategies").join(flat_name), bytes)
            .map_err(|error| format!("'{id}' could not be staged for the compile ({error})."))?;
        reserved.push((flat_name.clone(), id.clone()));
    }
    let helper_names: Vec<&str> = reserved
        .iter()
        .skip(1)
        .map(|(flat, _)| flat.as_str())
        .collect();
    fs::create_dir_all(snapshot.join("entry"))
        .map_err(|error| format!("The snapshot entry folder could not be created ({error})."))?;
    fs::write(
        snapshot.join("entry").join("WorkspaceStrategyEntry.cs"),
        ENTRY_TEMPLATE,
    )
    .map_err(|error| format!("The generated build entry could not be written ({error})."))?;
    fs::write(
        snapshot.join("WorkspaceCompile.csproj"),
        wrapper_project("WorkspaceCompile", &helper_names),
    )
    .map_err(|error| format!("The generated build project could not be written ({error})."))?;
    fs::write(snapshot.join("NuGet.Config"), OFFLINE_NUGET_CONFIG)
        .map_err(|error| format!("The offline restore policy could not be staged ({error})."))?;
    // Durable source-revision receipt so artifact evidence stays assignable after the fact.
    let receipt = serde_json::json!({
        "revision": revision,
        "sources": staged.iter().map(|(id, flat_name, _bytes)| serde_json::json!({
            "id": id,
            "snapshotName": flat_name,
        })).collect::<Vec<serde_json::Value>>(),
    });
    let receipt_bytes = serde_json::to_vec_pretty(&receipt)
        .map_err(|error| format!("The snapshot receipt could not be prepared ({error})."))?;
    fs::write(snapshot.join("revision.json"), receipt_bytes)
        .map_err(|error| format!("The snapshot receipt could not be written ({error})."))?;
    compile_inputs::write_compile_membership(&snapshot, &reserved)?;
    let reserved = staged
        .iter()
        .map(|(id, flat_name, _bytes)| (flat_name.clone(), id.clone()))
        .collect();
    Ok(SourceSet { snapshot, reserved })
}

/// Reads one project C# source for staging, enforcing the per-file size bound, never writing.
fn read_project_source(root: &ProjectRoot, id: &str) -> Result<Vec<u8>, String> {
    let mut path = root.directory().to_path_buf();
    for part in id.split('/') {
        path.push(part);
    }
    let metadata =
        fs::metadata(&path).map_err(|error| format!("'{id}' could not be read ({error})."))?;
    if metadata.len() > u64::from(MAX_SOURCE_BYTES) {
        return Err(format!(
            "'{id}' is larger than {} MB; the workspace build supports source files up to that size.",
            MAX_SOURCE_BYTES / (1024 * 1024)
        ));
    }
    fs::read(&path).map_err(|error| format!("'{id}' could not be read ({error})."))
}

/// Copies the preserved engine source into the snapshot, skipping caches and oversized files.
///
/// Returns the number of files copied, so callers can detect a truly empty engine copy at the
/// top level instead of failing when files live only inside project subfolders.
fn copy_engine_source(source: &Path, target: &Path) -> Result<usize, String> {
    let read = fs::read_dir(source)
        .map_err(|error| format!("The preserved engine source could not be read ({error})."))?;
    fs::create_dir_all(target)
        .map_err(|error| format!("The snapshot engine folder could not be created ({error})."))?;
    let mut copied = 0;
    for entry in read.filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink()
            || crate::workspace::EXCLUDED_DIRECTORY_NAMES
                .contains(&name.to_ascii_lowercase().as_str())
        {
            continue;
        }
        if metadata.is_dir() {
            copied += copy_engine_source(&path, &target.join(&name))?;
            continue;
        }
        if metadata.len() > MAX_ENGINE_FILE_BYTES {
            continue;
        }
        let bytes = fs::read(&path)
            .map_err(|error| format!("The engine source could not be staged ({error})."))?;
        fs::write(target.join(&name), bytes)
            .map_err(|error| format!("The engine source could not be staged ({error})."))?;
        copied += 1;
    }
    Ok(copied)
}

/// Removes stale snapshot directories so the app build store stays small; best effort only.
pub fn prune_snapshots(snapshots_base: &Path, keep_newest: usize) {
    let mut staged: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    if let Ok(read) = fs::read_dir(snapshots_base) {
        for entry in read.filter_map(Result::ok) {
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            staged.push((entry.path(), modified));
        }
    }
    if staged.len() <= keep_newest {
        return;
    }
    staged.sort_by_key(|(_path, modified)| std::cmp::Reverse(*modified));
    for (path, _) in staged.into_iter().skip(keep_newest) {
        let _ = fs::remove_dir_all(path);
    }
}

/// Locates possible dotnet executables in documented, owner-approved places.
///
/// The installed app's bundled .NET runtime is checked before machine-wide SDKs and the
/// documented portable developer fallback, while `DOTNET_ROOT` remains an explicit override.
fn dotnet_candidates() -> Vec<PathBuf> {
    let override_root = std::env::var_os("DOTNET_ROOT").map(PathBuf::from);
    let directory = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from));
    let mut candidates =
        preferred_dotnet_candidates(override_root.as_deref(), directory.as_deref());
    candidates.push(PathBuf::from("dotnet"));
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        let installed = PathBuf::from(program_files).join(r"dotnet\dotnet.exe");
        if installed.is_file() {
            candidates.push(installed);
        }
    }
    #[cfg(debug_assertions)]
    candidates.extend(
        std::iter::once(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.build-tools/dotnet/dotnet.exe"),
        )
        .filter(|path| path.is_file()),
    );
    candidates
}

/// Put an explicit SDK override before installed app resources, without reading developer paths in release builds.
fn preferred_dotnet_candidates(
    override_root: Option<&Path>,
    directory: Option<&Path>,
) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = override_root
        .map(|root| root.join("dotnet.exe"))
        .into_iter()
        .filter(|path| path.is_file())
        .collect();
    if let Some(directory) = directory {
        candidates.extend(
            [
                directory.join("runtimes/dotnet/dotnet.exe"),
                directory.join("resources/runtimes/dotnet/dotnet.exe"),
            ]
            .into_iter()
            .filter(|path| path.is_file()),
        );
    }
    candidates
}

/// Probes one dotnet candidate for an installed SDK able to target net10.0.
async fn probe_candidate(
    runtime: &crate::build_process::BuildRuntime,
    executable: &Path,
    cancel: &mut oneshot::Receiver<()>,
    cleanup: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<String, String> {
    let output = crate::build_process::probe_sdk(
        runtime,
        executable,
        cancel,
        cleanup,
        SDK_PROBE_TIMEOUT_SECONDS,
    )
    .await?;
    if !output.status.success() {
        return Err("The dotnet executable is not usable for builds.".into());
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let sdk_versions = text
        .lines()
        .filter(|line| !line.starts_with("BACKTESTENGINE_"))
        .filter_map(|line| line.split_whitespace().next())
        .map(|version| version.to_string())
        .collect::<Vec<String>>()
        .join(", ");
    let supports_net10 = text.lines().any(supports_net10);
    if !supports_net10 {
        return Err(match sdk_versions.is_empty() {
            true => "No .NET SDK was found at that location.".into(),
            false => format!(
                "Only the .NET SDK version(s) {sdk_versions} were found; net10.0 is required."
            ),
        });
    }
    Ok(sdk_versions)
}

/// Tests whether an SDK probe line reports a version that can target net10.0.
fn supports_net10(line: &str) -> bool {
    line.split_whitespace()
        .next()
        .and_then(|version| version.split('.').next())
        .and_then(|major| major.parse::<u64>().ok())
        .is_some_and(|major| major >= 10)
}

/// Requires an installed .NET SDK able to compile the engine's net10.0 sources, with an
/// actionable error when none exists. This never fakes capability.
pub(crate) async fn require_compiler(
    runtime: &crate::build_process::BuildRuntime,
    cancel: &mut oneshot::Receiver<()>,
    cleanup: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<DotnetCompiler, String> {
    use std::sync::atomic::Ordering;
    if !matches!(cancel.try_recv(), Err(oneshot::error::TryRecvError::Empty)) {
        return Err(CANCELLATION_MESSAGE.into());
    }
    let mut last_reason = "No dotnet executable was found.".to_string();
    for candidate in dotnet_candidates() {
        let candidate = match crate::build_process::canonical_candidate(&candidate) {
            Ok(path) => path,
            Err(reason) => {
                last_reason = reason;
                continue;
            }
        };
        match probe_candidate(runtime, &candidate, cancel, cleanup.clone()).await {
            Ok(_) => {
                return Ok(DotnetCompiler {
                    executable: candidate,
                })
            }
            Err(reason)
                if reason == CANCELLATION_MESSAGE
                    || !cleanup.load(Ordering::Acquire)
                    || reason.contains(crate::engine_job::CLEANUP_UNCONFIRMED) =>
            {
                return Err(reason)
            }
            Err(reason) => last_reason = reason,
        }
    }
    Err(format!(
        "A usable .NET 10 SDK is required to compile strategy source. {last_reason}. \
The bundled compiler is missing or unusable. Reinstall the application, or select a compatible SDK with DOTNET_ROOT and restart."
    ))
}

/// Resolves the preserved engine source used for source-linked compiles.
///
/// Order: documented `BACKTEST_ENGINE_SRC` override (testing), the app's bundled read-only
/// resources, and, in developer builds, the retained `engines/csharp/src` copy. The sources
/// are copied into snapshots and never edited in place.
pub fn resolve_engine_source(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(override_directory) = std::env::var_os("BACKTEST_ENGINE_SRC") {
        let directory = PathBuf::from(override_directory);
        if directory.is_dir() {
            return Ok(directory);
        }
    }
    if let Ok(resource) = app.path().resource_dir() {
        let bundled = resource.join("enginesrc");
        if bundled.is_dir() {
            return Ok(bundled);
        }
    }
    #[cfg(debug_assertions)]
    {
        // One parent from the manifest directory reaches the retained engines copy.
        let developer = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("engines")
            .join("csharp")
            .join("src");
        if developer.is_dir() {
            return Ok(developer);
        }
    }
    Err(
        "The preserved build engine source is missing from this installation. Reinstall the application and retry."
            .into(),
    )
}

/// Nonshipped fixture compiler helper; production build/reflection/replay/probe use the contained host.
/// This direct-child test utility does not establish descendant-tree qualification.
#[cfg(test)]
pub async fn run_process(
    executable: &Path,
    arguments: &[&str],
    working: &Path,
    environment: &[(&str, String)],
    cancel: &mut oneshot::Receiver<()>,
    timeout_seconds: u64,
) -> Result<std::process::Output, String> {
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .current_dir(working)
        .kill_on_drop(true)
        .creation_flags_windows();
    for (name, value) in environment {
        command.env(name, value);
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child.stdout.take().ok_or("Fixture stdout is missing.")?;
    let stderr = child.stderr.take().ok_or("Fixture stderr is missing.")?;
    let capture = async {
        let (status, stdout, stderr) = tokio::try_join!(
            async { child.wait().await.map_err(|error| error.to_string()) },
            fixture_output(stdout),
            fixture_output(stderr)
        )?;
        Ok(std::process::Output {
            status,
            stdout,
            stderr,
        })
    };
    let outcome: Result<std::process::Output, String> = tokio::select! {
        result=tokio::time::timeout(Duration::from_secs(timeout_seconds),capture)=>match result {Ok(value)=>value,Err(_)=>Err(format!("The process did not respond within {timeout_seconds} seconds."))},
        _=&mut *cancel=>Err(CANCELLATION_MESSAGE.into()),
    };
    if outcome.is_err() {
        let _ = child.start_kill();
    }
    tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .map_err(|_| "Fixture direct-child exit is unconfirmed.")?
        .map_err(|error| error.to_string())?;
    outcome
}

/// Bound nonshipped fixture output before accumulation too; this helper grants no production execution capability.
#[cfg(test)]
async fn fixture_output(stream: impl tokio::io::AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    stream
        .take(128 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| error.to_string())?;
    if bytes.len() > 128 * 1024 {
        return Err("Fixture output exceeds 128 KiB.".into());
    }
    Ok(bytes)
}

#[cfg(test)]
trait CreationFlagsWindows {
    /// Opens child windows without a console host, matching the established process pattern.
    fn creation_flags_windows(&mut self) -> &mut Self;
}

#[cfg(test)]
impl CreationFlagsWindows for Command {
    fn creation_flags_windows(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            self.creation_flags(0x0800_0000);
        }
        self
    }
}

/// Clamps captured process output so the output panel stays bounded.
fn clamp_output(text: &str) -> String {
    if text.chars().count() <= MAX_OUTPUT_CHARS + 32 {
        return text.to_string();
    }
    let head: String = text.chars().take(MAX_OUTPUT_CHARS / 2).collect();
    let tail: String = text
        .chars()
        .skip(text.chars().count() - MAX_OUTPUT_CHARS / 2)
        .collect();
    format!("{head}\n(output truncated)\n{tail}")
}

/// Captures the compiler error text for honest diagnostics when SARIF carries no results.
fn fallback_diagnostics(detail: &str) -> Vec<BuildDiagnostic> {
    vec![BuildDiagnostic {
        severity: DiagnosticSeverity::Error,
        message: detail.to_string(),
        code: None,
        path: None,
        line: None,
        column: None,
    }]
}

/// Runs one real build: snapshot assembly, .NET compile, SARIF diagnostics, reflected strategies.
///
/// Cancellation and the build-timeout kill the child process itself, not just a spinner state;
/// the returned report always identifies which source revision it describes via its artifact
/// path inside a revision-named snapshot directory.
pub(crate) async fn run_build(
    root: &ProjectRoot,
    engine_source: &Path,
    snapshots_base: &Path,
    compiler: &DotnetCompiler,
    runtime: &crate::build_process::BuildRuntime,
    flight: &crate::build_process::BuildFlight,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<WorkspaceBuild, String> {
    let started = Instant::now();
    let staged = assemble(root, engine_source, snapshots_base)?;
    let source_manifest = crate::replay_receipt::source_manifest(&staged.snapshot)?;
    flight.retain_sources(crate::replay_receipt::lock_source_manifest(
        &staged.snapshot,
        &source_manifest,
    )?)?;
    prune_snapshots(snapshots_base, 3);
    let project_path = staged.snapshot.join("WorkspaceCompile.csproj");
    let sarif_path = staged.snapshot.join("build.sarif");
    let project_argument = project_path.to_string_lossy().to_string();
    let build_environment = offline_build_environment(&staged.snapshot);
    let restore_argument = format!(
        "-p:RestoreConfigFile={}",
        staged.snapshot.join("NuGet.Config").display()
    );
    let compile_arguments: Vec<&str> = vec![
        "build",
        project_argument.as_str(),
        "-c",
        "Release",
        "-nologo",
        "-v",
        "q",
        "-p:ErrorLog=build.sarif",
        &restore_argument,
        "-p:NuGetAudit=false",
        "-p:UseSharedCompilation=false",
        "-nodeReuse:false",
    ];
    let compile_arguments: Vec<String> =
        compile_arguments.into_iter().map(str::to_string).collect();
    let compile = match crate::build_process::run_tool(
        crate::build_process::BuildTool {
            runtime,
            compiler: &compiler.executable,
            mode: crate::execution_process::ToolMode::Build,
            arguments: &compile_arguments,
            working: &staged.snapshot,
            environment: &build_environment,
            timeout_seconds: COMPILE_TIMEOUT_SECONDS,
        },
        cancel,
        flight.cleanup.clone(),
    )
    .await
    {
        Ok(output) => output,
        Err(error) => {
            return Err(format!("Compile phase failed: {error}"));
        }
    };
    let compile_exit_text = compile
        .status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let compiled_successfully = compile.status.success();
    let mut diagnostics = Vec::new();
    if let Ok(sarif_bytes) = fs::read(&sarif_path) {
        diagnostics.extend(diagnostics_from_sarif(
            &sarif_bytes,
            &staged.snapshot,
            &staged.reserved,
        ));
    }
    if !compiled_successfully
        && diagnostics
            .iter()
            .all(|entry| entry.severity != DiagnosticSeverity::Error)
    {
        diagnostics.extend(fallback_diagnostics(
            "The compiler failed. Inspect the build output for the MSBuild error details.",
        ));
    }
    let mut strategies = Vec::new();
    let mut artifacts: Option<String> = None;
    let mut extra_output = String::new();
    if compiled_successfully {
        let artifact = staged
            .snapshot
            .join(r"bin\Release\net10.0\WorkspaceCompile.dll");
        if !artifact.is_file() {
            diagnostics.extend(fallback_diagnostics(
                "The build reported success but no compiled assembly was produced.",
            ));
        } else {
            artifacts = Some(artifact.to_string_lossy().to_string());
            let (metadata_strategies, metadata_diagnostics, metadata_output, metadata_ok) =
                reflect_strategies(
                    runtime,
                    flight,
                    compiler,
                    artifact.parent().unwrap_or(&staged.snapshot),
                    &artifact,
                    cancel,
                )
                .await?;
            strategies = metadata_strategies;
            diagnostics.extend(metadata_diagnostics);
            extra_output = metadata_output;
            if !metadata_ok {
                diagnostics.push(BuildDiagnostic {
                    severity: DiagnosticSeverity::Error,
                    message: "The compiled build produced invalid strategy metadata.".into(),
                    code: None,
                    path: None,
                    line: None,
                    column: None,
                });
            }
        }
    }
    let output_sections = format!(
        "=== compile (exit {compile_exit_text}) ===\n{}\n=== strategy metadata ===\n{}",
        String::from_utf8_lossy(&compile.stdout),
        extra_output
    );
    let metadata_missing = strategies.is_empty() && compiled_successfully;
    let success = compiled_successfully
        && !diagnostics
            .iter()
            .any(|entry| entry.severity == DiagnosticSeverity::Error)
        && !metadata_missing;
    Ok(WorkspaceBuild {
        success,
        diagnostics,
        output: clamp_output(&output_sections),
        duration_ms: started.elapsed().as_millis() as u64,
        strategies,
        artifact_path: artifacts,
        source_manifest: success.then_some(source_manifest),
    })
}

/// Isolate CLI/cache writes and disable background online work and reusable compiler servers.
/// Installed Roslyn servers can otherwise outlive their owning build and retain snapshot assemblies.
pub(crate) fn offline_build_environment(snapshot: &Path) -> Vec<(&'static str, String)> {
    vec![
        (
            "DirectoryBuildPropsPath",
            snapshot
                .join("Directory.Build.props")
                .to_string_lossy()
                .into_owned(),
        ),
        (
            "DirectoryBuildTargetsPath",
            snapshot
                .join("Directory.Build.targets")
                .to_string_lossy()
                .into_owned(),
        ),
        (
            "DOTNET_CLI_HOME",
            snapshot.join(".dotnet-home").to_string_lossy().into_owned(),
        ),
        (
            "NUGET_PACKAGES",
            snapshot
                .join(".nuget-packages")
                .to_string_lossy()
                .into_owned(),
        ),
        (
            "NUGET_HTTP_CACHE_PATH",
            snapshot
                .join(".nuget-http-cache")
                .to_string_lossy()
                .into_owned(),
        ),
        ("DOTNET_NOLOGO", "1".into()),
        ("DOTNET_CLI_TELEMETRY_OPTOUT", "1".into()),
        ("DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE", "true".into()),
        ("DOTNET_GENERATE_ASPNET_CERTIFICATE", "false".into()),
        ("DOTNET_ADD_GLOBAL_TOOLS_TO_PATH", "false".into()),
        ("MSBUILDDISABLENODEREUSE", "1".into()),
        ("UseSharedCompilation", "false".into()),
    ]
}

/// Parses metadata marker lines into strategies and honest diagnostics.
fn parse_metadata_output(stdout_text: &str) -> (Vec<CompiledStrategy>, Vec<BuildDiagnostic>) {
    let mut strategies = Vec::new();
    let mut diagnostics = Vec::new();
    for line in stdout_text.lines() {
        let Some(json) = line.strip_prefix(METADATA_MARKER) else {
            continue;
        };
        let payload: MetadataPayload = match serde_json::from_str(json.trim()) {
            Ok(payload) => payload,
            Err(_) => {
                diagnostics.push(BuildDiagnostic {
                    severity: DiagnosticSeverity::Error,
                    message: "The compiled build produced unreadable strategy metadata.".into(),
                    code: None,
                    path: None,
                    line: None,
                    column: None,
                });
                continue;
            }
        };
        if let Some(message) = payload.error {
            diagnostics.push(BuildDiagnostic {
                severity: DiagnosticSeverity::Error,
                message,
                code: None,
                path: None,
                line: None,
                column: None,
            });
            continue;
        }
        let Some((strategy, strategy_type)) = payload
            .strategy
            .as_ref()
            .zip(payload.strategy_type.as_ref())
        else {
            diagnostics.push(BuildDiagnostic {
                severity: DiagnosticSeverity::Error,
                message: "A metadata marker carried no strategy identity.".into(),
                code: None,
                path: None,
                line: None,
                column: None,
            });
            continue;
        };
        strategies.push(CompiledStrategy {
            strategy: strategy.clone(),
            strategy_type: strategy_type.clone(),
            parameters: payload.parameters.unwrap_or_default(),
        });
    }
    (strategies, diagnostics)
}
/// Runs the compiled metadata entry and returns honest strategies, diagnostics and output.
///
/// Shares the build's cancel receiver so cancellation during schema reflection kills the child.
async fn reflect_strategies(
    runtime: &crate::build_process::BuildRuntime,
    flight: &crate::build_process::BuildFlight,
    compiler: &DotnetCompiler,
    working: &Path,
    artifact: &Path,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<(Vec<CompiledStrategy>, Vec<BuildDiagnostic>, String, bool), String> {
    let artifact_text = artifact.to_string_lossy().to_string();
    let arguments: Vec<String> = vec!["exec".into(), artifact_text];
    let output = match crate::build_process::run_tool(
        crate::build_process::BuildTool {
            runtime,
            compiler: &compiler.executable,
            mode: crate::execution_process::ToolMode::Metadata,
            arguments: &arguments,
            working,
            environment: &[],
            timeout_seconds: METADATA_TIMEOUT_SECONDS,
        },
        &mut *cancel,
        flight.cleanup.clone(),
    )
    .await
    {
        Ok(output) => output,
        Err(error) => {
            return Err(format!("Strategy metadata phase failed: {error}"));
        }
    };
    let stdout_text = String::from_utf8_lossy(&output.stdout);
    let (strategies, diagnostics) = parse_metadata_output(&stdout_text);
    let valid = !strategies.is_empty() && output.status.success();
    Ok((strategies, diagnostics, clamp_output(&stdout_text), valid))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::{create_entry, EntryKind, EXAMPLE_STRATEGY_TEMPLATE};

    /// A temporary project mirroring a seeded app-managed project.
    fn seeded_temp_project() -> (tempfile::TempDir, ProjectRoot) {
        let base = tempfile::TempDir::with_prefix("bktest-build-").unwrap();
        let source = base.path().join("Source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("ExampleStrategy.cs"), EXAMPLE_STRATEGY_TEMPLATE).unwrap();
        let root = ProjectRoot::open(base.path().to_str().unwrap()).unwrap();
        (base, root)
    }

    /// A minimal fake preserved-engine source for snapshot staging tests.
    fn fake_engine_source() -> (tempfile::TempDir, PathBuf) {
        let base = tempfile::TempDir::with_prefix("bktest-engine-").unwrap();
        let runner = base.path().join("BacktestEngine.Run");
        fs::create_dir_all(&runner).unwrap();
        let shim = base.path().join("BacktestEngine.CAlgoShim");
        fs::create_dir(&shim).unwrap();
        fs::write(
            shim.join("BacktestEngine.CAlgoShim.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\" />\n",
        )
        .unwrap();
        fs::write(
            runner.join("BacktestEngine.Run.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\" />\n",
        )
        .unwrap();
        fs::write(runner.join("Program.cs"), "class Program {}\n").unwrap();
        let engine = base.path().to_path_buf();
        (base, engine)
    }

    /// SARIF file URIs decode percent escapes into plain Windows paths.
    #[test]
    fn uri_to_path_decodes_file_uris() {
        assert_eq!(
            uri_to_path("file:///C:/Users/a%20b/x.cs"),
            "C:/Users/a b/x.cs"
        );
        assert_eq!(uri_to_path("C:/plain/path.cs"), "C:/plain/path.cs");
        assert_eq!(
            uri_to_path("file:///D:/Proj/scratch%2Ftest.cs"),
            "D:/Proj/scratch/test.cs"
        );
        assert_eq!(uri_to_path("file:///C:/a%20b/%E2%82%AC.cs"), "C:/a b/€.cs");
        assert_eq!(decode_percent_encoding("bad%2G%2%"), "bad%2G%2%");
        assert_eq!(decode_percent_encoding("%2520"), "%20");
    }

    /// SDK probe lines report net10 capability from the major version only.
    #[test]
    fn sdk_version_lines_drive_capability() {
        assert!(supports_net10("10.0.402 [C:\\Program Files\\dotnet\\sdk]"));
        assert!(supports_net10("11.0.100 [... ]"));
        assert!(!supports_net10("9.0.100 [C:\\Program Files\\dotnet\\sdk]"));
        assert!(!supports_net10("6.0.425"));
        assert!(!supports_net10(""));
        assert!(!supports_net10("(no output)"));
    }

    /// SARIF diagnostics parse the standard and `resultFile` location shapes alike.
    #[test]
    fn sarif_diagnostics_cover_both_location_shapes() {
        let snapshot = Path::new("D:/snapshot/build-abc");
        let reserved = vec![
            ("f0.cs".to_string(), "Source/ExampleStrategy.cs".to_string()),
            ("f1.cs".to_string(), "Source/Other.cs".to_string()),
        ];
        let report = r#"{
              "runs": [
                {
                  "results": [
                    {
                      "level": "error",
                      "ruleId": "CS1002",
                      "message": { "text": "; expected" },
                      "locations": [
                        { "physicalLocation": {
                          "uri": "file:///D:/snapshot/build-abc/strategies/f1.cs",
                          "region": { "startLine": 12, "startColumn": 3 }
                        } }
                      ]
                    },
                    {
                      "level": "warning",
                      "ruleId": "CS0219",
                      "message": "unused variable",
                      "locations": [
                        { "resultFile": {
                          "uri": "file:///D:/snapshot/build-abc/strategies/f0.cs"
                        } }
                      ]
                    },
                    {
                      "level": "note",
                      "message": "note text",
                      "locations": [{ "resultFile": {
                        "uri": "file:///C:/outside/repo.cs",
                        "region": { "startLine": 7 }
                      } }]
                    }
                  ]
                }
              ]
            }"#;
        let diagnostics = diagnostics_from_sarif(report.as_bytes(), snapshot, &reserved);
        assert_eq!(diagnostics.len(), 3, "{diagnostics:?}");
        assert!(matches!(diagnostics[0].severity, DiagnosticSeverity::Error));
        assert_eq!(diagnostics[0].code.as_deref(), Some("CS1002"));
        assert_eq!(diagnostics[0].path.as_deref(), Some("Source/Other.cs"));
        assert_eq!(diagnostics[0].line, Some(12));
        assert_eq!(diagnostics[0].column, Some(3));
        assert_eq!(
            diagnostics[1].path.as_deref(),
            Some("Source/ExampleStrategy.cs")
        );
        assert_eq!(diagnostics[1].message, "unused variable");
        assert_eq!(diagnostics[1].line, None);
        assert!(matches!(diagnostics[2].severity, DiagnosticSeverity::Info));
        assert_eq!(diagnostics[2].path.as_deref(), Some("C:/outside/repo.cs"));
        // Unparseable SARIF yields no invented results.
        assert!(diagnostics_from_sarif(b"not sarif", snapshot, &reserved).is_empty());
    }

    /// Engine metadata markers parse into real strategies; failures stay honest diagnostics.
    #[test]
    fn metadata_markers_parse_into_strategies_and_errors() {
        let stdout = format!(
            "BOOTING\n{} {{\"strategy\":\"ExampleStrategy\",\"strategyType\":\"cAlgo.Robots.ExampleStrategy\",\"parameters\":[{{\"name\":\"VolumeMultiplier\",\"displayName\":\"Volume Multiplier\",\"group\":\"Trading\",\"valueType\":\"Integer\",\"default\":1}}]}}\n{} not-json\n{} {{\"error\":\"did not initialize: boom\"}}\n{} {{\"strategy\":\"\"",
            METADATA_MARKER, METADATA_MARKER, METADATA_MARKER, METADATA_MARKER
        );
        let (strategies, diagnostics) = parse_metadata_output(&stdout);
        assert_eq!(strategies.len(), 1, "{diagnostics:?}");
        assert_eq!(strategies[0].strategy, "ExampleStrategy");
        assert_eq!(strategies[0].strategy_type, "cAlgo.Robots.ExampleStrategy");
        assert_eq!(
            strategies[0].parameters[0].display_name,
            "Volume Multiplier"
        );
        // The unreadable (x2) and engine-error markers become honest error diagnostics.
        assert_eq!(diagnostics.len(), 3, "{diagnostics:?}");
        assert!(diagnostics
            .iter()
            .all(|entry| matches!(entry.severity, DiagnosticSeverity::Error)));
        assert_eq!(
            diagnostics
                .iter()
                .filter(|entry| {
                    entry.message == "The compiled build produced unreadable strategy metadata."
                })
                .count(),
            2
        );
        assert!(diagnostics
            .iter()
            .any(|entry| entry.message.contains("did not initialize")));
        // A marker without any identity is also refused.
        let (empty, identity_errors) = parse_metadata_output(&format!("{METADATA_MARKER} {{}}"));
        assert!(empty.is_empty());
        assert_eq!(identity_errors.len(), 1);
    }

    /// Parameter `options` accepts both `null` and real lists per the engine output.
    #[test]
    fn strategy_parameters_accept_null_and_list_options() {
        let parameter: StrategyParameter = serde_json::from_value(serde_json::json!({
            "name": "Period",
            "displayName": "Period",
            "valueType": "Integer",
            "options": null
        }))
        .unwrap();
        assert!(parameter.options.is_empty());
        let listed: StrategyParameter = serde_json::from_value(serde_json::json!({
            "name": "Mode",
            "displayName": "Mode",
            "valueType": "String",
            "options": ["Fast", "Slow"]
        }))
        .unwrap();
        assert_eq!(listed.options, vec!["Fast".to_string(), "Slow".to_string()]);
    }

    /// The generated wrapper: source-linked properties, program replacement, no SDK re-imports.
    #[test]
    fn wrapper_template_stays_source_linked_without_sdk_reimports() {
        let project = wrapper_project("WorkspaceCompile", &["f1.cs", "f2.cs"]);
        assert!(
            project.contains("<StrategySource>"),
            "StrategySource is required."
        );
        assert!(
            project.contains("strategies\\f0.cs"),
            "the first staged file is the strategy."
        );
        assert!(
            project.contains("strategies\\f1.cs") && project.contains("strategies\\f2.cs"),
            "helper sources must be listed."
        );
        assert!(
            project.contains("BacktestEngine.Run\\BacktestEngine.Run.csproj"),
            "the runner import is required."
        );
        assert!(project.contains("<EnableDefaultCompileItems>false</EnableDefaultCompileItems>"));
        assert!(
            project.contains("<StartupObject>WorkspaceStrategyEntry</StartupObject>"),
            "StartupObject designates the forwarding entry while retaining Program.cs."
        );
        assert!(
            !project
                .contains("Compile Remove=\"$(EngineSourceDir)BacktestEngine.Run\\Program.cs\""),
            "Program.cs must remain compiled so the original engine entry can run."
        );
        assert!(
            project.contains("WorkspaceStrategyEntry.cs"),
            "the generated entry must compile."
        );
        assert!(
            !project.contains("Sdk=\"Microsoft.NET.Sdk\""),
            "explicit SDK imports duplicated the runner's own and produced MSB4011 noise."
        );
        assert!(project.contains("net10.0"));
    }

    /// Snapshot assembly stages a deterministic, receipted copy and never touches user files.
    #[test]
    fn assemble_stages_sources_with_a_durable_receipt() {
        let (project_base, root) = seeded_temp_project();
        let (_engine_base, engine_source) = fake_engine_source();
        // Snapshots live outside the project, exactly like the app-owned builds directory.
        let snapshots_dir = tempfile::TempDir::with_prefix("bktest-snaps-").unwrap();
        let snapshots = snapshots_dir.path().to_path_buf();
        let staged = assemble(&root, &engine_source, &snapshots).unwrap();
        // The snapshot name embeds the revision prefix, and the receipt records the full one.
        let receipt_bytes = fs::read(staged.snapshot.join("revision.json")).unwrap();
        let receipt: Value = serde_json::from_slice(&receipt_bytes).unwrap();
        let revision = receipt["revision"].as_str().unwrap().to_string();
        assert!(staged
            .snapshot
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(&revision[..12]));
        let sources = receipt["sources"].as_array().unwrap();
        assert_eq!(sources.len(), 1, "{sources:?}");
        assert_eq!(sources[0]["id"], "Source/ExampleStrategy.cs");
        assert_eq!(
            staged.reserved,
            vec![("f0.cs".to_string(), "Source/ExampleStrategy.cs".to_string())]
        );
        // Snapshot contents: engine copy, staged flat strategy, entry and generated wrapper.
        assert!(staged
            .snapshot
            .join("engine")
            .join("BacktestEngine.Run")
            .join("Program.cs")
            .is_file());
        assert_eq!(
            fs::read(staged.snapshot.join("strategies").join("f0.cs")).unwrap(),
            EXAMPLE_STRATEGY_TEMPLATE.as_bytes()
        );
        assert!(staged
            .snapshot
            .join("entry")
            .join("WorkspaceStrategyEntry.cs")
            .is_file());
        assert!(staged.snapshot.join("WorkspaceCompile.csproj").is_file());
        assert_eq!(
            fs::read_to_string(staged.snapshot.join("NuGet.Config")).unwrap(),
            OFFLINE_NUGET_CONFIG
        );
        // User source is untouched by staging.
        assert_eq!(
            fs::read(
                project_base
                    .path()
                    .join("Source")
                    .join("ExampleStrategy.cs")
            )
            .unwrap(),
            EXAMPLE_STRATEGY_TEMPLATE.as_bytes()
        );
        // A second assembly maps each id to its flat name in sorted id order.
        create_entry(&root, "Source", "Helper.cs", EntryKind::File).unwrap();
        let second = assemble(&root, &engine_source, &snapshots).unwrap();
        assert_eq!(second.reserved.len(), 2);
        assert_eq!(second.reserved[0].1, "Source/ExampleStrategy.cs");
        assert_eq!(second.reserved[1].1, "Source/Helper.cs");
        assert!(
            second.reserved.iter().all(|(flat, _)| second
                .snapshot
                .join("strategies")
                .join(flat)
                .is_file()),
            "every reserved flat name must exist inside the snapshot."
        );
    }

    /// Projects without any C# source fail assembly with an actionable error; no fake builds.
    #[test]
    fn assemble_requires_csharp_sources() {
        let base = tempfile::TempDir::with_prefix("bktest-empty-").unwrap();
        fs::write(base.path().join("README.md"), "nothing to build").unwrap();
        let root = ProjectRoot::open(base.path().to_str().unwrap()).unwrap();
        let (_engine_base, engine_source) = fake_engine_source();
        let error = assemble(&root, &engine_source, &base.path().join("builds")).unwrap_err();
        assert!(error.contains("no C# source files"), "{error}");
    }

    /// The deterministic revision equals the documented hash over sorted ids and content.
    #[test]
    fn assemble_revision_is_deterministic_for_identical_content() {
        let (_base, root) = seeded_temp_project();
        let (_engine_base, engine_source) = fake_engine_source();
        // Snapshots live outside the project, exactly like the app-owned builds directory.
        let snapshots_dir = tempfile::TempDir::with_prefix("bktest-snaps-").unwrap();
        let snapshots = snapshots_dir.path().to_path_buf();
        let first = assemble(&root, &engine_source, &snapshots).unwrap();
        let second = assemble(&root, &engine_source, &snapshots).unwrap();
        let read_revision = |snapshot: &Path| -> String {
            let receipt: Value =
                serde_json::from_slice(&fs::read(snapshot.join("revision.json")).unwrap()).unwrap();
            receipt["revision"].as_str().unwrap().to_string()
        };
        assert_eq!(
            read_revision(&first.snapshot),
            read_revision(&second.snapshot)
        );
        assert_ne!(
            first.snapshot, second.snapshot,
            "snapshots stay immutable per build."
        );
    }

    /// Output clamping keeps huge logs bounded and labels the truncation.
    #[test]
    fn clamp_output_bounds_and_marks_truncation() {
        let small = "short output";
        assert_eq!(clamp_output(small), small);
        let huge = "x".repeat(MAX_OUTPUT_CHARS * 4);
        let clamped = clamp_output(&huge);
        assert!(clamped.chars().count() < MAX_OUTPUT_CHARS + 64);
        assert!(clamped.contains("(output truncated)"));
    }

    /// A pre-canceled receiver cancels the SDK probe and compiler discovery deterministically.
    #[tokio::test]
    async fn compiler_discovery_honors_pre_canceled_receiver() {
        let probes = tempfile::tempdir().unwrap();
        let runtime = crate::build_process::staged_test_runtime(probes.path());
        let flight = crate::build_process::BuildFlight::new();
        let (sender, mut cancel) = oneshot::channel::<()>();
        let _ = sender.send(());
        let error = require_compiler(&runtime, &mut cancel, flight.cleanup.clone())
            .await
            .unwrap_err();
        assert_eq!(error, CANCELLATION_MESSAGE);
    }

    /// Cancellation kills a sleeping metadata/compile-style child process within its step.
    #[tokio::test]
    async fn run_process_cancels_a_sleeping_child_process() {
        let (sender, mut cancel) = oneshot::channel::<()>();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let _ = sender.send(());
        });
        let started = Instant::now();
        let arguments: Vec<&str> = vec!["-NoProfile", "-Command", "Start-Sleep -Seconds 60"];
        let result = run_process(
            Path::new("powershell"),
            &arguments,
            Path::new("."),
            &[],
            &mut cancel,
            120,
        )
        .await;
        assert_eq!(result.unwrap_err(), CANCELLATION_MESSAGE);
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "cancellation must stop the child quickly, not wait for its timeout."
        );
    }

    /// A timeout alone also stops a hanging child with an honest error.
    #[tokio::test]
    async fn run_process_times_out_hanging_children() {
        let (unused_sender, mut cancel) = oneshot::channel::<()>();
        std::mem::forget(unused_sender);
        let arguments: Vec<&str> = vec!["-NoProfile", "-Command", "Start-Sleep -Seconds 60"];
        let result = run_process(
            Path::new("powershell"),
            &arguments,
            Path::new("."),
            &[],
            &mut cancel,
            2,
        )
        .await;
        assert!(result
            .unwrap_err()
            .contains("did not respond within 2 seconds"));
    }

    /// Real integration: the seeded strategy compiles and reflects its documented parameters.
    ///
    /// Requires the actual staged verified SDK and contained host; missing preparation is a failure.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn real_build_compiles_seeded_strategy_and_reflects_metadata() {
        let probes = tempfile::tempdir().unwrap();
        let runtime = crate::build_process::staged_test_runtime(probes.path());
        let flight = crate::build_process::BuildFlight::new();
        let (sender, mut cancel) = oneshot::channel::<()>();
        std::mem::forget(sender);
        let compiler = require_compiler(&runtime, &mut cancel, flight.cleanup.clone())
            .await
            .unwrap();
        let (_project_base, root) = seeded_temp_project();
        // The retained engine copy mirrors production; the wrapper compiles against it.
        let engine_source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("engines")
            .join("csharp")
            .join("src");
        assert!(
            engine_source.is_dir(),
            "the retained engine source must exist in this repository."
        );
        let builds_dir = tempfile::TempDir::with_prefix("bktest-snaps-").unwrap();
        let builds = builds_dir.path().to_path_buf();
        let build = run_build(
            &root,
            &engine_source,
            &builds,
            &compiler,
            &runtime,
            &flight,
            &mut cancel,
        )
        .await
        .unwrap();
        assert!(flight.release_sources());
        if !build.success {
            eprintln!("build diagnostics: {:?}", build.diagnostics);
        }
        assert!(
            build.success,
            "the seeded strategy must compile; see diagnostics above."
        );
        assert!(build
            .diagnostics
            .iter()
            .all(|entry| !matches!(entry.severity, DiagnosticSeverity::Error)));
        assert_eq!(build.strategies.len(), 1, "{:?}", build.strategies);
        assert_eq!(build.strategies[0].strategy, "ExampleStrategy");
        let names: Vec<&str> = build.strategies[0]
            .parameters
            .iter()
            .map(|parameter| parameter.display_name.as_str())
            .collect();
        assert!(names.contains(&"Volume Multiplier"), "{names:?}");
        assert!(names.contains(&"Hold Ticks"), "{names:?}");
        let artifact = build.artifact_path.expect("artifact required on success");
        assert!(artifact.ends_with("WorkspaceCompile.dll"));
        assert!(Path::new(&artifact).is_file());
        assert!(
            build.output.contains("=== compile (exit 0) ==="),
            "{}",
            build.output
        );
        assert!(build.output.contains("=== strategy metadata ==="));
        assert!(build.duration_ms > 0);
    }

    /// Prove explicit SDK preference and both supported installed-resource layouts without global environment edits.
    #[test]
    fn compiler_prefers_override_then_bundled_sdk_locations() {
        let temporary = tempfile::tempdir().unwrap();
        let override_root = temporary.path().join("override");
        let app = temporary.path().join("app");
        let bundled = app.join("runtimes/dotnet/dotnet.exe");
        let nested = app.join("resources/runtimes/dotnet/dotnet.exe");
        for path in [&override_root.join("dotnet.exe"), &bundled, &nested] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "synthetic path marker").unwrap();
        }
        assert_eq!(
            preferred_dotnet_candidates(Some(&override_root), Some(&app)),
            vec![
                override_root.join("dotnet.exe"),
                bundled.clone(),
                nested.clone()
            ]
        );
        assert_eq!(
            preferred_dotnet_candidates(None, Some(&app)),
            vec![bundled, nested]
        );
    }

    /// Compile with only the actual bundled SDK, empty per-snapshot caches and an unreachable inherited feed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bundled_sdk_build_isolates_restore_from_parent_feeds_and_user_cache() {
        let probes = tempfile::tempdir().unwrap();
        let runtime = crate::build_process::staged_test_runtime(probes.path());
        let flight = crate::build_process::BuildFlight::new();
        let compiler = DotnetCompiler {
            executable: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources/runtimes/dotnet/dotnet.exe"),
        };
        assert!(
            compiler.executable.is_file(),
            "Stage the verified official bundled SDK before this test."
        );
        let (_project, root) = seeded_temp_project();
        let temporary = tempfile::tempdir().unwrap();
        fs::write(temporary.path().join("NuGet.Config"),r#"<configuration><packageSources><clear/><add key="unreachable-parent" value="https://127.0.0.1:9/never-use/index.json"/></packageSources></configuration>"#).unwrap();
        let builds = temporary.path().join("builds");
        let engine = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../engines/csharp/src");
        let (_sender, mut cancel) = oneshot::channel();
        let build = run_build(
            &root,
            &engine,
            &builds,
            &compiler,
            &runtime,
            &flight,
            &mut cancel,
        )
        .await
        .unwrap();
        assert!(flight.release_sources());
        assert!(build.success, "{:?}\n{}", build.diagnostics, build.output);
        let snapshot = fs::read_dir(&builds)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let assets: Value =
            serde_json::from_slice(&fs::read(snapshot.join("obj/project.assets.json")).unwrap())
                .unwrap();
        assert_eq!(
            assets["project"]["restore"]["configFilePaths"],
            serde_json::json!([snapshot.join("NuGet.Config")])
        );
        assert!(assets["project"]["restore"]["sources"]
            .as_object()
            .is_none_or(|sources| sources.is_empty()));
        let packages_path = PathBuf::from(
            assets["project"]["restore"]["packagesPath"]
                .as_str()
                .unwrap(),
        );
        assert_eq!(packages_path, snapshot.join(".nuget-packages"));
        assert!(!packages_path.exists() || fs::read_dir(packages_path).unwrap().next().is_none());
        assert!(!assets["libraries"]
            .as_object()
            .unwrap()
            .values()
            .any(|item| item["type"] == "package"));
        assert!(snapshot.join(".dotnet-home").is_dir());
    }

    /// A real build with an expected compile error reports honest SARIF diagnostics.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn real_build_reports_real_compile_errors_as_diagnostics() {
        let probes = tempfile::tempdir().unwrap();
        let runtime = crate::build_process::staged_test_runtime(probes.path());
        let flight = crate::build_process::BuildFlight::new();
        let (sender, mut cancel) = oneshot::channel::<()>();
        std::mem::forget(sender);
        let compiler = require_compiler(&runtime, &mut cancel, flight.cleanup.clone())
            .await
            .unwrap();
        let (project_base, root) = seeded_temp_project();
        fs::write(
            project_base.path().join("Source").join("Broken.cs"),
            "namespace cAlgo.Robots {{\n    this does not compile ;;;\n}}\n",
        )
        .unwrap();
        let engine_source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("engines")
            .join("csharp")
            .join("src");
        let builds_dir = tempfile::TempDir::with_prefix("bktest-snaps-").unwrap();
        let builds = builds_dir.path().to_path_buf();
        let build = run_build(
            &root,
            &engine_source,
            &builds,
            &compiler,
            &runtime,
            &flight,
            &mut cancel,
        )
        .await
        .unwrap();
        assert!(flight.release_sources());
        assert!(
            !build.success,
            "broken source must fail honestly; output was: {}",
            build.output
        );
        assert!(
            build.artifact_path.is_none(),
            "failed builds have no artifact."
        );
        let errors: Vec<&BuildDiagnostic> = build
            .diagnostics
            .iter()
            .filter(|entry| matches!(entry.severity, DiagnosticSeverity::Error))
            .collect();
        assert!(
            !errors.is_empty(),
            "MUST surface real compiler errors: {:?}",
            build.diagnostics
        );
        // A linked project file diagnostic maps back to the project-relative id path.
        let code_errors: Vec<BuildDiagnostic> = build
            .diagnostics
            .iter()
            .filter(|entry| {
                matches!(entry.severity, DiagnosticSeverity::Error)
                    && entry
                        .code
                        .as_deref()
                        .is_some_and(|code| code.starts_with("CS"))
            })
            .cloned()
            .collect();

        assert!(!code_errors.is_empty(), "{:?}", build.diagnostics);
        let id_paths: Vec<&str> = code_errors
            .iter()
            .filter_map(|entry| entry.path.as_deref())
            .collect();
        assert!(
            id_paths
                .iter()
                .any(|path| path.ends_with("Source/Broken.cs")),
            "diagnostics must map back to project ids: {id_paths:?}"
        );
    }

    /// Old snapshots are pruned so the app build store stays small but keeps the newest.
    #[test]
    fn prune_snapshots_keeps_exactly_three_snapshots() {
        let base = tempfile::TempDir::with_prefix("bktest-prune-").unwrap();
        for index in 0..5 {
            let name = format!("snap{index}");
            let path = base.path().join(&name);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("a.txt"), index.to_string()).unwrap();
            let stamp = std::time::SystemTime::UNIX_EPOCH
                .checked_add(Duration::from_secs(1_700_000_000 + index as u64))
                .unwrap();
            let file = fs::File::options()
                .write(true)
                .open(path.join("a.txt"))
                .unwrap();
            file.set_modified(stamp).unwrap();
        }
        prune_snapshots(base.path(), 3);
        let remaining = fs::read_dir(base.path()).unwrap().count();
        assert_eq!(
            remaining, 3,
            "pruning must keep exactly the newest snapshot count."
        );
    }
}
