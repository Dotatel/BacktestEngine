import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const application =
  process.env.BACKTEST_EXE ??
  path.join(root, "src-tauri/target/debug/dotatel-backtest-engine.exe");
const evidence = path.join(
  root,
  "artifacts/workspace-native",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const dataDirectory = path.join(evidence, "settings");
const port = 9228;
const checks = [];
const skipped = [];
const failures = [];
const preferences = {
  version: 1,
  step: 5,
  completed: true,
  workspaceStyle: "advanced",
  appearance: "light",
  agent: null,
  agentVerified: false,
};
let applicationProcess;
let browser;
let page;
let project;
let source;
let compiledStrategy;
let storedSession;
let applicationOutput = "";

/** Poll bounded state, preserving the final failure for actionable timeout evidence. */
async function until(probe, label, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  let failure;
  while (Date.now() < deadline) {
    let value;
    try {
      value = await probe();
    } catch (error) {
      failure = error;
    }
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`, { cause: failure });
}

/** Bound IPC waits without replacing host errors with synthetic success. */
async function bounded(operation, label, timeout = 25_000) {
  let timer;
  const expiration = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout);
  });
  try {
    return await Promise.race([operation, expiration]);
  } finally {
    clearTimeout(timer);
  }
}

/** Invoke only the app's ordinary scoped native commands through its actual webview. */
async function invoke(command, args = {}, timeout = 25_000) {
  return bounded(
    page.evaluate(
      ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
      { command, args },
    ),
    command,
    timeout,
  );
}

/** Record a group only after every assertion inside it passes. */
async function check(name, operation) {
  await operation();
  checks.push({ name, passed: true });
  console.log(`PASS ${name}`);
}

/** Require the intended error class; a disconnected renderer or unknown command cannot pass. */
async function rejects(command, args, pattern) {
  await assert.rejects(invoke(command, args), (error) => {
    assert.match(
      String(error),
      pattern,
      `${command} rejected for the wrong reason`,
    );
    return true;
  });
}

/** Verify a canonical path is inside the fresh evidence directory before touching a fixture. */
async function fixturePath(relative) {
  const projectRoot = await realpath(project.root);
  const isolatedRoot = await realpath(evidence);
  assertInside(isolatedRoot, projectRoot);
  const target = path.resolve(projectRoot, relative);
  assertInside(projectRoot, target);
  return target;
}

/** Refuse absolute relatives and escapes; no mutation is allowed outside the owned fixture. */
function assertInside(parent, target) {
  const relative = path.relative(parent, target);
  assert.ok(
    relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    `Expected ${target} inside ${parent}`,
  );
}

/** Flatten the contract tree without relying on an implementation-specific entry order. */
function entries(items) {
  return items.flatMap((item) => [item, ...entries(item.children ?? [])]);
}

/** Start a debug desktop executable with fresh settings and process-local WebView2 inspection. */
async function launch() {
  applicationProcess = spawn(application, [], {
    cwd: root,
    windowsHide: false,
    env: {
      ...process.env,
      BACKTEST_DATA_DIR: dataDirectory,
      WEBVIEW2_USER_DATA_FOLDER: path.join(evidence, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      DOTNET_NOLOGO: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  applicationProcess.stdout.on("data", (data) => {
    applicationOutput += data;
  });
  applicationProcess.stderr.on("data", (data) => {
    applicationOutput += data;
  });
  applicationProcess.on("error", (error) => {
    applicationOutput += error.message;
  });
  await until(async () => {
    assert.equal(
      applicationProcess.exitCode,
      null,
      `Desktop exited: ${applicationOutput}`,
    );
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  }, "native CDP endpoint on 9228");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
    timeout: 15_000,
  });
  page = await until(
    () =>
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => !candidate.url().startsWith("devtools:")),
    "app webview",
  );
  page.setDefaultTimeout(15_000);
  await page.locator("main").waitFor();
  await expect(
    page.getByRole("navigation", { name: "Research workflow" }),
  ).toBeVisible();
  assert.deepEqual(
    await invoke("load_preferences"),
    preferences,
    "BACKTEST_EXE must honor isolated debug BACKTEST_DATA_DIR",
  );
}

/** Capture settled real native UI, with local fonts/images ready and animations disabled. */
async function capture(name) {
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images).map((image) =>
        image.decode().catch(() => {}),
      ),
    );
  });
  await page.screenshot({
    path: path.join(evidence, `${name}.png`),
    animations: "disabled",
    fullPage: true,
  });
}

/** Exercise the actual custom close path, waiting for the app-owned process to exit. */
async function closeWithButton() {
  await page.getByRole("button", { name: "Close window", exact: true }).click();
  await until(
    () => applicationProcess.exitCode !== null,
    "custom close exits the native process",
  );
  await browser.close();
  browser = undefined;
}

/** Create a real app-managed example; verify its files and source against the preserved example. */
async function createProject() {
  project = await invoke("workspace_create_project");
  assert.equal(typeof project.root, "string");
  const example = entries(project.entries).find(
    (item) => item.kind === "file" && item.name === "ExampleStrategy.cs",
  );
  assert.ok(
    example,
    "App-created example project must include ExampleStrategy.cs",
  );
  source = await invoke("workspace_read_document", { path: example.id });
  assert.ok(source.revision);
  const original = await readFile(
    path.join(root, "engines/csharp/examples/ExampleStrategy.cs"),
    "utf8",
  );
  assert.equal(
    source.content.replaceAll("\r\n", "\n"),
    original.replaceAll("\r\n", "\n"),
  );
  assert.equal(
    await readFile(await fixturePath(source.path), "utf8"),
    source.content,
  );
  assert.ok((await stat(project.root)).isDirectory());
}

/** Create, edit, rename and move a subtree, proving real bytes survive each native mutation. */
async function filesystem() {
  await invoke("workspace_create_entry", {
    parent: "",
    name: "NativeChecks",
    kind: "folder",
  });
  await invoke("workspace_create_entry", {
    parent: "NativeChecks",
    name: "Nested",
    kind: "folder",
  });
  await invoke("workspace_create_entry", {
    parent: "NativeChecks/Nested",
    name: "notes.txt",
    kind: "file",
  });
  const initial = await invoke("workspace_read_document", {
    path: "NativeChecks/Nested/notes.txt",
  });
  assert.equal(initial.content, "");
  const content = "Native fixture — saved through ordinary IPC.\n";
  const saved = await invoke("workspace_save_document", {
    ...initial,
    content,
  });
  assert.equal(saved.content, content);
  assert.notEqual(saved.revision, initial.revision);
  await invoke("workspace_rename_entry", {
    path: "NativeChecks/Nested",
    name: "Renamed",
  });
  await invoke("workspace_create_entry", {
    parent: "",
    name: "Destination",
    kind: "folder",
  });
  const moved = await invoke("workspace_move_entry", {
    path: "NativeChecks",
    parent: "Destination",
  });
  const movedPath = "Destination/NativeChecks/Renamed/notes.txt";
  assert.ok(entries(moved.entries).some((entry) => entry.id === movedPath));
  assert.equal(
    (await invoke("workspace_read_document", { path: movedPath })).content,
    content,
  );
  assert.equal(await readFile(await fixturePath(movedPath), "utf8"), content);
  await assert.rejects(stat(await fixturePath("NativeChecks")), {
    code: "ENOENT",
  });
}

/** Reject root escape, malformed names, cycles, collisions and missing files for the intended reasons. */
async function invalidOperations() {
  await rejects(
    "workspace_read_document",
    { path: "../outside.txt" },
    /project-relative|usable file|travers|outside|escape/i,
  );
  await rejects(
    "workspace_save_document",
    { path: "../outside.txt", content: "escape", revision: "invalid" },
    /project-relative|usable file|travers|outside|escape/i,
  );
  await rejects(
    "workspace_create_entry",
    { parent: "", name: "../escape.txt", kind: "file" },
    /name|project-relative|travers/i,
  );
  await rejects(
    "workspace_read_document",
    { path: "missing-file.cs" },
    /no longer available|not found|does not exist|could not be read/i,
  );
  await rejects(
    "workspace_move_entry",
    {
      path: "Destination/NativeChecks",
      parent: "Destination/NativeChecks/Renamed",
    },
    /itself|own children|descendant|cycle/i,
  );
  await rejects(
    "workspace_create_entry",
    {
      parent: "Destination/NativeChecks/Renamed",
      name: "notes.txt",
      kind: "file",
    },
    /already exists|unused|collision/i,
  );
  await invoke("workspace_create_entry", {
    parent: "Destination/NativeChecks/Renamed",
    name: "other.txt",
    kind: "file",
  });
  await rejects(
    "workspace_rename_entry",
    { path: "Destination/NativeChecks/Renamed/other.txt", name: "notes.txt" },
    /already exists|collision/i,
  );
  await invoke("workspace_create_entry", {
    parent: "Destination",
    name: "notes.txt",
    kind: "file",
  });
  await rejects(
    "workspace_move_entry",
    {
      path: "Destination/NativeChecks/Renamed/notes.txt",
      parent: "Destination",
    },
    /already contains|already exists|collision/i,
  );
  assert.equal(
    await readFile(await fixturePath("Destination/notes.txt"), "utf8"),
    "",
  );
}

/** Simulate an external edit only inside the app-created fixture; stale writes must preserve it. */
async function externalConflict() {
  const document = await invoke("workspace_read_document", {
    path: "Destination/NativeChecks/Renamed/notes.txt",
  });
  const external = "External fixture edit; must survive stale save.\n";
  await writeFile(await fixturePath(document.path), external);
  await rejects(
    "workspace_save_document",
    { ...document, content: "Stale editor draft" },
    /changed outside|conflict|stale|revision/i,
  );
  assert.equal(
    await readFile(await fixturePath(document.path), "utf8"),
    external,
  );
  const latest = await invoke("workspace_read_document", {
    path: document.path,
  });
  assert.notEqual(latest.revision, document.revision);
  assert.equal(latest.content, external);
  const saved = await invoke("workspace_save_document", {
    ...latest,
    content: "Resolved fixture edit.\n",
  });
  assert.equal(
    await readFile(await fixturePath(saved.path), "utf8"),
    saved.content,
  );
}

/** Require successful actual compilation, an on-disk assembly and the original reflected parameter schema. */
async function successfulBuild(label) {
  const build = await invoke("workspace_build", {}, 180_000);
  await writeFile(
    path.join(evidence, `${label}.json`),
    JSON.stringify(build, null, 2),
  );
  assert.equal(build.success, true, build.output);
  assert.equal(
    build.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    false,
  );
  assert.ok(
    build.artifactPath,
    "Successful build must identify its compiled artifact",
  );
  assertInside(
    await realpath(dataDirectory),
    await realpath(build.artifactPath),
  );
  assert.ok((await stat(build.artifactPath)).size > 0);
  assert.ok(build.durationMs >= 0);
  compiledStrategy = build.strategies.find(
    (strategy) => strategy.strategy === "ExampleStrategy",
  );
  assert.ok(compiledStrategy, "Compiled ExampleStrategy metadata is required");
  assert.equal(compiledStrategy.strategyType, "cAlgo.Robots.ExampleStrategy");
  const expected = [
    {
      name: "HoldTicks",
      displayName: "Hold Ticks",
      group: "",
      valueType: "integer",
      default: 100,
      min: null,
      max: null,
      step: null,
      options: [],
    },
    {
      name: "VolumeMultiplier",
      displayName: "Volume Multiplier",
      group: "",
      valueType: "integer",
      default: 1,
      min: null,
      max: null,
      step: null,
      options: [],
    },
  ];
  assert.deepEqual(
    compiledStrategy.parameters
      .map((parameter) => ({
        ...parameter,
        options: parameter.options === null ? [] : parameter.options,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    expected,
  );
  return build;
}

/** Require compiler-generated source location/code after corrupting only our project, then restore it. */
async function compilerDiagnostics() {
  const current = await invoke("workspace_read_document", {
    path: source.path,
  });
  const badContent = `${current.content}\n#error NATIVE_WORKSPACE_TEST_ERROR\n`;
  const diagnosticLine = badContent
    .slice(0, badContent.indexOf("#error"))
    .split("\n").length;
  await invoke("workspace_save_document", { ...current, content: badContent });
  try {
    const failed = await invoke("workspace_build", {}, 180_000);
    await writeFile(
      path.join(evidence, "compiler-error.json"),
      JSON.stringify(failed, null, 2),
    );
    assert.equal(failed.success, false);
    assert.equal(
      failed.artifactPath,
      null,
      "Failed compile cannot retain a successful artifact",
    );
    const diagnostic = failed.diagnostics.find(
      (item) => item.code === "CS1029" && item.path === source.path,
    );
    assert.ok(
      diagnostic,
      "Expected real CS1029 diagnostic mapped to the original project-relative path",
    );
    assert.equal(diagnostic.severity, "error");
    assert.equal(diagnostic.line, diagnosticLine);
    assert.ok(diagnostic.column >= 1);
    assert.match(diagnostic.message, /NATIVE_WORKSPACE_TEST_ERROR/);
  } finally {
    const broken = await invoke("workspace_read_document", {
      path: source.path,
    });
    await invoke("workspace_save_document", {
      ...broken,
      content: current.content,
    });
  }
  await successfulBuild("restored-build");
}

/** Reject an overlap independent of host scheduling; cancel only while a build remains pending. */
async function buildLifecycle() {
  const result = await bounded(
    page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      let completed = 0;
      const builds = [0, 1].map(() =>
        invoke("workspace_build")
          .then(
            (value) => ({ value }),
            (error) => ({ error: String(error) }),
          )
          .finally(() => {
            completed += 1;
          }),
      );
      await Promise.race(builds);
      if (completed === 2)
        return { builds: await Promise.all(builds), cancelAttempted: false };
      const cancellation = await invoke("workspace_cancel_build").then(
        () => ({ accepted: true }),
        (error) => ({ error: String(error) }),
      );
      return {
        builds: await Promise.all(builds),
        cancellation,
        cancelAttempted: true,
      };
    }),
    "overlap and cancellation",
    180_000,
  );
  await writeFile(
    path.join(evidence, "build-lifecycle.json"),
    JSON.stringify(result, null, 2),
  );
  const overlaps = result.builds.filter((build) =>
    /already running|build.*progress/i.test(build.error ?? ""),
  );
  assert.equal(
    overlaps.length,
    1,
    "Exactly one concurrent build must be rejected as overlapping",
  );
  const active = result.builds.find((build) => build !== overlaps[0]);
  checks.push({ name: "overlapping real builds are rejected", passed: true });
  if (!result.cancelAttempted) {
    skipped.push({
      name: "native cancellation",
      reason:
        "Original build finished before cancellation could be requested; no cancellation success claimed.",
    });
    assert.equal(active.value?.success, true);
    return;
  }
  if (
    result.cancellation.error &&
    /no build is running/i.test(result.cancellation.error)
  ) {
    skipped.push({
      name: "native cancellation",
      reason:
        "Build finished between the pending check and cancellation; no cancellation success claimed.",
    });
    assert.equal(active.value?.success, true);
    return;
  }
  assert.equal(result.cancellation.accepted, true);
  if (active.value?.success === true) {
    skipped.push({
      name: "native cancellation",
      reason:
        "Build completed before the accepted cancellation took effect; no cancellation success claimed.",
    });
    return;
  }
  assert.match(
    active.error ?? "",
    /build was cancel[el]+d|build cancel[el]+d/i,
  );
  checks.push({
    name: "pending native build cancellation rejects its result",
    passed: true,
  });
  await successfulBuild("after-cancellation-build");
}

