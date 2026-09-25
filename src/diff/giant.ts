import type { FileEntry } from "../types";

const GIANT_CHANGED_LINES = 500;
const GIANT_BYTES = 2 * 1024 * 1024;

export const isGiantBySize = (e: FileEntry): boolean => (e.bytes ?? 0) >= GIANT_BYTES;

export const isGiant = (e: FileEntry): boolean => e.additions + e.deletions >= GIANT_CHANGED_LINES || isGiantBySize(e);
