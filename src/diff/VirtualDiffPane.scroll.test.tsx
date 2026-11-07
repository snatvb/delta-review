import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VirtualDiffPane } from "./VirtualDiffPane";
import type { FileEntry, Target } from "../types";
import type { DiffLayout } from "./useDiffLayout";

vi.mock("../api", () => ({
  api: { getFileDiff: () => new Promise(() => {}) },
  __setInvokeForDev: vi.fn(),
}));

const target: Target = { repoPath: "/r", mode: "all-changes" };
const noop = () => {};
const entry = (path: string, additions: number): FileEntry => ({
  path, additions, deletions: 0, binary: false, status: "modified",
});
const files = [entry("before.ts", 40), entry("large.ts", 400), entry("next.ts", 400)];

function pane(files: FileEntry[], viewedFiles = new Set<string>(), layout: DiffLayout = "unified") {
  return (
    <VirtualDiffPane
      target={target} files={files} viewedFiles={viewedFiles} layout={layout} theme="light"
      comments={[]} onToggleViewed={noop} onAddComment={noop} onAddFileComment={noop}
      onEditComment={noop} onDeleteComment={noop} onToggleResolvedComment={noop}
    />
  );
}

function sectionTop(path: string) {
  const section = screen.getByRole("button", { name: `collapse ${path}` }).closest("[data-file]")!;
  return Number.parseFloat(section.parentElement!.style.top);
}

async function scrollTo(el: HTMLElement, top: number) {
  await act(async () => {
    el.scrollTop = top;
    fireEvent.scroll(el);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

describe("VirtualDiffPane viewed scroll anchoring", () => {
  beforeEach(() => {
    // happy-dom has no layout. Derive the scroll range from the virtual canvas,
    // including the browser's automatic clamp as soon as that canvas shrinks.
    const positions = new WeakMap<HTMLElement, number>();
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === "diff-pane" ? 600 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      const canvas = this.querySelector<HTMLElement>(".diff-tailwindcss-wrapper");
      return canvas ? Number.parseFloat(canvas.style.height) : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(function (this: HTMLElement) {
      return Math.min(positions.get(this) ?? 0, Math.max(0, this.scrollHeight - this.clientHeight));
    });
    vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(function (this: HTMLElement, top: number) {
      positions.set(this, Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight)));
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each(["unified", "split"] as const)("reveals the next file from its start when a viewed file disappears (%s)", async (layout) => {
    const c = render(pane(files, new Set(), layout));
    const el = screen.getByTestId("diff-pane");
    const top = sectionTop("large.ts");
    await scrollTo(el, top + 3000);

    c.rerender(pane([files[0], files[2]], new Set(["large.ts"]), layout));

    expect(el.scrollTop).toBe(top - 14);
    expect(screen.getByRole("button", { name: "collapse next.ts" })).toBeInTheDocument();
    expect(sectionTop("next.ts") - el.scrollTop).toBe(14);
  });

  it("keeps the collapsed header above the next file", async () => {
    const c = render(pane(files));
    const el = screen.getByTestId("diff-pane");
    const top = sectionTop("large.ts");
    await scrollTo(el, top + 3000);

    c.rerender(pane(files, new Set(["large.ts"])));

    expect(el.scrollTop).toBe(top - 14);
    expect(screen.getByRole("button", { name: "expand large.ts" })).toBeInTheDocument();
    expect(sectionTop("next.ts") - el.scrollTop).toBe(14 + 40 + 10);
  });

  it("preserves the code being read when a viewed file above it disappears", async () => {
    const c = render(pane(files));
    const el = screen.getByTestId("diff-pane");
    // The next file starts outside the mounted window; scroll there to mount it.
    await scrollTo(el, el.scrollHeight - 2000);
    const offset = el.scrollTop - sectionTop("next.ts");

    c.rerender(pane([files[0], files[2]], new Set(["large.ts"])));

    expect(el.scrollTop - sectionTop("next.ts")).toBe(offset);
  });

  it("syncs the virtual window even when the browser already clamped the scroll after collapse", async () => {
    const shortTail = [entry("large.ts", 400), entry("next.ts", 1)];
    const c = render(pane(shortTail));
    const el = screen.getByTestId("diff-pane");
    await scrollTo(el, 6000);
    expect(screen.queryByRole("button", { name: "collapse next.ts" })).not.toBeInTheDocument();

    c.rerender(pane(shortTail, new Set(["large.ts"])));

    expect(el.scrollTop).toBe(0);
    expect(screen.getByRole("button", { name: "expand large.ts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "collapse next.ts" })).toBeInTheDocument();
  });
});
