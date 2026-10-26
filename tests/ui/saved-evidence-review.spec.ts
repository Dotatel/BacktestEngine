import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";

// These browser captures inject explicitly synthetic evidence. They are UI checks, not native acceptance.
for (const surface of ["reports", "validation"] as const) {
  for (const appearance of ["dark", "light"]) {
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 800, height: 640 },
    ]) {
      test(`synthetic ${surface} review ${appearance} ${viewport.width}`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await page.goto("/");
        await page.evaluate(
          async ({ surface, appearance }) => {
            const reactUrl = "/node_modules/.vite/deps/react.js";
            const domUrl = "/node_modules/.vite/deps/react-dom_client.js";
            const componentUrl =
              surface === "reports"
                ? "/src/features/reports/ReportsStage.tsx"
                : "/src/features/validation/ValidationStage.tsx";
            const [React, Dom, module] = await Promise.all([
              import(reactUrl),
              import(domUrl),
              import(componentUrl),
            ]);
            document.documentElement.classList.toggle(
              "dark",
              appearance === "dark",
            );
            document.title = "Synthetic saved-evidence UI review";
            const source = {
              projectRoot: "C:/Synthetic review project",
              runId: "synthetic-run-ui-only",
              reportSha256: "a".repeat(64),
              reportJsonPath: "C:/Synthetic review project/runs/report.json",
              buildRevision: "synthetic-build-revision",
              datasetId: "synthetic-import",
              completedAt: "2026-10-24T10:00:00Z",
              strategy: "Synthetic fixture — UI review only",
              symbol: "EURUSD",
              timeframe: "M1",
              accountCurrency: "EUR",
              nativeDrawdownMethod: "ctrader-price-extremes-and-deals-v1",
              closedTradeCount: 4,
              metrics: [
                { label: "Closing balance", value: 10100.5, unit: "money" },
                { label: "Profit factor", value: null, unit: "ratio" },
                { label: "Full replay equity drawdown", value: 4, unit: "%" },
                {
                  label: "Native price-extremes equity drawdown",
                  value: 3,
                  unit: "%",
                },
              ],
            };
            const result = {
              validationRunId: "synthetic-validation-ui-only",
              executionRunId: source.runId,
              sourceReportSha256: source.reportSha256,
              mode: "savedReport",
              success: true,
              status: "completed",
              verdict: "UNPROVEN",
              projectRoot: source.projectRoot,
              startedAt: "2026-10-24T10:01:00Z",
              completedAt: "2026-10-24T10:01:02Z",
              durationMs: 2000,
              validationDir: "C:/Synthetic validation",
              configPath: "C:/Synthetic validation/config.json",
              finalVerdictPath: "C:/Synthetic validation/FinalVerdict.json",
              finalReportPath: "C:/Synthetic validation/FinalReport.md",
              missingEvidence: [
                "engine_level_latency_stress",
                "walk_forward_embargo_backtests",
              ],
              errors: [],
              output: "Synthetic UI fixture. No Python was executed.",
              lastGoodPreserved: false,
            };
            const reportsBridge = {
              native: true,
              selected: async () => source,
              exportSaved: async () => null,
            };
            const validationBridge = {
              native: true,
              run: async () => result,
              cancel: async () => {},
              lastGoodResult: async () => result,
            };
            const prior = document.getElementById("root");
            if (prior) prior.style.display = "none";
            const host = document.createElement("main");
            host.style.height = "100dvh";
            host.setAttribute("aria-label", "Synthetic saved-evidence review");
            document.body.append(host);
            const Component =
              surface === "reports"
                ? module.ReportsStage
                : module.ValidationStage;
            const props =
              surface === "reports"
                ? { bridge: reportsBridge, projectRoot: source.projectRoot }
                : {
                    bridge: validationBridge,
                    reportsBridge,
                    projectRoot: source.projectRoot,
                  };
            const ReactApi = React.default ?? React;
            const DomApi = Dom.default ?? Dom;
            DomApi.createRoot(host).render(
              ReactApi.createElement(Component, props),
            );
            await document.fonts.ready;
          },
          { surface, appearance },
        );
        await expect(
          page.getByText(/Synthetic fixture — UI review only/),
        ).toBeVisible();
        const violations = await new AxeBuilder({ page })
          .include(`.${surface === "reports" ? "reports" : "validation"}-stage`)
          .analyze();
        expect(violations.violations).toEqual([]);
        const overflow = await page
          .locator(`.${surface === "reports" ? "reports" : "validation"}-stage`)
          .evaluate((element) => element.scrollWidth > element.clientWidth + 1);
        expect(overflow).toBe(false);
        fs.mkdirSync("artifacts/saved-evidence-ui-review", { recursive: true });
        await page.screenshot({
          path: `artifacts/saved-evidence-ui-review/synthetic-${surface}-${appearance}-${viewport.width}.png`,
          animations: "disabled",
        });
        if (surface === "validation") {
          await page
            .getByRole("heading", { name: "Validation evidence", exact: true })
            .scrollIntoViewIfNeeded();
          await expect(
            page.getByText("UNPROVEN", { exact: true }),
          ).toBeVisible();
          await page.screenshot({
            path: `artifacts/saved-evidence-ui-review/synthetic-validation-evidence-${appearance}-${viewport.width}.png`,
            animations: "disabled",
          });
        }
      });
    }
  }
}
