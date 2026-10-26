import { invoke, isTauri } from "@tauri-apps/api/core";
import type { MarketPreviewBridge } from "./market-preview-contract";

/** Read real app-owned history in desktop; browser previews never fabricate prices. */
export const marketPreview: MarketPreviewBridge = {
  native: isTauri(),
  /** Ask the host for bounded verified source observations, never synthetic market data. */
  async preview(request) {
    if (!isTauri())
      throw new Error(
        "Imported price preview is available in the desktop app.",
      );
    return invoke("market_preview", { request });
  },
};
