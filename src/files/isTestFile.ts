// Path conventions only: never hide a production file merely because its name
// contains "test" (latest.ts, testimonials.tsx, or testing/client.ts).
export function isTestFile(path: string): boolean {
  const parts = path.replace(/\\/g, "/").toLowerCase().split("/");
  const name = parts.pop() ?? "";
  return parts.some((part) => part === "test" || part === "tests" || part === "__tests__")
    || /\.(?:test|spec)\./.test(name)
    || /_test\./.test(name)
    || name.startsWith("test_");
}
