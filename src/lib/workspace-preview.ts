import exampleSource from "../../engines/csharp/examples/ExampleStrategy.cs?raw";
import type {
  WorkspaceBridge,
  WorkspaceDocument,
  WorkspaceEntry,
  WorkspaceProject,
  WorkspaceSession,
} from "./workspace-contract";

const storageKey = "dotatel-workspace-browser-preview-v1";
const emptySession: WorkspaceSession = {
  lastProject: null,
  activeFile: null,
  openFiles: [],
  presets: [],
};

interface PreviewStore {
  version: 1;
  root: string | null;
  folders: string[];
  documents: Record<string, WorkspaceDocument>;
  session: WorkspaceSession;
}

/** Load only the isolated preview store; malformed data is reported without silently resetting it. */
function readStore(): PreviewStore {
  const raw = localStorage.getItem(storageKey);
  if (!raw)
    return {
      version: 1,
      root: null,
      folders: [],
      documents: {},
      session: structuredClone(emptySession),
    };
  let value: PreviewStore;
  try {
    value = JSON.parse(raw) as PreviewStore;
  } catch {
    throw new Error(
      "Browser preview settings are damaged. Your desktop project files have not been changed.",
    );
  }
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.folders) ||
    !value.documents ||
    !value.session ||
    !Array.isArray(value.session.openFiles) ||
    !Array.isArray(value.session.presets)
  )
    throw new Error(
      "Browser preview settings are damaged. Your desktop project files have not been changed.",
    );
  return value;
}

/** Persist one complete preview snapshot before exposing success; storage/quota failures remain actionable. */
function writeStore(store: PreviewStore) {
  localStorage.setItem(storageKey, JSON.stringify(store));
}

/** Require an explicit project before allowing any preview file operation. */
function projectStore() {
  const store = readStore();
  if (!store.root) throw new Error("Open or create a project first.");
  return store;
}

