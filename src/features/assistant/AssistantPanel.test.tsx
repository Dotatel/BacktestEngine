import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AssistantPanel } from "./AssistantPanel";
import { syntheticAssistant } from "./assistant-fixtures.test-support";

describe("optional assistant panel (synthetic DI)", () => {
  it("does not automatically attach supplied context, connect, or send", async () => {
    const bridge = syntheticAssistant();
    render(
      <AssistantPanel
        bridge={bridge}
        contextOptions={[
          {
            label: "Build diagnostics",
            text: "Synthetic build context requires click",
          },
        ]}
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryByText("Loading local conversation…"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByDisplayValue("Synthetic build context requires click"),
    ).not.toBeInTheDocument();
    expect(bridge.status).not.toHaveBeenCalled();
    expect(bridge.send).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Add Build diagnostics" }),
    );
    expect(
      screen.getByDisplayValue("Synthetic build context requires click"),
    ).toBeVisible();
  });
  it("shows exact native preview and inherited-context disclosure before a separate Send action", async () => {
    const bridge = syntheticAssistant();
    render(<AssistantPanel bridge={bridge} />);
    await waitFor(() =>
      expect(
        screen.queryByText("Loading local conversation…"),
      ).not.toBeInTheDocument(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Connect OpenCode" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Review outgoing text" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Exact outgoing application text",
      }),
    ).toBeVisible();
    expect(screen.getByText(/cannot show all provider context/)).toBeVisible();
    expect(bridge.send).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Send reviewed text" }),
    ).toBeEnabled();
  });
  it("browser cannot connect or produce a provider answer", async () => {
    const bridge = { ...syntheticAssistant(), native: false };
    render(<AssistantPanel bridge={bridge} />);
    expect(
      screen.getByRole("button", { name: "Connect OpenCode" }),
    ).toBeDisabled();
    expect(screen.getByText(/Browser preview cannot connect/)).toBeVisible();
    expect(bridge.send).not.toHaveBeenCalled();
  });
});
