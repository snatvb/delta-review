// A highlight.js grammar for GDScript (Godot 4), registered into
// @git-diff-view's lowlight engine so .gd files stop falling through to
// auto-detection (which misreads them as ini/properties). The structure
// mirrors highlight.js's own python grammar, which solves the same
// indentation-language problems.
//
// highlight.js is only a transitive dependency (via @git-diff-view/lowlight),
// so this file stays structurally typed against the LanguageFn shape that
// engine.register() expects; the one cast at the call site keeps tsc honest.

import { highlighter } from "@git-diff-view/file";

import {
  GDSCRIPT_BUILTINS,
  GDSCRIPT_CONSTANTS,
  GDSCRIPT_CONTROL_KEYWORDS,
  GDSCRIPT_KEYWORDS,
  GDSCRIPT_LITERALS,
  GDSCRIPT_TYPES,
} from "./gdscriptTokens";

// Minimal slices of highlight.js's grammar types: enough to describe what we
// build, without importing from a transitive dependency.
type Mode = {
  scope?: string | Record<number, string>;
  match?: RegExp | (RegExp | string)[];
  begin?: RegExp | string;
  end?: RegExp | string;
  variants?: Mode[];
  keywords?: Record<string, unknown>;
  contains?: Mode[];
  relevance?: number;
};
type Grammar = Mode & { name?: string; aliases?: string[]; unicodeRegex?: boolean };
type HljsApi = {
  BACKSLASH_ESCAPE: Mode;
  QUOTE_STRING_MODE: Mode;
  APOS_STRING_MODE: Mode;
  HASH_COMMENT_MODE: Mode;
};

export function gdscriptGrammar(hljs: HljsApi): Grammar {
  const digitpart = "[0-9](_?[0-9])*";

  return {
    name: "GDScript",
    aliases: ["gd", "gdscript"],
    keywords: {
      $pattern: /[A-Za-z_]\w*/,
      keyword: [...GDSCRIPT_CONTROL_KEYWORDS, ...GDSCRIPT_KEYWORDS],
      built_in: GDSCRIPT_BUILTINS,
      literal: [...GDSCRIPT_LITERALS, ...GDSCRIPT_CONSTANTS],
      type: GDSCRIPT_TYPES,
    },
    contains: [
      hljs.HASH_COMMENT_MODE,
      // StringName/NodePath literals (^"..", &"..") before plain strings eat the quote.
      { match: /[&^]("[^"\n]*"|'[^'\n]*')/, scope: "variable" },
      // Scene-tree paths: $Node/Child, %Unique, $"With spaces"
      { match: /[$%]("[^"\n]*"|'[^'\n]*'|[A-Za-z_][\w%/]*)/, scope: "variable" },
      {
        scope: "number",
        relevance: 0,
        variants: [
          { begin: `\\b0[xX](_?[0-9a-fA-F])+` },
          { begin: `\\b0[bB](_?[01])+` },
          { begin: `\\b(${digitpart})\\.(${digitpart})([eE][+-]?(${digitpart}))?` },
          { begin: `\\.(${digitpart})([eE][+-]?(${digitpart}))?` },
          { begin: `\\b(${digitpart})[eE][+-]?(${digitpart})` },
          { begin: `\\b${digitpart}\\.` },
          { begin: `\\b${digitpart}` },
        ],
      },
      // Triple-quoted strings first so the single-quote modes can't eat their opener.
      { begin: /"""/, end: /"""/, scope: "string", contains: [hljs.BACKSLASH_ESCAPE], relevance: 10 },
      { begin: /'''/, end: /'''/, scope: "string", contains: [hljs.BACKSLASH_ESCAPE], relevance: 10 },
      hljs.QUOTE_STRING_MODE,
      hljs.APOS_STRING_MODE,
      // @export_range(0, 10)-style annotations; the parens stay root-level so
      // their numbers/strings still get colored.
      { match: /@[A-Za-z_][\w.]*/, scope: "attribute" },
      { match: [/\bfunc/, /\s+/, /[A-Za-z_]\w*/], scope: { 1: "keyword", 3: "title.function" } },
      { match: [/\bsignal/, /\s+/, /[A-Za-z_]\w*/], scope: { 1: "keyword", 3: "title.function" } },
      { match: [/\bclass_name/, /\s+/, /[A-Za-z_][\w.]*/], scope: { 1: "keyword", 3: "title.class" } },
      { match: [/\bextends/, /\s+/, /[A-Za-z_][\w.]*/], scope: { 1: "keyword", 3: "title.class" } },
      { match: [/\bclass/, /\s+/, /[A-Za-z_]\w*/], scope: { 1: "keyword", 3: "title.class" } },
      { match: [/\benum/, /\s+/, /[A-Za-z_]\w*/], scope: { 1: "keyword", 3: "title.class" } },
      // Function and method call sites, borrowed from the rust grammar's
      // FUNCTION_INVOKE: any lowercase identifier invoked with (…). The scope
      // resolves to the same .hljs-title.function_ CSS the app already themes
      // (purple), so calls stand out from plain variables the way they do in
      // .rs diffs. Capitalized callers stay "type" (constructors); keywords
      // that can precede a paren — if(/while(/func( — are excluded.
      {
        scope: "title.function.invoke",
        relevance: 0,
        match: new RegExp(`\\b(?!${[...GDSCRIPT_CONTROL_KEYWORDS, ...GDSCRIPT_KEYWORDS].map((w) => `${w}\\b`).join("|")})[a-z_][A-Za-z0-9_]*(?=\\s*\\()`),
      },
      // Engine and user classes (Player, Node2D) — any capitalized identifier.
      { match: /\b[A-Z][A-Za-z0-9_]*/, scope: "type" },
    ],
  };
}

let registered = false;

/**
 * Teach the diff view's lowlight instance about GDScript. Idempotent, so a
 * caller can invoke it before every diff without tracking lifecycle itself.
 */
export function registerGdscriptHighlighting(): void {
  if (registered) return;
  const engine = highlighter.getHighlighterEngine();
  const grammar = gdscriptGrammar as unknown as Parameters<typeof engine.register>[1];
  // lowlight ignores a grammar's `aliases`, so register both keys explicitly.
  engine.register("gd", grammar);
  engine.register("gdscript", grammar);
  registered = true;
}
