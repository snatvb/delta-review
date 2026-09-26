// Word lists for RON (Rusty Object Notation) highlighting, shared by the
// diff-view highlight.js grammar (ronHljs.ts) and the CodeMirror stream mode
// (ronLanguage.ts). RON has almost no keywords — these lists are the whole
// vocabulary; everything else is punctuation, literals and identifiers.

// `#![enable(...)]` extension names (docs/extensions.md) plus the header verb.
export const RON_EXTENSIONS = [
  "enable",
  "unwrap_newtypes",
  "implicit_some",
  "unwrap_variant_newtypes",
  "explicit_struct_names",
];

// Option constructors — plain identifiers to the parser, but worth coloring.
export const RON_OPTIONS = ["Some", "None"];

// Boolean literals.
export const RON_LITERALS = ["true", "false"];
