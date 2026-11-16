import { fireEvent, render, screen, within } from "@testing-library/react";
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

it("marks the chosen On/Off side and moves the mark on click despite the tooltip wrapper", () => {
  render(<GeneralSection />);
  const group = screen.getByRole("radiogroup", { name: "Hide viewed files" });
  const on = within(group).getByRole("radio", { name: "On" });
  const off = within(group).getByRole("radio", { name: "Off" });
  const selected = [on, off].find((item) => item.getAttribute("data-state") === "on");
  expect(selected).toBeDefined();
  const other = selected === on ? off : on;
  fireEvent.click(other);
  expect(other).toHaveAttribute("data-state", "on");
  expect(selected).toHaveAttribute("data-state", "off");
});
