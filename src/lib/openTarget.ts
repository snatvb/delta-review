import { api } from "../api";
import { notify } from "./notify";
import type { DiffMode } from "../types";

/** Open a target for review, surfacing a failure (a moved or deleted repo is the
 *  common one) in a modal instead of leaving the click with no visible effect. */
export async function openTarget(repoPath: string, mode: DiffMode, base?: string): Promise<void> {
  try {
    await api.openTarget(repoPath, mode, base);
  } catch (e) {
    notify({ title: "Can’t open this repository", message: e instanceof Error ? e.message : String(e) });
  }
}
