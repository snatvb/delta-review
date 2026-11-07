import { describe, expect, it } from "vitest";
import { isTestFile } from "./isTestFile";

describe("isTestFile", () => {
  it.each([
    "src/auth.test.ts",
    "src/auth.test.scroll.tsx",
    "src/auth.spec.js",
    "src/auth_test.go",
    "src/auth_test.rs",
    "src/test_auth.py",
    "tests/auth.ts",
    "test/helpers/setup.ts",
    "src/__tests__/auth.tsx",
    "packages/core/tests/fixtures/data.json",
    "src/Auth.TEST.TSX",
    "src\\__tests__\\auth.tsx",
  ])("recognizes %s", (path) => {
    expect(isTestFile(path)).toBe(true);
  });

  it.each([
    "src/auth.ts",
    "src/latest.ts",
    "src/contest.ts",
    "src/testimonials.tsx",
    "src/testing/client.ts",
    "src/test-utils.ts",
    "src/tests.ts",
    "src/test.config.ts",
    "docs/testing.md",
    "vitest.config.ts",
    "",
  ])("does not hide unrelated file %s", (path) => {
    expect(isTestFile(path)).toBe(false);
  });
});
