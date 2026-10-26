import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  "artifacts/native",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const dataDirectory = path.join(evidence, "settings");
const port = 9226;
const checks = [];
let applicationProcess;
let browser;
let page;
await mkdir(dataDirectory, { recursive: true });

/** Poll bounded native state without fixed long sleeps, retaining the last failure for diagnosis. */
async function until(probe, label, timeout = 20_000) {
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

/** Start the real embedded-frontend executable with isolated settings and process-local WebView2 inspection enabled. */
async function launch() {
  applicationProcess = spawn(application, [], {
    cwd: root,
    windowsHide: false,
    env: {
      ...process.env,
      BACKTEST_DATA_DIR: dataDirectory,
      WEBVIEW2_USER_DATA_FOLDER: path.join(evidence, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  applicationProcess.stdout.on("data", (data) => {
    output += data;
  });
  applicationProcess.stderr.on("data", (data) => {
    output += data;
  });
  applicationProcess.on("error", (error) => {
    output += error.message;
  });
  await until(async () => {
    if (applicationProcess.exitCode !== null)
      throw new Error(`Native app exited: ${output}`);
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  }, "the native WebView2 inspection endpoint");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await until(
    async () =>
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => !candidate.url().startsWith("devtools:")),
    "the app webview",
  );
  await page.locator("main").waitFor();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
}

/** Invoke the app's ordinary scoped IPC, never a test-only production command. */
async function invoke(command, args = {}) {
  return page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
}

/** Capture the actual embedded WebView after local fonts and images have loaded. */
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

/** Record an independent named assertion group only after it has completed successfully. */
async function check(name, operation) {
  await operation();
  checks.push({ name, passed: true });
  console.log(`PASS ${name}`);
}

/** Close using the custom button and wait for process exit, proving real lifecycle behavior. */
async function closeWithButton() {
  await page.getByRole("button", { name: "Close window" }).click();
  await until(
    () => applicationProcess.exitCode !== null,
    "the custom close button to exit the app",
  );
  await browser.close().catch(() => {});
}

try {
  await launch();
  await check("compact real welcome window and custom chrome", async () => {
    await expect(
      page.getByRole("heading", { name: "Welcome to BacktestEngine" }),
    ).toBeVisible();
    const size = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    assert.deepEqual(size, { width: 660, height: 470 });
    await expect(
      page.getByRole("button", { name: "Minimize window" }),
    ).toBeEnabled();
    await capture("P01-welcome");
  });
  await check(
    "custom maximize and restore change the actual native window",
    async () => {
      await page.getByRole("button", { name: "Maximize window" }).click();
      await until(
        () => invoke("plugin:window|is_maximized", { label: "main" }),
        "native maximize",
      );
      await page.getByRole("button", { name: "Restore window" }).click();
      await until(
        async () =>
          !(await invoke("plugin:window|is_maximized", { label: "main" })),
        "native restore",
      );
      assert.equal(await page.evaluate(() => innerWidth), 660);
    },
  );
  await check(
    "custom minimize changes native state and the app can be restored",
    async () => {
      await page.getByRole("button", { name: "Minimize window" }).click();
      await until(
        () => invoke("plugin:window|is_minimized", { label: "main" }),
        "native minimize",
      );
      await invoke("present_window", { expanded: false });
      await until(
        async () =>
          !(await invoke("plugin:window|is_minimized", { label: "main" })),
        "native unminimize",
      );
    },
  );
  await check(
    "Rust executes the bundled self-contained C# engine",
    async () => {
      const metadata = await invoke("engine_metadata");
      assert.equal(metadata.strategy, "ExampleStrategy");
      assert.ok(
        metadata.parameters.some((parameter) => parameter.name === "HoldTicks"),
      );
      await writeFile(
        path.join(evidence, "engine-metadata.json"),
        JSON.stringify(metadata, null, 2),
      );
    },
  );
  await check(
    "welcome expands the actual window and supports keyboard selections",
    async () => {
      await page.getByRole("button", { name: "Get Started" }).click();
      await expect(
        page.getByRole("radio", { name: "Simple", exact: true }),
      ).toBeChecked();
      assert.equal(
        await invoke("plugin:window|is_maximized", { label: "main" }),
        true,
      );
      await page.getByRole("radio", { name: "Simple", exact: true }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(
        page.getByRole("radio", { name: "Advanced", exact: true }),
      ).toBeChecked();
      await capture("P02-workspace");
      await page.getByRole("button", { name: "Restore window" }).click();
      await until(
        async () =>
          !(await invoke("plugin:window|is_maximized", { label: "main" })),
        "restored setup window",
      );
      const restored = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      }));
      assert.ok(restored.width >= 800 && restored.height >= 640);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      assert.equal(
        await invoke("plugin:window|is_maximized", { label: "main" }),
        false,
      );
      await page.getByRole("button", { name: "Maximize window" }).click();
      await until(
        () => invoke("plugin:window|is_maximized", { label: "main" }),
        "expanded appearance window",
      );
      await page.getByRole("radio", { name: "Dark", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Continue", exact: true }),
      ).toBeEnabled();
      await capture("P03-appearance");
    },
  );
  await check(
    "custom Close and relaunch preserve unfinished setup on disk",
    async () => {
      await closeWithButton();
      const stored = JSON.parse(
        await readFile(path.join(dataDirectory, "onboarding.json"), "utf8"),
      );
      assert.equal(stored.workspaceStyle, "advanced");
      assert.equal(stored.appearance, "dark");
      assert.equal(stored.step, 3);
      await launch();
      await expect(
        page.getByRole("heading", { name: "Choose your appearance" }),
      ).toBeVisible();
      await expect(
        page.getByRole("radio", { name: "Dark", exact: true }),
      ).toBeChecked();
    },
  );
  await check(
    "optional agent failure is actionable and never blocks setup",
    async () => {
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("radio", { name: "Codex", exact: true }).click();
      await page.getByRole("button", { name: "Connect agent" }).click();
      await expect(page.getByRole("alert")).toContainText("not available yet");
      await expect(
        page.getByRole("button", { name: "Skip for now" }),
      ).toBeEnabled();
      await page.getByRole("radio", { name: "OpenCode", exact: true }).click();
      await capture("P04-agent");
      if (process.env.BACKTEST_TEST_OPENCODE === "1") {
        await page.getByRole("button", { name: "Connect agent" }).click();
        await expect(
          page.getByRole("button", { name: "Continue", exact: true }),
        ).toBeEnabled({ timeout: 15_000 });
        await expect(page.getByText(/OpenCode .* is connected/)).toBeVisible();
        await capture("P04-connected");
      }
      await page.getByRole("button", { name: "Skip for now" }).click();
      await expect(
        page.getByRole("heading", { name: "You’re all set" }),
      ).toBeVisible();
      await expect(page.getByText("Skipped for now")).toBeVisible();
      await capture("P05-finish");
    },
  );
  await check(
    "native final screen has no automated accessibility violations",
    async () => {
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      assert.deepEqual(result.violations, []);
    },
  );
  await check(
    "Finish is durable and returning users do not repeat setup",
    async () => {
      await page.getByRole("button", { name: "Open BacktestEngine" }).click();
      await expect(
        page.getByRole("region", { name: "Build workspace" }),
      ).toBeVisible();
      await closeWithButton();
      assert.equal(
        JSON.parse(
          await readFile(path.join(dataDirectory, "onboarding.json"), "utf8"),
        ).completed,
        true,
      );
      await launch();
      await expect(
        page.getByRole("region", { name: "Build workspace" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Workspace settings", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Review setup", exact: true })
        .click();
      await expect(
        page.getByRole("radio", { name: "Advanced", exact: true }),
      ).toBeChecked();
      await closeWithButton();
    },
  );
  await check(
    "damaged disk preferences require explicit backup and reset",
    async () => {
      await writeFile(
        path.join(dataDirectory, "onboarding.json"),
        "corrupt-native-test",
      );
      await launch();
      await expect(
        page.getByRole("heading", { name: "Let’s recover your setup" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Reset setup", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await capture("recovery-confirmation");
      await page.getByRole("button", { name: "Back up and reset" }).click();
      await expect(
        page.getByRole("heading", { name: "Welcome to BacktestEngine" }),
      ).toBeVisible();
      assert.equal(
        JSON.parse(
          await readFile(path.join(dataDirectory, "onboarding.json"), "utf8"),
        ).step,
        1,
      );
      await closeWithButton();
    },
  );
  await writeFile(
    path.join(evidence, "report.json"),
    JSON.stringify(
      {
        application,
        checks,
        passed: checks.length,
        failed: 0,
        openCodeServiceVerified: process.env.BACKTEST_TEST_OPENCODE === "1",
        evidence,
      },
      null,
      2,
    ),
  );
  console.log(`${checks.length} native checks passed. Evidence: ${evidence}`);
} catch (error) {
  console.error(error);
  if (page && !page.isClosed()) await capture("failure").catch(() => {});
  await writeFile(
    path.join(evidence, "report.json"),
    JSON.stringify(
      { application, checks, failed: 1, error: error.message },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  if (applicationProcess && applicationProcess.exitCode === null)
    applicationProcess.kill();
  await browser?.close().catch(() => {});
}
