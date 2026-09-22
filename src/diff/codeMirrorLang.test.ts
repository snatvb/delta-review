import { describe, it, expect } from "vitest";
import { codeMirrorLanguageFor } from "./codeMirrorLang";

describe("codeMirrorLanguageFor", () => {
  it("resolves common extensions to their CodeMirror language id", () => {
    expect(codeMirrorLanguageFor("src/App.tsx")).toBe("tsx");
    expect(codeMirrorLanguageFor("src/index.ts")).toBe("typescript");
    expect(codeMirrorLanguageFor("scripts/build.js")).toBe("javascript");
    expect(codeMirrorLanguageFor("main.rs")).toBe("rust");
    expect(codeMirrorLanguageFor("app.py")).toBe("python");
    expect(codeMirrorLanguageFor("style.scss")).toBe("css");
    expect(codeMirrorLanguageFor("data.yml")).toBe("yaml");
    expect(codeMirrorLanguageFor("README.md")).toBe("markdown");
  });

  it("resolves a nested path by its basename", () => {
    expect(codeMirrorLanguageFor("a/b/c/module.json")).toBe("json");
  });

  it("is case-insensitive on the extension", () => {
    expect(codeMirrorLanguageFor("Main.RS")).toBe("rust");
  });

  it("returns null for an unknown or extension-less file", () => {
    expect(codeMirrorLanguageFor("Dockerfile")).toBeNull();
    expect(codeMirrorLanguageFor("a/b/binaryfile.wasm")).toBeNull();
  });
});
