import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { getFileTypeFilter, setFileTypeFilter } from "../fileTypeFilterPref";
import { GeneralSection } from "./GeneralSection";

beforeEach(() => {
  setFileTypeFilter("only-tests");
});

it("uses the shared three-way file filter instead of a conflicting Hide tests toggle", () => {
  render(<GeneralSection />);
  const filter = screen.getByRole("combobox", { name: "File types" });
  expect(filter).toHaveValue("only-tests");
  expect(screen.queryByRole("group", { name: "Hide test files" })).not.toBeInTheDocument();
  fireEvent.change(filter, { target: { value: "exclude-tests" } });
  expect(getFileTypeFilter()).toBe("exclude-tests");
  expect(screen.getByRole("option", { name: "All files" })).toBeInTheDocument();
});
