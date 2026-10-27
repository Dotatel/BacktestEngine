import { useEffect } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { EditorWorkspace } from "./EditorWorkspace";
import { useWorkspaceDocuments } from "../hooks/useWorkspaceDocuments";
import {
  tabPaths,
  tabProject,
  tabsBridge,
} from "../hooks/workspace-tabs.test-support";

// Source rendering is injected here; browser coverage separately uses the actual locally bundled Monaco editor.
vi.mock("./CodeEditor", () => ({
  default: () => <div>Synthetic editor surface</div>,
}));

/** Mount actual tab controls and document selection while isolating the heavyweight editor from unit tests. */
function TabsFixture({
  onClose,
  onCloseTabs,
}: {
  onClose: (path: string) => void;
  onCloseTabs: (paths: string[]) => void;
}) {
  const documents = useWorkspaceDocuments(fixtureBridge);
  const restore = documents.restore;
  useEffect(() => {
    void restore(tabPaths, "B.cs");
  }, [restore]);
  return (
    <EditorWorkspace
      root={tabProject.root}
      documents={documents}
      dark
      onCloseTab={onClose}
      onCloseTabs={onCloseTabs}
      onSave={() => {}}
    />
  );
}
const fixtureBridge = tabsBridge();

test("every file has its own close button and an inactive close does not activate the file", async () => {
  const onClose = vi.fn();
  render(<TabsFixture onClose={onClose} onCloseTabs={vi.fn()} />);
  await screen.findByRole("tab", { name: "A.cs" });
  expect(
    screen.getAllByRole("button", { name: /^Close [ABC]\.cs$/ }),
  ).toHaveLength(3);
  for (const close of screen.getAllByRole("button", {
    name: /^Close [ABC]\.cs$/,
  })) {
    expect(close.closest('[role="tablist"]')).toBeNull();
    expect(close.closest('[role="tab"]')).toBeNull();
  }
  await userEvent.click(screen.getByRole("button", { name: "Close A.cs" }));
  expect(onClose).toHaveBeenCalledWith("A.cs");
  expect(screen.getByRole("tab", { name: "B.cs" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test.each([
  ["Close Others", ["A.cs", "C.cs"]],
  ["Close to Right", ["C.cs"]],
  ["Close All", tabPaths],
])(
  "context action %s uses the clicked tab's displayed order",
  async (action, paths) => {
    const onCloseTabs = vi.fn();
    render(<TabsFixture onClose={vi.fn()} onCloseTabs={onCloseTabs} />);
    fireEvent.contextMenu(await screen.findByRole("tab", { name: "B.cs" }), {
      clientX: 80,
      clientY: 40,
    });
    await userEvent.click(
      await screen.findByRole("menuitem", { name: action }),
    );
    expect(onCloseTabs).toHaveBeenCalledWith(paths);
  },
);

test("context Close targets an inactive tab and the final tab disables Close to Right", async () => {
  const onClose = vi.fn();
  render(<TabsFixture onClose={onClose} onCloseTabs={vi.fn()} />);
  fireEvent.contextMenu(await screen.findByRole("tab", { name: "C.cs" }), {
    clientX: 80,
    clientY: 40,
  });
  expect(
    await screen.findByRole("menuitem", { name: "Close to Right" }),
  ).toHaveAttribute("data-disabled");
  await userEvent.click(screen.getByRole("menuitem", { name: "Close" }));
  expect(onClose).toHaveBeenCalledWith("C.cs");
});

test("tab arrows retain selection and Delete uses the existing guarded per-file close action", async () => {
  const onClose = vi.fn();
  render(<TabsFixture onClose={onClose} onCloseTabs={vi.fn()} />);
  const tab = await screen.findByRole("tab", { name: "B.cs" });
  tab.focus();
  await userEvent.keyboard("{ArrowRight}");
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "C.cs" })).toHaveFocus(),
  );
  await userEvent.keyboard("{Delete}");
  expect(onClose).toHaveBeenCalledWith("C.cs");
});
