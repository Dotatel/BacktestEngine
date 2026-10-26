import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { App } from "./App";
import { defaultPreferences, type Preferences } from "./lib/preferences";
import type { DesktopBridge } from "./lib/desktop";
import type { BuildWorkspaceProps } from "./lib/workspace-contract";

// App tests exercise routing, preferences and close protection; the real workspace is covered in browser/native checks.
vi.mock("@/features/workspace/BuildWorkspace", () => ({
  BuildWorkspace: (props: BuildWorkspaceProps) => (
    <section aria-label="Build workspace">
      <h1>Build workspace</h1>
      <button onClick={props.onReviewSetup}>Review setup</button>
      <button onClick={() => props.onDirtyChange?.(true)}>
        Edit test document
      </button>
      <button onClick={() => props.onDirtyChange?.(false)}>
        Save test document
      </button>
    </section>
  ),
}));

/** Create an isolated bridge double to test UI recovery, timing and persistence without claiming native coverage. */
function createBridge(
  saved: Preferences = { ...defaultPreferences },
): DesktopBridge {
  return {
    native: true,
    loadPreferences: vi.fn().mockResolvedValue(saved),
    savePreferences: vi.fn().mockResolvedValue(undefined),
    resetPreferences: vi.fn().mockResolvedValue({ ...defaultPreferences }),
    connectAgent: vi
      .fn()
      .mockRejectedValue(
        new Error("OpenCode is not responding. Retry or skip for now."),
      ),
    cancelConnection: vi.fn().mockResolvedValue(undefined),
    presentWindow: vi.fn().mockResolvedValue(undefined),
    minimize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    startDragging: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    observeMaximized: vi.fn().mockResolvedValue(() => {}),
  };
}

/** Wait until a named action becomes enabled before using it, matching the save-before-advance contract. */
async function clickAction(
  name: string,
  user: ReturnType<typeof userEvent.setup>,
) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

test("complete setup saves real choices, retains them on Back, skips agents and finishes without creating a project", async () => {
  const bridge = createBridge();
  const user = userEvent.setup();
  render(<App bridge={bridge} />);
  await clickAction("Get Started", user);
  await user.click(await screen.findByRole("radio", { name: "Advanced" }));
  await clickAction("Continue", user);
  await user.click(await screen.findByRole("radio", { name: "Dark" }));
  await clickAction("Back", user);
  expect(await screen.findByRole("radio", { name: "Advanced" })).toBeChecked();
  await clickAction("Continue", user);
  expect(await screen.findByRole("radio", { name: "Dark" })).toBeChecked();
  await clickAction("Continue", user);
  expect(
    await screen.findByRole("button", { name: "Connect agent" }),
  ).toBeDisabled();
  await clickAction("Skip for now", user);
  expect(
    await screen.findByRole("heading", { name: "You’re all set" }),
  ).toHaveFocus();
  expect(screen.getByText("Advanced")).toBeVisible();
  expect(screen.getByText("Dark")).toBeVisible();
  expect(screen.getByText("Skipped for now")).toBeVisible();
  await clickAction("Open BacktestEngine", user);
  expect(
    await screen.findByRole("region", { name: "Build workspace" }),
  ).toBeVisible();
  expect(bridge.savePreferences).toHaveBeenLastCalledWith(
    expect.objectContaining({
      completed: true,
      step: 5,
      workspaceStyle: "advanced",
      appearance: "dark",
      agent: null,
      agentVerified: false,
    }),
  );
  expect(bridge.connectAgent).not.toHaveBeenCalled();
});

test("closing and reopening resumes setup while returning users enter Build", async () => {
  const bridge = createBridge({
    ...defaultPreferences,
    step: 3,
    workspaceStyle: "advanced",
    appearance: "light",
  });
  const view = render(<App bridge={bridge} />);
  expect(await screen.findByRole("radio", { name: "Light" })).toBeChecked();
  expect(document.documentElement).not.toHaveClass("dark");
  expect(bridge.presentWindow).toHaveBeenCalledWith(true);
  view.unmount();
  render(
    <App
      bridge={createBridge({ ...defaultPreferences, step: 5, completed: true })}
    />,
  );
  expect(
    await screen.findByRole("region", { name: "Build workspace" }),
  ).toBeVisible();
});

