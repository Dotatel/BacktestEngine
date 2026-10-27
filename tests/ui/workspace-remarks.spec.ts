import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";

/** Enter the real workspace with its isolated preview store and locally bundled Monaco. */
async function openWorkspace(page: Page, appearance = "dark") {
  await page.addInitScript(
    (appearance) =>
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
      ),
    appearance,
  );
  await page.goto("/");
  await expect(
    page.getByRole("menubar", { name: "Application menu" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Use example project", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", {
      name: "Source of ExampleStrategy.cs",
      exact: true,
    }),
  ).toBeAttached({ timeout: 30_000 });
}

/** Open a top-level application menu through its public accessible name. */
async function menu(page: Page, name: string) {
  await page
    .getByRole("menubar", { name: "Application menu" })
    .getByRole("menuitem", { name, exact: true })
    .click();
}

/** Create a real preview document through File rather than a private model mutation. */
async function addFile(page: Page, name: string) {
  await menu(page, "File");
  await page.getByRole("menuitem", { name: /^New file/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: `Source of ${name}`, exact: true }),
  ).toBeAttached({ timeout: 30_000 });
}

for (const appearance of ["dark", "light"]) {
  for (const width of [800, 1440]) {
    test(`workspace remarks layout ${appearance} ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await openWorkspace(page, appearance);
      const bar = page.getByRole("menubar", { name: "Application menu" });
      for (const name of ["File", "Edit", "View", "Window", "Help"])
        await expect(
          bar.getByRole("menuitem", { name, exact: true }),
        ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Markets", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Data", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Strategy", exact: true }),
      ).toBeDisabled();
      expect(
        await page
          .locator(".explorer-tree")
          .evaluate(
            (element) =>
              element.scrollHeight > element.clientHeight + 1 ||
              element.scrollWidth > element.clientWidth + 1,
          ),
      ).toBe(false);
      await menu(page, "Help");
      await page
        .getByRole("menuitem", { name: "Keyboard shortcuts", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toContainText("Ctrl+W");
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(result.violations).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
      fs.mkdirSync("artifacts/workspace-remarks-ui-review", {
        recursive: true,
      });
      await page.screenshot({
        path: `artifacts/workspace-remarks-ui-review/workspace-${appearance}-${width}.png`,
        fullPage: true,
      });
    });
  }
}

test("Edit Find keeps keyboard focus in Monaco after the caption menu closes", async ({
  page,
}) => {
  await openWorkspace(page);
  await menu(page, "Edit");
  await page.getByRole("menuitem", { name: /^Find\s/ }).click();
  const find = page.getByRole("textbox", { name: "Find", exact: true });
  await expect(find).toBeVisible();
  await expect(find).toBeFocused();
  await page.keyboard.type("VolumeMultiplier");
  await expect(find).toHaveValue("VolumeMultiplier");
});

test("rapid editor input is not overwritten by caption or draft-state updates", async ({
  page,
}) => {
  await openWorkspace(page);
  await addFile(page, "RapidTyping.cs");
  const editor = page.getByRole("textbox", {
    name: "Source of RapidTyping.cs",
    exact: true,
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.locator(".monaco-editor").click({ position: { x: 130, y: 40 } });
    await page.keyboard.press("Control+a");
    const text = `// rapid input ${attempt}: 0123456789 abcdefghijklmnopqrstuvwxyz`;
    await page.keyboard.type(text);
    await expect(page.locator(".view-lines")).toHaveText(text, {
      useInnerText: true,
    });
    await page.keyboard.press("Control+s");
    await expect(
      page.getByText("All changes saved", { exact: true }),
    ).toBeVisible();
    await expect(editor).toBeAttached();
  }
});

test("File and tab context actions protect dirty files and close the chosen set", async ({
  page,
}) => {
  await openWorkspace(page);
  await addFile(page, "Second.cs");
  await addFile(page, "Third.cs");
  await page.getByRole("tab", { name: "Second.cs", exact: true }).click();
  await page.locator(".monaco-editor").click({ position: { x: 130, y: 40 } });
  await page.keyboard.type("// preserve this draft");
  await page.getByRole("tab", { name: "Third.cs", exact: true }).click();
  await page
    .getByRole("tab", { name: "Third.cs", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Close Others", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("unsaved changes");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: /^Second.cs/ })).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Third.cs", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page
    .getByRole("tab", { name: "Third.cs", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Close Others", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save all selected and close", exact: true })
    .click();
  await expect(page.getByRole("tab")).toHaveCount(3); // One file tab plus Problems and Output.
  await expect(
    page.getByRole("tab", { name: "Third.cs", exact: true }),
  ).toBeVisible();
  await menu(page, "File");
  await page
    .getByRole("menuitem", { name: "Close all editors", exact: true })
    .click();
  await expect(page.getByText("No files open", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Close .*\.cs$/ }),
  ).toHaveCount(0);
});

test("Ctrl+W and per-tab close preserve the active document on inactive closure", async ({
  page,
}) => {
  await openWorkspace(page);
  await addFile(page, "Other.cs");
  await page
    .getByRole("button", { name: "Close ExampleStrategy.cs", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Other.cs", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+w");
  await expect(page.getByText("No files open", { exact: true })).toBeVisible();
});
