import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
const application = path.resolve(
  process.env.BACKTEST_EXE ??
    path.join(root, "src-tauri/target/debug/dotatel-backtest-engine.exe"),
);
const evidence = path.join(
  root,
  "artifacts/execution-native-qa",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const dataDirectory = path.join(evidence, "settings");
const port = 9230;
const checks = [];
const skipped = [];
const failures = [];
const blocked = [];
const reportArtifacts = [];
const preferences = {
  version: 1,
  step: 5,
  completed: true,
  workspaceStyle: "advanced",
  appearance: "light",
  agent: null,
  agentVerified: false,
};
const symbolSpecPath = process.env.BACKTEST_SYMBOL_SPEC ?? "";
let applicationProcess;
let browser;
let page;
let project;
let source;
let build;
let importedDataset;
let registrationFixture;
let applicationOutput = "";
let executableIdentity;
let windowMinimized = false;

/** Normalize canonical Windows paths before comparing returned IPC paths. */
function normalizeWindowsPath(value) {
  const text = String(value ?? "");
  if (text.startsWith("\\\\?\\UNC\\")) return `\\\\${text.slice(8)}`;
  if (text.startsWith("\\\\?\\")) return text.slice(4);
  return text;
}

/** Reject roots, absolute relatives, and traversal before any fixture mutation or removal. */
function assertInside(parent, target) {
  const relative = path.relative(parent, target);
  assert.ok(
    relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    `Fixture escapes owned root: ${target}`,
  );
}

/** Resolve an existing owned file; symlink targets must also remain under this run's evidence. */
async function ownedPath(target) {
  const resolved = normalizeWindowsPath(await realpath(target));
  assertInside(normalizeWindowsPath(await realpath(evidence)), resolved);
  return resolved;
}

/** Poll bounded observable state, preserving the last error for useful timeout diagnostics. */
async function until(probe, label, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  let failure;
  while (Date.now() < deadline) {
    const outcome = await Promise.resolve()
      .then(probe)
      .catch((error) => {
        failure = error;
        return null;
      });
    if (outcome) return outcome;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`, { cause: failure });
}

/** Bound IPC waits without converting timeout or host errors into synthetic success. */
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

/** Invoke the actual webview's scoped Tauri command bridge. */
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

/** Record each attempted check independently; failures never become skipped or passed checks. */
async function check(name, operation) {
  try {
    await operation();
    checks.push({ name, passed: true });
    console.log(`PASS ${name}`);
    return true;
  } catch (error) {
    failures.push({ name, message: String(error), stack: error?.stack });
    console.error(`FAIL ${name}: ${error}`);
    return false;
  }
}

/** Require the intended host error class, never an unrelated earlier validation failure. */
async function rejects(command, args, pattern) {
  await assert.rejects(invoke(command, args), (error) => {
    assert.match(
      String(error),
      pattern,
      `${command} rejected for the wrong reason: ${String(error)}`,
    );
    return true;
  });
}

/** Hash exact file bytes for provenance and executable/report identity. */
async function sha256File(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

/** Make deterministic, explicitly synthetic ticks for guard checks; these establish no trading parity. */
function generateTickCsv(rowCount) {
  const lines = ["time_utc,bid,ask"];
  for (let index = 0; index < rowCount; index += 1) {
    const time = new Date(
      Date.parse("2026-01-01T00:00:00Z") + index * 60_000,
    ).toISOString();
    lines.push(
      `${time},${(100 + index * 0.01).toFixed(5)},${(100.0002 + index * 0.01).toFixed(5)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Build a request whose execution artifact always comes from the host's approved build. */
function request(overrides = {}) {
  return {
    buildArtifactPath: build.artifactPath,
    strategy: "ExampleStrategy",
    datasetId: importedDataset.id,
    symbolSpecPath: registrationFixture.storedPath,
    startingBalance: 10000,
    commissionUsdPerMillion: -1,
    slippagePips: 0,
    writeEquityCsv: false,
    ...overrides,
  };
}

/** Replace only an owned fixture: Windows may deny truncating a mapped DLL while allowing unlink/recreation. */
async function withFileMutation(target, replacement, operation) {
  const resolved = await ownedPath(target);
  const original = await readFile(resolved);
  try {
    await rm(resolved);
    if (replacement !== null) await writeFile(resolved, replacement);
    await operation();
  } finally {
    await rm(resolved, { force: true });
    await writeFile(resolved, original);
    assert.deepEqual(
      await readFile(resolved),
      original,
      `Fixture restoration failed: ${resolved}`,
    );
  }
}

/** Find the actual snapshot receipt, stopping strictly at this run's owned builds directory. */
async function receiptPath() {
  const buildsRoot = await ownedPath(
    path.join(dataDirectory, "workspace", "builds"),
  );
  let ancestor = path.dirname(await ownedPath(build.artifactPath));
  while (ancestor !== buildsRoot) {
    assertInside(buildsRoot, ancestor);
    const candidate = path.join(ancestor, "revision.json");
    if (
      await stat(candidate)
        .then((item) => item.isFile())
        .catch(() => false)
    )
      return ownedPath(candidate);
    ancestor = path.dirname(ancestor);
  }
  throw new Error("Real successful build has no snapshot-root receipt.");
}

/** Launch a fresh isolated app; refuse to attach to an occupied debugging port. */
async function launch() {
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    }),
    "CDP port occupied; refusing to attach to another process",
  );
  executableIdentity = {
    sha256: await sha256File(application),
    mtime: (await stat(application)).mtime.toISOString(),
  };
  applicationProcess = spawn(application, [], {
    cwd: root,
    windowsHide: true,
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
    return (
      await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      })
    ).ok;
  }, "owned native CDP endpoint");
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
  assert.deepEqual(await invoke("load_preferences"), preferences);
  await minimizeOwnedWindow();
}

