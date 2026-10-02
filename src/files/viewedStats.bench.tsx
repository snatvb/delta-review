// src/files/viewedStats.bench.ts
//
// The "unviewed-only totals" experiment (#viewed-stats): what one click on a
// viewed checkbox costs on a large review, with the pref off vs on.
//
// A viewed flip recomputes, per render:
//   1. the `viewedFiles` Set (Workspace memo),
//   2. the header totals (sumChangeStats — the only thing the pref changes),
//   3. the FilesPanel re-render itself (tree rollup + windowed rows).
// Nothing else moves: no IPC, no git work, the diff snapshot cache is untouched.
//
// Run:  npx vitest bench src/files/viewedStats.bench.ts --run
// NOTE: absolute times come from happy-dom/node, not a real browser — compare
// variants against each other, and read the pure-compute numbers as the real
// per-click cost (they run identically in production).
import { bench, describe } from "vitest";
import { render } from "@testing-library/react";
import { reviewOrder } from "./buildTree";
import { sumChangeStats } from "./changeStats";
import { FilesPanel } from "./FilesPanel";
import type { FileEntry, FileStatus } from "../types";

// Deterministic synthetic review: `n` files spread over packages of 50, mixed
// statuses and varied +/− counts — the shape of a busy agent's big commit.
function makeFiles(n: number): FileEntry[] {
  const statuses: FileStatus[] = ["modified", "modified", "modified", "added", "deleted"];
  const files: FileEntry[] = [];
  for (let i = 0; i < n; i++) {
    files.push({
      path: `src/pkg-${Math.floor(i / 50)}/file-${i}.ts`,
      status: statuses[i % statuses.length],
      additions: (i % 37) + 1,
      deletions: (i % 23) + 1,
      binary: false,
    });
  }
  return files;
}

const viewedSet = (files: FileEntry[], frac: number) =>
  new Set(files.slice(0, Math.floor(files.length * frac)).map((f) => f.path));

for (const n of [2_500, 10_000]) {
  const files = makeFiles(n);
  const none = new Set<string>();
  const half = viewedSet(files, 0.5);
  const most = viewedSet(files, 0.9);

  describe(`per-click pure compute — ${n.toLocaleString()} files`, () => {
    bench("viewedFiles Set rebuild (Workspace memo)", () => {
      void new Set(files.slice(0, Math.floor(n * 0.9)).map((f) => f.path));
    });

    bench("header totals — pref OFF (today's reduce)", () => {
      void sumChangeStats(files, none, false);
    });

    bench("header totals — pref ON, 50% viewed", () => {
      void sumChangeStats(files, half, true);
    });

    bench("header totals — pref ON, 90% viewed", () => {
      void sumChangeStats(files, most, true);
    });
  });

  describe(`per-open context (unchanged by the pref) — ${n.toLocaleString()} files`, () => {
    bench("reviewOrder (sort + partition)", () => {
      void reviewOrder(files);
    });
  });
}

// The full render path of one viewed flip at review scale: same rerender the
// existing collapse-on-view behavior already triggers, now also re-summing the
// totals. happy-dom inflates DOM costs vs a real browser — treat this as an
// upper bound and a before/after comparator, not a frame-time prediction.
describe("FilesPanel re-render on a viewed flip — 2,500 files (happy-dom, upper bound)", () => {
  const files = makeFiles(2_500);
  const none = new Set<string>();
  const half = viewedSet(files, 0.5);
  const utils = render(
    <FilesPanel files={files} selected={null} onSelect={() => {}} viewedFiles={none} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />,
  );
  let flip = false;

  bench("rerender (viewed Set flips half the review)", () => {
    flip = !flip;
    utils.rerender(
      <FilesPanel files={files} selected={null} onSelect={() => {}} viewedFiles={flip ? half : none} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />,
    );
  });
});
