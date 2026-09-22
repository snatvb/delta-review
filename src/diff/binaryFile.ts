// src/diff/binaryFile.ts
//
// Binary-file card helpers (#binary): which binary extensions render as images,
// the MIME each maps to, and human-readable byte sizes for the placeholder.

// Extensions the webview's <img> can decode on both mac (WKWebView) and Windows
// (WebView2). TIFF is Safari-only, HEIC uncompressible-by-default — both excluded.
const IMAGE_MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
};

export function imageMimeFor(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  return IMAGE_MIMES[base.slice(dot + 1).toLowerCase()] ?? null;
}

export const isImagePath = (path: string): boolean => imageMimeFor(path) != null;

export function imageDataUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

/** "45 KB" · "1.2 MB" — 1024-based; one decimal only below 10 units. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  const rounded = Math.round(v * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${units[u]}`;
}
