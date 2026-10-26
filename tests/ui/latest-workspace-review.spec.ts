import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";

for (const appearance of ["light", "dark"]) {
  for (const width of [800, 1440]) {
    test(`engine scenario controls ${appearance} ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await page.evaluate(async (appearance) => {
        const reactUrl = "/node_modules/.vite/deps/react.js";
        const domUrl = "/node_modules/.vite/deps/react-dom_client.js";
        const componentUrl = "/src/features/validation/FullValidationPanel.tsx";
        const fixturesUrl = "/src/features/reports/saved-runs.test-support.ts";
        const [React, Dom, module, fixtures] = await Promise.all([
          import(reactUrl),
          import(domUrl),
          import(componentUrl),
          import(fixturesUrl),
        ]);
        document.documentElement.classList.toggle(
          "dark",
          appearance === "dark",
        );
        const prior = document.getElementById("root");
        if (prior) prior.style.display = "none";
        const host = document.createElement("main");
        host.className = "validation-stage";
        host.setAttribute(
          "aria-label",
          "Synthetic engine scenario presentation review",
        );
        host.style.height = "100dvh";
        document.body.append(host);
        const ReactApi = React.default ?? React;
        const DomApi = Dom.default ?? Dom;
        DomApi.createRoot(host).render(
          ReactApi.createElement(module.FullValidationPanel, {
            bridge: {
              native: true,
              lastGoodResult: async () => null,
              cancel: async () => {},
              run: async () => {
                throw new Error(
                  "Synthetic UI fixture: native workflow not executed.",
                );
              },
            },
            executions: {
              native: true,
              lastGoodResult: async () => fixtures.historySelection.run,
            },
            source: fixtures.historyReport,
            reportBusy: false,
          }),
        );
        await document.fonts.ready;
      }, appearance);
      await expect(
        page.getByRole("button", { name: "Run engine scenarios" }),
      ).toBeEnabled();
      const axe = await new AxeBuilder({ page })
        .include(".validation-stage")
        .analyze();
      expect(axe.violations).toEqual([]);
      expect(
        await page
          .locator(".validation-stage")
          .evaluate((element) => element.scrollWidth > element.clientWidth + 1),
      ).toBe(false);
      await page.getByLabel("Latency ticks", { exact: true }).fill("1.5");
      await page.getByRole("button", { name: "Run engine scenarios" }).click();
      await expect(page.getByRole("alert")).toContainText(
        "Correct the scenario settings",
      );
      fs.mkdirSync("artifacts/latest-workspace-ui-review", { recursive: true });
      await page.screenshot({
        path: `artifacts/latest-workspace-ui-review/scenarios-${appearance}-${width}.png`,
        fullPage: true,
      });
    });
  }
  test(`integrated assistant toggle ${appearance}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(
      (appearance) =>
        localStorage.setItem(
          "dotatel-onboarding-browser-preview-v1",
          JSON.stringify({
            version: 1,
            step: 5,
            completed: true,
            workspaceStyle: "advanced",
            appearance,
            agent: null,
            agentVerified: false,
          }),
        ),
      appearance,
    );
    await page.goto("/");
    const toggle = page.getByRole("button", { name: "Toggle assistant" });
    await toggle.click();
    await expect(
      page.getByRole("complementary", { name: "Assistant panel" }),
    ).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const axe = await new AxeBuilder({ page })
      .include(".build-workspace")
      .analyze();
    expect(axe.violations).toEqual([]);
    fs.mkdirSync("artifacts/latest-workspace-ui-review", { recursive: true });
    await page.screenshot({
      path: `artifacts/latest-workspace-ui-review/assistant-${appearance}.png`,
      fullPage: true,
    });
    await page
      .getByRole("complementary", { name: "Assistant panel" })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(
      page.getByRole("complementary", { name: "Assistant panel" }),
    ).toBeHidden();
    await toggle.click();
    await expect(
      page.getByRole("heading", { name: "Assistant", exact: true }),
    ).toBeVisible();
  });
}
