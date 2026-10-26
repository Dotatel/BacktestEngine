import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import type { SelectedReport } from "../../src/lib/reports-contract";

// Explicit synthetic DI presentation checks. No native storage, compilation or genuine trading evidence is claimed.
for (const appearance of ["dark", "light"]) {
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 800, height: 640 },
  ]) {
    test(`synthetic saved-run history ${appearance} ${viewport.width}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await page.evaluate(async (appearance) => {
        const reactUrl = "/node_modules/.vite/deps/react.js";
        const domUrl = "/node_modules/.vite/deps/react-dom_client.js";
        const componentUrl = "/src/features/reports/ReportsStage.tsx";
        const fixtureUrl = "/src/features/reports/saved-runs.test-support.ts";
        const [React, Dom, module, fixtures] = await Promise.all([
          import(reactUrl),
          import(domUrl),
          import(componentUrl),
          import(fixtureUrl),
        ]);
        document.documentElement.classList.toggle(
          "dark",
          appearance === "dark",
        );
        document.title = "Synthetic saved-run history UI review";
        const prior = document.getElementById("root");
        if (prior) prior.style.display = "none";
        const host = document.createElement("main");
        host.style.height = "100dvh";
        host.setAttribute(
          "aria-label",
          "Synthetic saved-run history UI review only",
        );
        document.body.append(host);
        let selected: SelectedReport | null = null;
        const reports = {
          native: true,
          selected: async () => selected,
          exportSaved: async () => null,
        };
        const history = fixtures.syntheticHistoryBridge({
          list: async () => ({
            ...fixtures.historyPage,
            rows: [
              fixtures.historyRow,
              { ...fixtures.historyRow, runId: "synthetic-history-second-run" },
            ],
          }),
          select: async () => {
            selected = fixtures.historyReport;
            return fixtures.historySelection;
          },
        });
        const ReactApi = React.default ?? React;
        const DomApi = Dom.default ?? Dom;
        DomApi.createRoot(host).render(
          ReactApi.createElement(module.ReportsStage, {
            bridge: reports,
            historyBridge: history,
            projectRoot: "project-a",
          }),
        );
        await document.fonts.ready;
      }, appearance);
      const open = page.getByRole("button", {
        name: "Verify and open run synthetic-history-run",
        exact: true,
      });
      await expect(open).toBeEnabled();
      await open.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByText("Selected", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Export original JSON" }),
      ).toBeEnabled();
      expect(
        (await new AxeBuilder({ page }).include(".reports-stage").analyze())
          .violations,
      ).toEqual([]);
      expect(
        await page
          .locator(".reports-stage")
          .evaluate((element) => element.scrollWidth > element.clientWidth + 1),
      ).toBe(false);
      fs.mkdirSync("artifacts/saved-history-ui-review", { recursive: true });
      await page.locator(".reports-stage").evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({
        path: `artifacts/saved-history-ui-review/synthetic-history-${appearance}-${viewport.width}.png`,
        animations: "disabled",
      });
    });
  }
}