/** Exercise editor, compiler, reflected form and preset persistence through the actual rendered controls. */
async function editorWorkflow() {
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible();
  await editor.click({ position: { x: 160, y: 40 } });
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n// Saved through the native editor UI\n");
  await expect(
    page.getByRole("tab", { name: /ExampleStrategy.*Unsaved changes/ }),
  ).toBeVisible();
  await page.keyboard.press("Control+s");
  await until(
    async () =>
      (
        await invoke("workspace_read_document", { path: source.path })
      ).content.includes("Saved through the native editor UI"),
    "editor save reaches the actual filesystem",
  );
  const savedSource = await invoke("workspace_read_document", {
    path: source.path,
  });
  const build = page
    .getByRole("group", { name: "Build actions" })
    .getByRole("button", { name: "Build", exact: true });
  await build.click();
  await expect(page.getByText("Build succeeded.", { exact: true })).toBeVisible(
    { timeout: 180_000 },
  );
  const hold = page.getByRole("textbox", { name: "Hold Ticks", exact: true });
  await expect(hold).toHaveValue("100");
  await hold.fill("250");
  await page
    .getByRole("textbox", { name: "Volume Multiplier", exact: true })
    .fill("2");
  await page
    .getByRole("textbox", { name: "New preset name", exact: true })
    .fill("Saved through UI");
  await page.getByRole("button", { name: "Save preset", exact: true }).click();
  await until(
    async () =>
      (await invoke("workspace_load_session")).presets.some(
        (preset) =>
          preset.name === "Saved through UI" && preset.values.HoldTicks === 250,
      ),
    "form preset is durable",
  );
  const formBounds = await page
    .locator(".inspector-scroll")
    .evaluate((element) => ({
      width: element.clientWidth,
      content: element.scrollWidth,
      left: element.scrollLeft,
    }));
  assert.ok(
    formBounds.content <= formBounds.width + 1,
    "Parameter form must fit the inspector without horizontal clipping",
  );
  assert.equal(formBounds.left, 0);
  const a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  assert.deepEqual(a11y.violations, [], JSON.stringify(a11y.violations));
  await capture("workspace-built-dark");
  await editor.click({ position: { x: 160, y: 40 } });
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n#error UI_COMPILER_CHECK\n");
  await build.click();
  await expect(
    page.getByRole("button", { name: /UI_COMPILER_CHECK/ }),
  ).toBeVisible({ timeout: 180_000 });
  await page.getByRole("button", { name: /UI_COMPILER_CHECK/ }).click();
  await capture("workspace-compiler-error");
  await editor.click({ position: { x: 160, y: 40 } });
  // Delete the injected final error line through ordinary keys; typing is not clipboard paste.
  await page.keyboard.press("Control+End");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("Backspace");
  await build.click();
  await expect(page.getByText("Build succeeded.", { exact: true })).toBeVisible(
    { timeout: 180_000 },
  );
  assert.equal(
    (
      await invoke("workspace_read_document", { path: source.path })
    ).content.trimEnd(),
    savedSource.content.trimEnd(),
  );
}

