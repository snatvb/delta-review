import type { Extension } from "@codemirror/state";
import type { CodeMirrorLanguageId } from "./codeMirrorLang";

// One dynamic import per language, so opening a .ts file never pulls in the
// Python/Rust/SQL/... parsers — each lands in its own chunk, fetched only
// when a file of that language is actually edited.
export async function loadCodeMirrorLanguage(id: CodeMirrorLanguageId | null): Promise<Extension[]> {
  switch (id) {
    case "javascript":
      return [(await import("@codemirror/lang-javascript")).javascript()];
    case "jsx":
      return [(await import("@codemirror/lang-javascript")).javascript({ jsx: true })];
    case "typescript":
      return [(await import("@codemirror/lang-javascript")).javascript({ typescript: true })];
    case "tsx":
      return [(await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true })];
    case "python":
      return [(await import("@codemirror/lang-python")).python()];
    case "rust":
      return [(await import("@codemirror/lang-rust")).rust()];
    case "sql":
      return [(await import("@codemirror/lang-sql")).sql()];
    case "css":
      return [(await import("@codemirror/lang-css")).css()];
    case "html":
      return [(await import("@codemirror/lang-html")).html()];
    case "json":
      return [(await import("@codemirror/lang-json")).json()];
    case "markdown":
      return [(await import("@codemirror/lang-markdown")).markdown()];
    case "xml":
      return [(await import("@codemirror/lang-xml")).xml()];
    case "yaml":
      return [(await import("@codemirror/lang-yaml")).yaml()];
    case "cpp":
      return [(await import("@codemirror/lang-cpp")).cpp()];
    case "java":
      return [(await import("@codemirror/lang-java")).java()];
    case "php":
      return [(await import("@codemirror/lang-php")).php()];
    default:
      return [];
  }
}
