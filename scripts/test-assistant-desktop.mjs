import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
const application = path.resolve(
  process.env.BACKTEST_EXE ??
    path.join(root, "src-tauri/target/debug/dotatel-backtest-engine.exe"),
);
const evidence = path.join(root, "artifacts/assistant-native-qa", randomUUID());
const dataDirectory = path.join(evidence, "settings");
const endpoint = "http://127.0.0.1:9253";
const live = process.env.BACKTEST_ASSISTANT_LIVE === "1";
const checks = [];
const failures = [];
const blocked = [];
const ownedPids = [];
const fixture = {
  message: "Native QA local draft: keep <b>literal text</b> unchanged.",
  context: [
    {
      label: "Explicit QA context",
      text: "Synthetic boundary evidence only; no trading result.",
    },
  ],
  model: { providerId: "opencode", id: "glm-5.3-flash-free" },
};
const preferences = {
  version: 1,
  step: 5,
  completed: true,
  workspaceStyle: "advanced",
  appearance: "light",
  agent: null,
  agentVerified: false,
};
let child;
let browser;
let page;
let identity;
let saved;
let liveConversation;

/** Hash exact bytes for executable identity and native-composed preview equality. */
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Poll bounded observed state without replacing a failure with a synthetic result. */
async function until(probe, label, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    const value = await Promise.resolve()
      .then(probe)
      .catch((error) => {
        last = error;
        return null;
      });
    if (value) return value;
    await delay(75);
  }
  throw new Error(`Timed out: ${label}`, { cause: last });
}

