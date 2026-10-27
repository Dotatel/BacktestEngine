import { Minus, Square, Copy, X } from "lucide-react";
import { Brand } from "./Brand";
import { Button } from "./ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import { type DesktopBridge } from "@/lib/desktop";
import { errorMessage } from "@/lib/preferences";
import { useMaximizedWindow } from "@/hooks/useMaximizedWindow";
import type { AppMenuController } from "@/lib/app-menu-contract";
import { AppMenu } from "./AppMenu";
import "./title-bar.css";

interface TitleBarProps {
  bridge: DesktopBridge;
  onError(message: string): void;
  beforeClose?(): Promise<void | boolean>;
  menu?: AppMenuController;
}

/** Render an integrated application header with standard shadcn controls and actual native window actions. */
export function TitleBar({
  bridge,
  onError,
  beforeClose,
  menu,
}: TitleBarProps) {
  const maximized = useMaximizedWindow(bridge, onError);

  /** Keep window failures actionable without hiding storage failures in the setup controller. */
  async function perform(action: () => void | Promise<void>) {
    onError("");
    try {
      await action();
    } catch (error) {
      onError(errorMessage(error));
    }
  }

  /** Flush durable preference writes before closing the actual desktop process. */
  async function closeWindow() {
    if ((await beforeClose?.()) === false) return;
    await bridge.close();
  }

  const controls = [
    {
      id: "minimize",
      label: "Minimize window",
      hint: "Minimize",
      Icon: Minus,
      action: () => bridge.minimize(),
    },
    {
      id: "maximize",
      label: maximized ? "Restore window" : "Maximize window",
      hint: maximized ? "Restore" : "Maximize",
      Icon: maximized ? Copy : Square,
      action: () => bridge.toggleMaximize(),
    },
    {
      id: "close",
      label: "Close window",
      hint: "Close",
      Icon: X,
      action: closeWindow,
    },
  ];

  return (
    <header
      className={`titlebar${menu ? " titlebar--workspace" : ""}`}
      aria-label="Window title bar"
    >
      {menu ? (
        <AppMenu
          controller={menu}
          perform={(action) => void perform(action)}
          windowActions={{
            native: bridge.native,
            maximized,
            minimize: () => void perform(() => bridge.minimize()),
            toggleMaximize: () => void perform(() => bridge.toggleMaximize()),
            close: () => void perform(closeWindow),
          }}
        />
      ) : null}
      <div
        className="titlebar-drag"
        onMouseDown={(event) => {
          if (event.button !== 0 || !bridge.native) return;
          if (event.detail === 2) {
            void perform(() => bridge.toggleMaximize());
            return;
          }
          void perform(() => bridge.startDragging());
        }}
      >
        {menu ? (
          <span className="titlebar-workspace-caption">BacktestEngine</span>
        ) : (
          <>
            <Brand className="titlebar-brand" />
            <span className="titlebar-product">BacktestEngine</span>
          </>
        )}
      </div>
      <TooltipProvider delayDuration={450}>
        <div className="window-controls" aria-label="Window controls">
          {controls.map(({ id, label, hint, Icon, action }) => (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={`window-control window-${id}`}
                  aria-label={label}
                  disabled={!bridge.native}
                  onClick={() => void perform(action)}
                >
                  <Icon aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{hint}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TooltipProvider>
    </header>
  );
}
