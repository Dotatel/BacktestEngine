import { Button } from "@/components/ui/button";
import type { ExtensionCatalogItem } from "./extension-catalog";
import type { useExtensions } from "./useExtensions";

/** Expose the next real lifecycle action independently of a card's disclosure trigger. */
export function ExtensionAction({
  item,
  controller,
  native,
  onOpenAssistant,
}: {
  item: ExtensionCatalogItem;
  controller: ReturnType<typeof useExtensions>;
  native: boolean;
  onOpenAssistant(): void;
}) {
  const entry = item.installed;
  const busy = controller.phase !== "idle";
  if (entry)
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !native || (!entry.compatible && !entry.issue)}
        onClick={() =>
          void controller.setEnabled(entry, entry.compatible && !entry.enabled)
        }
      >
        {actionLabel(entry.compatible, entry.enabled)}
      </Button>
    );
  if (item.exampleId)
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !native}
        onClick={() => void controller.installExample(item.exampleId!)}
      >
        Install
      </Button>
    );
  if (item.assistant === "opencode")
    return (
      <Button size="sm" variant="outline" onClick={onOpenAssistant}>
        Open assistant
      </Button>
    );
  return (
    <Button size="sm" variant="outline" disabled>
      Preview only
    </Button>
  );
}

/** Invalid registrations can only lose authority; a valid installation can be activated or disabled. */
function actionLabel(compatible: boolean, enabled: boolean) {
  if (!compatible) return "Disable registration";
  return enabled ? "Disable" : "Activate";
}
