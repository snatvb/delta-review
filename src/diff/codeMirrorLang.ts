import { langFromFilename } from "./lang";

// CodeMirror's official @codemirror/lang-* packages, keyed by highlight.js-style
// hint (the same token lang.ts already resolves from a file's extension) rather
// than re-deriving a language from the path — this is a translation of that
// hint into a CodeMirror loader id, not a second extension→language table.
export type CodeMirrorLanguageId =
  | "javascript" | "jsx" | "typescript" | "tsx"
  | "python" | "rust" | "sql" | "css" | "html" | "json" | "markdown"
  | "xml" | "yaml" | "cpp" | "java" | "php" | "gdscript" | "ron";

const HINT_TO_LANGUAGE: Record<string, CodeMirrorLanguageId> = {
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  py: "python", pyw: "python", pyi: "python",
  rs: "rust",
  sql: "sql",
  css: "css", scss: "css", less: "css",
  html: "html", htm: "html", vue: "html",
  json: "json", jsonc: "json",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  xml: "xml", svg: "xml", xsl: "xml",
  yaml: "yaml", yml: "yaml",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp", c: "cpp", h: "cpp",
  java: "java",
  php: "php",
  gd: "gdscript",
  ron: "ron",
};

export function codeMirrorLanguageFor(path: string): CodeMirrorLanguageId | null {
  return HINT_TO_LANGUAGE[langFromFilename(path)] ?? null;
}
