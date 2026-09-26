import { describe, it, expect } from "vitest";
import { tags, type Tag } from "@lezer/highlight";

import { codeMirrorHighlightStyle } from "./codeMirrorTheme";
import { codeMirrorLanguageFor } from "./codeMirrorLang";
import { loadCodeMirrorLanguage } from "./loadCodeMirrorLanguage";

// The edit overlay must color EVERY token kind the in-repo stream modes emit
// (ronLanguage.ts, gdscriptLanguage.ts). A tag with no rule here falls back to
// plain foreground — and since .ron files are dominated by field names, a
// missing propertyName rule made the editor read as unhighlighted even though
// the diff pane colored the same file.
describe("codeMirrorHighlightStyle", () => {
  const styled = (tag: Tag) => codeMirrorHighlightStyle.style([tag]);

  it("styles every token kind the RON stream mode emits", () => {
    for (const tag of [
      tags.keyword, tags.comment, tags.string, tags.number, tags.bool, tags.null,
      tags.typeName, tags.propertyName, tags.function(tags.variableName),
    ]) {
      expect(styled(tag), String(tag)).not.toBeNull();
    }
  });

  it("styles every token kind the GDScript stream mode emits", () => {
    for (const tag of [
      tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.comment,
      tags.string, tags.number, tags.bool, tags.null, tags.atom,
      tags.className, tags.typeName, tags.function(tags.variableName),
      tags.standard(tags.variableName),
    ]) {
      expect(styled(tag), String(tag)).not.toBeNull();
    }
  });

  it("maps field names to the same color group as numbers (mirrors hljs-attr)", () => {
    // The diff pane groups .hljs-attr with .hljs-number in both palettes; the
    // editor must keep that grouping so the two surfaces read as one system.
    expect(styled(tags.propertyName)).toBe(styled(tags.number));
  });

  it("covers the languages the overlay can load for .gd/.ron files", async () => {
    expect(codeMirrorLanguageFor("game/player.gd")).toBe("gdscript");
    expect(codeMirrorLanguageFor("game/spells/combustion.ron")).toBe("ron");
    expect(await loadCodeMirrorLanguage("gdscript")).toHaveLength(1);
    expect(await loadCodeMirrorLanguage("ron")).toHaveLength(1);
  });
});
