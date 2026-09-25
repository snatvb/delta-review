import { generateDiffFile } from "@git-diff-view/file";
import type { FileDiff } from "../types";
import { registerGdscriptHighlighting } from "./gdscriptHljs";
import { langFromFilename } from "./lang";

export function toDiffFile(fd: FileDiff) {
  // The engine falls back to auto-detection for unregistered languages, which
  // misreads GDScript as ini — make sure ours is in before the first init().
  registerGdscriptHighlighting();
  const oldName = fd.oldFileName ?? "";
  const newName = fd.newFileName ?? "";
  const file = generateDiffFile(
    oldName,
    fd.oldContent ?? "",
    newName,
    fd.newContent ?? "",
    langFromFilename(oldName),
    langFromFilename(newName)
  );
  file.init();
  return file;
}
