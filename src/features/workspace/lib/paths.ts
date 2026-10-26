import type { WorkspaceEntry } from "@/lib/workspace-contract";

/** Join a project-relative parent folder and a direct child name; the root is the empty string. */
export function childPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** Return the project-relative parent folder of a path, or an empty string for a root item. */
export function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/** Return the final segment of a project-relative path for display. */
export function nameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/** Test whether a path is the folder itself or lives below it; an empty folder means the project root. */
export function isPathWithin(path: string, folder: string): boolean {
  if (!folder) return true;
  return path === folder || path.startsWith(`${folder}/`);
}

/** Rewrite a path when a file or one of its ancestor folders is renamed or moved. */
export function remapPath(
  path: string,
  from: string,
  to: string,
  isFolder: boolean,
): string {
  if (path === from) return to;
  if (!isFolder || !path.startsWith(`${from}/`)) return path;
  return `${to}${path.slice(from.length)}`;
}

/** Find an explorer entry by its project-relative identifier. */
export function findEntry(
  entries: WorkspaceEntry[],
  path: string,
): WorkspaceEntry | null {
  for (const entry of entries) {
    if (entry.id === path) return entry;
    const nested = findEntry(entry.children ?? [], path);
    if (nested) return nested;
  }
  return null;
}

/** Collect every folder that can receive a moved or created entry. */
export function collectFolders(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return entries.flatMap((entry) =>
    entry.kind === "folder"
      ? [entry, ...collectFolders(entry.children ?? [])]
      : [],
  );
}

/** Find the first supported source file so an opened project does not land on an empty editor. */
export function findPreferredFile(
  entries: WorkspaceEntry[],
): WorkspaceEntry | null {
  const files = collectFiles(entries);
  return (
    files.find((entry) => entry.name.toLowerCase().endsWith(".cs")) ??
    files.find((entry) => entry.name.toLowerCase().endsWith(".json")) ??
    files[0] ??
    null
  );
}

/** Flatten the file entries of a project tree; folder order is preserved. */
function collectFiles(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return entries.flatMap((entry) =>
    entry.kind === "file" ? [entry] : collectFiles(entry.children ?? []),
  );
}

/** Test for a case-insensitive sibling collision, optionally ignoring the entry being renamed. */
export function hasSiblingName(
  entries: WorkspaceEntry[],
  parent: string,
  name: string,
  ignorePath?: string,
): boolean {
  const siblings = parent
    ? (findEntry(entries, parent)?.children ?? [])
    : entries;
  const wanted = name.toLocaleLowerCase();
  return siblings.some(
    (entry) =>
      entry.id !== ignorePath && entry.name.toLocaleLowerCase() === wanted,
  );
}

/** Validate a new or renamed entry name against product and Windows filesystem rules. */
export function validateEntryName(name: string): string | null {
  if (!name.trim()) return "Enter a name.";
  if (name !== name.trim()) return "Remove leading or trailing spaces.";
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name))
    return 'Avoid these characters: < > : " / \\ | ? *.';
  if (name === "." || name === "..") return "Choose a different name.";
  if (/[. ]$/.test(name)) return "Names cannot end with a dot or space.";
  const stem = name.split(".")[0]?.toLocaleUpperCase() ?? "";
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem))
    return "That name is reserved by Windows.";
  return null;
}

/** Convert a compiler path into a project-relative id, rejecting locations outside the project. */
export function normalizeDiagnosticPath(
  path: string,
  root: string,
): string | null {
  const clean = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
  if (!normalizedRoot) return clean;
  const prefix = `${normalizedRoot.toLocaleLowerCase()}/`;
  if (clean.toLocaleLowerCase().startsWith(prefix))
    return clean.slice(normalizedRoot.length + 1);
  if (clean.startsWith("/") || /^[a-z]:\//i.test(clean)) return null;
  return clean;
}

/** Map a file extension to a locally bundled Monaco language id. */
export function languageForPath(path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLocaleLowerCase();
  const languages: Record<string, string> = {
    ".cs": "csharp",
    ".json": "json",
    ".md": "markdown",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
  };
  return languages[extension] ?? "plaintext";
}

/** Format a project-relative path for display without exposing a trailing root separator. */
export function displayPath(path: string): string {
  return path || "Project root";
}
