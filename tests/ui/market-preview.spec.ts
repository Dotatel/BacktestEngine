import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";

for (const appearance of ["dark", "light"]) {
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 800, height: 640 },
  ]) {
    test(`market preview DI candles ${appearance} ${viewport.width}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto(
        `/tests/ui/fixtures/market-preview.html?appearance=${appearance}`,
      );
      await expect(page.getByText(/synthetic OHLC/)).toBeVisible();
      await expect(page.locator(".execution-candle-body")).toHaveCount(3);
      for (const candle of await page.locator(".execution-candle-body").all())
        expect(await candle.getAttribute("d")).not.toContain("NaN");
      await expect(
        page.getByRole("button", { name: "Run backtest" }),
      ).toBeDisabled();
      await expect(
        page.getByText("Volume is not present in the imported source."),
      ).toBeVisible();
      await expect(page.getByRole("slider")).toHaveCount(2);
      await expect(page.getByLabel("Start UTC", { exact: true })).toHaveValue(
        "",
      );
      await expect(page.getByLabel("End UTC (exclusive)")).toHaveValue("");
      const firstHandle = page.getByRole("slider").first();
      await firstHandle.focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByLabel("Start UTC", { exact: true })).toHaveValue(
        "2026-01-02",
      );
      await page.getByRole("button", { name: "All history" }).click();
      await expect(page.getByLabel("Start UTC", { exact: true })).toHaveValue(
        "",
      );
      await expect(page.locator(".execution-candle-body")).toHaveCount(3);
      const results = await new AxeBuilder({ page })
        .include(".execution-stage")
        .analyze();
      expect(results.violations).toEqual([]);
      await page
        .getByRole("region", { name: "Market and run configuration" })
        .scrollIntoViewIfNeeded();
      fs.mkdirSync("artifacts/market-preview/di-fixtures", { recursive: true });
      await page.screenshot({
        path: `artifacts/market-preview/di-fixtures/candles-${appearance}-${viewport.width}.png`,
        animations: "disabled",
      });
      await page.getByText("Exact OHLC values and data provenance").click();
      await expect(
        page.getByRole("table", { name: /Exact imported candle values/ }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("table", { name: /Exact imported candle values/ })
          .getByRole("row"),
      ).toHaveCount(4);
    });
  }
}

test("matching-run fill triangles reveal the actual ledger row and disappear on draft changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    "/tests/ui/fixtures/backtest.html?appearance=dark&prices=fixture",
  );
  await expect(page.locator(".execution-candle-body")).toHaveCount(3);
  await page.getByRole("button", { name: "Run backtest" }).click();
  const marker = page.getByRole("button", {
    name: /Buy entry, .* trade fixture-trade-25$/,
  });
  await expect(marker).toBeVisible();
  await marker.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Page 2 of 2")).toBeVisible();
  await expect(
    page.getByText("Trade fixture-trade-25 · EURUSD", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Equity curve" }).click();
  await marker.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("tab", { name: "Trades", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const accessibility = await new AxeBuilder({ page })
    .include(".execution-stage")
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.getByLabel("EMA fast", { exact: true }).fill("25");
  await expect(page.locator(".execution-fill-marker")).toHaveCount(0);
  await expect(
    page.getByText("Previous run metrics", { exact: true }),
  ).toBeVisible();
});

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 800, height: 640 },
]) {
  test(`recorded-volume fixture stays above run provenance at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(
      "/tests/ui/fixtures/market-preview.html?appearance=dark&volume=recorded",
    );
    await expect(
      page.getByRole("img", { name: "Imported recorded volume" }),
    ).toBeVisible();
    await expect(page.locator(".execution-candle-body")).toHaveCount(3);
    const body = await page.locator(".execution-candles-body").boundingBox();
    const volume = await page.locator(".execution-volume-chart").boundingBox();
    const values = await page.locator(".execution-candle-values").boundingBox();
    const identity = await page
      .locator(".execution-run-identity")
      .boundingBox();
    expect(volume!.y + volume!.height).toBeLessThanOrEqual(
      body!.y + body!.height + 1,
    );
    expect(values!.y + values!.height).toBeLessThanOrEqual(identity!.y + 1);
    expect(body!.y + body!.height).toBeLessThanOrEqual(identity!.y + 1);
    const data = await page
      .getByRole("combobox", { name: "Data", exact: true })
      .boundingBox();
    expect(data!.width).toBeGreaterThan(140);
    await page.locator(".execution-volume-chart").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `artifacts/market-preview/di-fixtures/recorded-volume-${viewport.width}.png`,
      animations: "disabled",
    });
  });
}
