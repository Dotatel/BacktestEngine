import type { useExtensions } from "./useExtensions";

/** Keep native action feedback in the active reading surface, including the compact inspector. */
export function ExtensionsFeedback({
  controller,
}: {
  controller: ReturnType<typeof useExtensions>;
}) {
  const busy = controller.phase !== "idle";
  if (!controller.error && !controller.message && !busy) return null;
  return (
    <div className="extensions-feedback">
      {controller.error && (
        <p className="app-extensions-error" role="alert">
          {controller.error}
        </p>
      )}
      {controller.message && (
        <p className="app-extensions-note" role="status">
          {controller.message}
        </p>
      )}
      {busy && (
        <p className="app-extensions-note" role="status">
          {controller.phase === "loading"
            ? "Reading imported manifests and the selected saved report…"
            : "Updating local extensions…"}
        </p>
      )}
    </div>
  );
}
