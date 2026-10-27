import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

for (const appearance of ["dark", "light"]) {
  for (const width of [800, 1440]) {
    test(`application menu ${appearance} ${width}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 700 });
      await page.goto("/");
      await page.evaluate(async (appearance) => {
        const reactUrl = "/node_modules/.vite/deps/react.js";
        const domUrl = "/node_modules/.vite/deps/react-dom_client.js";
        const componentUrl = "/src/components/TitleBar.tsx";
        const [React, Dom, component] = await Promise.all([
          import(reactUrl),
          import(domUrl),
          import(componentUrl),
        ]);
        const ReactApi = React.default ?? React;
        const DomApi = Dom.default ?? Dom;
        const prior = document.getElementById("root");
        if (prior) prior.style.display = "none";
        document.documentElement.classList.toggle(
          "dark",
          appearance === "dark",
        );
        const host = document.createElement("div");
        host.id = "menu-review";
        host.className = "app-shell app-shell--workspace";
        host.style.height = "100dvh";
        host.style.display = "flex";
        host.style.flexDirection = "column";
        document.body.append(host);
        /** Explicit synthetic callbacks prove menu interaction only; they never edit files or manipulate a native window. */
        function Fixture() {
          const [explorer, setExplorer] = ReactApi.useState(true);
          return ReactApi.createElement(
            ReactApi.Fragment,
            null,
            ReactApi.createElement(component.TitleBar, {
              bridge: {
                native: true,
                observeMaximized: async () => () => {},
                minimize: async () => {
                  host.dataset.windowAction = "minimize";
                },
                toggleMaximize: async () => {},
                close: async () => {},
                startDragging: async () => {
                  host.dataset.dragged = "true";
                },
              },
              onError: (message: string) => {
                host.dataset.error = message;
              },
              menu: {
                actions: {
                  save: {
                    enabled: true,
                    shortcut: "Ctrl+S",
                    run: () => {
                      host.dataset.action = "save";
                    },
                  },
                  toggleExplorer: {
                    enabled: true,
                    run: () => setExplorer((visible: boolean) => !visible),
                  },
                },
                view: { explorer, parameters: false, assistant: false },
              },
            }),
            ReactApi.createElement(
              "main",
              { style: { padding: "16px" } },
              ReactApi.createElement("h1", null, "Application menu review"),
              ReactApi.createElement(
                "p",
                null,
                "Synthetic callbacks only. No native window, editor or engine operation is executed.",
              ),
            ),
          );
        }
        DomApi.createRoot(host).render(ReactApi.createElement(Fixture));
        await document.fonts.ready;
      }, appearance);
      const caption = page
        .getByRole("banner", { name: "Window title bar" })
        .last();
      await expect(caption.getByRole("menubar")).toBeVisible();
      await expect(page.locator("#menu-review")).toHaveCSS(
        "background-image",
        "none",
      );
      await expect(caption.getByRole("menubar")).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await expect(caption.getByRole("menubar")).toHaveCSS(
        "border-top-color",
        "rgba(0, 0, 0, 0)",
      );
      expect(
        await caption
          .getByRole("menubar")
          .evaluate((element) => getComputedStyle(element).boxShadow),
      ).toMatch(
        /^(?:none|rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(?:, rgba\(0, 0, 0, 0\) 0px 0px 0px 0px)*)$/,
      );
      await page.keyboard.press("Alt+f");
      const fileMenu = page.getByRole("menu", { name: "File", exact: true });
      await expect(fileMenu).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
      expect(
        await fileMenu.evaluate(
          (element) => getComputedStyle(element).boxShadow,
        ),
      ).toMatch(
        /^(?:none|rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(?:, rgba\(0, 0, 0, 0\) 0px 0px 0px 0px)*)$/,
      );
      expect(
        await fileMenu.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        ),
      ).not.toBe("rgba(0, 0, 0, 0)");
      await expect(
        page.getByRole("menuitem", { name: "Save Ctrl+S", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("#menu-review")).toHaveAttribute(
        "data-action",
        "save",
      );
      await page.keyboard.press("Alt+v");
      await expect(
        page.getByRole("menuitemcheckbox", { name: "Explorer" }),
      ).toBeChecked();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Alt+v");
      await expect(
        page.getByRole("menuitemcheckbox", { name: "Explorer" }),
      ).not.toBeChecked();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Alt+h");
      await page.getByRole("menuitem", { name: "Keyboard shortcuts" }).click();
      await expect(
        page.getByRole("dialog", { name: "Keyboard shortcuts" }),
      ).toBeVisible();
      await expect(
        page.getByText(
          "Editor shortcuts apply while the code editor is focused.",
        ),
      ).toBeVisible();
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Alt+w");
      await page
        .getByRole("menuitem", { name: "Minimize", exact: true })
        .click();
      await expect(page.locator("#menu-review")).toHaveAttribute(
        "data-window-action",
        "minimize",
      );
      await expect(page.locator("#menu-review")).not.toHaveAttribute(
        "data-dragged",
        "true",
      );
      await page.keyboard.press("Alt+f");
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
      await page.screenshot({
        path: testInfo.outputPath(`${appearance}-${width}.png`),
        fullPage: true,
      });
    });
  }
}
