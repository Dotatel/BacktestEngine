import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TitleBar } from "./TitleBar";
import type { DesktopBridge } from "@/lib/desktop";
import type { AppMenuController } from "@/lib/app-menu-contract";

/** Inject actual action boundaries without touching native windows, files, clipboard or editor content. */
function fixture() {
  const bridge = {
    native: true,
    minimize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    startDragging: vi.fn().mockResolvedValue(undefined),
    observeMaximized: vi.fn().mockResolvedValue(() => {}),
  } as unknown as DesktopBridge;
  const save = vi.fn();
  const menu: AppMenuController = {
    actions: { save: { enabled: true, run: save, shortcut: "Ctrl+S" } },
    view: { explorer: true, parameters: false, assistant: false },
  };
  return { bridge, save, menu, onError: vi.fn() };
}

describe("application caption menus", () => {
  it("preserves approved onboarding branding when no workspace controller is registered", () => {
    const { bridge, onError } = fixture();
    render(<TitleBar bridge={bridge} onError={onError} />);
    expect(screen.queryByRole("menubar")).not.toBeInTheDocument();
    expect(screen.getAllByAltText("DotaTel")).toHaveLength(2);
  });

  it("runs only enabled injected commands and menu hits never start a window drag", async () => {
    const user = userEvent.setup();
    const { bridge, menu, save, onError } = fixture();
    render(<TitleBar bridge={bridge} menu={menu} onError={onError} />);
    await user.click(screen.getByRole("menuitem", { name: "File" }));
    expect(screen.getByRole("menuitem", { name: "New file…" })).toHaveAttribute(
      "data-disabled",
    );
    await user.click(screen.getByRole("menuitem", { name: "Save Ctrl+S" }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(bridge.startDragging).not.toHaveBeenCalled();
  });

  it("supports Alt access keys, arrow navigation, Escape and F10 without workspace shortcuts", async () => {
    const user = userEvent.setup();
    const { bridge, menu, onError } = fixture();
    render(<TitleBar bridge={bridge} menu={menu} onError={onError} />);
    await user.keyboard("{Alt>}f{/Alt}");
    expect(
      await screen.findByRole("menuitem", { name: "Save Ctrl+S" }),
    ).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("menuitem", { name: "Undo" })).toBeVisible();
    await user.keyboard("{Escape}{F10}");
    expect(screen.getByRole("menuitem", { name: "File" })).toHaveFocus();
  });

  it("uses the same guarded close from Window and the existing caption button", async () => {
    const user = userEvent.setup();
    const { bridge, menu, onError } = fixture();
    const guard = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    render(
      <TitleBar
        bridge={bridge}
        menu={menu}
        onError={onError}
        beforeClose={guard}
      />,
    );
    await user.click(screen.getByRole("menuitem", { name: "Window" }));
    await user.click(screen.getByRole("menuitem", { name: "Close window" }));
    expect(guard).toHaveBeenCalledTimes(1);
    expect(bridge.close).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Close window" }));
    await waitFor(() => expect(bridge.close).toHaveBeenCalledTimes(1));
  });

  it("reports asynchronous command failure and provides a real local keyboard reference", async () => {
    const user = userEvent.setup();
    const { bridge, menu, onError } = fixture();
    menu.actions.save!.run = vi
      .fn()
      .mockRejectedValue(new Error("Synthetic write failure"));
    render(<TitleBar bridge={bridge} menu={menu} onError={onError} />);
    await user.click(screen.getByRole("menuitem", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Save Ctrl+S" }));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("Synthetic write failure"),
    );
    await user.click(screen.getByRole("menuitem", { name: "Help" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Keyboard shortcuts" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeVisible();
    expect(screen.getByText("Ctrl+S")).toBeVisible();
    expect(
      screen.getByText(
        "Editor shortcuts apply while the code editor is focused.",
      ),
    ).toBeVisible();
  });
});
