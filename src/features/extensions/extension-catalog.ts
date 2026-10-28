import reportTools from "../../../src-tauri/examples/extensions/report-tools/manifest.json";
import tradeLedger from "../../../src-tauri/examples/extensions/trade-ledger-export/manifest.json";
import htmlReports from "../../../src-tauri/examples/extensions/html-reports/manifest.json";
import type {
  AppExtension,
  ExampleExtensionId,
} from "@/lib/extensions-contract";

/** Presentation-only catalog item; native registrations alone grant actual export authority. */
export interface ExtensionCatalogItem {
  key: string;
  name: string;
  description: string;
  version: string;
  category: "reports" | "assistants";
  commands: AppExtension["commands"];
  exampleId?: ExampleExtensionId;
  assistant?: "claude" | "chatgpt" | "opencode";
  image?: string;
  installed?: AppExtension;
  tone: "sage" | "blue" | "amber" | "brand";
}

const examples: ExtensionCatalogItem[] = [
  reportTools,
  tradeLedger,
  htmlReports,
].map((manifest, index) => ({
  key: `report:${manifest.id}`,
  name: manifest.name,
  description: manifest.description,
  version: manifest.version,
  category: "reports",
  commands: manifest.contributes.commands as AppExtension["commands"],
  exampleId: manifest.id as ExampleExtensionId,
  tone: (["sage", "blue", "amber"] as const)[index],
}));
const assistants: ExtensionCatalogItem[] = [
  {
    key: "assistant:claude",
    name: "Claude",
    description:
      "An example assistant integration. A Claude connector is not implemented in this app.",
    version: "Preview",
    category: "assistants",
    commands: [],
    assistant: "claude",
    image: "/assets/onboarding/claude.png",
    tone: "brand",
  },
  {
    key: "assistant:chatgpt",
    name: "ChatGPT",
    description:
      "An example assistant integration. A ChatGPT connector is not implemented in this app.",
    version: "Preview",
    category: "assistants",
    commands: [],
    assistant: "chatgpt",
    image: "/assets/extensions/chatgpt.svg",
    tone: "brand",
  },
  {
    key: "assistant:opencode",
    name: "OpenCode",
    description:
      "Open the existing optional assistant to review and connect your local OpenCode service.",
    version: "Assistant",
    category: "assistants",
    commands: [],
    assistant: "opencode",
    image: "/assets/onboarding/opencode.png",
    tone: "brand",
  },
];

/** Merge installed metadata once by native identity; never mistake a sample or provider preview for installed code. */
export function extensionCatalog(
  installed: AppExtension[],
): ExtensionCatalogItem[] {
  const reports = examples.map((item) => ({
    ...item,
    installed: installed.find((entry) => `report:${entry.id}` === item.key),
  }));
  const imported = installed
    .filter((entry) => !reports.some((item) => item.installed?.id === entry.id))
    .map((entry): ExtensionCatalogItem => ({
      key: `report:${entry.id}`,
      name: entry.name,
      description: entry.description ?? "Imported report extension.",
      version: entry.version ?? "Unknown version",
      category: "reports",
      commands: entry.commands,
      installed: entry,
      tone: "blue",
    }));
  return [...reports, ...imported, ...assistants].map((item) =>
    item.installed
      ? {
          ...item,
          name: item.installed.name,
          description: item.installed.description ?? item.description,
          commands: item.installed.commands,
          version: item.installed.version ?? "Unknown version",
        }
      : item,
  );
}

/** Derive visible state from real registration status instead of a catalog's illustrative metadata. */
export function extensionState(item: ExtensionCatalogItem): string {
  if (item.installed?.issue || (item.installed && !item.installed.compatible))
    return "Needs attention";
  if (item.installed) return item.installed.enabled ? "Enabled" : "Disabled";
  if (item.assistant === "opencode") return "Assistant";
  if (item.assistant) return "Preview only";
  return "Available";
}

/** Identify local installations, bundled examples and integrations without inventing publisher approval. */
export function extensionOrigin(item: ExtensionCatalogItem): string {
  if (item.installed) return "Installed locally";
  return item.category === "reports"
    ? "Included example"
    : "Assistant integration";
}
