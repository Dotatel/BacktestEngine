import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";

/** Pick a standard shadcn state filter through its public accessible controls. */
async function chooseState(page: Page, region: Locator, state: string) {
  await region
    .getByRole("combobox", { name: "Extension state", exact: true })
    .click();
  await page.getByRole("option", { name: state, exact: true }).click();
}

/** Exercise the actual stretched native hit target rather than forcing a click through its overlay. */
async function clickCardSurface(card: Locator, surface: Locator) {
  await surface.scrollIntoViewIfNeeded();
  const cardBounds = await card.boundingBox();
  const surfaceBounds = await surface.boundingBox();
  if (!cardBounds || !surfaceBounds)
    throw new Error("Card surface has no rendered bounds");
  await card.click({
    position: {
      x: surfaceBounds.x - cardBounds.x + surfaceBounds.width / 2,
      y: surfaceBounds.y - cardBounds.y + surfaceBounds.height / 2,
    },
  });
}

/** Cards keep one height across all rows and never grow inline to contain the inspector. */
async function expectEqualCards(region: Locator) {
  const geometry = await region.locator("article").evaluateAll((cards) =>
    cards.map((card) => ({
      height: card.getBoundingClientRect().height,
      width: card.getBoundingClientRect().width,
      clipped: card.scrollHeight > card.clientHeight + 1,
    })),
  );
  expect(geometry.length).toBeGreaterThan(0);
  expect(
    Math.max(...geometry.map((card) => card.height)) -
      Math.min(...geometry.map((card) => card.height)),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.max(...geometry.map((card) => card.width)) -
      Math.min(...geometry.map((card) => card.width)),
  ).toBeLessThanOrEqual(1);
  expect(geometry.some((card) => card.clipped)).toBe(false);
}

/** Wide windows dock a right column; compact windows anchor the inspector to the page's right edge. */
async function expectRightInspector(region: Locator, width: number) {
  const panel = region.locator(".extension-details-panel");
  await expect(panel).toBeVisible();
  const geometry = await region.evaluate((element) => {
    const panel = element
      .querySelector(".extension-details-panel")!
      .getBoundingClientRect();
    const main = element
      .querySelector(".extensions-main")!
      .getBoundingClientRect();
    const page = element.getBoundingClientRect();
    return {
      left: panel.left,
      right: panel.right,
      catalogRight: main.right,
      pageRight: page.right,
      contained: [...element.querySelectorAll("article")].some((card) =>
        card.contains(
          element.querySelector('[aria-label="Extension details"]'),
        ),
      ),
    };
  });
  expect(geometry.contained).toBe(false);
  expect(Math.abs(geometry.right - geometry.pageRight)).toBeLessThanOrEqual(1);
  if (width > 1100)
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.catalogRight - 1);
  await expectEqualCards(region);
}

