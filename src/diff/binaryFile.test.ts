import { describe, it, expect } from "vitest";
import { formatBytes, imageDataUrl, imageMimeFor, isImagePath } from "./binaryFile";

describe("imageMimeFor / isImagePath", () => {
  it("maps image extensions to their MIME, case-insensitively", () => {
    expect(imageMimeFor("logo.PNG")).toBe("image/png");
    expect(imageMimeFor("assets/photo.jpeg")).toBe("image/jpeg");
    expect(imageMimeFor("icon.ico")).toBe("image/x-icon");
    expect(imageMimeFor("art.svg")).toBe("image/svg+xml");
    expect(isImagePath("assets/logo.png")).toBe(true);
  });

  it("rejects non-image and extension-less names", () => {
    expect(imageMimeFor("archive.zip")).toBeNull();
    expect(imageMimeFor("notes.txt")).toBeNull();
    expect(imageMimeFor("Makefile")).toBeNull();
    expect(imageMimeFor("dir.d/inner")).toBeNull();
    expect(isImagePath("archive.zip")).toBe(false);
  });

  it("ignores dots in directory names", () => {
    expect(imageMimeFor("v1.2.3/logo/png")).toBeNull();
    expect(imageMimeFor("v1.2.3/logo.png")).toBe("image/png");
  });
});

describe("imageDataUrl", () => {
  it("wraps base64 in a data URL", () => {
    expect(imageDataUrl("image/png", "AAAA")).toBe("data:image/png;base64,AAAA");
  });
});

describe("formatBytes", () => {
  it("keeps bytes plain and rounds the unit steps", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(45 * 1024)).toBe("45 KB");
    expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
    expect(formatBytes(12 * 1024 * 1024)).toBe("12 MB");
  });
});