/** Store source-independent session state, close the actual window, and prove durable restoration. */
async function persistence() {
  storedSession = {
    lastProject: project.root,
    activeFile: source.path,
    openFiles: [source.path, "Destination/NativeChecks/Renamed/notes.txt"],
    presets: [
      {
        projectRoot: project.root,
        strategy: compiledStrategy.strategy,
        name: "Native persistence fixture",
        values: { HoldTicks: 250, VolumeMultiplier: 2 },
      },
    ],
  };
  await invoke("workspace_save_session", { session: storedSession });
  assert.deepEqual(await invoke("workspace_load_session"), storedSession);
  await page.reload();
  await expect(
    page.getByRole("navigation", { name: "Research workflow" }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: /ExampleStrategy\.cs/ }),
  ).toBeVisible();
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await capture("workspace-light");
  await closeWithButton();
  await launch();
  assert.deepEqual(await invoke("workspace_load_session"), storedSession);
  await expect(
    page.getByRole("tab", { name: /ExampleStrategy\.cs/ }),
  ).toBeVisible();
  assert.equal(
    (await invoke("workspace_read_document", { path: source.path })).content,
    source.content,
  );
  assert.equal(
    await readFile(await fixturePath(source.path), "utf8"),
    source.content,
  );
  const settings = page.getByRole("button", {
    name: "Workspace settings",
    exact: true,
  });
  await settings.click();
  await page.getByRole("combobox", { name: "Appearance", exact: true }).click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await until(
    async () => (await invoke("load_preferences")).appearance === "dark",
    "durable dark appearance",
  );
  await capture("workspace-dark");
  await closeWithButton();
  preferences.appearance = "dark";
  await launch();
  assert.deepEqual(await invoke("workspace_load_session"), storedSession);
  assert.equal(
    (await invoke("workspace_read_document", { path: source.path })).content,
    source.content,
  );
  await check(
    "native UI editing, save-before-build, reflected parameters, presets and compiler navigation",
    editorWorkflow,
  );
  await closeWithButton();
}