test("a failed save keeps the current step and allows retrying without erasing the selection", async () => {
  const bridge = createBridge({ ...defaultPreferences, step: 2 });
  vi.mocked(bridge.savePreferences).mockRejectedValueOnce(
    new Error("Disk is full. Free space and retry."),
  );
  const user = userEvent.setup();
  render(<App bridge={bridge} />);
  await clickAction("Continue", user);
  expect(await screen.findByRole("alert")).toHaveTextContent("Disk is full");
  expect(
    screen.getByRole("heading", { name: /How would you like/ }),
  ).toBeVisible();
  await clickAction("Retry saving", user);
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  await clickAction("Continue", user);
  expect(
    await screen.findByRole("heading", { name: "Choose your appearance" }),
  ).toBeVisible();
});

test("damaged settings are never silently reset and reset requires a clear confirmation", async () => {
  const bridge = createBridge();
  vi.mocked(bridge.loadPreferences).mockRejectedValue(
    new Error("Saved setup is damaged."),
  );
  const user = userEvent.setup();
  render(<App bridge={bridge} />);
  expect(
    await screen.findByRole("heading", { name: "Let’s recover your setup" }),
  ).toBeVisible();
  expect(bridge.savePreferences).not.toHaveBeenCalled();
  await clickAction("Reset setup", user);
  expect(await screen.findByRole("dialog")).toHaveAccessibleName(
    "Reset your setup?",
  );
  await clickAction("Keep settings", user);
  expect(bridge.resetPreferences).not.toHaveBeenCalled();
  await clickAction("Reset setup", user);
  await clickAction("Back up and reset", user);
  expect(
    await screen.findByRole("heading", { name: "Welcome to BacktestEngine" }),
  ).toBeVisible();
  expect(bridge.resetPreferences).toHaveBeenCalledTimes(1);
});

test("a provider error offers retry or skip and selection never counts as connection", async () => {
  const bridge = createBridge({ ...defaultPreferences, step: 4 });
  const user = userEvent.setup();
  render(<App bridge={bridge} />);
  await user.click(await screen.findByRole("radio", { name: "OpenCode" }));
  await clickAction("Connect agent", user);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "OpenCode is not responding",
  );
  expect(
    screen.queryByRole("button", { name: "Retry saving" }),
  ).not.toBeInTheDocument();
  await clickAction("Skip for now", user);
  expect(await screen.findByText("Skipped for now")).toBeVisible();
});

test("canceling ignores a late provider result and still permits offline completion", async () => {
  const bridge = createBridge({
    ...defaultPreferences,
    step: 4,
    agent: "opencode",
  });
  let resolveConnection!: (value: {
    provider: "opencode";
    version: string;
  }) => void;
  vi.mocked(bridge.connectAgent).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveConnection = resolve;
      }),
  );
  const user = userEvent.setup();
  render(<App bridge={bridge} />);
  await clickAction("Connect agent", user);
  await clickAction("Cancel connection", user);
  await act(async () => {
    resolveConnection({ provider: "opencode", version: "2.1.4" });
  });
  expect(
    screen.getByText("Connection canceled. You can retry or skip for now."),
  ).toBeVisible();
  expect(screen.queryByText(/is connected/)).not.toBeInTheDocument();
  expect(bridge.cancelConnection).toHaveBeenCalledTimes(1);
  await clickAction("Skip for now", user);
  expect(await screen.findByText("Skipped for now")).toBeVisible();
});

