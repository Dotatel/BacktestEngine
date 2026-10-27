import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";

/** Seed only this browser's isolated preview documents; no native files, compiler or user profile is touched. */
async function openTabs(page: Page, appearance: string) {
  await page.addInitScript((appearance) => {
    const paths = ["A.cs", "B.cs", "C.cs"];
    const root = "browser-preview:/synthetic-tab-review";
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
            {
              path,
              content: `// Synthetic browser tab fixture ${path}\n`,
              revision: `synthetic-${path}`,
            },
          ]),
        ),
        session: {
          lastProject: root,
          activeFile: "B.cs",
          openFiles: paths,
          presets: [],
        },
      }),
    );
  }, appearance);
  await page.goto("/");
  await expect(
    page.getByRole("tab", { name: "B.cs", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("textbox", { name: "Source of B.cs", exact: true }),
  ).toBeAttached({ timeout: 30_000 });
}

for (const appearance of ["dark", "light"]) {
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 800, height: 640 },
  ]) {
    test(`browser-preview file tabs ${appearance} ${viewport.width}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await openTabs(page, appearance);
      await expect(
        page
          .locator(".file-tabs")
          .getByRole("button", { name: /^Close [ABC]\.cs$/ }),
      ).toHaveCount(3);
      expect(
        (await new AxeBuilder({ page }).include(".file-tabs").analyze())
          .violations,
      ).toEqual([]);
      await page.getByRole("tab", { name: "B.cs", exact: true }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(
        page.getByRole("tab", { name: "C.cs", exact: true }),
      ).toBeFocused();
      await page
        .getByRole("textbox", { name: "Source of C.cs", exact: true })
        .focus();
      await page.keyboard.press("Control+End");
      await page.keyboard.insertText("\n// draft preserved by bulk cancel\n");
      await expect(
        page.getByRole("tab", { name: /C.cs.*Unsaved changes/ }),
      ).toBeVisible();
      await page.getByRole("tab", { name: "B.cs", exact: true }).focus();
      await page.keyboard.press("Shift+F10");
      await expect(
        page.getByRole("menuitem", { name: "Close Others", exact: true }),
      ).toBeVisible();
      expect(
        (
          await new AxeBuilder({ page })
            .include(".file-tabs")
            .include('[data-slot="context-menu-content"]')
            .analyze()
        ).violations,
      ).toEqual([]);
      expect(
        await page
          .locator(".file-tabs")
          .evaluate((element) => element.scrollWidth > element.clientWidth + 1),
      ).toBe(false);
      fs.mkdirSync("artifacts/editor-tabs-review", { recursive: true });
      await page.screenshot({
        path: `artifacts/editor-tabs-review/browser-preview-tabs-${appearance}-${viewport.width}.png`,
        animations: "disabled",
      });
      await page
        .getByRole("menuitem", { name: "Close to Right", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toContainText("Close C.cs?");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await expect(
        page.getByRole("tab", { name: /C.cs.*Unsaved changes/ }),
      ).toBeVisible();
      await page
        .getByRole("tab", { name: "A.cs", exact: true })
        .click({ button: "right" });
      await page
        .getByRole("menuitem", { name: "Close Others", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toContainText("Close 2 tabs?");
      await page
        .getByRole("dialog")
        .getByRole("button", {
          name: "Save all selected and close",
          exact: true,
        })
        .click();
      await expect(page.locator(".file-tabs").getByRole("tab")).toHaveCount(1);
      await expect(
        page.getByRole("tab", { name: "A.cs", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            JSON.parse(
              localStorage.getItem("dotatel-workspace-browser-preview-v1")!,
            ).documents["C.cs"].content,
        ),
      ).toContain("draft preserved by bulk cancel");
      await page
        .getByRole("button", { name: "Close A.cs", exact: true })
        .click();
      await expect(
        page.getByText("No file is open.", { exact: true }),
      ).toBeVisible();
    });
  }
}
