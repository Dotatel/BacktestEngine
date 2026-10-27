import { expect, test, type Locator, type Page } from "@playwright/test";

const longName =
  "StrategyWithAnIntentionallyLongDescriptiveNameForItsTradingRulesAndRiskLimits.cs";

/** Seed only an isolated browser-preview project; no native project/profile is opened. */
async function openExplorer(
  page: Page,
  files: string[],
  folders: string[] = [],
) {
  await page.addInitScript(
    ({ files, folders }) => {
      const root = "browser-preview://explorer-scroll-review";
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
      );
      localStorage.setItem(
        "dotatel-workspace-browser-preview-v1",
        JSON.stringify({
          version: 1,
          root,
          folders,
          documents: Object.fromEntries(
            files.map((path) => [
              path,
              {
                path,
                content: "// Explorer-only browser fixture",
                revision: "explorer-review-v1",
              },
            ]),
          ),
          session: {
            lastProject: root,
            activeFile: null,
            openFiles: [],
            presets: [],
          },
        }),
      );
    },
    { files, folders },
  );
  await page.goto("/");
  await expect(page.getByRole("tree", { name: "Project files" })).toBeVisible();
}

/** Inspect every actual scrolling ancestor inside Explorer instead of relying on scrollbar visibility. */
async function overflow(explorer: Locator) {
  return explorer.evaluate((element) =>
    [
      ...element.querySelectorAll<HTMLElement>(
        ".explorer-tree, .explorer-tree *",
      ),
    ]
      .filter((node) => /(auto|scroll)/.test(getComputedStyle(node).overflow))
      .map((node) => ({
        width: node.clientWidth,
        scrollWidth: node.scrollWidth,
        height: node.clientHeight,
        scrollHeight: node.scrollHeight,
        top: node.scrollTop,
      })),
  );
}

for (const width of [800, 1280]) {
  test(`few files and long labels fit Explorer at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 640 });
    await openExplorer(page, [longName, "Short.cs"]);
    const explorer = page.getByRole("complementary", {
      name: "Project explorer",
    });
    await expect(
      page.getByRole("treeitem", { name: longName, exact: true }),
    ).toBeVisible();
    await explorer.screenshot({ path: info.outputPath("few-files.png") });
    const metrics = await overflow(explorer);
    await info.attach("scroll-metrics", {
      body: JSON.stringify(metrics),
      contentType: "application/json",
    });
    expect(metrics.length).toBeGreaterThan(0);
    for (const metric of metrics) {
      expect(metric.scrollWidth).toBeLessThanOrEqual(metric.width + 1);
      expect(metric.scrollHeight).toBeLessThanOrEqual(metric.height + 1);
    }
    await expect(
      explorer.locator(".explorer-name").filter({ hasText: longName }),
    ).toHaveAttribute("title", longName);
    await explorer
      .getByRole("button", { name: "Explorer actions", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Collapse project explorer" }),
    ).toBeVisible();
  });
}

test("many files retain a working virtualized vertical scrollbar and keyboard navigation", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 800, height: 640 });
  await openExplorer(
    page,
    Array.from(
      { length: 100 },
      (_, index) => `Strategy${String(index).padStart(3, "0")}.cs`,
    ),
  );
  const tree = page.getByRole("tree", { name: "Project files" });
  const explorer = page.getByRole("complementary", {
    name: "Project explorer",
  });
  await expect
    .poll(async () =>
      (await overflow(explorer)).some(
        (item) => item.scrollHeight > item.height,
      ),
    )
    .toBe(true);
  await tree.focus();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("treeitem", { name: "Strategy099.cs", exact: true }),
  ).toBeVisible();
  expect((await overflow(explorer)).some((item) => item.top > 0)).toBe(true);
  await page.setViewportSize({ width: 800, height: 720 });
  await expect
    .poll(() =>
      tree.evaluate((element) =>
        Math.abs(element.clientHeight - element.parentElement!.clientHeight),
      ),
    )
    .toBeLessThanOrEqual(1);
  await tree.focus();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("treeitem", { name: "Strategy099.cs", exact: true }),
  ).toBeVisible();
  await explorer.screenshot({
    path: info.outputPath("many-files-scrolled.png"),
  });
});

test("folder drag handles and collapse actions survive the fitted viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 640 });
  await openExplorer(
    page,
    ["Short.cs", "Strategies/Nested.cs"],
    ["Strategies"],
  );
  const folder = page.getByRole("treeitem", {
    name: "Strategies",
    exact: true,
  });
  await folder.click();
  await expect(
    page.getByRole("treeitem", { name: "Nested.cs", exact: true }),
  ).toHaveCount(0);
  await folder.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("treeitem", { name: "Nested.cs", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("treeitem", { name: "Short.cs", exact: true })
    .locator(".explorer-node")
    .dragTo(
      page
        .getByRole("treeitem", { name: "Strategies", exact: true })
        .locator(".explorer-node"),
    );
  const move = page.getByRole("dialog", { name: "Move Short.cs", exact: true });
  await expect(move).toBeVisible();
  await move.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Explorer actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Collapse project explorer" })
    .click();
  await expect(
    page.getByRole("button", { name: "Show explorer", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() =>
      page
        .locator("#explorer")
        .evaluate((panel) => panel.getBoundingClientRect().width),
    )
    .toBeLessThanOrEqual(1);
  await page
    .getByRole("button", { name: "Show explorer", exact: true })
    .click();
  await expect
    .poll(() =>
      page
        .locator("#explorer")
        .evaluate((panel) => panel.getBoundingClientRect().width),
    )
    .toBeGreaterThanOrEqual(180);
});
