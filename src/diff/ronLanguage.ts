// A CodeMirror StreamLanguage mode for RON (Rusty Object Notation), used by
// the file-edit overlay. Word lists live in ronTokens.ts, shared with the
// diff view's highlight.js grammar. RON is line-agnostic (no indentation, no
// statement structure) — the tokenizer only needs state for the three
// constructs that can span lines: nested /* */ comments, raw strings, and
// plain strings left open at EOL.

import { StreamLanguage, type StringStream } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

import { RON_EXTENSIONS, RON_LITERALS, RON_OPTIONS } from "./ronTokens";

const EXTENSIONS = new Set(RON_EXTENSIONS);
const OPTIONS = new Set(RON_OPTIONS);
const LITERALS = new Set(RON_LITERALS);

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/;
// Numbers: hex/bin/oct with _, signed decimals (leading/trailing dot),
// exponents, Rust-style suffixes, and the inf/NaN float words (word-bounded
// so `info:` stays an identifier).
const NUMBER = /[+-]?(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|inf(?![\w])|NaN(?![\w])|[0-9][0-9_]*(\.(?!\.)[0-9_]*)?([eE][+-]?[0-9_]+)?|\.[0-9][0-9_]*([eE][+-]?[0-9]+)?)(i8|i16|i32|i64|i128|u8|u16|u32|u64|u128|f32|f64)?/;
const NUMBER_START = /^[+-]?(0[xXoObB]|inf(?![\w])|NaN(?![\w])|[0-9]|\.[0-9])/;
// A field name is an identifier whose next non-space character is `:` — the
// only place a bare identifier precedes a colon in RON.
const IS_FIELD = /^[\t ]*:/;
// Raw-string opener: b?r, any number of #, then a quote. Probed at token
// start so identifiers like `radius` never trigger it.
const RAW_OPEN = /b?r(#*)"/y;

type State = {
  /** `/* nesting depth while inside a block comment. */
  blockDepth: number;
  /** Closing delimiter (`"` + hashes) while inside a raw string. */
  rawClose: string | null;
  /** Quote char while a plain string is open across a line break. */
  plainQuote: string | null;
};

export const ronLanguage = StreamLanguage.define<State>({
  name: "ron",
  languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },
  startState: () => ({ blockDepth: 0, rawClose: null, plainQuote: null }),
  copyState: (s) => ({ blockDepth: s.blockDepth, rawClose: s.rawClose, plainQuote: s.plainQuote }),
  token(stream, state) {
    if (state.rawClose) {
      if (stream.match(state.rawClose)) state.rawClose = null;
      else if (!stream.skipTo(state.rawClose)) stream.skipToEnd();
      return "string";
    }

    if (state.plainQuote) {
      readQuotedBody(stream, state.plainQuote);
      state.plainQuote = stream.eol() ? state.plainQuote : null;
      return "string";
    }

    if (state.blockDepth > 0) return blockCommentToken(stream, state);

    if (stream.eatSpace()) return null;

    const ch = stream.peek()!;

    // #![enable(...)] / #![type = "…"] headers.
    if (ch === "#" && stream.match("#!", false)) {
      stream.pos += 2;
      return "keyword";
    }

    if (ch === "/" && stream.match("//", false)) {
      stream.skipToEnd();
      return "comment";
    }
    if (ch === "/" && stream.match("/*", false)) {
      stream.pos += 2;
      state.blockDepth = 1;
      return blockCommentToken(stream, state);
    }

    // Raw strings first — before the identifier path can eat `r`.
    RAW_OPEN.lastIndex = stream.pos;
    const raw = stream.string.match(RAW_OPEN);
    if (raw) {
      stream.pos += raw[0].length;
      const closer = '"' + raw[1];
      if (stream.match(closer)) return "string"; // empty r"" / r#""#
      state.rawClose = closer;
      if (!stream.skipTo(closer)) stream.skipToEnd();
      return "string";
    }

    if (ch === '"' || ch === "'") {
      const quote = stream.next()!;
      readQuotedBody(stream, quote);
      state.plainQuote = stream.eol() ? quote : null;
      return "string";
    }

    // Byte chars and byte strings: b'x', b"…" (plain quotes are handled above).
    const bytePrefixed = stream.string.slice(stream.pos, stream.pos + 2).match(/^b(['"])/);
    if (bytePrefixed) {
      stream.pos += 2;
      readQuotedBody(stream, bytePrefixed[1]);
      return "string";
    }

    if (/[0-9]/.test(ch) || NUMBER_START.test(stream.string.slice(stream.pos))) {
      stream.match(NUMBER);
      return "number";
    }

    const word = (stream.match(IDENT) as RegExpMatchArray | null)?.[0];
    if (word) {
      if (EXTENSIONS.has(word)) return "keyword";
      if (LITERALS.has(word)) return "bool";
      if (OPTIONS.has(word)) return "keyword";
      if (/^[A-Z]/.test(word)) return "typeName";
      if (IS_FIELD.test(stream.string.slice(stream.pos))) return "propertyName";
      if (stream.peek() === "(") return "variableName.function";
      return null;
    }

    stream.next();
    return null;
  },
});

/** Consume a block-comment body, tracking nesting. */
function blockCommentToken(stream: StringStream, state: State): string {
  while (!stream.eol()) {
    if (stream.match("/*")) {
      state.blockDepth++;
      continue;
    }
    if (stream.match("*/")) {
      state.blockDepth--;
      if (state.blockDepth === 0) return "comment";
      continue;
    }
    stream.next();
  }
  return "comment";
}

/** Consume a string body (escapes allowed) up to and including the closing quote. */
function readQuotedBody(stream: StringStream, quote: string) {
  let escaped = false;
  while (!stream.eol()) {
    const c = stream.next();
    if (escaped) escaped = false;
    else if (c === "\\") escaped = true;
    else if (c === quote) break;
  }
}

export function ron(): Extension {
  return ronLanguage;
}
