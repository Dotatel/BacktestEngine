import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";

// Browser-only synthetic bridges. No OpenCode service, provider session or model prompt is involved.
for (const appearance of ["dark", "light"]) {
  for (const width of [380, 800]) {
    test(`synthetic assistant review ${appearance} ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/");
      await page.evaluate(
        async ({ appearance }) => {
          const reactUrl = "/node_modules/.vite/deps/react.js",
            domUrl = "/node_modules/.vite/deps/react-dom_client.js",
            componentUrl = "/src/features/assistant/AssistantPanel.tsx";
          const [React, Dom, component] = await Promise.all([
            import(reactUrl),
            import(domUrl),
            import(componentUrl),
          ]);
          const model = { providerId: "opencode", id: "glm-5.3-flash-free" };
          let record = {
            id: "synthetic-local-conversation",
            title: "Synthetic UI review only",
            revision: 0,
            updatedAt: "2026-10-24T12:00:00Z",
            draft: {
              message:
                "Explain the supplied build diagnostic. This is a synthetic UI review, with no provider execution.",
              context: [
                {
                  label: "Synthetic build diagnostic",
                  text: "CS0103: synthetic identifier does not exist. No strategy source file is attached.",
                },
              ],
              model,
            },
            messages: [
              {
                id: "msg_synthetic",
                role: "assistant",
                text: "Synthetic proposal: inspect the named identifier and its scope. No compiler, engine or model was executed in this UI fixture.",
                status: "completed",
                createdAt: "2026-10-24T12:00:00Z",
                model,
              },
            ],
            preview: { text: "", sha256: "a".repeat(64) },
          };
          record.preview.text = `${record.draft.message}\n\n---\n[${record.draft.context[0].label}]\n${record.draft.context[0].text}`;
          const bridge = {
            native: true,
            load: async () => ({
              conversations: [
                {
                  id: record.id,
                  title: record.title,
                  updatedAt: record.updatedAt,
                },
              ],
              selected: record,
              busy: false,
              cancellationUnconfirmed: false,
            }),
            status: async () => ({
              connected: true,
              version: "synthetic-only",
              toolsDisabledVerified: true,
              models: [
                {
                  model,
                  name: "Synthetic zero-cost model",
                  checkedAt: record.updatedAt,
                  zeroCostVerified: true,
                },
              ],
              problem: null,
            }),
            saveDraft: async (
              _id: string,
              revision: number,
              draft: typeof record.draft,
            ) => {
              record = {
                ...record,
                revision: revision + 1,
                draft,
                preview: {
                  text: `${draft.message}\n\n---\n[${draft.context[0].label}]\n${draft.context[0].text}`,
                  sha256: "b".repeat(64),
                },
              };
              return record;
            },
            newConversation: async () => record,
            send: async () => {
              throw new Error("This synthetic review never sends.");
            },
            cancel: async () => ({
              status: "idle",
              conversation: record,
              cancellationUnconfirmed: false,
              problem: null,
            }),
          };
          document.documentElement.classList.toggle(
            "dark",
            appearance === "dark",
          );
          const prior = document.getElementById("root");
          if (prior) prior.style.display = "none";
          const host = document.createElement("main");
          host.style.height = "100dvh";
          document.body.append(host);
          const ReactApi = React.default ?? React,
            DomApi = Dom.default ?? Dom;
          DomApi.createRoot(host).render(
            ReactApi.createElement(component.AssistantPanel, { bridge }),
          );
          await document.fonts.ready;
        },
        { appearance },
      );
      await expect(
        page.getByText("Synthetic UI review only", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Connect OpenCode" }).click();
      const violations = await new AxeBuilder({ page })
        .include(".assistant-panel")
        .analyze();
      expect(violations.violations).toEqual([]);
      expect(
        await page
          .locator(".assistant-panel")
          .evaluate((element) => element.scrollWidth > element.clientWidth + 1),
      ).toBe(false);
      fs.mkdirSync("artifacts/assistant-ui-review", { recursive: true });
      await page.screenshot({
        path: `artifacts/assistant-ui-review/synthetic-${appearance}-${width}.png`,
        animations: "disabled",
      });
      await page.getByRole("button", { name: "Review outgoing text" }).click();
      await page
        .getByRole("button", { name: "Send reviewed text" })
        .scrollIntoViewIfNeeded();
      await expect(
        page.getByRole("heading", { name: "Exact outgoing application text" }),
      ).toBeVisible();
      await expect(page.locator(".assistant-preview")).toContainText(
        "Explain the supplied build diagnostic.",
      );
      await expect(page.locator(".assistant-preview")).toContainText(
        "CS0103: synthetic identifier does not exist.",
      );
      const reviewViolations = await new AxeBuilder({ page })
        .include(".assistant-panel")
        .analyze();
      expect(reviewViolations.violations).toEqual([]);
      await page.screenshot({
        path: `artifacts/assistant-ui-review/synthetic-preview-${appearance}-${width}.png`,
        animations: "disabled",
      });
    });
  }
}
