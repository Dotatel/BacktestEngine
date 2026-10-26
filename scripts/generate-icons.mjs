import { readFile, mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";

// Reuse the exact official split-D paths; generate only the required Windows app icon sizes.
const wordmark = await readFile(
  new URL("../public/assets/dotatel-logo-dark.svg", import.meta.url),
  "utf8",
);
const mark = wordmark.match(
  /<g aria-label="Custom split D mark">([\s\S]*?)<\/g>/,
)?.[1];
if (!mark) throw new Error("The official split-D mark was not found.");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-13 -14 130 130">${mark}</svg>`;
const outputDirectory = new URL("../src-tauri/icons/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });
const png = await sharp(Buffer.from(svg)).resize(256, 256).png().toBuffer();
await writeFile(new URL("icon.png", outputDirectory), png);
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);
await writeFile(
  new URL("icon.ico", outputDirectory),
  Buffer.concat([header, png]),
);
