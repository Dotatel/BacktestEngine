import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";

// Explicitly synthetic UI captures. No optimizer execution, trading or economics proof is claimed.
for (const appearance of ["dark", "light"]) {
  for (const width of [1920, 800]) {
    test(`synthetic optimization ${appearance} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1080 });
      await page.goto("/");
      await page.evaluate(
        async ({ appearance }) => {
          const reactUrl = "/node_modules/.vite/deps/react.js",
            domUrl = "/node_modules/.vite/deps/react-dom_client.js",
            componentUrl = "/src/features/optimization/OptimizeStage.tsx";
          const [React, Dom, module] = await Promise.all([
            import(reactUrl),
            import(domUrl),
            import(componentUrl),
          ]);
          const schema = {
            strategy: "Synthetic UI review only",
            strategyType: "Synthetic",
            parameters: [
              {
                name: "HoldTicks",
                displayName: "Hold ticks",
                group: "",
                valueType: "integer",
                default: 10,
                min: 1,
                max: 100,
                step: 1,
                options: [],
              },
            ],
          };
          const candidate = {
            id: "candidate_000001",
            hash: "0123456789abcdef",
            status: "completed",
            error: null,
            parameters: { HoldTicks: "10" },
            metrics: {
              currency: "EUR",
              netProfit: 12,
              profitFactor: null,
              optimizerProfitFactor: 999,
              nativeDrawdownPercent: 3,
              nativeDrawdownMethod: "Synthetic native method",
              fullReplayDrawdownPercent: 4,
              fitnessScore: 0.5,
            },
            reportJsonPath: "C:/Synthetic/report.json",
            reportSha256: "a".repeat(64),
          };
          const result = {
            runId: "synthetic-ui-only",
            projectRoot: "synthetic-project",
            status: "completed",
            success: true,
            exitCode: 0,
            candidates: [
              candidate,
              {
                ...candidate,
                id: "candidate_000002",
                status: "failed",
                metrics: null,
                error: "Synthetic failure; no metrics available",
              },
            ],
            errors: [],
            output: "Synthetic fixture. No optimizer was executed.",
            budget: 2,
            method: "grid",
            seed: 42,
            buildRevision: "synthetic-build",
            approvedArtifactSha256: "a".repeat(64),
            datasetSha256: "b".repeat(64),
            symbolSpecSha256: "c".repeat(64),
            configSha256: "d".repeat(64),
            runFolder: "C:/Synthetic/output",
          };
          const props = {
            bridge: {
              native: true,
              run: async () => result,
              cancel: async () => {},
              lastGoodResult: async () => result,
            },
            executionBridge: {
              native: true,
              listDatasets: async () => [
                {
                  id: "data",
                  originalPath: "C:/Synthetic/history.csv",
                  kind: "ticks",
                },
              ],
              listSymbolSpecs: async () => [
                { id: "profile", originalPath: "C:/Synthetic/profile.json" },
              ],
            },
            projectRoot: "synthetic-project",
            build: {
              success: true,
              artifactPath: "synthetic.dll",
              strategies: [schema],
            },
            stale: false,
            parameters: { activeStrategy: schema, values: { HoldTicks: 10 } },
          };
          document.documentElement.classList.toggle(
            "dark",
            appearance === "dark",
          );
          const prior = document.getElementById("root");
          if (prior) prior.style.display = "none";
          const host = document.createElement("main");
          host.style.height = "100dvh";
          document.body.append(host);
          const ReactApi = React.default ?? React,
            DomApi = Dom.default ?? Dom;
          DomApi.createRoot(host).render(
            ReactApi.createElement(module.OptimizeStage, props),
          );
          await document.fonts.ready;
        },
        { appearance },
      );
      await expect(
        page.getByText("Synthetic UI review only", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Add search parameter" }).click();
      const violations = await new AxeBuilder({ page })
        .include(".optimization-stage")
        .analyze();
      expect(violations.violations).toEqual([]);
      expect(
        await page
          .locator(".optimization-stage")
          .evaluate((element) => element.scrollWidth > element.clientWidth + 1),
      ).toBe(false);
      fs.mkdirSync("artifacts/optimization-ui-review", { recursive: true });
      await page.screenshot({
        path: `artifacts/optimization-ui-review/synthetic-${appearance}-${width}.png`,
        animations: "disabled",
      });
      await page.getByRole("table").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `artifacts/optimization-ui-review/synthetic-evidence-${appearance}-${width}.png`,
        animations: "disabled",
      });
    });
  }
}
