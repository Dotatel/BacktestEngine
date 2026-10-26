import { expect, test, type Page } from "@playwright/test";

/** Capture settled, locally rendered UI with the pointer clear of hover states; baselines await owner visual approval. */
async function expectComposition(page: Page, name: string) {
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images).map((image) =>
        image.decode().catch(() => {}),
      ),
    );
  });
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot(name, {
    animations: "disabled",
    fullPage: true,
    maxDiffPixelRatio: 0.002,
  });
}

test("onboarding visual regression baseline", async ({ page }) => {
  await page.setViewportSize({ width: 660, height: 470 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to BacktestEngine" }),
  ).toBeVisible();
  await expectComposition(page, "P01-welcome-dark.png");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expectComposition(page, "P01-welcome-light.png");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("button", { name: "Get Started" }).click();
  await page.setViewportSize({ width: 1672, height: 941 });
  await expectComposition(page, "P02-workspace.png");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expectComposition(page, "P03-appearance.png");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expectComposition(page, "P04-agent.png");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expectComposition(page, "P05-finish.png");
});