/** Invoke the actual isolated app bridge, with a deadline independent of provider completion. */
async function invoke(command, args = {}, timeout = 30_000) {
  let timer;
  const expiration = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out: ${command}`)),
      timeout,
    );
  });
  try {
    return await Promise.race([
      page.evaluate(
        ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
        { command, args },
      ),
      expiration,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Record an attempted native group once; prerequisites may stop dependent work but never turn failures green. */
async function check(name, operation) {
  try {
    const outcome = await operation();
    if (outcome === false) return;
    checks.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, message: String(error) });
    throw error;
  }
}

/** Require the intended boundary error rather than accepting unknown-command or disconnected-webview failures. */
async function rejects(command, args, pattern) {
  await assert.rejects(invoke(command, args), (error) => {
    assert.match(String(error), pattern);
    return true;
  });
}

/** Start only a fresh owned profile and refuse an occupied debugging endpoint. */
async function launch() {
  await assert.rejects(
    fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) }),
    "Occupied debugging endpoint; refusing another app",
  );
  assert.equal(
    digest(await readFile(application)),
    identity.sha256,
    "Candidate changed between launches",
  );
  child = spawn(application, [], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      BACKTEST_DATA_DIR: dataDirectory,
      WEBVIEW2_USER_DATA_FOLDER: path.join(evidence, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9253",
    },
    stdio: "ignore",
  });
  ownedPids.push(child.pid);
  await until(async () => {
    assert.equal(
      child.exitCode,
      null,
      "Owned application exited during startup",
    );
    return (
      await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(1000),
      })
    ).ok;
  }, "owned native debugging endpoint");
  browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
  page = await until(
    () =>
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => !candidate.url().startsWith("devtools:")),
    "owned application webview",
  );
  await page.locator("main").waitFor();
  assert.deepEqual(await invoke("load_preferences"), preferences);
}

/** Terminate only the exact app PID created here; no OpenCode server/session or owner preview is stopped. */
async function closeApp() {
  const ownedProcess = child;
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "pipe",
      timeout: 10_000,
    });
    await until(
      () => child.exitCode !== null || child.signalCode !== null,
      "owned app process exit",
      10_000,
    );
  }
  await browser?.close().catch(() => {});
  browser = undefined;
  page = undefined;
  child = undefined;
  if (!ownedProcess?.pid) return;
  await until(
    () =>
      fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(500),
      }).then(
        () => false,
        () => true,
      ),
    "owned debugging endpoint shutdown",
    10_000,
  );
}

/** Exercise local storage/preview validation without calling assistant status or admitting any model prompt. */
async function localDraftChecks() {
  const initial = await invoke("assistant_load", { conversationId: null });
  assert.equal(initial.busy, false);
  assert.equal(initial.cancellationUnconfirmed, false);
  assert.equal(initial.selected, null);
  assert.deepEqual(initial.conversations, []);
  const created = await invoke("assistant_new_conversation");
  saved = await invoke("assistant_save_draft", {
    request: {
      conversationId: created.id,
      expectedRevision: created.revision,
      draft: fixture,
    },
  });
  assert.deepEqual(saved.draft, fixture);
  assert.equal(saved.preview.sha256, digest(saved.preview.text));
  assert.ok(saved.preview.text.includes(fixture.message));
  assert.ok(saved.preview.text.includes(fixture.context[0].text));
  assert.equal(saved.messages.length, 0);
  await rejects(
    "assistant_save_draft",
    {
      request: {
        conversationId: saved.id,
        expectedRevision: created.revision,
        draft: { ...fixture, message: "Stale replacement" },
      },
    },
    /newer assistant draft|Reload/,
  );
  await rejects(
    "assistant_save_draft",
    {
      request: {
        conversationId: saved.id,
        expectedRevision: saved.revision,
        draft: { ...fixture, message: "x".repeat(8001) },
      },
    },
    /8,000|8000/,
  );
  await rejects(
    "assistant_save_draft",
    {
      request: {
        conversationId: saved.id,
        expectedRevision: saved.revision,
        draft: {
          ...fixture,
          model: { providerId: "paid-route", id: "unapproved" },
        },
      },
    },
    /supported free routes/,
  );
  await rejects(
    "assistant_send",
    {
      request: {
        conversationId: saved.id,
        expectedRevision: saved.revision,
        previewSha256: "0".repeat(64),
      },
    },
    /draft changed after review/,
  );
  assert.deepEqual(
    (await invoke("assistant_load", { conversationId: saved.id })).selected,
    saved,
  );
  const stopped = await invoke("assistant_cancel", {
    conversationId: saved.id,
  });
  assert.equal(stopped.status, "idle");
  assert.equal(stopped.cancellationUnconfirmed, false);
  assert.deepEqual(stopped.conversation, saved);
}

/** The same app binary must recover the exact saved local draft across a real process restart. */
async function restartChecks() {
  await closeApp();
  await launch();
  const restored = await invoke("assistant_load", { conversationId: saved.id });
  assert.deepEqual(restored.selected, saved);
  assert.equal(restored.busy, false);
  assert.equal(restored.cancellationUnconfirmed, false);
}

/** Exercise the mounted native pane and flush a hidden unsaved draft through the real title-bar close. */
async function mountedPaneChecks() {
  const panel = page.getByRole("complementary", { name: "Assistant panel" });
  await page.getByRole("button", { name: "Toggle assistant" }).click();
  await expect(panel.getByLabel("Your question", { exact: true })).toHaveValue(
    fixture.message,
  );
  const message = `${fixture.message}\nNative pane close/flush proof.`;
  await panel.getByLabel("Your question", { exact: true }).fill(message);
  await page.screenshot({
    path: path.join(evidence, "native-assistant-pane.png"),
    fullPage: true,
  });
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).toBeHidden();
  const ownedProcess = child;
  await page.getByRole("button", { name: "Close window", exact: true }).click();
  await until(
    () => ownedProcess.exitCode !== null || ownedProcess.signalCode !== null,
    "real custom close after hidden-draft flush",
  );
  await closeApp();
  await launch();
  const restored = await invoke("assistant_load", { conversationId: saved.id });
  assert.equal(restored.selected.draft.message, message);
  assert.deepEqual(restored.selected.draft.context, fixture.context);
  assert.deepEqual(restored.selected.draft.model, fixture.model);
  assert.equal(restored.selected.messages.length, 0);
  assert.ok(restored.selected.revision > saved.revision);
  saved = restored.selected;
}

/** Bounded local history refuses new allocation at capacity and retains existing records byte-for-byte. */
async function historyCapacityChecks() {
  for (let index = 1; index < 20; index += 1)
    await invoke("assistant_new_conversation");
  await rejects(
    "assistant_new_conversation",
    {},
    /20|conversation.*limit|capacity/i,
  );
  const snapshot = await invoke("assistant_load", { conversationId: saved.id });
  assert.equal(snapshot.conversations.length, 20);
  assert.deepEqual(snapshot.selected, saved);
}

/** Optionally send exactly one explicit synthetic proposal through the production native adapter, with no fallback. */
async function liveProposalCheck() {
  const status = await invoke("assistant_status", {}, 80_000);
  if (!status.connected || !status.toolsDisabledVerified) {
    blocked.push({
      name: "live proposal",
      reason:
        status.problem ??
        "Existing OpenCode proposal-only capability unavailable",
    });
    return false;
  }
  const offer = status.models.find(
    (item) =>
      item.model.providerId === fixture.model.providerId &&
      item.model.id === fixture.model.id &&
      item.zeroCostVerified,
  );
  if (!offer) {
    blocked.push({
      name: "live proposal",
      reason:
        "The exact selected free model is unavailable; no fallback or prompt attempted",
    });
    return false;
  }
  liveConversation = await invoke("assistant_save_draft", {
    request: {
      conversationId: saved.id,
      expectedRevision: saved.revision,
      draft: {
        message:
          "Backend QA: reply with one short plain-text sentence containing BACKTESTENGINE_QA_PROPOSAL. Do not use tools or claim trading validation.",
        context: [],
        model: fixture.model,
      },
    },
  });
  assert.equal(
    liveConversation.preview.sha256,
    digest(liveConversation.preview.text),
  );
  const sentPreview = liveConversation.preview.text;
  const result = await invoke(
    "assistant_send",
    {
      request: {
        conversationId: liveConversation.id,
        expectedRevision: liveConversation.revision,
        previewSha256: liveConversation.preview.sha256,
      },
    },
    240_000,
  );
  await writeFile(
    path.join(evidence, "live-result.json"),
    JSON.stringify(result, null, 2),
  );
  liveConversation = result.conversation;
  assert.equal(
    result.status,
    "completed",
    result.problem ?? "Native proposal did not complete",
  );
  assert.equal(result.cancellationUnconfirmed, false);
  assert.equal(result.conversation.draft.message, "");
  assert.equal(result.conversation.messages.length, 2);
  assert.equal(result.conversation.messages[0].text, sentPreview);
  assert.equal(result.conversation.messages[1].role, "assistant");
  assert.equal(result.conversation.messages[1].status, "completed");
  assert.deepEqual(result.conversation.messages[1].model, fixture.model);
  assert.ok(result.conversation.messages[1].text.trim());
  assert.equal(
    (await invoke("assistant_load", { conversationId: saved.id })).busy,
    false,
  );
}

/** Finish only an app-owned pending provider operation before stopping the test app; unconfirmed recovery remains explicit. */
async function settleOwnedSend() {
  if (!liveConversation || !page || page.isClosed()) return;
  const snapshot = await invoke("assistant_load", {
    conversationId: liveConversation.id,
  });
  if (!snapshot.busy) return;
  const result = await invoke(
    "assistant_cancel",
    { conversationId: liveConversation.id },
    100_000,
  );
  await writeFile(
    path.join(evidence, "owned-cancel-result.json"),
    JSON.stringify(result, null, 2),
  );
  const settled = await until(
    async () => {
      const current = await invoke("assistant_load", {
        conversationId: liveConversation.id,
      });
      return !current.busy || current.cancellationUnconfirmed ? current : null;
    },
    "owned provider cancellation settlement",
    130_000,
  );
  if (settled.cancellationUnconfirmed)
    blocked.push({
      name: "owned provider stop",
      reason:
        "Native cancellation remains unconfirmed; durable pending state was preserved",
    });
}

/** Run real isolated IPC checks, preserving failures and optional provider limits in one immutable evidence directory. */
async function main() {
  await mkdir(dataDirectory, { recursive: true });
  identity = {
    path: application,
    sha256: digest(await readFile(application)),
    bytes: (await stat(application)).size,
  };
  await writeFile(
    path.join(dataDirectory, "onboarding.json"),
    JSON.stringify(preferences),
  );
  try {
    await check(
      "isolated native startup and exact local draft/preview boundaries",
      async () => {
        await launch();
        await localDraftChecks();
      },
    );
    await check(
      "real process restart preserves exact local assistant draft",
      restartChecks,
    );
    await check(
      "native mounted pane and hidden-draft flush through custom close",
      mountedPaneChecks,
    );
    if (live)
      await check(
        "explicit zero-cost proposal through registered native adapter",
        liveProposalCheck,
      );
    else
      blocked.push({
        name: "live proposal",
        reason:
          "Not requested for this invocation; set BACKTEST_ASSISTANT_LIVE=1 for the controlled single-prompt check",
      });
    if (!live)
      await check(
        "native local history capacity preserves prior records",
        historyCapacityChecks,
      );
  } catch (error) {
    if (!failures.length)
      failures.push({ name: "suite prerequisite", message: String(error) });
  } finally {
    await settleOwnedSend().catch((error) =>
      failures.push({ name: "owned provider cleanup", message: String(error) }),
    );
    await closeApp().catch((error) =>
      failures.push({ name: "owned app cleanup", message: String(error) }),
    );
    const unchanged = digest(await readFile(application)) === identity.sha256;
    if (!unchanged)
      failures.push({
        name: "candidate identity",
        message: "Executable changed during QA",
      });
    const report = {
      application: identity,
      executableUnchanged: unchanged,
      evidence,
      ownedPids,
      liveRequested: live,
      checks,
      failures,
      blocked,
      limits: [
        "Native IPC, mounted pane and hidden-draft custom-close evidence; a provider prompt runs only with the explicit live flag.",
        "Only this fresh app profile and its own provider conversation are used; owner preview/settings and other OpenCode sessions remain outside the suite.",
        "No numerical trading or C# parity claim follows from assistant evidence.",
      ],
    };
    const reportPath = path.join(evidence, "report.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`Evidence: ${reportPath}`);
    process.exitCode = failures.length ? 1 : blocked.length ? 2 : 0;
  }
}

await main();
