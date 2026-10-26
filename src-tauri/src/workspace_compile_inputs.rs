//! Generated snapshot-only compiler membership; retained project files and SDK generation stay unchanged.
use std::{fs, path::Path};

/// Pin original runner/shim and flattened strategy files before CoreCompile, excluding later wildcard injections.
pub(crate) fn write_compile_membership(
    snapshot: &Path,
    strategies: &[(String, String)],
) -> Result<(), String> {
    fs::write(snapshot.join("Directory.Build.props"),r#"<Project><PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems><DirectoryBuildTargetsPath>$(MSBuildThisFileDirectory)Directory.Build.targets</DirectoryBuildTargetsPath></PropertyGroup></Project>"#).map_err(|error|error.to_string())?;
    let runner = compile_sources(snapshot, "engine/BacktestEngine.Run", false)?;
    let shim = compile_sources(snapshot, "engine/BacktestEngine.CAlgoShim", true)?;
    let mut wrapper = runner;
    wrapper.extend(
        strategies
            .iter()
            .map(|(flat, _)| format!("strategies/{flat}")),
    );
    wrapper.push("entry/WorkspaceStrategyEntry.cs".into());
    let wrapper_items = compile_items(&wrapper, "$(_DotaTelWrapper)");
    let shim_items = compile_items(&shim, "$(_DotaTelShim)");
    let targets = format!(
        r#"<Project>
  <PropertyGroup>
    <_DotaTelFrozenRoot>$(MSBuildThisFileDirectory)</_DotaTelFrozenRoot>
    <_DotaTelWrapper>$([System.IO.Path]::GetFullPath('$(_DotaTelFrozenRoot)WorkspaceCompile.csproj'))</_DotaTelWrapper>
    <_DotaTelShim>$([System.IO.Path]::GetFullPath('$(_DotaTelFrozenRoot)engine/BacktestEngine.CAlgoShim/BacktestEngine.CAlgoShim.csproj'))</_DotaTelShim>
  </PropertyGroup>
  <Target Name="DotaTelFrozenCompileInputs" BeforeTargets="CoreCompile" DependsOnTargets="GenerateAssemblyInfo;GenerateGlobalUsings;GenerateTargetFrameworkMonikerAttribute">
    <Error Condition="'$(MSBuildProjectFullPath)' != '$(_DotaTelWrapper)' and '$(MSBuildProjectFullPath)' != '$(_DotaTelShim)'" Text="Unexpected project in the frozen compiler-input graph." />
    <PropertyGroup>
      <_DotaTelOwnedObj>$([System.IO.Path]::GetFullPath('$(MSBuildProjectDirectory)/obj/'))</_DotaTelOwnedObj>
    </PropertyGroup>
    <ItemGroup>
      <_DotaTelSdkGenerated Include="$(GeneratedAssemblyInfoFile)" Condition="'$(GeneratedAssemblyInfoFile)' != '' and Exists('$(GeneratedAssemblyInfoFile)')" />
      <_DotaTelSdkGenerated Include="$(GeneratedGlobalUsingsFile)" Condition="'$(GeneratedGlobalUsingsFile)' != '' and Exists('$(GeneratedGlobalUsingsFile)')" />
      <_DotaTelSdkGenerated Include="$(TargetFrameworkMonikerAssemblyAttributesPath)" Condition="'$(TargetFrameworkMonikerAssemblyAttributesPath)' != '' and Exists('$(TargetFrameworkMonikerAssemblyAttributesPath)')" />
    </ItemGroup>
    <Error Condition="!$([System.String]::Copy('%(_DotaTelSdkGenerated.FullPath)').StartsWith('$(_DotaTelOwnedObj)', System.StringComparison.OrdinalIgnoreCase))" Text="SDK-generated compile input escaped its owned obj directory." />
    <ItemGroup>
      <Compile Remove="@(Compile)" />
{wrapper_items}{shim_items}      <Compile Include="@(_DotaTelSdkGenerated)" />
    </ItemGroup>
  </Target>
</Project>
"#
    );
    fs::write(snapshot.join("Directory.Build.targets"), targets)
        .map_err(|error| format!("Cannot pin compiler input membership ({error})."))
}

/// Use stable relative identities so identical Build/fresh replay snapshots have identical target bytes.
fn compile_items(files: &[String], project: &str) -> String {
    files.iter().map(|file|format!("      <Compile Include=\"$(_DotaTelFrozenRoot){}\" Condition=\"'$(MSBuildProjectFullPath)' == '{project}'\" />\n",xml(file))).collect()
}

/// Enumerate only captured .cs files, keeping runner's top-level and shim's original recursive scope.
fn compile_sources(root: &Path, relative: &str, recursive: bool) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    collect_sources(root, relative, recursive, &mut files, 0)?;
    files.sort_by_key(|value| value.to_ascii_lowercase());
    Ok(files)
}

/// Bound directory work and refuse redirected source entries; no retained project wildcard reaches Csc.
fn collect_sources(
    root: &Path,
    relative: &str,
    recursive: bool,
    files: &mut Vec<String>,
    depth: usize,
) -> Result<(), String> {
    if depth > 16 || files.len() > 4096 {
        return Err("Frozen compiler membership exceeds its bounds.".into());
    }
    crate::replay_receipt::ensure_plain_path(&root.join(relative))?;
    for entry in fs::read_dir(root.join(relative)).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let relative = format!("{relative}/{}", entry.file_name().to_string_lossy());
        collect_entry(root, &relative, recursive, files, depth)?;
    }
    Ok(())
}

/// Keep bin/obj out of original source membership; only the three explicit SDK-generated files are restored later.
fn collect_entry(
    root: &Path,
    relative: &str,
    recursive: bool,
    files: &mut Vec<String>,
    depth: usize,
) -> Result<(), String> {
    let path = root.join(relative);
    crate::replay_receipt::ensure_plain_path(&path)?;
    if path.is_dir() {
        if recursive
            && !matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some("bin" | "obj")
            )
        {
            collect_sources(root, relative, recursive, files, depth + 1)?;
        }
        return Ok(());
    }
    if path.extension().and_then(|extension| extension.to_str()) == Some("cs") {
        files.push(relative.into());
    }
    Ok(())
}

/// Escape only MSBuild/XML metacharacters in literal compiler identities; source filenames are never executable text.
fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace(char::from(39), "&apos;")
}

#[cfg(test)]
#[path = "workspace_compile_inputs_tests.rs"]
mod tests;
