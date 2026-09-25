import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";

// Colors are CSS custom properties (--cm-*, defined in index.css for :root and
// .dark) so the editor follows the app's light/dark theme and its palette stays
// in one place, mirroring the diff pane's own hljs colors.
const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword], color: "var(--cm-keyword)" },
  { tag: [tags.className, tags.typeName, tags.tagName], color: "var(--cm-type)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName)], color: "var(--cm-entity)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--cm-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.attributeValue], color: "var(--cm-constant)" },
  { tag: tags.standard(tags.variableName), color: "var(--cm-constant)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: tags.invalid, color: "var(--destructive)" },
]);

// Chrome (background, gutters, selection, cursor) driven entirely by the app's
// existing oklch tokens — no colors of its own, so it inherits theme changes
// for free.
const chrome = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--code)",
    color: "var(--foreground)",
    fontSize: "var(--code-fs, 13px)",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    lineHeight: "var(--code-lh, 22px)",
    caretColor: "var(--primary)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in oklch, var(--primary) 25%, transparent)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--muted) 60%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "color-mix(in oklch, var(--muted) 60%, transparent)" },
  ".cm-gutters": {
    backgroundColor: "var(--code)",
    color: "var(--muted-foreground)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-lineNumbers .cm-gutterElement": { fontSize: "var(--gutter-fs, 11px)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)" },
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: "color-mix(in oklch, var(--primary) 18%, transparent)",
    outline: "none",
  },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklch, var(--primary) 20%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in oklch, var(--primary) 35%, transparent)" },
});

export function codeMirrorAppTheme(): Extension[] {
  return [chrome, syntaxHighlighting(highlightStyle)];
}