test("a verified connection is saved and shown using actual provider evidence", async () => {
  const bridge = createBridge({
    ...defaultPreferences,
    step: 4,
    agent: "opencode",
  });
  vi.mocked(bridge.connectAgent).mockResolvedValue({
    provider: "opencode",
    version: "2.1.4",
  });
  const user = userEvent.setup();
  render(<App bridge={bridge} />);
  await clickAction("Connect agent", user);
  expect(await screen.findByText(/OpenCode 2.1.4 is connected/)).toBeVisible();
  await clickAction("Continue", user);
  expect(await screen.findByText("OpenCode · connected")).toBeVisible();
});

test("custom controls invoke their native actions and failures are visible", async () => {
  const bridge = createBridge();
  vi.mocked(bridge.toggleMaximize).mockRejectedValue(
    new Error("Window could not be resized. Retry."),
  );
  const user = userEvent.setup();
  render(<App bridge={bridge} />);
  await screen.findByRole("heading", { name: "Welcome to BacktestEngine" });
  await user.click(screen.getByRole("button", { name: "Minimize window" }));
  expect(bridge.minimize).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Maximize window" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Window could not be resized",
  );
  await user.click(screen.getByRole("button", { name: "Close window" }));
  expect(bridge.close).toHaveBeenCalledTimes(1);
});

test("radio arrows update the choice and focus follows step headings", async () => {
  const user = userEvent.setup();
  render(<App bridge={createBridge({ ...defaultPreferences, step: 2 })} />);
  const simple = await screen.findByRole("radio", { name: "Simple" });
  await act(async () => {
    simple.focus();
  });
  await user.keyboard("{ArrowRight}");
  await waitFor(() =>
    expect(screen.getByRole("radio", { name: "Advanced" })).toBeChecked(),
  );
  expect(screen.getByRole("radio", { name: "Advanced" })).toHaveFocus();
  await clickAction("Continue", user);
  expect(
    await screen.findByRole("heading", { name: "Choose your appearance" }),
  ).toHaveFocus();
});

test("custom Close waits for an in-flight preference write", async () => {
  const bridge = createBridge({ ...defaultPreferences, step: 2 });
  let finishSave!: () => void;
  vi.mocked(bridge.savePreferences).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishSave = resolve;
      }),
  );
  const user = userEvent.setup();
  render(<App bridge={bridge} />);
  await user.click(await screen.findByRole("radio", { name: "Advanced" }));
  await user.click(screen.getByRole("button", { name: "Close window" }));
  expect(bridge.close).not.toHaveBeenCalled();
  await act(async () => {
    finishSave();
  });
  await waitFor(() => expect(bridge.close).toHaveBeenCalledTimes(1));
});

test("title bar starts a native drag and double-click toggles maximize", async () => {
  const bridge = createBridge();
  render(<App bridge={bridge} />);
  await screen.findByRole("heading", { name: "Welcome to BacktestEngine" });
  const title = screen.getByText("BacktestEngine", { exact: true });
  fireEvent.mouseDown(title, { button: 0, detail: 1 });
  expect(bridge.startDragging).toHaveBeenCalledTimes(1);
  fireEvent.mouseDown(title, { button: 0, detail: 2 });
  expect(bridge.toggleMaximize).toHaveBeenCalledTimes(1);
});

test("the workspace close path protects drafts before permitting a clean exit", async () => {
  const bridge = createBridge({
    ...defaultPreferences,
    step: 5,
    completed: true,
  });
  const user = userEvent.setup();
  render(<App bridge={bridge} />);
  await user.click(
    await screen.findByRole("button", { name: "Edit test document" }),
  );
  await user.click(screen.getByRole("button", { name: "Close window" }));
  expect(bridge.close).not.toHaveBeenCalled();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Save your changes",
  );
  await user.click(screen.getByRole("button", { name: "Save test document" }));
  await user.click(screen.getByRole("button", { name: "Close window" }));
  await waitFor(() => expect(bridge.close).toHaveBeenCalledTimes(1));
});