/** Keep the owner's preview visible after proving the test app's real minimize control works. */
async function minimizeOwnedWindow() {
  if (process.env.BACKTEST_QA_MINIMIZE !== "1") return;
  const minimized = await check(
    "owned native test window minimizes before background checks",
    async () => {
      const button = page.getByRole("button", { name: "Minimize window" });
      await button.waitFor({ state: "visible" });
      assert.equal(await button.isEnabled(), true);
      assert.equal(
        await invoke("plugin:window|is_minimized", { label: "main" }),
        false,
      );
      await button.click();
      await until(
        () => invoke("plugin:window|is_minimized", { label: "main" }),
        "owned test window minimized",
      );
      windowMinimized = true;
    },
  );
  assert.ok(minimized, "Could not minimize the owned test window");
}

/** Cancel owned work and terminate only the process tree started by this harness. */
async function closeApp() {
  if (page && !page.isClosed()) {
    await invoke("execution_cancel", {}, 5000).catch(() => {});
    await invoke("workspace_cancel_build", {}, 5000).catch(() => {});
  }
  if (applicationProcess?.pid && applicationProcess.exitCode === null) {
    execFileSync(
      "taskkill",
      ["/PID", String(applicationProcess.pid), "/T", "/F"],
      { windowsHide: true, stdio: "pipe", timeout: 10000 },
    );
    await until(
      () =>
        applicationProcess.exitCode !== null ||
        applicationProcess.signalCode !== null,
      "owned desktop process cleanup",
      10000,
    );
  }
  await browser?.close().catch(() => {});
}

/** Create an isolated project through the app's real entry point and retain its real source revision. */
async function createProject() {
  project = await invoke("workspace_create_project");
  await ownedPath(project.root);
  source = await invoke("workspace_read_document", {
    path: "Source/ExampleStrategy.cs",
  });
  assert.ok(source.revision);
}

/** Compile the saved example with the real toolchain; never fabricate an approval receipt. */
async function successfulBuild() {
  build = await invoke("workspace_build", {}, 180_000);
  await writeFile(
    path.join(evidence, "build.json"),
    JSON.stringify(build, null, 2),
  );
  assert.equal(build.success, true, build.output);
  assert.ok(build.artifactPath);
  assert.ok((await stat(await ownedPath(build.artifactPath))).size > 0);
  assert.ok(
    build.strategies.some(
      (strategy) => strategy.strategy === "ExampleStrategy",
    ),
  );
  assert.ok(JSON.parse(await readFile(await receiptPath(), "utf8")).revision);
}

