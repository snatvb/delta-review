// src/files/fileTypeIcons.tsx
// File-type icons vendored from vscode-material-icon-theme (MIT) under
// src/assets/file-icons. The icon answers "what kind of file is this?";
// git status is carried separately (see FilesPanel's status letters), so the
// two channels no longer fight over the glyph's color.
import { FileText } from "lucide-react";

// Vite turns every vendored SVG into a hashed asset URL at build time; keys are
// the glob paths, normalized to icon name → url. `no-inline` keeps them as
// emitted files (fetched per type on demand) instead of ~325KB of base64 in the
// JS bundle.
const ICON_URLS = import.meta.glob("../assets/file-icons/*.svg", {
  eager: true,
  query: "?url&no-inline",
  import: "default",
}) as Record<string, string>;

const url = (icon: string): string | undefined =>
  ICON_URLS[`../assets/file-icons/${icon}.svg`];

// Basenames (lowercased) that get a dedicated icon before any extension rule —
// manifests, lockfiles and friends whose extension alone would misclassify them.
const FILE_NAMES: Record<string, string> = {
  "dockerfile": "docker",
  ".dockerignore": "docker",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  "package.json": "npm",
  "package-lock.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "cargo.toml": "rust",
  "cargo.lock": "rust",
  "go.mod": "go",
  "go.sum": "go",
  "tsconfig.json": "tsconfig",
  "jsconfig.json": "jsconfig",
  "cmakelists.txt": "cmake",
  "makefile": "makefile",
  "gnumakefile": "makefile",
};

// Basename prefixes (lowercased), checked after exact names. README/LICENSE
// keep their icon across extensions (.md, .txt, …).
const FILE_NAME_PREFIXES: [prefix: string, icon: string][] = [
  ["readme", "readme"],
  ["license", "license"],
  ["licence", "license"],
];

// Extension (lowercased, no dot) → icon name. Ordered specificity comes free:
// exact names first, then these, then the caller's neutral fallback.
const FILE_EXTS: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "react_ts",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "react",
  json: "json", jsonc: "json", json5: "json",
  css: "css",
  scss: "sass", sass: "sass",
  less: "less",
  html: "html", htm: "html",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  md: "markdown", mdx: "markdown", markdown: "markdown",
  py: "python", pyi: "python", pyw: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  swift: "swift",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", ino: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  sh: "console", bash: "console", zsh: "console", fish: "console", mk: "makefile",
  ps1: "powershell", psm1: "powershell",
  toml: "toml",
  yml: "yaml", yaml: "yaml",
  xml: "xml", xsd: "xml", xsl: "xml", plist: "xml",
  sql: "database",
  graphql: "graphql", gql: "graphql",
  prisma: "prisma",
  svg: "svg",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  ico: "image", avif: "image", bmp: "image", tiff: "image",
  mp3: "audio", wav: "audio", ogg: "audio", flac: "audio", m4a: "audio",
  mp4: "video", mov: "video", webm: "video", avi: "video", mkv: "video",
  zip: "zip", tar: "zip", gz: "zip", tgz: "zip", "7z": "zip", rar: "zip", bz2: "zip", xz: "zip",
  pdf: "pdf",
  lock: "lock",
  ttf: "font", otf: "font", woff: "font", woff2: "font",
  gradle: "gradle",
  scala: "scala",
  dart: "dart",
  lua: "lua",
  pl: "perl", pm: "perl",
  hs: "haskell",
  ex: "elixir", exs: "elixir",
  erl: "erlang",
  clj: "clojure", cljs: "clojure",
};

/** Asset URL of the file-type icon for a file name, or null for the caller's fallback glyph. */
export function fileTypeIconUrl(name: string): string | null {
  const lower = name.toLowerCase();
  const byName = FILE_NAMES[lower] ?? FILE_NAME_PREFIXES.find(([p]) => lower.startsWith(p))?.[1];
  const icon = byName ?? FILE_EXTS[lower.slice(lower.lastIndexOf(".") + 1)];
  return (icon && url(icon)) || null;
}

/** File-type icon for a file name; falls back to a neutral glyph for unknown types. */
export function FileTypeIcon({ name, muted = false }: { name: string; muted?: boolean }) {
  const src = fileTypeIconUrl(name);
  if (!src) return <FileText className={`size-3.5 shrink-0 text-muted-foreground ${muted ? "opacity-60" : ""}`} />;
  return <img src={src} alt="" aria-hidden draggable={false} className={`size-4 shrink-0 ${muted ? "opacity-50" : ""}`} />;
}
