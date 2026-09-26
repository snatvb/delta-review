// A highlight.js grammar for RON (Rusty Object Notation), registered into
// @git-diff-view's lowlight engine so .ron files stop falling through to
// auto-detection. Token categories mirror GitHub's rendering, which uses the
// vscode-ron TextMate grammar: field names before `:` → attr (JSON-key
// color), capitalized identifiers → type (struct names, enum variants),
// lowercase tuple-style calls → the same invoke styling Rust gets.
//
// highlight.js is only a transitive dependency (via @git-diff-view/lowlight),
// so this file stays structurally typed against the LanguageFn shape that
// engine.register() expects; the one cast at the call site keeps tsc honest.

import { highlighter } from "@git-diff-view/file";

import { RON_EXTENSIONS, RON_LITERALS, RON_OPTIONS } from "./ronTokens";

// Minimal slices of highlight.js's grammar types, mirroring gdscriptHljs.ts.
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
  C_LINE_COMMENT_MODE: Mode;
  COMMENT(begin: RegExp | string, end: RegExp | string, opts?: { contains?: string[] }): Mode;
};

export function ronGrammar(hljs: HljsApi): Grammar {
  const digit = "[0-9](?:_?[0-9])*";
  // Integer/float suffixes are part of the literal (a \b between digit and
  // `u8` never matches), same trick as rust.js's NUMBER_SUFFIX.
  const suffix = "(?:i8|i16|i32|i64|i128|u8|u16|u32|u64|u128|f32|f64)?";

  return {
    name: "RON",
    aliases: ["ron"],
    // true/false through the keyword machinery (→ hljs-literal).
    keywords: { $pattern: /[A-Za-z_]\w*/, literal: RON_LITERALS.join(" ") },
    contains: [
      // Nested block comments, like rust.js.
      hljs.COMMENT("/\\*", "\\*/", { contains: ["self"] }),
      hljs.C_LINE_COMMENT_MODE,
      // Extension/tooling header: #![enable(unwrap_newtypes)] / #![type = "…"].
      {
        begin: /#!\[/,
        end: /\]/,
        scope: "meta",
        contains: [
          { match: new RegExp(`\\b(?:${RON_EXTENSIONS.join("|")})\\b`), scope: "keyword" },
          { begin: /"/, end: /"/, scope: "string", contains: [hljs.BACKSLASH_ESCAPE] },
        ],
      },
      // Raw/byte-raw strings with any number of # — rust.js's idiom (\1 backrefs the hashes).
      { scope: "string", begin: /b?r(#*)"(.|\n)*?"\1(?!#)/ },
      // Plain and byte strings.
      { begin: /b?"/, end: /"/, scope: "string", contains: [hljs.BACKSLASH_ESCAPE] },
      // Chars and byte chars — RON has no lifetimes, so ' always starts one.
      { begin: /b?'/, end: /'/, scope: "string", contains: [hljs.BACKSLASH_ESCAPE] },
      // Numbers before identifier rules: hex/bin/oct with _, signed decimals
      // (leading-dot, trailing-dot), exponents, suffixes, and inf/NaN words.
      {
        scope: "number",
        relevance: 0,
        variants: [
          { begin: `[+-]?\\b0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*${suffix}` },
          { begin: `[+-]?\\b0[bB][01](?:_?[01])*${suffix}` },
          { begin: `[+-]?\\b0[oO][0-7](?:_?[0-7])*${suffix}` },
          { begin: `[+-]?\\b(?:inf|NaN)\\b` },
          // The (?!\.) after the dot keeps `3..5` a range, not two floats.
          { begin: `[+-]?(?:\\b${digit}(?:\\.(?!\\.)[0-9_]*)?|\\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?${suffix}` },
        ],
      },
      // Field names: lowercase ident before `:` — exactly vscode-ron's rule,
      // so keys get the JSON-key color GitHub shows.
      { match: /[a-z_][A-Za-z0-9_]*(?=\s*:)/, scope: "attr" },
      { match: new RegExp(`\\b(?:${RON_OPTIONS.join("|")})\\b`), scope: "keyword" },
      // Engine/struct names, enum variants, capitalized map keys.
      { match: /\b[A-Z][A-Za-z0-9_]*\b/, scope: "type" },
      // Lowercase tuple-style calls — instant((…)), phased((…)) — reuse the
      // rust FUNCTION_INVOKE styling already themed in this app.
      { scope: "title.function.invoke", relevance: 0, match: /[a-z_][A-Za-z0-9_]*(?=\s*\()/ },
    ],
  };
}

let registered = false;

/** Teach the diff view's lowlight instance about RON. Idempotent. */
export function registerRonHighlighting(): void {
  if (registered) return;
  const engine = highlighter.getHighlighterEngine();
  engine.register("ron", ronGrammar as unknown as Parameters<typeof engine.register>[1]);
  registered = true;
}
