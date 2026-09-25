// A CodeMirror StreamLanguage mode for GDScript (Godot 4), used by the
// file-edit overlay. Word lists live in gdscriptTokens.ts, shared with the
// diff view's highlight.js grammar. This is a coloring-oriented tokenizer —
// it deliberately has no syntax tree, so block folding and auto-indent after
// `:` are out of scope for .gd (see CLAUDE.md's editor-surface notes).

import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

import {
  GDSCRIPT_BUILTINS,
  GDSCRIPT_CONSTANTS,
  GDSCRIPT_CONTROL_KEYWORDS,
  GDSCRIPT_KEYWORDS,
  GDSCRIPT_LITERALS,
} from "./gdscriptTokens";

const CONTROL = new Set(GDSCRIPT_CONTROL_KEYWORDS);
const KEYWORDS = new Set(GDSCRIPT_KEYWORDS);
const LITERALS = new Set(GDSCRIPT_LITERALS);
const CONSTANTS = new Set(GDSCRIPT_CONSTANTS);
const BUILTINS = new Set(GDSCRIPT_BUILTINS);
// Operators spelled as words (`and`/`in`/`is`…), split out of the control set
// so they get the operator-keyword tag rather than the control one.
const WORD_OPS = new Set(["and", "or", "not", "in", "is", "as"]);
// The word right after one of these is a definition site (func name, class…).
const NAME_AFTER = new Set(["func", "signal", "class", "class_name", "extends", "enum"]);

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/;
// Hex and binary first, then floats (optionally with exponent), then ints.
const NUMBER = /0[xX](_?[0-9a-fA-F])+|0[bB](_?[01])+|(?:[0-9]_?)*\.?[0-9](?:_?[0-9])*(?:[eE][+-]?[0-9](?:_?[0-9])*)?/;

type State = {
  /** Delimiter (`"""`/`'''`) while inside a multi-line string. */
  triple: string | null;
  /** Introducer word (`func`, `class_name`, …) whose following word is a name. */
  after: string | null;
};

/** Consume a string body (escapes allowed) up to and including the closing quote. */
function readQuotedBody(stream: { eol(): boolean; next(): string | void }, quote: string) {
  let escaped = false;
  while (!stream.eol()) {
    const c = stream.next();
    if (escaped) escaped = false;
    else if (c === "\\") escaped = true;
    else if (c === quote) break;
  }
}

export const gdscriptLanguage = StreamLanguage.define<State>({
  name: "gdscript",
  languageData: { commentTokens: { line: "#" } },
  startState: () => ({ triple: null, after: null }),
  copyState: (s) => ({ triple: s.triple, after: s.after }),
  token(stream, state) {
    if (state.triple) {
      if (stream.match(state.triple)) state.triple = null;
      else if (!stream.skipTo(state.triple)) stream.skipToEnd();
      return "string";
    }

    if (stream.eatSpace()) return null;

    const ch = stream.peek()!;

    if (ch === "#") {
      stream.skipToEnd();
      state.after = null;
      return "comment";
    }

    // Triple-quoted strings first so the single-quote path can't eat their opener.
    const opener = stream.string.slice(stream.pos, stream.pos + 3);
    if (opener === '"""' || opener === "'''") {
      stream.pos += 3;
      if (stream.match(opener)) return "string"; // """""" — open and shut
      state.triple = opener;
      if (!stream.skipTo(opener)) stream.skipToEnd();
      return "string";
    }

    if (ch === '"' || ch === "'") {
      stream.next();
      readQuotedBody(stream, ch);
      state.after = null;
      return "string";
    }

    // StringName/NodePath literals (&"…", ^"…") — only with a quote right after;
    // bare & and ^ are bitwise operators and must stay unstyled.
    if ((ch === "&" || ch === "^") && stream.string[stream.pos + 1] === '"') {
      stream.next();
      stream.next();
      readQuotedBody(stream, '"');
      state.after = null;
      return "string";
    }

    // Scene-tree paths: $Node/Child, %Unique, $"With spaces" — a path must
    // start with a letter or a quote; a bare % (modulo) stays unstyled.
    if ((ch === "$" || ch === "%") && /[A-Za-z_"]/.test(stream.string[stream.pos + 1] ?? "")) {
      stream.next();
      if (stream.peek() === '"' || stream.peek() === "'") {
        const quote = stream.next()!;
        readQuotedBody(stream, quote);
      } else {
        stream.eatWhile(/[A-Za-z0-9_/%]/);
      }
      state.after = null;
      return "string";
    }

    if (ch === "@") {
      stream.next();
      stream.eatWhile(/[A-Za-z0-9_.]/);
      state.after = null;
      return "keyword";
    }

    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(stream.string[stream.pos + 1] ?? ""))) {
      stream.match(NUMBER);
      state.after = null;
      return "number";
    }

    const word = (stream.match(IDENT) as RegExpMatchArray | null)?.[0];
    if (word) {
      const wasAfter = state.after;
      state.after = null;
      if (NAME_AFTER.has(word)) {
        state.after = word;
        return "keyword";
      }
      if (WORD_OPS.has(word)) return "operatorKeyword";
      if (CONTROL.has(word)) return "controlKeyword";
      if (KEYWORDS.has(word)) return "keyword";
      if (LITERALS.has(word)) return word === "null" ? "null" : "bool";
      if (CONSTANTS.has(word)) return "atom";
      // A builtin being *called* is a call site (entity color, like the diff
      // view's invoke rule); only a bare reference keeps the builtin color.
      if (BUILTINS.has(word)) return stream.peek() === "(" ? "variableName.function" : "variableName.standard";
      if (wasAfter === "func" || wasAfter === "signal") return "variableName.function";
      if (wasAfter) return "className";
      if (/^[A-Z]/.test(word)) return "typeName";
      if (stream.peek() === "(") return "variableName.function";
      return null;
    }

    stream.next();
    state.after = null;
    return null;
  },
});

export function gdscript(): Extension {
  return gdscriptLanguage;
}
