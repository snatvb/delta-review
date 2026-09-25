import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";

import { highlighter } from "@git-diff-view/file";

import { toDiffFile } from "./toDiffFile";
import { registerGdscriptHighlighting } from "./gdscriptHljs";
import { gdscript } from "./gdscriptLanguage";
import type { FileDiff } from "../types";

// Representative GDScript 2.0 (Godot 4) sample, mirroring the idioms actually
// used in our Godot projects: typed declarations, &"StringName", %Unique and
// $Node paths, annotations, lambdas, typed for-loops.
const SAMPLE = `extends CharacterBody2D
class_name Player

signal health_changed(new_health: int)

@export var speed := 300.0
@onready var sprite: Sprite2D = $Sprite2D
@export_range(0, 100, 1) var hp: int = 100
static var inst: Player

const MAX_JUMPS := 2
const MAGIC := 0xff
const LAYER := 1 << 1
var state := State.IDLE

func _ready() -> void:
	var tween := create_tween()
	tween.finished.connect(func() -> void: sprite.visible = false)
	print("готов", speed)
	for lib: StringName in libs:
		print(lib)
	if hp > 0 and not is_on_floor():
		await get_tree().create_timer(0.1).timeout
	match state:
		State.IDLE: pass
		_: pass
	if Input.is_action_just_pressed(&"jump"):
		emit_signal(&"health_changed", hp)
	hp = clampi(hp - 1, 0, 100)
	%HealthBar.update(hp)
`;

/** Collect every hljs class produced for the given source. */
function hljsClasses(source: string): Set<string> {
  registerGdscriptHighlighting();
  const engine = highlighter.getHighlighterEngine();
  const ast = engine.highlight("gd", source);
  const classes = new Set<string>();
  const walk = (node: { properties?: { className?: string[] }; children?: unknown[] }) => {
    for (const c of node.properties?.className ?? []) classes.add(c);
    for (const child of node.children ?? []) walk(child as never);
  };
  walk(ast as never);
  return classes;
}

describe("gdscript diff-view grammar", () => {
  it("registers gd and gdscript with the lowlight engine", () => {
    registerGdscriptHighlighting();
    const engine = highlighter.getHighlighterEngine();
    expect(engine.registered("gd")).toBe(true);
    expect(engine.registered("gdscript")).toBe(true);
  });

  it("highlights the core token kinds", () => {
    const classes = hljsClasses(SAMPLE);
    for (const expected of [
      "hljs-keyword", // func, var, if…
      "hljs-title", // _ready (func name), Player (class_name) — nested scopes
                    // like title.function render as ["hljs-title", "function_"]
      "hljs-string",
      "hljs-number", // 300.0, 0xff
      "hljs-type", // Sprite2D, Color, State
      "hljs-attribute", // @export
      "hljs-variable", // $Sprite2D, %HealthBar, &"jump"
      "hljs-built_in", // clampi, print
    ]) {
      expect(classes, expected).toContain(expected);
    }
  });

  it("highlights comments, literals and constants", () => {
    const classes = hljsClasses("# комментарий\nvar ok = true\nvar tau = TAU\n");
    expect(classes).toContain("hljs-comment");
    expect(classes).toContain("hljs-literal");
  });

  it("does not leak keywords into strings", () => {
    const classes = hljsClasses('x = "func var if print"\n');
    expect(classes).not.toContain("hljs-keyword");
    expect(classes).toContain("hljs-string");
  });

  it("keeps % as modulo when not followed by a path", () => {
    const classes = hljsClasses("var r = hp % 3\n");
    expect(classes.has("hljs-variable")).toBe(false);
  });

  it("flows through toDiffFile: .gd gets syntax lines from our grammar", () => {
    const fd: FileDiff = {
      oldFileName: "player.gd", oldContent: "var a = 1\n",
      newFileName: "player.gd", newContent: "var a = 2\n",
      status: "modified", binary: false,
    };
    const file = toDiffFile(fd);
    file.buildSplitDiffLines();
    const line = file.getNewSyntaxLine(1);
    const classes = new Set<string>();
    // hljs classes land on the wrapper span, not the inner text node.
    for (const { node, wrapper } of line?.nodeList ?? []) {
      for (const c of wrapper?.properties?.className ?? node.properties?.className ?? []) classes.add(c);
    }
    expect(classes).toContain("hljs-keyword");
  });
});

describe("gdscript CodeMirror mode", () => {
  /** Token names over the sample, as (name, text) pairs. */
  function tokens(doc: string): { name: string; text: string }[] {
    const state = EditorState.create({ doc, extensions: [gdscript()] });
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
    for (const expected of [
      "keyword", "controlKeyword", "operatorKeyword", "string", "number",
      "typeName", "variableName.function", "variableName.standard",
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it("marks func names and call sites as function variables", () => {
    const ts = tokens("func take_damage(amount: int) -> void:\n\ttake_damage(3)\n");
    expect(ts).toContainEqual({ name: "variableName.function", text: "take_damage" });
  });

  it("colors capitalized identifiers as types", () => {
    expect(tokens("var v: Vector2 = Vector2.ZERO\n")).toContainEqual({ name: "typeName", text: "Vector2" });
  });

  it("treats &-quoted names, $paths and %Unique as strings", () => {
    const ts = tokens('if a == &"jump":\n\t$UI/Label.text = ""\n\t%HealthBar.update(1)\n');
    expect(ts).toContainEqual({ name: "string", text: '&"jump"' });
    expect(ts).toContainEqual({ name: "string", text: "$UI/Label" });
    expect(ts).toContainEqual({ name: "string", text: "%HealthBar" });
  });

  it("keeps modulo and bitwise operators out of the string tokens", () => {
    const ts = tokens("var r = hp % 3\nvar m = a & b\nvar x = a ^ b\n");
    expect(ts.some((t) => t.name === "string")).toBe(false);
  });

  it("keeps triple-quoted strings together across lines", () => {
    const ts = tokens('var s = """a\nb"""\n');
    const texts = ts.filter((t) => t.name === "string").map((t) => t.text);
    // Adjacent string tokens merge; the body and both delimiters stay string-colored.
    expect(texts).toContain('"""a');
    expect(texts).toContain('b"""');
  });

  it("highlights comments", () => {
    expect(tokens("var a = 1 # комментарий\n")).toContainEqual({ name: "comment", text: "# комментарий" });
  });
});