/** Import a deliberately incomplete profile for registration guards, never for economics acceptance. */
async function createRegistrationFixture() {
  const sourcePath = path.join(evidence, "qa-non-authoritative-source.json");
  const profilePath = path.join(
    evidence,
    "qa-incomplete-registration-profile.json",
  );
  await writeFile(
    sourcePath,
    JSON.stringify({
      qa: "Synthetic invalid source: not an authority or parity fixture.",
    }),
  );
  const fixture = {
    schema_version: "backtestengine.economic-symbol/v2",
    symbol: "QA_SOURCE_ONLY",
    specification_source_path: path.basename(sourcePath),
    specification_source_sha256: await sha256File(sourcePath),
    swap_time_authority_status: "Unknown",
    commission_model: "UsdPerMillionUsdVolume",
    commission_rate: 0,
    commission_rate_currency: "USD",
    commission_side_semantics: "PerFill",
    minimum_commission: 0,
    minimum_commission_currency: "USD",
    commission_rounding_mode: "CurrencyCent",
    note: "Intentionally missing economic fields. Registration and rejection checks only.",
  };
  const original = JSON.stringify(fixture, null, 2);
  await writeFile(profilePath, original);
  registrationFixture = await invoke("execution_import_symbol_spec", {
    path: profilePath,
  });
  await ownedPath(registrationFixture.storedPath);
  assert.equal(
    await readFile(profilePath, "utf8"),
    original,
    "Import must preserve original bytes",
  );
  const derived = JSON.parse(
    await readFile(registrationFixture.storedPath, "utf8"),
  );
  assert.equal(
    normalizeWindowsPath(derived.specification_source_path),
    normalizeWindowsPath(await realpath(sourcePath)),
  );
  assert.equal(
    registrationFixture.sha256,
    await sha256File(registrationFixture.storedPath),
  );
  return { sourcePath, profilePath, fixture };
}

/** Prove renderer artifact selection is ignored by observing the same exact downstream profile gate. */
async function checkHostArtifactSelection() {
  const missingProfile = path.join(
    evidence,
    "deliberately-missing-profile.json",
  );
  const gate = /The symbol specification could not be resolved/i;
  await rejects(
    "execution_run",
    { request: request({ symbolSpecPath: missingProfile }) },
    gate,
  );
  await rejects(
    "execution_run",
    {
      request: request({
        buildArtifactPath: application,
        symbolSpecPath: missingProfile,
      }),
    },
    gate,
  );
  await rejects(
    "execution_run",
    {
      request: request({
        buildArtifactPath: path.join(evidence, "nonexistent.dll"),
        symbolSpecPath: missingProfile,
      }),
    },
    gate,
  );
}

/** Exercise source freshness and selected-project binding, restoring the source and selected project. */
async function checkSourceAndProject() {
  const edited = await invoke("workspace_save_document", {
    path: source.path,
    content: `${source.content}\n// QA freshness mutation\n`,
    revision: source.revision,
  });
  try {
    await rejects(
      "execution_run",
      { request: request() },
      /project source changed since the approved build/i,
    );
  } finally {
    source = await invoke("workspace_save_document", {
      path: source.path,
      content: source.content,
      revision: edited.revision,
    });
  }
  const originalProject = project;
  try {
    const other = await invoke("workspace_create_project");
    await ownedPath(other.root);
    await rejects(
      "execution_run",
      { request: request() },
      /selected project does not match the approved build/i,
    );
  } finally {
    await invoke("workspace_open_project", { root: originalProject.root });
  }
}

/** Exercise UI-issued project identity through real IPC before any genuine economics input exists. */
async function checkPublicProjectIdentity() {
  assert.equal(
    await invoke("reports_selected", { projectRoot: project.root }),
    null,
  );
  assert.equal(await invoke("validation_last_good_result"), null);
  assert.equal(await invoke("optimization_last_good_result"), null);
  const foreignDirectory = path.join(
    path.dirname(project.root),
    path.basename(project.root) + "-foreign",
  );
  await mkdir(foreignDirectory);
  await ownedPath(foreignDirectory);
  let foreign;
  try {
    foreign = await invoke("workspace_open_project", {
      root: foreignDirectory,
    });
    assert.equal(
      await invoke("reports_selected", { projectRoot: foreign.root }),
      null,
    );
    assert.equal(await invoke("validation_last_good_result"), null);
    assert.equal(await invoke("optimization_last_good_result"), null);
  } finally {
    const restored = await invoke("workspace_open_project", {
      root: project.root,
    });
    assert.equal(restored.root, project.root);
  }
  await rejects(
    "reports_selected",
    { projectRoot: foreign.root },
    /selected project changed/i,
  );
  assert.equal(
    await invoke("reports_selected", { projectRoot: project.root }),
    null,
  );
}

