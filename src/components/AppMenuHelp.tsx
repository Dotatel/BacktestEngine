import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  appMenuLabels,
  type AppMenuCommand,
  type AppMenuController,
} from "@/lib/app-menu-contract";
import { version } from "../../package.json";

/** Built-in reference dialogs need no external connection or file access. */
export function AppMenuHelp({
  page,
  onClose,
  controller,
}: {
  page: "shortcuts" | "about" | null;
  onClose(): void;
  controller: AppMenuController;
}) {
  const shortcuts = Object.entries(controller.actions).filter(
    ([, action]) => action?.shortcut,
  );
  return (
    <Dialog
      open={page !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {page === "about" ? "About BacktestEngine" : "Keyboard shortcuts"}
          </DialogTitle>
          <DialogDescription>
            {page === "about"
              ? `DotaTel BacktestEngine · Version ${version}`
              : "Commands available in this workspace. Availability follows the active editor and current work."}
          </DialogDescription>
        </DialogHeader>
        {page === "about" ? (
          <div
            className="app-menu-help"
            role="region"
            aria-label="Application information"
            tabIndex={0}
          >
            <p>
              An offline-first workspace for C# strategy development, historical
              replay, validation and saved evidence.
            </p>
            <p>
              The original C# engine and Python validation are retained.
              Synthetic fixtures and completed processes do not establish
              trading validity or native-platform parity.
            </p>
            <p>
              The app sends explicitly reviewed text when you choose Send. The
              assistant service or provider may also apply its existing global
              instructions and conversation context.
            </p>
          </div>
        ) : (
          <div
            className="app-menu-help"
            role="region"
            aria-label="Keyboard shortcut list"
            tabIndex={0}
          >
            <p>Editor shortcuts apply while the code editor is focused.</p>
            <dl className="app-menu-shortcuts">
              <dt>Focus application menus</dt>
              <dd>F10</dd>
              <dt>Open File / Edit / View / Window / Help</dt>
              <dd>Alt+F / E / V / W / H</dd>
              <dt>Move between menus / commands</dt>
              <dd>Arrow keys</dd>
              <dt>Choose / dismiss</dt>
              <dd>Enter / Esc</dd>
              {shortcuts.map(([command, action]) => (
                <div className="app-menu-shortcut-row" key={command}>
                  <dt>{appMenuLabels[command as AppMenuCommand]}</dt>
                  <dd>{action?.shortcut}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