/** Disconnect and terminate only this script's spawned process; never stop a port owner or other app. */
async function cleanup() {
  if (page && !page.isClosed() && applicationProcess?.exitCode === null)
    await invoke("workspace_cancel_build", {}, 5000).catch(() => {});
  await browser?.close().catch(() => {});
  if (
    !applicationProcess ||
    applicationProcess.exitCode !== null ||
    applicationProcess.signalCode !== null
  )
    return;
  applicationProcess.kill();
  await until(
    () =>
      applicationProcess.exitCode !== null ||
      applicationProcess.signalCode !== null,
    "owned desktop cleanup",
    10_000,
  ).catch((error) => failures.push({ cleanup: error.message }));
}

/** Persist exact passing groups, skips and failures even if startup or the first contract check fails. */
async function report() {
  await writeFile(path.join(evidence, "application.log"), applicationOutput);
  await writeFile(
    path.join(evidence, "report.json"),
    JSON.stringify(
      {
        application,
        evidence,
        checks,
        skipped,
        failures,
        passed: checks.length,
        failed: failures.length,
      },
      null,
      2,
    ),
  );
  console.log(
    `Native workspace: ${checks.length} passed; ${failures.length} failed; ${skipped.length} skipped. Evidence: ${evidence}`,
  );
}

