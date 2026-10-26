import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";

// Explicit synthetic dependency-injected presentation evidence; this is not native acceptance.
for (const appearance of ["dark", "light"]) {
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 800, height: 640 },
  ]) {
    test(`synthetic Settings and Extensions ${appearance} ${viewport.width}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
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
      await expect(
        settings.getByRole("button", { name: "Choose folder" }),
      ).toBeEnabled();
      expect(
        (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
          .violations,
      ).toEqual([]);
      expect(
        await settings.evaluate(
          (element) => element.scrollWidth > element.clientWidth + 1,
        ),
      ).toBe(false);
      fs.mkdirSync("artifacts/settings-extensions-ui-review", {
        recursive: true,
      });
      await page.screenshot({
        path: `artifacts/settings-extensions-ui-review/synthetic-settings-${appearance}-${viewport.width}.png`,
        animations: "disabled",
      });
      await settings.getByRole("tab", { name: "Updates" }).click();
      await expect(
        settings.getByRole("button", { name: "Check now" }),
      ).toBeDisabled();
      await settings
        .getByRole("combobox", { name: "Manual release checks" })
        .click();
      await page
        .getByRole("option", { name: "Enabled — manual only", exact: true })
        .click();
      await settings.getByRole("button", { name: "Check now" }).click();
      await expect(
        settings.getByText(/No public release information available/),
      ).toBeVisible();
      expect(
        (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
          .violations,
      ).toEqual([]);
      await page.screenshot({
        path: `artifacts/settings-extensions-ui-review/synthetic-updates-unavailable-${appearance}-${viewport.width}.png`,
        animations: "disabled",
      });
      await settings.getByRole("button", { name: "Done", exact: true }).click();
      await expect(
        page.getByRole("textbox", { name: "Unsaved synthetic draft" }),
      ).toHaveValue("Unsaved synthetic editor draft — UI fixture only");
      await page
        .getByRole("button", { name: "Extensions", exact: true })
        .click();
      const extensions = page.getByRole("dialog", {
        name: "App extensions · experimental",
      });
      await expect(
        extensions.getByRole("article", { name: "Report tools", exact: true }),
      ).toBeVisible();
      await expect(
        extensions.getByRole("button", { name: "Export JSON", exact: true }),
      ).toBeDisabled();
      await extensions
        .getByRole("button", { name: "Enable", exact: true })
        .click();
      await expect(
        extensions.getByRole("button", { name: "Export JSON", exact: true }),
      ).toBeEnabled();
      expect(
        (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
          .violations,
      ).toEqual([]);
      expect(
        await extensions.evaluate(
          (element) => element.scrollWidth > element.clientWidth + 1,
        ),
      ).toBe(false);
      await page.screenshot({
        path: `artifacts/settings-extensions-ui-review/synthetic-extensions-${appearance}-${viewport.width}.png`,
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await expect(extensions).not.toBeVisible();
      await expect(
        page.getByRole("button", { name: "Extensions", exact: true }),
      ).toBeFocused();
    });
  }
}

test("browser workspace settings preserve the real editor draft and completion state while changing theme/style", async ({
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
  await page.keyboard.insertText("\n// settings retained draft\n");
  await expect(
    page.getByRole("tab", { name: /ExampleStrategy.cs.*Unsaved changes/ }),
  ).toBeVisible();
  const editor = await page.locator(".monaco-editor").elementHandle();
  await page
    .getByRole("button", { name: "Workspace settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Workspace settings",
    exact: true,
  });
  await settings
    .getByRole("combobox", { name: "Appearance", exact: true })
    .click();
  await page.getByRole("option", { name: "Light", exact: true }).click();
  await settings
    .getByRole("combobox", { name: "Workspace style", exact: true })
    .click();
  await page.getByRole("option", { name: "Simple", exact: true }).click();
  await page.keyboard.press("Control+s");
  await settings.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Show parameters", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: /ExampleStrategy.cs.*Unsaved changes/ }),
  ).toBeVisible();
  expect(await editor!.evaluate((element) => element.isConnected)).toBe(true);
  const stored = await page.evaluate(() => ({
    preferences: JSON.parse(
      localStorage.getItem("dotatel-onboarding-browser-preview-v1")!,
    ),
    source: JSON.parse(
      localStorage.getItem("dotatel-workspace-browser-preview-v1")!,
    ).documents["ExampleStrategy.cs"].content,
  }));
  expect(stored.preferences).toMatchObject({
    completed: true,
    step: 5,
    appearance: "light",
    workspaceStyle: "simple",
  });
  expect(stored.source).not.toContain("settings retained draft");
  await page
    .getByRole("button", { name: "Workspace settings", exact: true })
    .click();
  await settings
    .getByRole("combobox", { name: "Workspace style", exact: true })
    .click();
  await page.getByRole("option", { name: "Advanced", exact: true }).click();
  await settings.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Hide parameters", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: /ExampleStrategy.cs.*Unsaved changes/ }),
  ).toBeVisible();
});
