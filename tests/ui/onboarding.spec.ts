import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** Advance only after the selected preferences have finished saving. */
async function continueSetup(page: Page) {
  const next = page.getByRole("button", { name: "Continue", exact: true });
  await expect(next).toBeEnabled();
  await next.click();
}

/** Measure actual rendered page geometry, including bottom controls and overflow at the current size. */
async function expectUsableLayout(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const button = page
    .getByRole("button", {
      name: /^(Continue|Connect agent|Open BacktestEngine)$/,
    })
    .first();
  await button.scrollIntoViewIfNeeded();
  const rect = await button.boundingBox();
  await expect(button).toHaveAttribute("data-size", "lg");
  await expect(button).toHaveCSS("font-size", "14px");
  expect(rect?.height).toBe(40);
  expect(rect?.width).toBeGreaterThanOrEqual(24);
  const caption = page.getByRole("button", { name: "Close window" });
  await expect(caption).toHaveAttribute("data-size", "icon-sm");
  expect((await caption.boundingBox())?.height).toBe(32);
  expect((await caption.boundingBox())?.width).toBe(32);
  await expect(
    page.getByRole("banner", { name: "Window title bar" }),
  ).toBeInViewport();
  await expect
    .poll(() =>
      page
        .locator("img:visible")
        .evaluateAll((images) =>
          images.every(
            (image) =>
              (image as HTMLImageElement).complete &&
              (image as HTMLImageElement).naturalWidth > 0,
          ),
        ),
    )
    .toBe(true);
}

test("all five steps work, survive reload and show actual choices at completion", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto("/");
  await page.getByRole("button", { name: "Get Started" }).click();
  await page.getByRole("radio", { name: "Advanced", exact: true }).click();
  await continueSetup(page);
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Choose your appearance" }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Dark", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(
    page.getByRole("radio", { name: "Advanced", exact: true }),
  ).toBeChecked();
  await continueSetup(page);
  await continueSetup(page);
  await page.getByRole("radio", { name: "OpenCode", exact: true }).click();
  await page.getByRole("button", { name: "Connect agent" }).click();
  await expect(page.getByRole("alert")).toContainText("desktop app");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByText("Advanced", { exact: true })).toBeVisible();
  await expect(page.getByText("Dark", { exact: true })).toBeVisible();
  await expect(page.getByText("Skipped for now")).toBeVisible();
  await page.getByRole("button", { name: "Open BacktestEngine" }).click();
  await expect(
    page.getByRole("region", { name: "Build workspace" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Build workspace" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Workspace settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Review setup", exact: true }).click();
  await expect(
    page.getByRole("radio", { name: "Advanced", exact: true }),
  ).toBeChecked();
  expect(errors).toEqual([]);
});

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1672, height: 941 },
  { width: 1280, height: 720 },
  { width: 800, height: 640 },
]) {
  test(`setup layout and accessibility at ${viewport.width} × ${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.getByRole("button", { name: "Get Started" }).click();
    for (let step = 2; step <= 5; step++) {
      await expectUsableLayout(page);
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(result.violations, JSON.stringify(result.violations)).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`P0${step}-${viewport.width}.png`),
        fullPage: true,
      });
      if (step === 4)
        await page.getByRole("button", { name: "Skip for now" }).click();
      else if (step < 5) await continueSetup(page);
    }
  });
}

test("keyboard-only setup supports arrows, Space and visible focus", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Get Started" }).press("Enter");
  const simple = page.getByRole("radio", { name: "Simple", exact: true });
  await simple.focus();
  await page.keyboard.press("ArrowRight");
  const advanced = page.getByRole("radio", { name: "Advanced", exact: true });
  await expect(advanced).toBeChecked();
  await expect(advanced).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Choose your appearance" }),
  ).toBeFocused();
});

test("System follows OS appearance changes while a chosen theme stays fixed", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Get Started" }).click();
  await continueSetup(page);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(result.violations).toEqual([]);
});

test("every step remains accessible in Light appearance", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  let result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(result.violations).toEqual([]);
  await page.getByRole("button", { name: "Get Started" }).click();
  for (let step = 2; step <= 5; step++) {
    result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(result.violations, JSON.stringify(result.violations)).toEqual([]);
    if (step === 4)
      await page.getByRole("button", { name: "Skip for now" }).click();
    else if (step < 5) await continueSetup(page);
  }
});

test("storage failures are recoverable without silent data loss", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value() {
        throw new Error("Disk storage is unavailable. Retry.");
      },
    });
  });
  await page.getByRole("button", { name: "Get Started" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Disk storage is unavailable",
  );
  await expect(
    page.getByRole("heading", { name: "Welcome to BacktestEngine" }),
  ).toBeVisible();
});

test("the complete flow loads all assets locally without network requests", async ({
  page,
}) => {
  const external: string[] = [];
  page.on("request", (request) => {
    if (
      !request.url().startsWith("http://127.0.0.1:1420") &&
      !request.url().startsWith("ws://127.0.0.1:1420")
    )
      external.push(request.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Get Started" }).click();
  await continueSetup(page);
  await continueSetup(page);
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("button", { name: "Open BacktestEngine" }).click();
  await expect(
    page.getByRole("region", { name: "Build workspace" }),
  ).toBeVisible();
  expect(external).toEqual([]);
});

test("shared control sizes and restrained motion follow the design system", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 660, height: 470 });
  await page.goto("/");
  const start = page.getByRole("button", { name: "Get Started" });
  await expect(start).toHaveAttribute("data-size", "lg");
  await expect(start).toHaveCSS("height", "40px");
  await expect(start).toHaveCSS("font-size", "14px");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCSS(
    "font-size",
    "24px",
  );
  await expect(page.locator(".setup-pane")).toHaveCSS(
    "animation-name",
    "step-arrive",
  );
  await expect(page.locator(".setup-pane")).toHaveCSS(
    "animation-duration",
    "0.2s",
  );
  await expect(start).toHaveCSS("transition-duration", "0.12s");
  await expect(page.locator("main")).toHaveCSS("overflow-x", "hidden");
  await start.click();
  await page.setViewportSize({ width: 800, height: 640 });
  const radio = page.getByRole("radio", { name: "Simple", exact: true });
  await expect(radio).toHaveCSS("height", "16px");
  await expect(radio).toHaveCSS("width", "16px");
  await expect(page.locator('[data-slot="radio-group-indicator"]')).toHaveCSS(
    "animation-name",
    "selection-confirm",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".setup-pane")).toHaveCSS("animation-name", "none");
  await expect(page.locator('[data-slot="radio-group-indicator"]')).toHaveCSS(
    "animation-name",
    "none",
  );
  await expectUsableLayout(page);
});