await mkdir(dataDirectory, { recursive: true });
try {
  await stat(application);
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    }),
    "CDP 9228 is occupied; refusing to attach to another process",
  );
  await writeFile(
    path.join(dataDirectory, "onboarding.json"),
    JSON.stringify(preferences, null, 2),
  );
  await launch();
  await check("isolated native Build workspace startup", async () => {
    assert.deepEqual(await invoke("workspace_load_session"), {
      lastProject: null,
      activeFile: null,
      openFiles: [],
      presets: [],
    });
    await rejects(
      "workspace_build",
      {},
      /no project is open|open a project first/i,
    );
    await capture("workspace-empty");
  });
  await check("app-created example exists on disk", createProject);
  await check(
    "real create/save/rename/move preserve subtree contents",
    filesystem,
  );
  await check(
    "unsafe paths, cycles, collisions and missing paths are rejected",
    invalidOperations,
  );
  await check(
    "stale document revisions preserve external edits",
    externalConflict,
  );
  await check(
    "saved C# compiles to a real assembly with original reflected schema",
    () => successfulBuild("initial-build"),
  );
  await check(
    "real source compiler diagnostic and restored successful rebuild",
    compilerDiagnostics,
  );
  await buildLifecycle();
  await check(
    "custom close/relaunch preserves files, open tabs, preset and appearance",
    persistence,
  );
} catch (error) {
  failures.push({
    message: String(error),
    stack: error?.stack,
    cause: String(error?.cause ?? ""),
  });
  console.error(error);
  if (page && !page.isClosed()) await capture("failure").catch(() => {});
  process.exitCode = 1;
} finally {
  await cleanup();
  await report();
  if (failures.length) process.exitCode = 1;
}
