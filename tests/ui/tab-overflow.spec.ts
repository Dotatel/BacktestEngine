import { expect, test, type Locator, type Page } from "@playwright/test";

/** Check actual clipping bounds, including the line indicator painted below a standard shadcn tab. */
async function expectContainedTabs(strip: Locator) {
  await expect
    .poll(() =>
      strip
        .locator('[role="tab"][data-state="active"]')
        .evaluate((element) => getComputedStyle(element, "::after").opacity),
    )
    .toBe("1");
  const geometry = await strip.evaluate((element) => {
    const active = element.querySelector<HTMLElement>(
      '[role="tab"][data-state="active"]',
    )!;
    const bounds = element.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    const marker = getComputedStyle(active, "::after");
    const style = getComputedStyle(active);
    const focusExtent =
      parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
    return {
      overflow: element.scrollHeight - element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
      markerOpacity: marker.opacity,
      markerBottom:
        tab.bottom -
        parseFloat(style.borderBottomWidth) -
        parseFloat(marker.bottom),
      clipBottom: bounds.top + element.clientHeight,
      focusVisible: active.matches(":focus-visible"),
      focusPaintFits:
        tab.top - focusExtent >= bounds.top &&
        tab.bottom + focusExtent <= bounds.top + element.clientHeight &&
        tab.left - focusExtent >= bounds.left &&
        tab.right + focusExtent <= bounds.left + element.clientWidth,
    };
  });
  expect(geometry.overflow).toBe(0);
  expect(geometry.overflowY).toBe("hidden");
  expect(geometry.markerOpacity).toBe("1");
  expect(geometry.markerBottom).toBeLessThanOrEqual(geometry.clipBottom);
  if (geometry.focusVisible) expect(geometry.focusPaintFits).toBe(true);
}

/** Seed many saved preview files to exercise the existing editor tab grid and real overflow. */
async function openManyFiles(page: Page, appearance: string) {
  await page.addInitScript((appearance) => {
    const paths = Array.from(
      { length: 20 },
      (_, index) => `StrategyDocument${String(index).padStart(2, "0")}.cs`,
    );
    const root = "browser-preview:/tab-overflow-regression";
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
    );
    localStorage.setItem(
      "dotatel-workspace-browser-preview-v1",
      JSON.stringify({
        version: 1,
        root,
        folders: [],
        documents: Object.fromEntries(
          paths.map((path) => [
            path,
            { path, content: `// ${path}\n`, revision: path },
          ]),
        ),
        session: {
          lastProject: root,
          activeFile: paths[0],
          openFiles: paths,
          presets: [],
        },
      }),
    );
  }, appearance);
  await page.goto("/");
  await expect(
    page.getByRole("tab", { name: "StrategyDocument00.cs", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
}

for (const appearance of ["dark", "light"]) {
  for (const width of [800, 1920]) {
    test(`tab strips retain indicators, keyboard focus and real scrolling ${appearance} ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(
        `/tests/ui/fixtures/backtest.html?appearance=${appearance}`,
      );
      const backtestTabs = page.getByRole("tablist", { name: "Result views" });
      const backtestStrip = page.locator(
        ".execution-results .workspace-tabs-scroll",
      );
      await expect(backtestTabs).toBeVisible();
      await expectContainedTabs(backtestStrip);
      await backtestStrip.evaluate((element) => {
        element.style.maxWidth = "180px";
      });
      await backtestTabs
        .getByRole("tab", { name: "Trades", exact: true })
        .focus();
      await page.keyboard.press("End");
      await expect(
        backtestTabs.getByRole("tab", { name: "Logs", exact: true }),
      ).toBeFocused();
      await expect
        .poll(() => backtestStrip.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(0);
      await expectContainedTabs(backtestStrip);
      await expect(
        page.getByRole("button", { name: "Export trades", exact: true }),
      ).toBeVisible();
      expect(
        await page
          .locator(".execution-strategy")
          .evaluate((element) => getComputedStyle(element).borderRadius),
      ).toBe("0px");
      expect(
        await page
          .locator(".execution-results")
          .evaluate((element) => getComputedStyle(element).borderLeftWidth),
      ).toBe("0px");

      await page.goto(
        `/tests/ui/fixtures/app-settings.html?theme=${appearance}`,
      );
      await page
        .getByRole("button", { name: "Workspace settings", exact: true })
        .click();
      const settings = page.getByRole("dialog", {
        name: "Workspace settings",
        exact: true,
      });
      const settingsStrip = settings.locator(".workspace-tabs-scroll");
      await expectContainedTabs(settingsStrip);
      await settings.getByRole("tab", { name: "General", exact: true }).focus();
      await page.keyboard.press("End");
      await expect(
        settings.getByRole("tab", { name: "Diagnostics", exact: true }),
      ).toBeFocused();
      await expectContainedTabs(settingsStrip);
      const body = settings.locator(".app-settings-body");
      await body.evaluate((element) => {
        element.style.maxHeight = "180px";
        element.scrollTop = 40;
      });
      await expect
        .poll(() => body.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      expect(
        await settingsStrip.evaluate(
          (element) => element.scrollHeight - element.clientHeight,
        ),
      ).toBe(0);

      await openManyFiles(page, appearance);
      const buildStrip = page.locator(".results-bar .workspace-tabs-scroll");
      await expectContainedTabs(buildStrip);
      await buildStrip
        .getByRole("tab", { name: "Output", exact: true })
        .focus();
      await expectContainedTabs(buildStrip);
      const files = page.locator(".file-tabs");
      await page
        .getByRole("tab", { name: "StrategyDocument00.cs", exact: true })
        .focus();
      await page.keyboard.press("End");
      await expect(
        page.getByRole("tab", { name: "StrategyDocument19.cs", exact: true }),
      ).toBeFocused();
      await expect
        .poll(() => files.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(0);
      expect(
        await files.evaluate((element) => getComputedStyle(element).overflowY),
      ).toBe("hidden");
      const close = page.getByRole("button", {
        name: "Close StrategyDocument19.cs",
        exact: true,
      });
      await close.focus();
      await expect(close).toBeInViewport();
      await close.click();
      await expect(
        page.getByRole("tab", { name: "StrategyDocument19.cs", exact: true }),
      ).toHaveCount(0);
    });
  }
}
