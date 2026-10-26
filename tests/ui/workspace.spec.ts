import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** Enter the completed-setup route with isolated browser preferences; desktop persistence is tested separately. */
async function openBuild(page: Page, appearance = "dark") {
  await page.addInitScript((appearance) => {
    if (!localStorage.getItem("dotatel-onboarding-browser-preview-v1"))
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
  }, appearance);
  await page.goto("/");
  await expect(
    page.getByRole("region", { name: "Build workspace" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Use example project", exact: true })
    .click();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 30000 });
  await expect(sourceEditor(page)).toBeAttached();
}

/** Target Monaco through its public accessible label rather than a hidden model/debug API. */
function sourceEditor(page: Page) {
  return page.getByRole("textbox", {
    name: "Source of ExampleStrategy.cs",
    exact: true,
  });
}

/** Make a genuine keyboard edit in the active source buffer. */
async function editExample(page: Page, comment: string) {
  await page.locator(".monaco-editor").click({ position: { x: 160, y: 40 } });
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(`\n// ${comment}\n`);
  await expect(
    page.getByRole("tab", { name: /ExampleStrategy.cs.*Unsaved changes/ }),
  ).toBeVisible();
}

/** Inspect this explicitly labeled browser preview's durable fixture, never native user source. */
async function storedExample(page: Page) {
  return page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("dotatel-workspace-browser-preview-v1")!)
        .documents["ExampleStrategy.cs"].content as string,
  );
}

test("keyboard editing and saving survive a reload without external assets", async ({
  page,
}) => {
  const errors: string[] = [];
  const external: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      /^https?:/.test(request.url()) &&
      !request.url().startsWith("http://127.0.0.1:1420")
    )
      external.push(request.url());
  });
  await openBuild(page);
  await editExample(page, "persisted by UI keyboard save");
  await page.keyboard.press("Control+s");
  await expect
    .poll(() => storedExample(page))
    .toContain("persisted by UI keyboard save");
  await expect(page.getByRole("tab", { name: /Unsaved changes/ })).toHaveCount(
    0,
  );
  await page.reload();
  await expect(page.locator(".monaco-editor")).toBeVisible();
  expect(await storedExample(page)).toContain("persisted by UI keyboard save");
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("project files can be created, renamed and moved through labeled dialogs", async ({
  page,
}) => {
  await openBuild(page);
  await page
    .getByRole("button", { name: "New folder in project root", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("textbox").fill("Strategies");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("treeitem", { name: "Strategies", exact: true }).click();
  await page
    .getByRole("button", { name: "New file in Strategies", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("textbox").fill("Helper.cs");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Helper.cs", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Explorer actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Rename selected item", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "New name", exact: true })
    .fill("Renamed.cs");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Rename", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Renamed.cs", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Explorer actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Move selected item", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Destination", exact: true })
    .click();
  await page.getByRole("option", { name: "Project root", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Move", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(
          JSON.parse(
            localStorage.getItem("dotatel-workspace-browser-preview-v1")!,
          ).documents,
        ),
      ),
    )
    .toContain("Renamed.cs");
  await expect(
    page.getByRole("treeitem", { name: "Renamed.cs", exact: true }),
  ).toBeVisible();
});

test("dragging a file into a folder uses the real move flow", async ({
  page,
}) => {
  await openBuild(page);
  await page
    .getByRole("button", { name: "New folder in project root", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("textbox").fill("Strategies");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const source = page
    .getByRole("treeitem", { name: "ExampleStrategy.cs", exact: true })
    .locator(".explorer-node");
  const target = page
    .getByRole("treeitem", { name: "Strategies", exact: true })
    .locator(".explorer-node");
  await source.dragTo(target);
  const dialog = page.getByRole("dialog", {
    name: "Move ExampleStrategy.cs",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Destination" }),
  ).toContainText("Strategies");
  await dialog.getByRole("button", { name: "Move", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const store = JSON.parse(
          localStorage.getItem("dotatel-workspace-browser-preview-v1")!,
        );
        return (
          Boolean(store.documents["Strategies/ExampleStrategy.cs"]) &&
          !store.documents["ExampleStrategy.cs"]
        );
      }),
    )
    .toBe(true);
  await expect(
    page.getByRole("tab", { name: "ExampleStrategy.cs", exact: true }),
  ).toBeVisible();
});

test("closing an unsaved tab requires a real save or explicit discard", async ({
  page,
}) => {
  await openBuild(page);
  const before = await storedExample(page);
  await editExample(page, "draft that must survive cancel");
  await page
    .getByRole("button", { name: "Close ExampleStrategy.cs", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("unsaved changes");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: /Unsaved changes/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close ExampleStrategy.cs", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: /ExampleStrategy/ })).toHaveCount(
    0,
  );
  expect(await storedExample(page)).toBe(before);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(result.violations).toEqual([]);
});

test("a failed write keeps the draft available for retry", async ({ page }) => {
  await openBuild(page);
  const before = await storedExample(page);
  await editExample(page, "retryable draft");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value(key: string, value: string) {
        if (key === "dotatel-workspace-browser-preview-v1")
          throw new Error("Test storage is full. Retry saving.");
        original.call(this, key, value);
      },
    });
    (
      window as Window & { restoreWorkspaceStorage?: () => void }
    ).restoreWorkspaceStorage = () =>
      Object.defineProperty(Storage.prototype, "setItem", {
        configurable: true,
        value: original,
      });
  });
  await page.getByRole("button", { name: "Save all", exact: true }).click();
  await expect(
    page
      .getByText("Test storage is full. Retry saving.", { exact: true })
      .first(),
  ).toBeVisible();
  expect(await storedExample(page)).toBe(before);
  await expect(
    page.getByRole("tab", { name: /Unsaved changes/ }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as Window & { restoreWorkspaceStorage?: () => void }
    ).restoreWorkspaceStorage?.(),
  );
  await page.getByRole("button", { name: "Save all", exact: true }).click();
  await expect.poll(() => storedExample(page)).toContain("retryable draft");
});

test("the browser reports compiler limitations instead of fabricated success", async ({
  page,
}) => {
  await openBuild(page);
  await page
    .locator(".workspace-header__actions")
    .getByRole("button", { name: "Build", exact: true })
    .click();
  await expect(
    page.getByText(/This browser preview does not execute C#/),
  ).toBeVisible();
  await expect(page.getByText("Build ready", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "Strategy parameters" }),
  ).toContainText("No reflected parameters yet");
});

for (const appearance of ["dark", "light"]) {
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1024, height: 720 },
    { width: 800, height: 640 },
  ]) {
    test(`workspace is usable and accessible in ${appearance} at ${viewport.width}x${viewport.height}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await openBuild(page, appearance);
      await page.setViewportSize(viewport);
      await expect(page.locator(".monaco-editor")).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        width: innerWidth,
        content: document.documentElement.scrollWidth,
      }));
      expect(dimensions.content).toBeLessThanOrEqual(dimensions.width);
      const explorer = page.getByRole("complementary", {
        name: "Project explorer",
      });
      await expect(explorer).toBeInViewport();
      expect((await explorer.boundingBox())!.width).toBeGreaterThanOrEqual(180);
      const explorerBounds = (await explorer.boundingBox())!;
      for (const control of await explorer.getByRole("button").all()) {
        const bounds = (await control.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(explorerBounds.x);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(
          explorerBounds.x + explorerBounds.width,
        );
      }
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(result.violations, JSON.stringify(result.violations)).toEqual([]);
      await page.screenshot({
        path: info.outputPath(`workspace-${appearance}-${viewport.width}.png`),
        animations: "disabled",
      });
    });
  }
}
