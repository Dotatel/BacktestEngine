import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";

const sizes = [
  { width: 1920, height: 1080 },
  { width: 800, height: 640 },
];

for (const appearance of ["dark", "light"]) {
  for (const viewport of sizes) {
    for (const state of ["empty", "completed"]) {
      test(`Backtest DI presentation fixture ${state} ${appearance} ${viewport.width}x${viewport.height}`, async ({
        page,
      }) => {
        fs.mkdirSync("artifacts/execution-ui-review/di-fixtures", {
          recursive: true,
        });
        await page.setViewportSize(viewport);
        await page.goto(
          `/tests/ui/fixtures/backtest.html?appearance=${appearance}`,
        );
        await expect(
          page.getByText(/Presentation fixture · synthetic results/),
        ).toBeVisible();
        await expect(
          page.getByLabel("Backtest stage", { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Price chart unavailable" }),
        ).toBeVisible();
        if (state === "completed") {
          await page.getByRole("button", { name: "Run backtest" }).click();
          await expect(page.getByRole("table")).toHaveAccessibleName(
            /fixture-run-001/,
          );
          await expect(page.getByText("Page 1 of 2")).toBeVisible();
          await page.getByRole("button", { name: "Next trade page" }).click();
          await expect(
            page.getByText("21–25 of 25 trades · 20 / page"),
          ).toBeVisible();
          await page
            .getByRole("button", { name: "Previous trade page" })
            .click();
        }
        await page
          .getByRole("region", { name: "Market and run configuration" })
          .scrollIntoViewIfNeeded();
        const sidebar = page.getByRole("complementary", {
          name: "Strategy parameters",
        });
        const configuration = page.getByRole("region", {
          name: "Market and run configuration",
        });
        const chart = page.getByRole("region", { name: "Market chart" });
        const sidebarBox = await sidebar.boundingBox();
        const configurationBox = await configuration.boundingBox();
        const chartBox = await chart.boundingBox();
        expect(sidebarBox!.x + sidebarBox!.width).toBeLessThanOrEqual(
          chartBox!.x,
        );
        expect(
          configurationBox!.y + configurationBox!.height,
        ).toBeLessThanOrEqual(chartBox!.y);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await expect(page.getByLabel("Capital", { exact: true })).toBeVisible();
        const accessibility = await new AxeBuilder({ page })
          .include(".execution-stage")
          .analyze();
        expect(accessibility.violations).toEqual([]);
        await page.screenshot({
          path: `artifacts/execution-ui-review/di-fixtures/${state}-${appearance}-${viewport.width}x${viewport.height}.png`,
          animations: "disabled",
        });
      });
    }
  }
}

test("Backtest DI fixture keeps chart tabs, frozen inputs and CSV export on the selected run", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tests/ui/fixtures/backtest.html?appearance=dark");
  await page.getByRole("button", { name: "Run backtest" }).click();
  await page.getByRole("tab", { name: "Equity curve" }).click();
  await expect(
    page.getByRole("img", { name: "Equity and balance" }),
  ).toBeVisible();
  await expect(page.getByText(/2 of 2 samples/)).toBeVisible();
  await expect(
    page.locator(".execution-equity-chart .recharts-surface"),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Drawdown" }).click();
  await expect(
    page.getByRole("img", { name: "Sampled equity drawdown" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Logs" }).click();
  await expect(page.getByText(/Run fixture-run-001 · completed/)).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export trades" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    "backtest-fixture-run-001-trades.csv",
  );
  const path = await download.path();
  expect(fs.readFileSync(path!, "utf8").split("\r\n")).toHaveLength(26);
  await page.getByLabel("EMA fast", { exact: true }).fill("25");
  await expect(page.getByText("Previous run", { exact: true })).toBeVisible();
  await page.getByText("Run inputs and provenance").click();
  await expect(page.getByText(/FastPeriod = 20/)).toBeVisible();
});