/** Newly exposed native history stays empty without a real completion and rejects another project. */
async function checkSavedHistoryBoundary() {
  const request = { projectRoot: project.root, cursor: null, limit: 25 };
  const page = await invoke("saved_runs_list", { request });
  assert.deepEqual(page.rows, []);
  assert.equal(page.nextCursor, null);
  assert.equal(
    await invoke("saved_runs_restore_selected", {
      request: { projectRoot: project.root },
    }),
    null,
  );
  await rejects(
    "saved_runs_list",
    { request: { ...request, projectRoot: project.root + "-foreign" } },
    /selected project changed|selected project|different project/i,
  );
}

/** Native full-validation activation requires a genuine approved baseline rather than creating synthetic results. */
async function checkFullValidationBoundary() {
  assert.equal(await invoke("full_validation_last_good_result"), null);
  await rejects(
    "full_validation_run",
    {
      request: {
        executionRunId: "11111111-1111-4111-8111-111111111111",
        replayReceiptSha256: "a".repeat(64),
        spreadMultipliers: [1],
        commissionMultipliers: [1],
        latencyTicks: [1],
        walkForward: {
          trainDays: 90,
          validationDays: 30,
          testDays: 30,
          embargoDays: 1,
        },
        monteCarloRuns: 1000,
        seed: 42,
        gates: null,
      },
    },
    /No successful baseline/i,
  );
}

/** Verify late malformed CSV rows and exact imported bytes through native import. */
async function checkMarketImport() {
  const csv = generateTickCsv(420);
  const ticksPath = path.join(evidence, "qa-ticks.csv");
  await writeFile(ticksPath, csv);
  importedDataset = await invoke("execution_import_market_data", {
    path: ticksPath,
    kind: "ticks",
  });
  assert.equal(importedDataset.kind, "ticks");
  assert.equal(importedDataset.rowCount, 420);
  assert.equal(importedDataset.sha256, await sha256File(ticksPath));
  assert.equal(
    await readFile(await ownedPath(importedDataset.storedPath), "utf8"),
    csv,
  );
  assert.equal(
    normalizeWindowsPath(importedDataset.originalPath),
    normalizeWindowsPath(await realpath(ticksPath)),
  );
  const malformed = path.join(evidence, "late-malformed.csv");
  await writeFile(malformed, `${csv}2026-01-01T07:01:00Z,not-a-number,1.1\n`);
  await rejects(
    "execution_import_market_data",
    { path: malformed, kind: "ticks" },
    /invalid bid|columns|non-finite/i,
  );
}

/** Reject missing/changed active authorities and preserve the imported profile's original files. */
async function checkProfileImportSafety(fixture) {
  const missing = path.join(evidence, "missing-dependency-profile.json");
  const before = await invoke("execution_list_symbol_specs");
  await writeFile(
    missing,
    JSON.stringify({
      ...fixture.fixture,
      specification_source_path: "missing-source.json",
    }),
  );
  await rejects(
    "execution_import_symbol_spec",
    { path: missing },
    /authority dependency.*could not be resolved|authority dependency.*missing/i,
  );
  assert.deepEqual(
    await invoke("execution_list_symbol_specs"),
    before,
    "Failed import must not publish partial catalog entries",
  );
  await writeFile(
    missing,
    JSON.stringify({
      ...fixture.fixture,
      swap_time_authority_status: "AUTHENTICATED",
      swap_time_authority_path: "missing-swap.json",
    }),
  );
  await rejects(
    "execution_import_symbol_spec",
    { path: missing },
    /authority dependency.*could not be resolved|authority dependency.*missing/i,
  );
  await writeFile(
    missing,
    JSON.stringify({
      ...fixture.fixture,
      usd_notional_conversion_rule: "fixed_base_to_usd",
      commission_conversion_authority_path: "missing-commission.json",
    }),
  );
  await rejects(
    "execution_import_symbol_spec",
    { path: missing },
    /authority dependency.*could not be resolved|authority dependency.*missing/i,
  );
}

