import { expect, test } from "@playwright/test";

/** The browser preview must keep Backtest disabled because no successful native build exists. */
test("backtest stage stays disabled in the browser preview", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("dotatel-onboarding-browser-preview-v1")) {
      localStorage.setItem(
        "dotatel-onboarding-browser-preview-v1",
        JSON.stringify({
          version: 1,
          step: 5,
          completed: true,
          workspaceStyle: "advanced",
          appearance: "dark",
          agent: null,
          agentVerified: false,
        }),
      );
    }
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Use example project", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Backtest", exact: true }),
  ).toBeDisabled();
});
