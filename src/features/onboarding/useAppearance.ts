import { useEffect } from "react";
import type { Appearance } from "@/lib/preferences";

/** Apply the selected app theme, observing OS changes only for System and cleaning up its listener on change/unmount. */
export function useAppearance(appearance: Appearance) {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    /** Resolve the app's colors without changing the operating system preference. */
    function applyAppearance() {
      const dark =
        appearance === "dark" || (appearance === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    }

    applyAppearance();
    if (appearance !== "system") return;
    media.addEventListener("change", applyAppearance);
    return () => media.removeEventListener("change", applyAppearance);
  }, [appearance]);
}
