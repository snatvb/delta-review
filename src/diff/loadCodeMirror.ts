import type { Extension } from "@codemirror/state";
import type { CodeMirrorLanguageId } from "./codeMirrorLang";
import { loadCodeMirrorLanguage } from "./loadCodeMirrorLanguage";

export async function loadCodeMirror(language: CodeMirrorLanguageId | null) {
  const [{ EditorState }, { EditorView }, { basicSetup }, { codeMirrorAppTheme }, languageExtensions] = await Promise.all([
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("codemirror"),
    import("./codeMirrorTheme"),
    loadCodeMirrorLanguage(language),
  ]);
  return { EditorState, EditorView, basicSetup, codeMirrorAppTheme, languageExtensions: languageExtensions as Extension[] };
}