/** Validate one Windows-compatible filename rather than interpreting separators as directories. */
function validName(name: string) {
  if (
    !name.trim() ||
    name !== name.trim() ||
    /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    throw new Error(
      "Use a valid file or folder name without reserved characters or trailing dots/spaces.",
    );
}

/** Ensure relative identifiers cannot escape the selected preview root or address inherited object properties. */
function validPath(path: string) {
  if (
    !path ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    path.includes("\\")
  )
    throw new Error("Choose an item inside the current project.");
  path.split("/").forEach(validName);
}

/** Compose a child identifier only when its parent is a real directory. */
function childPath(store: PreviewStore, parent: string, name: string) {
  validName(name);
  if (parent && !store.folders.includes(parent))
    throw new Error(
      "The destination folder no longer exists. Refresh and retry.",
    );
  return parent ? `${parent}/${name}` : name;
}

/** Convert stored paths to the tree library's nested data shape; the library owns interaction mechanics. */
function projectTree(store: PreviewStore): WorkspaceProject {
  const folders = new Map<string, WorkspaceEntry>();
  const entries: WorkspaceEntry[] = [];
  const paths = [...store.folders, ...Object.keys(store.documents)].sort();
  for (const id of paths) {
    const kind = store.folders.includes(id) ? "folder" : "file";
    const entry: WorkspaceEntry = { id, name: id.split("/").at(-1)!, kind };
    if (kind === "folder") {
      entry.children = [];
      folders.set(id, entry);
    }
    const parent = id.slice(0, Math.max(0, id.lastIndexOf("/")));
    const siblings = folders.get(parent)?.children ?? entries;
    siblings.push(entry);
  }
  return { root: store.root!, name: "Example project", entries };
}

/** Find an owned document only; object prototype names never masquerade as files. */
function documentAt(store: PreviewStore, path: string) {
  validPath(path);
  if (!Object.hasOwn(store.documents, path))
    throw new Error(
      "The file no longer exists. Refresh the explorer and retry.",
    );
  const document = store.documents[path];
  if (
    typeof document.content !== "string" ||
    typeof document.revision !== "string"
  )
    throw new Error(
      "This preview document is damaged. Its stored data has not been replaced.",
    );
  return document;
}

/** Relocate a complete subtree with collision/cycle checks and one durable preview write. */
function relocate(path: string, parent: string, name: string) {
  const store = projectStore();
  validPath(path);
  const folder = store.folders.includes(path);
  if (!folder) documentAt(store, path);
  const destination = childPath(store, parent, name);
  if (destination === path) return projectTree(store);
  if (parent === path || parent.startsWith(`${path}/`))
    throw new Error("A folder cannot be moved inside itself.");
  if (
    store.folders.includes(destination) ||
    Object.hasOwn(store.documents, destination)
  )
    throw new Error("An item with that name already exists.");
  /** Remap only the selected item and its descendants, preserving unrelated file names and document contents. */
  function mapped(id: string) {
    return id === path || id.startsWith(`${path}/`)
      ? destination + id.slice(path.length)
      : id;
  }
  store.folders = store.folders.map(mapped);
  store.documents = Object.fromEntries(
    Object.entries(store.documents).map(([id, document]) => [
      mapped(id),
      { ...document, path: mapped(id) },
    ]),
  );
  writeStore(store);
  return projectTree(store);
}

/** Preview the same user flow in browser-local storage; native files and compiler output are never simulated as real evidence. */
export const previewWorkspace: WorkspaceBridge = {
  native: false,
  /** Read browser-only session state without sharing desktop settings. */
  async loadSession() {
    return structuredClone(readStore().session);
  },
  /** Persist browser-only navigation/presets and propagate storage failures. */
  async saveSession(session) {
    const store = readStore();
    store.session = structuredClone(session);
    writeStore(store);
  },
  /** Create an explicit fresh preview of the actual retained example source. */
  async createProject() {
    const store = readStore();
    store.root = `preview://example-${crypto.randomUUID()}`;
    store.folders = [];
    store.documents = {
      "ExampleStrategy.cs": {
        path: "ExampleStrategy.cs",
        content: exampleSource,
        revision: crypto.randomUUID(),
      },
    };
    writeStore(store);
    return projectTree(store);
  },
  /** Native folder selection is intentionally unavailable in browser preview. */
  async pickProject() {
    throw new Error(
      "Opening disk folders requires the desktop app. Use the example project to explore this browser preview.",
    );
  },
  /** Restore only this browser's explicit preview project. */
  async openProject(root) {
    const store = projectStore();
    if (store.root !== root)
      throw new Error(
        "This project is unavailable in browser preview. Open it in the desktop app.",
      );
    return projectTree(store);
  },
  /** Return current preview tree data without clearing any drafts. */
  async refreshProject() {
    return projectTree(projectStore());
  },
  /** Read a revision-bearing document from isolated browser storage. */
  async readDocument(path) {
    return structuredClone(documentAt(projectStore(), path));
  },
  /** Preserve an externally changed preview document instead of accepting a stale editor revision. */
  async saveDocument(path, content, revision) {
    const store = projectStore();
    const previous = documentAt(store, path);
    if (previous.revision !== revision)
      throw new Error(
        "This file changed outside the editor. Your draft is preserved. Reopen the disk version before saving again.",
      );
    if (content.length > 1_048_576)
      throw new Error("This text file exceeds the editor's 1 MB limit.");
    const document = { path, content, revision: crypto.randomUUID() };
    store.documents[path] = document;
    writeStore(store);
    return document;
  },
  /** Add a new empty file/folder after validating parent/name and collision behavior. */
  async createEntry(parent, name, kind) {
    const store = projectStore();
    const path = childPath(store, parent, name);
    if (store.folders.includes(path) || Object.hasOwn(store.documents, path))
      throw new Error("An item with that name already exists.");
    if (kind === "folder") store.folders.push(path);
    else
      store.documents[path] = {
        path,
        content: "",
        revision: crypto.randomUUID(),
      };
    writeStore(store);
    return projectTree(store);
  },
  /** Rename only the selected preview item and its descendants. */
  async renameEntry(path, name) {
    return relocate(
      path,
      path.slice(0, Math.max(0, path.lastIndexOf("/"))),
      name,
    );
  },
  /** Move a preview subtree without losing its contents or allowing descendant cycles. */
  async moveEntry(path, parent) {
    return relocate(path, parent, path.split("/").at(-1)!);
  },
  /** Report compiler unavailability honestly; a browser preview never invents a successful build. */
  async build() {
    return {
      success: false,
      diagnostics: [
        {
          severity: "info",
          message:
            "Compile strategies in the desktop app with the .NET 10 SDK installed. This browser preview does not execute C#.",
        },
      ],
      output: "No compiler was run in the browser preview.",
      durationMs: 0,
      strategies: [],
      artifactPath: null,
    };
  },
  /** No native process exists to cancel in preview mode. */
  async cancelBuild() {},
};
