import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";

import { highlighter } from "@git-diff-view/file";

import { toDiffFile } from "./toDiffFile";
import { registerRonHighlighting } from "./ronHljs";
import { ron } from "./ronLanguage";
import type { FileDiff } from "../types";

// Comprehensive sample from the RON research report: extensions header, raw
// and byte strings, chars, every number form, maps with string and enum keys,
// newtype payloads, Some/None, ranges, comments, trailing commas.
const SAMPLE = `#![enable(unwrap_newtypes, implicit_some)]
GameConfig( /* nested /* comments */ ok */
    window_title: r#"raw "quote" text"#,
    bytes: b"\\x65\\x73", banner: br#"raw"#,
    hotkey: 'q', esc: '\\u{1F600}',
    sens: -1.5e-3, dot: .5, half: 1., max: inf, reset: NaN,
    big: 17543403292272803279, tiny: 255u8, f: 2.0f32,
    bindings: { "up": Up, Sword2h: "idle" },
    mods: [instant((clip: "x", speed: 1.3)), phased((windup: "y"))],
    school: Some(Fire), alt: None,
    fullscreen: true, vsync: false,
    range: 3..=7, // trailing comma below
    pos: (800, 600, +5),
)
`;

// The shapes actually used in our Godot project's spell/config files.
const DEATH_BATTLE_SAMPLE = `(
    id: "combustion",
    cast: Fire(
        cost: Mana(amount: 25),
        delay_ms: 60_000,
    ),
    hit: ApplyStatus((name: "burning", stacks: 3)),
    animations: { Sword2h: "great_sword_idle" },
    crit: None,
    periodic: Some(0.25),
)
`;

/** Collect every hljs class produced for the given source. */
function hljsClasses(source: string): Set<string> {
  registerRonHighlighting();
  const engine = highlighter.getHighlighterEngine();
  const ast = engine.highlight("ron", source);
  const classes = new Set<string>();
  const walk = (node: { properties?: { className?: string[] }; children?: unknown[] }) => {
    for (const c of node.properties?.className ?? []) classes.add(c);
    for (const child of node.children ?? []) walk(child as never);
  };
  walk(ast as never);
  return classes;
}

/** (class, text) pairs for span elements — for precise assertions. */
function hljsSpans(source: string): [string, string][] {
  registerRonHighlighting();
  const ast = highlighter.getHighlighterEngine().highlight("ron", source);
  const pairs: [string, string][] = [];
  const walk = (n: { type?: string; properties?: { className?: string[] }; children?: unknown[] }) => {
    if (n.type === "element") {
      const cls = (n.properties?.className ?? []).join(".");
      const texts: string[] = [];
      const grab = (m: { value?: string; children?: unknown[] }) => {
        if (typeof m.value === "string") texts.push(m.value);
        for (const ch of m.children ?? []) grab(ch as never);
      };
      grab(n as never);
      if (cls && texts.length) pairs.push([cls, texts.join("")]);
    }
    for (const child of n.children ?? []) walk(child as never);
  };
  walk(ast as never);
  return pairs;
}

