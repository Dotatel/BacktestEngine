import { FileChartColumn, FileCode2, FileSpreadsheet } from "lucide-react";
import type { ExtensionCatalogItem } from "./extension-catalog";

/** Keep provider imagery bundled offline and use colored document icons for report examples. */
export function ExtensionIcon({ item }: { item: ExtensionCatalogItem }) {
  const Icon = reportIcon(item.tone);
  return (
    <span
      className={`extension-icon extension-icon--${item.tone}`}
      aria-hidden="true"
    >
      {item.image ? <img src={item.image} alt="" /> : <Icon />}
    </span>
  );
}

/** Reuse the existing icon set while allowing each example its own quiet color. */
function reportIcon(tone: ExtensionCatalogItem["tone"]) {
  if (tone === "blue") return FileSpreadsheet;
  return tone === "amber" ? FileCode2 : FileChartColumn;
}
