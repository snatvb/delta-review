// The binary image compare card (#binary): which sides render per change status,
// the size captions, and the too-large fallback when the backend capped a side.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BinaryImageDiff } from "./BinaryImageDiff";
import type { BinaryFileDiff } from "../types";

const both: BinaryFileDiff = { oldSize: 45, newSize: 1536, oldData: "AAAA", newData: "BBBB" };

describe("BinaryImageDiff", () => {
  it("shows old and new side by side for a modified image, with sizes", () => {
    render(<BinaryImageDiff binary={both} status="modified" mime="image/png" />);
    expect(screen.getByAltText("Old version")).toHaveAttribute("src", "data:image/png;base64,AAAA");
    expect(screen.getByAltText("New version")).toHaveAttribute("src", "data:image/png;base64,BBBB");
    expect(screen.getByText("45 B")).toBeInTheDocument();
    expect(screen.getByText("1.5 KB")).toBeInTheDocument();
  });

  it("shows only the new pane for an added image", () => {
    render(<BinaryImageDiff binary={both} status="added" mime="image/png" />);
    expect(screen.queryByAltText("Old version")).toBeNull();
    expect(screen.getByAltText("New version")).toHaveAttribute("src", "data:image/png;base64,BBBB");
  });

  it("shows only the old pane for a deleted image", () => {
    render(<BinaryImageDiff binary={both} status="deleted" mime="image/png" />);
    expect(screen.getByAltText("Old version")).toBeInTheDocument();
    expect(screen.queryByAltText("New version")).toBeNull();
  });

  it("explains a side over the preview cap instead of rendering an img", () => {
    const capped: BinaryFileDiff = { oldSize: null, newSize: 12 * 1024 * 1024, oldData: null, newData: null };
    render(<BinaryImageDiff binary={capped} status="added" mime="image/png" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Too large to preview — 12 MB")).toBeInTheDocument();
    expect(screen.getByText("12 MB")).toBeInTheDocument(); // caption still reports the size
  });

  it("shows a loading note while the fetch is in flight", () => {
    render(<BinaryImageDiff binary={undefined} status="modified" mime="image/png" />);
    expect(screen.getByText("Loading image…")).toBeInTheDocument();
  });
});