/** Require the actual retained engine to reject missing economics, proving the DLL was invoked. */
async function checkIncompleteEngineFailure() {
  const result = await invoke("execution_run", { request: request() }, 180_000);
  await writeFile(
    path.join(evidence, "incomplete-engine-rejection.json"),
    JSON.stringify(result, null, 2),
  );
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.match(
    result.output,
    /Missing or invalid required string 'specification_source'|Effective symbol specification/i,
    "Must reach retained C# economics validation, not merely fail to invoke dotnet",
  );
  assert.equal(
    normalizeWindowsPath(result.buildArtifactPath),
    normalizeWindowsPath(await realpath(build.artifactPath)),
  );
}

/** Drive overlap and cancellation during native preparation, then prove that the latch releases. */
async function checkCancelOverlap() {
  let settled = false;
  const first = invoke("execution_run", { request: request() }, 180_000)
    .then(
      (result) => ({ result }),
      (error) => ({ error: String(error) }),
    )
    .finally(() => {
      settled = true;
    });
  const overlap = await invoke("execution_run", { request: request() }).then(
    (result) => ({ result }),
    (error) => ({ error: String(error) }),
  );
  if (!overlap.error?.includes("already running")) {
    await first;
    throw new Error(
      `Concurrent request did not reach running latch: ${JSON.stringify(overlap)}`,
    );
  }
  await invoke("execution_cancel");
  const outcome = await first;
  assert.ok(settled);
  assert.equal(
    outcome.error,
    undefined,
    `Cancellation must return structured status: ${outcome.error}`,
  );
  assert.equal(outcome.result?.success, false);
  assert.equal(
    outcome.result?.status,
    "cancelled",
    "Cancellation must terminate owned work, not just reject overlap",
  );
  await writeFile(
    path.join(evidence, "cancelled-run.json"),
    JSON.stringify(outcome.result, null, 2),
  );
  await checkIncompleteEngineFailure();
}

