import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const controls = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
]);
const geometry =
  /^(?:height|width|min-height|min-width|max-height|max-width|padding(?:-.+)?|border-radius|font-size)$/;
const protectedSelector =
  /\.(?:primary-action|back-action|skip-action|finish-action|window-control|window-(?:close|minimize|maximize)|choice-radio)\b|\[data-slot=["']?(?:button|radio-group-item)["']?\]/;

/** Inspect authored TypeScript with its parser; function boundaries reset control-flow depth. */
function inspectSource(source, file) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const errors = [];
  /** Attach a stable source location to each actionable standard violation. */
  function report(node, message) {
    const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
    errors.push(`${file}:${line + 1}: ${message}`);
  }
  /** Traverse syntax rather than counting braces, which also occur in JSX, objects and strings. */
  function visit(node, depth = 0) {
    const functionBoundary = ts.isFunctionLike(node);
    const nextDepth = functionBoundary
      ? 0
      : depth + Number(controls.has(node.kind));
    if (nextDepth > 2 && controls.has(node.kind))
      report(
        node,
        "Use early returns or a focused operation; control-flow nesting exceeds two levels.",
      );
    if (
      ts.isConditionalExpression(node) &&
      (ts.isConditionalExpression(node.whenTrue) ||
        ts.isConditionalExpression(node.whenFalse))
    )
      report(
        node,
        "Replace the nested conditional expression with explicit guards.",
      );
    const namedFunction = functionBoundary && node.name && node.body;
    const publicContract =
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      node.modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword);
    if (
      (namedFunction || publicContract) &&
      ts.getJSDocCommentsAndTags(node).length === 0
    )
      report(node, "Document this named function or public contract.");
    if (
      ts.isImportDeclaration(node) &&
      /features\/(?:onboarding\/|workspace\/(?:components\/|BuildWorkspace\.))/.test(
        file,
      ) &&
      !path.basename(file).startsWith("use") &&
      /@tauri-apps|node:|lib\/(?:desktop|workspace)(?:$|\/)/.test(
        node.moduleSpecifier.text,
      )
    )
      report(
        node,
        "Presentation must receive state/actions from its controller, not import native integration.",
      );
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      inspectComponent(node);
    ts.forEachChild(node, (child) => visit(child, nextDepth));
  }
  /** Require public size/variant APIs instead of inline geometry utilities on shared controls. */
  function inspectComponent(node) {
    if (!["Button", "RadioGroupItem"].includes(node.tagName.getText(tree)))
      return;
    const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
    for (const attribute of attributes) {
      if (attribute.name.getText(tree) === "style")
        report(
          attribute,
          "Keep shared control geometry in its size/variant API; arrange it with page CSS.",
        );
      if (attribute.name.getText(tree) !== "className") continue;
      const value = attribute.initializer?.getText(tree) ?? "";
      if (
        /(?:^|[\s"'`])(?:[\w-]+:)*!?(?:h-|w-|size-|min-h-|min-w-|max-h-|max-w-|p[xytrblse]?-|rounded(?:-|\b)|text-(?:xs|sm|base|lg|xl|[2-9]xl|\[))/.test(
          value,
        )
      )
        report(
          attribute,
          "Use the shadcn size API; remove the control geometry utility.",
        );
    }
  }
  visit(tree);
  return errors;
}

/** Reject geometry overrides on the actual shared controls while permitting placement, feedback and semantic colors. */
function inspectStyles(source, file) {
  const errors = [];
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!protectedSelector.test(selector)) continue;
    for (const [, property] of body.matchAll(/(?:^|;)\s*([\w-]+)\s*:/g)) {
      if (geometry.test(property))
        errors.push(
          `${file}: ${selector.trim()}: remove ${property}; use the shared component API.`,
        );
    }
  }
  return errors;
}

/** Enumerate only owned production sources; vendor components and retained engines have separate provenance contracts. */
async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (absolute === path.join(root, "src/components/ui")) return [];
      if (entry.isDirectory()) return sourceFiles(absolute);
      if (/\.test\./.test(entry.name) || !/\.(?:tsx?|css)$/.test(entry.name))
        return [];
      return [absolute];
    }),
  );
  return groups.flat();
}

// Calibrate against both violations and allowed composition so a vacuous or overbroad checker cannot pass.
assert(
  inspectSource(
    "function bad() { if (a) { while (b) { if (c) x(); } } }",
    "fixture.ts",
  ).some((error) => error.includes("nesting")),
);
assert(
  inspectSource("const result = a ? b ? c : d : e;", "fixture.ts").some(
    (error) => error.includes("conditional"),
  ),
);
assert(
  inspectSource("function undocumented() {}", "fixture.ts").some((error) =>
    error.includes("Document"),
  ),
);
assert(
  inspectSource(
    "export interface Undocumented { value: string }",
    "fixture.ts",
  ).some((error) => error.includes("Document")),
);
assert.deepEqual(
  inspectSource(
    "/** Values. */ export interface Documented { value: string }",
    "fixture.ts",
  ),
  [],
);
assert(
  inspectSource(
    'import { invoke } from "@tauri-apps/api/core";',
    "features/workspace/components/Example.tsx",
  ).some((error) => error.includes("Presentation")),
);
assert.deepEqual(
  inspectSource(
    'import type { WorkspaceProject } from "@/lib/workspace-contract";',
    "features/workspace/components/Example.tsx",
  ),
  [],
);
assert.deepEqual(
  inspectSource(
    "/** Work. */ function good() { if (a) return; for (const b of c) { if (b) x(); } }",
    "fixture.ts",
  ),
  [],
);
assert(
  inspectSource('<Button className="h-14" />', "fixture.tsx").some((error) =>
    error.includes("geometry"),
  ),
);
assert.deepEqual(
  inspectSource(
    '<Button size="lg" className="primary-action" />',
    "fixture.tsx",
  ),
  [],
);
assert.equal(
  inspectStyles(".welcome .primary-action { height: 50px; }", "fixture.css")
    .length,
  1,
);
assert.deepEqual(
  inspectStyles(
    '.primary-action { margin-top: 32px; } [data-slot="button"] { transition-duration: 120ms; }',
    "fixture.css",
  ),
  [],
);

const files = await sourceFiles(path.join(root, "src"));
const results = await Promise.all(
  files.map(async (absolute) => {
    const file = path.relative(root, absolute).replaceAll("\\", "/");
    const source = await readFile(absolute, "utf8");
    return file.endsWith(".css")
      ? inspectStyles(source, file)
      : inspectSource(source, file);
  }),
);
const errors = results.flat();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Standards passed: ${files.length} owned source files; parser/style self-checks passed.`,
  );