describe("ron diff-view grammar", () => {
  it("registers ron with the lowlight engine", () => {
    registerRonHighlighting();
    expect(highlighter.getHighlighterEngine().registered("ron")).toBe(true);
  });

  it("highlights the core token kinds", () => {
    const classes = hljsClasses(SAMPLE);
    for (const expected of [
      "hljs-attr", // window_title, cost, stacks — GitHub's field color
      "hljs-type", // GameConfig, Fire, Mana, Up, Sword2h
      "hljs-string", // "combustion", r#"…"#, 'q', b"…"
      "hljs-number", // 60_000, .5, inf, 255u8, NaN
      "hljs-literal", // true/false — via RON_LITERALS
      "hljs-comment", // /* nested */ and //
      "hljs-keyword", // Some, None, enable
    ]) {
      expect(classes, expected).toContain(expected);
    }
  });

  it("colors call-shaped payloads with the invoke styling", () => {
    const classes = hljsClasses(SAMPLE);
    expect(classes).toContain("invoke__");
  });

  it("keeps ranges out of the number rule", () => {
    const spans = hljsSpans("range: 3..=7,\n");
    expect(spans.map(([, t]) => t)).not.toContain("3..");
    expect(spans).toContainEqual(["hljs-number", "3"]);
    expect(spans).toContainEqual(["hljs-number", "7"]);
  });

  it("treats inf-word identifiers as identifiers", () => {
    const spans = hljsSpans("info: 1,\n");
    expect(spans).toContainEqual(["hljs-attr", "info"]);
  });

  it("flows through toDiffFile: .ron gets syntax lines from our grammar", () => {
    const fd: FileDiff = {
      oldFileName: "spell.ron", oldContent: "(id: \"a\")\n",
      newFileName: "spell.ron", newContent: "(id: \"b\")\n",
      status: "modified", binary: false,
    };
    const file = toDiffFile(fd);
    file.buildSplitDiffLines();
    const line = file.getNewSyntaxLine(1);
    const classes = new Set<string>();
    for (const { node, wrapper } of line?.nodeList ?? []) {
      for (const c of wrapper?.properties?.className ?? node.properties?.className ?? []) classes.add(c);
    }
    expect(classes).toContain("hljs-attr");
    expect(classes).toContain("hljs-string");
  });

  it("handles the death-battle corpus shapes", () => {
    const classes = hljsClasses(DEATH_BATTLE_SAMPLE);
    for (const expected of ["hljs-attr", "hljs-type", "hljs-string", "hljs-number", "hljs-keyword"]) {
      expect(classes, expected).toContain(expected);
    }
  });
});

describe("ron CodeMirror mode", () => {
  function tokens(doc: string): { name: string; text: string }[] {
    const state = EditorState.create({ doc, extensions: [ron()] });
    const tree = ensureSyntaxTree(state, doc.length);
    expect(tree).toBeTruthy();
    const out: { name: string; text: string }[] = [];
    tree!.iterate({
      enter: (node) => {
        if (node.name && node.name !== "Document") out.push({ name: node.name, text: doc.slice(node.from, node.to) });
      },
    });
    return out;
  }

  it("produces the expected token kinds", () => {
    const names = tokens(SAMPLE).map((t) => t.name);
    for (const expected of ["keyword", "string", "number", "comment", "typeName", "propertyName", "bool", "variableName.function"]) {
      expect(names, expected).toContain(expected);
    }
  });

  it("marks field names but not map-enum keys as properties", () => {
    const ts = tokens('window_size: (800, 600),\nanim: { Sword2h: "idle" },\n');
    expect(ts).toContainEqual({ name: "propertyName", text: "window_size" });
    expect(ts).toContainEqual({ name: "typeName", text: "Sword2h" });
  });

  it("keeps nested block comments together", () => {
    const ts = tokens("a: 1, /* one /* two */ one */ b: 2,\n");
    const comments = ts.filter((t) => t.name === "comment").map((t) => t.text).join("|");
    expect(comments).toContain("/* one ");
    expect(comments).toContain(" two ");
    expect(comments).toContain(" one */");
  });

  it("keeps raw strings together across lines", () => {
    const ts = tokens('title: r#"line one\nline two"#,\n');
    const texts = ts.filter((t) => t.name === "string").map((t) => t.text);
    expect(texts).toContain('r#"line one');
    expect(texts).toContain('line two"#');
  });

  it("colors numbers but not ranges or inf-words", () => {
    const ts = tokens("range: 3..=7, info: 1, neg: -12.5e-3, tiny: 255u8,\n");
    expect(ts).toContainEqual({ name: "number", text: "3" });
    expect(ts).toContainEqual({ name: "number", text: "7" });
    expect(ts).toContainEqual({ name: "number", text: "-12.5e-3" });
    expect(ts).toContainEqual({ name: "number", text: "255u8" });
    expect(ts).toContainEqual({ name: "propertyName", text: "info" });
    expect(ts.some((t) => t.name === "number" && t.text === "3..")).toBe(false);
  });
});