/** Translate one camelCase report field to the retained writer's snake_case key. */
function snakeCase(value) {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Compare every exposed mapped field against actual ReportWriter values, including derived rates. */
function compareSection(actual, expected, section) {
  assert.ok(actual && expected, `Required report section missing: ${section}`);
  for (const [key, value] of Object.entries(actual)) {
    if (key === "winRate" || key === "lossRate") continue;
    const rawKey =
      key === "ticksPerSecond"
        ? "ticks_or_synthetic_ticks_per_second"
        : snakeCase(key);
    const raw = expected[rawKey];
    const normalized = key === "id" ? String(raw) : raw;
    assert.deepEqual(
      value,
      normalized,
      `${section}.${key} differs from ReportWriter`,
    );
  }
}

/** Validate complete real run output, report equality and exported-file hashes. */
async function verifyRealReport(result, label) {
  assert.equal(
    result.success,
    true,
    `${result.output}\n${result.errors?.join("\n")}`,
  );
  assert.equal(result.status, "completed");
  const reportPath = await ownedPath(result.reportJsonPath);
  const raw = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(result.strategy, raw.strategy);
  assert.equal(result.symbol, raw.symbol);
  assert.equal(result.timeframe, raw.timeframe);
  compareSection(result.account, raw.account, "account");
  compareSection(result.replay, raw.replay, "replay");
  compareSection(
    result.tradeStatistics,
    raw.trade_statistics,
    "tradeStatistics",
  );
  compareSection(result.fullReplayDrawdown, raw.drawdown, "fullReplayDrawdown");
  if (raw.native_report_drawdown)
    compareSection(
      result.nativeReportDrawdown,
      raw.native_report_drawdown,
      "nativeReportDrawdown",
    );
  const stats = raw.trade_statistics;
  const denominator = stats.total_trades || 1;
  assert.equal(
    result.tradeStatistics.winRate,
    (stats.winning_trades / denominator) * 100,
  );
  assert.equal(
    result.tradeStatistics.lossRate,
    (stats.losing_trades / denominator) * 100,
  );
  assert.equal(result.trades.length, raw.trades.length);
  assert.equal(result.openPositions.length, raw.open_positions.length);
  result.trades.forEach((trade, index) =>
    compareSection(trade, raw.trades[index], `trades[${index}]`),
  );
  result.openPositions.forEach((position, index) =>
    compareSection(
      position,
      raw.open_positions[index],
      `openPositions[${index}]`,
    ),
  );
  assert.ok(result.equity.length > 0, "Real report needs equity samples");
  const equityCsv = await readFile(
    await ownedPath(result.equityCsvPath),
    "utf8",
  );
  const equityRows = equityCsv.trim().split(/\r?\n/);
  assert.equal(equityRows.shift(), "time_utc,balance,equity");
  const equity = equityRows.map((line) => {
    const [timeUtc, balance, equity] = line.split(",");
    return { timeUtc, balance: Number(balance), equity: Number(equity) };
  });
  assert.deepEqual(
    result.equity,
    equity,
    "Mapped equity differs from original CSV",
  );
  for (const artifact of [
    reportPath,
    result.tradesCsvPath,
    result.openPositionsCsvPath,
    result.equityCsvPath,
  ]) {
    const owned = await ownedPath(artifact);
    assert.ok((await stat(owned)).size > 0);
    reportArtifacts.push({
      label,
      path: owned,
      sha256: await sha256File(owned),
    });
  }
  await writeFile(
    path.join(evidence, `${label}.json`),
    JSON.stringify(result, null, 2),
  );
}

/** Keep genuine replay/report acceptance blocked when the owner has supplied no validated economics. */
async function checkRealReplay() {
  const names = [
    "actual retained-engine replay and complete ReportWriter equality",
    "zero-trade legitimate report",
  ];
  if (!symbolSpecPath) {
    for (const name of names)
      blocked.push({
        name,
        reason:
          "MISSING INPUT: BACKTEST_SYMBOL_SPEC must name a real validated economic-symbol/v2 profile with active source/cost authorities. Synthetic guard fixtures establish no trading parity.",
      });
    return;
  }
  const imported = await invoke("execution_import_symbol_spec", {
    path: symbolSpecPath,
  });
  await check(names[0], async () => {
    const result = await invoke(
      "execution_run",
      {
        request: request({
          symbolSpecPath: imported.storedPath,
          writeEquityCsv: true,
        }),
      },
      180_000,
    );
    await verifyRealReport(result, "real-run");
  });
  await check(names[1], async () => {
    const zeroPath = path.join(evidence, "zero-ticks.csv");
    await writeFile(zeroPath, generateTickCsv(1));
    const dataset = await invoke("execution_import_market_data", {
      path: zeroPath,
      kind: "ticks",
    });
    const result = await invoke(
      "execution_run",
      {
        request: request({
          datasetId: dataset.id,
          symbolSpecPath: imported.storedPath,
          writeEquityCsv: true,
        }),
      },
      180_000,
    );
    await verifyRealReport(result, "zero-run");
    assert.equal(result.tradeStatistics.totalTrades, 0);
  });
}

/** Exercise independent guards using only real app-created build receipts and isolated files. */
async function runGuardChecks(fixture) {
  await check(
    "host ignores renderer artifact path and uses approved saved-source build",
    checkHostArtifactSelection,
  );
  const receipt = await receiptPath();
  await check("real approved build without snapshot receipt is rejected", () =>
    withFileMutation(receipt, null, () =>
      rejects(
        "execution_run",
        { request: request() },
        /build artifact has no approval receipt/i,
      ),
    ),
  );
  await check("real approved build with damaged receipt is rejected", () =>
    withFileMutation(receipt, "{ invalid json", () =>
      rejects(
        "execution_run",
        { request: request() },
        /build receipt is damaged/i,
      ),
    ),
  );
  await check("changed approved DLL is rejected by hash", async () => {
    const original = await readFile(build.artifactPath);
    await withFileMutation(
      build.artifactPath,
      Buffer.concat([original, Buffer.from("QA artifact mutation")]),
      () =>
        rejects(
          "execution_run",
          { request: request() },
          /approved build artifact changed on disk/i,
        ),
    );
  });
  for (const name of [
    "BacktestEngine.CAlgoShim.dll",
    "WorkspaceCompile.deps.json",
    "WorkspaceCompile.runtimeconfig.json",
  ]) {
    await check(
      `changed approved runtime companion ${name} is rejected`,
      async () => {
        const file = path.join(path.dirname(build.artifactPath), name);
        const original = await readFile(await ownedPath(file));
        await withFileMutation(
          file,
          Buffer.concat([original, Buffer.from("QA companion mutation")]),
          () =>
            rejects(
              "execution_run",
              { request: request() },
              /approved build runtime companions changed on disk/i,
            ),
        );
      },
    );
  }
  await check("missing approved numerical shim is rejected before launch", () =>
    withFileMutation(
      path.join(
        path.dirname(build.artifactPath),
        "BacktestEngine.CAlgoShim.dll",
      ),
      null,
      () =>
        rejects(
          "execution_run",
          { request: request() },
          /approved runtime companion.*could not be resolved/i,
        ),
    ),
  );
  await check(
    "stale saved source and switched project cannot use approval",
    checkSourceAndProject,
  );
  await check(
    "profile import preserves originals and rejects missing active authorities",
    () => checkProfileImportSafety(fixture),
  );
  await check("changed imported profile is rejected by registered hash", () =>
    withFileMutation(
      registrationFixture.storedPath,
      JSON.stringify({ ...fixture.fixture, symbol: "TAMPERED" }),
      () =>
        rejects(
          "execution_run",
          { request: request() },
          /derived profile hash does not match/i,
        ),
    ),
  );
  await check("changed original source dependency is rejected", () =>
    withFileMutation(fixture.sourcePath, "{}", () =>
      rejects(
        "execution_run",
        { request: request() },
        /registered dependency hash changed/i,
      ),
    ),
  );
  await check("missing original source dependency is rejected", () =>
    withFileMutation(fixture.sourcePath, null, () =>
      rejects(
        "execution_run",
        { request: request() },
        /registered dependency is missing|active dependency is missing/i,
      ),
    ),
  );
  const manifest = path.join(
    path.dirname(registrationFixture.storedPath),
    "dependencies.json",
  );
  await check("damaged dependency manifest is rejected", () =>
    withFileMutation(manifest, "{ invalid json", () =>
      rejects(
        "execution_run",
        { request: request() },
        /dependency manifest is damaged/i,
      ),
    ),
  );
  await check("removed active manifest dependency is rejected", async () => {
    const original = JSON.parse(await readFile(manifest, "utf8"));
    await withFileMutation(
      manifest,
      JSON.stringify({ ...original, dependencies: [] }),
      () =>
        rejects(
          "execution_run",
          { request: request() },
          /registered dependency references do not match|active dependency.*not registered/i,
        ),
    );
  });
  const sidecar = path.join(
    dataDirectory,
    "workspace",
    "market_data",
    `${importedDataset.id}.json`,
  );
  await check("damaged dataset provenance is rejected", () =>
    withFileMutation(sidecar, "{ invalid json", () =>
      rejects(
        "execution_run",
        { request: request() },
        /dataset provenance is damaged/i,
      ),
    ),
  );
  await check(
    "changed imported CSV bytes are rejected against provenance",
    async () => {
      const csv = await readFile(importedDataset.storedPath, "utf8");
      await withFileMutation(
        importedDataset.storedPath,
        `${csv}2026-01-02T00:00:00Z,101,101.1\n`,
        () =>
          rejects(
            "execution_run",
            { request: request() },
            /dataset.*(?:hash|integrity|size)|provenance.*(?:hash|size)|content.*(?:changed|match)|stored.*(?:hash|changed)|SHA-256/i,
          ),
      );
    },
  );
  await check(
    "incomplete economics reaches retained engine and fails closed",
    checkIncompleteEngineFailure,
  );
  await check(
    "native overlap rejects and cancellation returns honest status then releases latch",
    checkCancelOverlap,
  );
}

/** Emit machine-readable independent outcomes, exact executable identity, and report hashes. */
async function writeReport() {
  await writeFile(path.join(evidence, "application.log"), applicationOutput);
  const report = {
    application,
    executableSha256: executableIdentity?.sha256 ?? null,
    executableMtime: executableIdentity?.mtime ?? null,
    minimizeRequested: process.env.BACKTEST_QA_MINIMIZE === "1",
    windowMinimized,
    scriptSha256: await sha256File(fileURLToPath(import.meta.url)),
    evidence,
    checks,
    skipped,
    failures,
    blocked,
    reportArtifacts,
    passed: checks.length,
    failed: failures.length,
    symbolSpecPath: symbolSpecPath || null,
    parityAccepted: false,
  };
  const reportPath = path.join(evidence, "report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await writeFile(
    path.join(evidence, "report.sha256"),
    `${await sha256File(reportPath)}  report.json\n`,
  );
  console.log(
    `Execution native QA: ${checks.length} passed; ${failures.length} failed; ${skipped.length} skipped; ${blocked.length} blocked. Evidence: ${evidence}`,
  );
}

/** Run static helper assertions without spawning an app, opening a window, or writing fixtures. */
function selfCheck() {
  const parent = path.resolve("qa-root");
  assertInside(parent, path.join(parent, "fixture.json"));
  for (const target of [
    parent,
    path.dirname(parent),
    path.join(parent, "..", "escaped"),
  ])
    assert.throws(() => assertInside(parent, target));
  assert.equal(normalizeWindowsPath("\\\\?\\C:\\qa\\file"), "C:\\qa\\file");
  assert.equal(
    normalizeWindowsPath("\\\\?\\UNC\\server\\share"),
    "\\\\server\\share",
  );
  compareSection(
    { balance: 100, currencyDigits: 2 },
    { balance: 100, currency_digits: 2 },
    "account",
  );
  assert.throws(() =>
    compareSection({ balance: 0 }, { balance: 100 }, "account"),
  );
  assert.throws(() => compareSection({ balance: 0 }, {}, "account"));
  assert.equal(generateTickCsv(420).trim().split("\n").length, 421);
  console.log(
    "PASS static harness boundary and report-comparison assertions (desktop not launched)",
  );
}

/** Execute the isolated suite; missing required inputs remain separately blocked, never green. */
async function main() {
  await mkdir(dataDirectory, { recursive: true });
  try {
    await writeFile(
      path.join(dataDirectory, "onboarding.json"),
      JSON.stringify(preferences),
    );
    await launch();
    const startup = await check(
      "isolated native startup and session",
      async () => {
        assert.deepEqual(await invoke("workspace_load_session"), {
          lastProject: null,
          activeFile: null,
          openFiles: [],
          presets: [],
        });
      },
    );
    assert.ok(startup, "Startup prerequisite failed");
    const built = await check(
      "app-created example and real saved-source build",
      async () => {
        await createProject();
        await successfulBuild();
      },
    );
    assert.ok(built, "Real approved build prerequisite failed");
    await check(
      "host-issued public project identities work across Reports, Validate and Optimize",
      checkPublicProjectIdentity,
    );
    await check(
      "native saved history never invents a run and rejects foreign projects",
      checkSavedHistoryBoundary,
    );
    await check(
      "native engine scenarios require a genuine approved baseline",
      checkFullValidationBoundary,
    );
    const imported = await check(
      "CSV import verifies exact original bytes, hash, count and late-row rejection",
      checkMarketImport,
    );
    assert.ok(imported, "Dataset prerequisite failed");
    const fixture = await createRegistrationFixture();
    await runGuardChecks(fixture);
    await checkRealReplay();
  } catch (error) {
    failures.push({
      name: "suite prerequisite",
      message: String(error),
      stack: error?.stack,
    });
    skipped.push({
      name: "remaining dependent native checks",
      reason: `Prerequisite failure: ${error}`,
    });
  } finally {
    await closeApp().catch((error) =>
      failures.push({ name: "owned process cleanup", message: String(error) }),
    );
    await writeReport();
    process.exitCode = resultExitCode();
  }
}

/** Distinguish actual failures from missing acceptance inputs in automation exit status. */
function resultExitCode() {
  if (failures.length) return 1;
  if (blocked.length) return 2;
  return 0;
}

if (process.argv.includes("--self-check")) selfCheck();
else await main();
