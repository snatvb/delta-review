import type { FileEntry } from "../types";

const GIANT_CHANGED_LINES = 500;

export const isGiant = (e: FileEntry): boolean => e.additions + e.deletions >= GIANT_CHANGED_LINES;