/** Check actual visible image loading and the page's horizontal clipping boundary. */
async function expectPageFits(region: Locator) {
  expect(
    await region.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBe(0);
  const images = region.locator("img");
  await expect
    .poll(() =>
      images.evaluateAll((elements) =>
        elements.every(
          (element) =>
            (element as HTMLImageElement).complete &&
            (element as HTMLImageElement).naturalWidth > 0,
        ),
      ),
    )
    .toBe(true);
}

for (const appearance of ["dark", "light"]) {
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 800, height: 640 },
  ]) {
    test(`full-page extension catalog ${appearance} ${viewport.width}`, async ({
      page,
    }) => {
      const externalRequests: string[] = [];
      page.on("request", (request) => {
        if (
          /^https?:/.test(request.url()) &&
          !request.url().startsWith("http://127.0.0.1:1420")
        )
          externalRequests.push(request.url());
      });
      await page.setViewportSize(viewport);
      await page.goto(
        `/tests/ui/fixtures/app-settings.html?theme=${appearance}`,
      );
      await page
        .getByRole("button", { name: "Extensions", exact: true })
        .click();
      const region = page.getByRole("region", {
        name: "App extensions",
        exact: true,
      });
      const categories = region.getByRole("navigation", {
        name: "Extension categories",
      });
      const details = region.getByRole("region", {
        name: "Extension details",
      });
      await expect(
        region.getByRole("heading", {
          name: "App extensions",
          level: 1,
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        categories.getByRole("button", { name: "All extensions", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await expect(
        region.getByRole("article", { name: "Report tools", exact: true }),
      ).toHaveCount(1);
      await expect(details).toHaveCount(0);
      await expectEqualCards(region);
      const reportCard = region.getByRole("article", {
        name: "Report tools",
        exact: true,
        includeHidden: true,
      });
      const reportToggle = reportCard.getByRole("button", {
        name: "View Report tools",
        exact: true,
        includeHidden: true,
      });
      await expect(reportToggle).toHaveAttribute("aria-expanded", "false");
      await expect(reportToggle).toHaveAccessibleDescription(
        /Installed locally.*1\.0\.0.*Declarative report commands/,
      );
      await clickCardSurface(
        reportCard,
        reportCard.locator(".extension-card__description"),
      );
      await expect(reportToggle).toHaveAttribute("aria-expanded", "true");
      if (viewport.width > 1100) await expect(reportToggle).toBeFocused();
      await expect(details).toBeVisible();
      await expect(
        reportCard.getByRole("region", {
          name: "Extension details",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(reportToggle).toHaveAttribute(
        "aria-controls",
        (await details.getAttribute("id"))!,
      );
      await expectRightInspector(region, viewport.width);
      await expect(region.locator("button button")).toHaveCount(0);
      if (viewport.width > 1100) {
        await clickCardSurface(
          reportCard,
          reportCard.locator(".extension-icon"),
        );
      } else {
        await expect(
          region.getByRole("button", {
            name: "Close extension details",
            exact: true,
          }),
        ).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(reportToggle).toBeFocused();
        await clickCardSurface(
          reportCard,
          reportCard.locator(".extension-icon"),
        );
        await expect(details).toBeVisible();
        await region
          .getByRole("button", { name: "Close extension details", exact: true })
          .click();
        await expect(reportToggle).toBeFocused();
      }
      await expect(reportToggle).toHaveAttribute("aria-expanded", "false");
      await expect(details).toHaveCount(0);
      const summary = reportCard.locator(".extension-card__summary");
      const summaryBounds = await summary.boundingBox();
      if (!summaryBounds) throw new Error("Card summary has no bounds");
      await reportCard.click({
        position: { x: 8, y: summaryBounds.height - 8 },
      });
      await expect(reportToggle).toHaveAttribute("aria-expanded", "true");
      await region
        .getByRole("button", { name: "Close extension details", exact: true })
        .click();
      await expect(reportToggle).toBeFocused();
      await expect(details).toHaveCount(0);
      await page.keyboard.press("Enter");
      await expect(details).toBeVisible();
      await region
        .getByRole("button", { name: "Close extension details", exact: true })
        .focus();
      await page.keyboard.press("Escape");
      await expect(details).toHaveCount(0);
      await expect(reportToggle).toBeFocused();
      expect(await region.locator("img").count()).toBeGreaterThanOrEqual(3);
      await expectPageFits(region);
      expect(
        (
          await new AxeBuilder({ page })
            .include('[aria-label="App extensions"]')
            .analyze()
        ).violations,
      ).toEqual([]);
      fs.mkdirSync("artifacts/extensions-page-ui-review", { recursive: true });
      await page.screenshot({
        path: `artifacts/extensions-page-ui-review/catalog-${appearance}-${viewport.width}.png`,
        animations: "disabled",
      });

      const search = region.getByRole("textbox", {
        name: "Search extensions",
        exact: true,
      });
      await search.fill("claude");
      await expect(
        region.getByRole("article", { name: "Claude", exact: true }),
      ).toBeVisible();
      await expect(
        region.getByRole("article", { name: "Report tools", exact: true }),
      ).toHaveCount(0);
      await region
        .getByRole("button", { name: "View Claude", exact: true })
        .click();
      await expect(details).toContainText(/Preview only/i);
      await expect(
        details.getByRole("button", { name: "Install", exact: true }),
      ).toHaveCount(0);
      await expectPageFits(region);
      await page.screenshot({
        path: `artifacts/extensions-page-ui-review/claude-preview-${appearance}-${viewport.width}.png`,
        animations: "disabled",
      });
      await region
        .getByRole("button", { name: "Close extension details", exact: true })
        .click();
      await search.fill("");
      await categories
        .getByRole("button", { name: "Assistants", exact: true })
        .click();
      await expect(
        region.getByRole("article", { name: "ChatGPT", exact: true }),
      ).toBeVisible();
      await region
        .getByRole("button", { name: "View OpenCode", exact: true })
        .click();
      await expect(
        region
          .getByRole("article", { name: "OpenCode", exact: true })
          .getByRole("button", { name: "Open assistant", exact: true }),
      ).toBeEnabled();

      await categories
        .getByRole("button", { name: "Reports", exact: true })
        .click();
      await chooseState(page, region, "Available");
      await expect(
        region.getByRole("article", { name: "Report tools", exact: true }),
      ).toHaveCount(0);
      const ledgerCard = region.getByRole("article", {
        name: "Trade ledger export",
        exact: true,
      });
      await expect(details).toHaveCount(0);
      await ledgerCard
        .getByRole("button", { name: "Install", exact: true })
        .click();
      await expect(
        region.getByText(
          "Installed Trade ledger export. Review its commands before enabling.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(details).toHaveCount(0);
      await chooseState(page, region, "All states");
      await categories
        .getByRole("button", { name: "Installed", exact: true })
        .click();
      await region
        .getByRole("button", { name: "View Trade ledger export", exact: true })
        .click();
      await expect(
        region.getByRole("article", {
          name: "Trade ledger export",
          exact: true,
          includeHidden: true,
        }),
      ).toHaveCount(1);
      await expect(
        details.getByRole("button", { name: "Export CSV", exact: true }),
      ).toBeDisabled();
      await region
        .getByRole("button", { name: "Close extension details", exact: true })
        .click();
      await region
        .getByRole("article", { name: "Trade ledger export", exact: true })
        .getByRole("button", { name: "Activate", exact: true })
        .click();
      await expect(details).toHaveCount(0);
      await region
        .getByRole("button", { name: "View Trade ledger export", exact: true })
        .click();
      await expect(
        region
          .getByRole("article", { name: "Trade ledger export", exact: true })
          .getByRole("button", { name: "Disable", exact: true }),
      ).toBeEnabled();
      await expect(
        details.getByRole("button", { name: "Export CSV", exact: true }),
      ).toBeEnabled();
      await details
        .getByRole("button", { name: "Export CSV", exact: true })
        .click();
      await expect(
        region.getByText("Export canceled. No file was written.", {
          exact: true,
        }),
      ).toBeVisible();
      await expectPageFits(region);
      expect(
        (
          await new AxeBuilder({ page })
            .include('[aria-label="App extensions"]')
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({
        path: `artifacts/extensions-page-ui-review/installed-${appearance}-${viewport.width}.png`,
        animations: "disabled",
      });
      await region
        .getByRole("button", { name: "Back to workspace", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Extensions", exact: true }),
      ).toBeFocused();
      await expect(
        page.getByRole("textbox", { name: "Unsaved synthetic draft" }),
      ).toHaveValue("Unsaved synthetic editor draft — UI fixture only");
      expect(externalRequests).toEqual([]);
    });
  }
}

test("collapsed cards expose separate Install, Activate and Disable actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 640 });
  await page.goto("/tests/ui/fixtures/app-settings.html?theme=dark&empty");
  await page.getByRole("button", { name: "Extensions", exact: true }).click();
  const region = page.getByRole("region", {
    name: "App extensions",
    exact: true,
  });
  const details = region.getByRole("region", {
    name: "Extension details",
    exact: true,
  });
  const card = region.getByRole("article", {
    name: "Trade ledger export",
    exact: true,
  });
  const toggle = card.getByRole("button", {
    name: "View Trade ledger export",
    exact: true,
  });
  await card.getByRole("button", { name: "Install", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "Activate", exact: true }),
  ).toBeEnabled();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(details).toHaveCount(0);
  await card.getByRole("button", { name: "Activate", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "Disable", exact: true }),
  ).toBeEnabled();
  await expect(details).toHaveCount(0);
  await card.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "Activate", exact: true }),
  ).toBeEnabled();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(details).toHaveCount(0);
});

test("Extensions preserves the real editor, file shortcuts and original sidebar while navigating", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.addInitScript(() =>
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
    ),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Use example project", exact: true })
    .click();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 30000 });
  await expect(
    page.getByRole("textbox", {
      name: "Source of ExampleStrategy.cs",
      exact: true,
    }),
  ).toBeAttached();
  await page.locator(".monaco-editor").click({ position: { x: 160, y: 40 } });
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n// extensions retained draft\n");
  const editor = await page.locator(".monaco-editor").elementHandle();
  const rail = page.getByRole("navigation", { name: "Workspace areas" });
  const icons = await rail
    .locator("button svg")
    .evaluateAll((elements) => elements.map((element) => element.outerHTML));
  const labels = await rail
    .getByRole("button")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label")),
    );
  await rail.getByRole("button", { name: "Extensions", exact: true }).click();
  const region = page.getByRole("region", {
    name: "App extensions",
    exact: true,
  });
  await expect(region).toBeVisible();
  await expect(
    page.getByRole("banner", { name: "Window title bar" }),
  ).toBeVisible();
  await expect(page.locator(".workspace-header")).toBeHidden();
  await expect(page.locator(".workspace-main")).toBeHidden();
  await expect(
    rail.getByRole("button", { name: "Extensions", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  expect(
    await rail
      .locator("button svg")
      .evaluateAll((elements) => elements.map((element) => element.outerHTML)),
  ).toEqual(icons);
  expect(
    await rail
      .getByRole("button")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("aria-label")),
      ),
  ).toEqual(labels);
  await region
    .getByRole("textbox", { name: "Search extensions", exact: true })
    .fill("Claude");
  await region
    .getByRole("button", { name: "View Claude", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    region.getByRole("region", { name: "Extension details" }),
  ).toContainText(/Preview only/i);
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+w");
  await region
    .getByRole("button", { name: "Back to workspace", exact: true })
    .click();
  await expect(
    rail.getByRole("button", { name: "Extensions", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("tab", { name: /ExampleStrategy.cs.*Unsaved changes/ }),
  ).toBeVisible();
  expect(await editor!.evaluate((element) => element.isConnected)).toBe(true);
  const storedSource = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("dotatel-workspace-browser-preview-v1")!)
        .documents["ExampleStrategy.cs"].content,
  );
  expect(storedSource).not.toContain("extensions retained draft");
  await expect(page.locator(".workspace-header")).toBeVisible();
});

test("compact cards open a right inspector and restore trigger focus when dismissed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 640 });
  await page.goto("/tests/ui/fixtures/app-settings.html?theme=dark");
  await page.getByRole("button", { name: "Extensions", exact: true }).click();
  const region = page.getByRole("region", {
    name: "App extensions",
    exact: true,
  });
  const details = region.getByRole("region", {
    name: "Extension details",
    exact: true,
  });
  const toggle = region.getByRole("button", {
    name: "View Claude",
    exact: true,
    includeHidden: true,
  });
  const close = region.getByRole("button", {
    name: "Close extension details",
    exact: true,
  });
  await expect(details).toHaveCount(0);
  await toggle.focus();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(details).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(close).toBeFocused();
  await expectRightInspector(region, 800);
  await expect(region.locator(".extensions-main")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Space");
  await expect(details).toBeVisible();
  await expect(close).toBeFocused();
  await close.click();
  await expect(toggle).toBeFocused();
  await expect(details).toHaveCount(0);
  await toggle.click();
  await region
    .getByRole("navigation", { name: "Extension categories" })
    .getByRole("button", { name: "Reports", exact: true })
    .click();
  await expect(details).toHaveCount(0);
  await expect
    .poll(() =>
      region
        .locator(".extensions-main")
        .evaluate((element) => element.scrollTop),
    )
    .toBe(0);
  await expect(
    region.getByRole("textbox", { name: "Search extensions", exact: true }),
  ).toBeInViewport();
});

test("compact export cancellation stays in the active inspector without duplicate feedback", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 640 });
  await page.goto("/tests/ui/fixtures/app-settings.html?theme=dark");
  await page.getByRole("button", { name: "Extensions", exact: true }).click();
  const region = page.getByRole("region", {
    name: "App extensions",
    exact: true,
  });
  const card = region.getByRole("article", {
    name: "Report tools",
    exact: true,
  });
  await card.getByRole("button", { name: "Activate", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "Disable", exact: true }),
  ).toBeEnabled();
  await card
    .getByRole("button", { name: "View Report tools", exact: true })
    .click();
  const inspector = region.getByRole("complementary", {
    name: "Extension inspector",
  });
  await inspector
    .getByRole("button", { name: "Export JSON", exact: true })
    .click();
  const message = inspector.getByRole("status");
  await expect(message).toHaveText("Export canceled. No file was written.");
  await expect(message).toBeInViewport();
  await expect(region.locator('[role="status"]')).toHaveCount(1);
  await expect(region.locator('.extensions-main [role="status"]')).toHaveCount(
    0,
  );
  await inspector
    .getByRole("button", { name: "Close extension details", exact: true })
    .click();
  await expect(inspector).toHaveCount(0);
  await expect(region.locator('.extensions-main [role="status"]')).toHaveText(
    "Export canceled. No file was written.",
  );
  await expect(region.locator('[role="status"]')).toHaveCount(1);
});

test("Extensions keeps report navigation unavailable until a project is open", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 640 });
  await page.addInitScript(() =>
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
    ),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Use example project", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Workspace areas" })
    .getByRole("button", { name: "Extensions", exact: true })
    .click();
  const region = page.getByRole("region", {
    name: "App extensions",
    exact: true,
  });
  await region
    .getByRole("button", { name: "View Report tools", exact: true })
    .click();
  const goToReports = region
    .getByRole("region", { name: "Extension details" })
    .getByRole("button", { name: "Go to Reports", exact: true });
  await expect(goToReports).toBeDisabled();
  await expect(goToReports).toHaveAttribute(
    "title",
    "Open a project to review its saved runs",
  );
  await expect(region).toBeVisible();
  await region
    .getByRole("button", { name: "Back to workspace", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Use example project", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Reports stage", exact: true }),
  ).toHaveCount(0);
});
