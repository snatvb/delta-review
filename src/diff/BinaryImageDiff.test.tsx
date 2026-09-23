// The binary image compare card (#binary): which sides render per change status,
// the size captions, and the fallbacks when a side is missing or fails to load.
import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BinaryImageDiff } from "./BinaryImageDiff";
import type { BinaryFileDiff, BlobSide } from "../types";

const both: BinaryFileDiff = { oldSize: 45, newSize: 1536 };
const srcOf = (side: BlobSide, mime: string) => `blob://${side}/${mime}`;

describe("BinaryImageDiff", () => {
  it("shows old and new side by side for a modified image, with sizes", () => {
    render(<BinaryImageDiff binary={both} status="modified" mime="image/png" srcOf={srcOf} />);
    expect(screen.getByAltText("Old version")).toHaveAttribute("src", "blob://old/image/png");
    expect(screen.getByAltText("New version")).toHaveAttribute("src", "blob://new/image/png");
    expect(screen.getByText("45 B")).toBeInTheDocument();
    expect(screen.getByText("1.5 KB")).toBeInTheDocument();
  });

  it("shows only the new pane for an added image", () => {
    render(<BinaryImageDiff binary={both} status="added" mime="image/png" srcOf={srcOf} />);
    expect(screen.queryByAltText("Old version")).toBeNull();
    expect(screen.getByAltText("New version")).toHaveAttribute("src", "blob://new/image/png");
  });

  it("shows only the old pane for a deleted image", () => {
    render(<BinaryImageDiff binary={both} status="deleted" mime="image/png" srcOf={srcOf} />);
    expect(screen.getByAltText("Old version")).toBeInTheDocument();
    expect(screen.queryByAltText("New version")).toBeNull();
  });

  it("renders an image under the preview cap", () => {
    const big: BinaryFileDiff = { oldSize: null, newSize: 12 * 1024 * 1024 };
    render(<BinaryImageDiff binary={big} status="added" mime="image/png" srcOf={srcOf} />);
    expect(screen.getByAltText("New version")).toBeInTheDocument();
    expect(screen.getByText("12 MB")).toBeInTheDocument();
  });

  it("explains a side over the preview cap instead of loading it", () => {
    const huge: BinaryFileDiff = { oldSize: null, newSize: 20 * 1024 * 1024 };
    render(<BinaryImageDiff binary={huge} status="added" mime="image/png" srcOf={srcOf} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Too large to preview — 20 MB")).toBeInTheDocument();
  });

  it("explains a side whose image fails to load", () => {
    render(<BinaryImageDiff binary={both} status="added" mime="image/png" srcOf={srcOf} />);
    fireEvent.error(screen.getByAltText("New version"));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Preview failed to load")).toBeInTheDocument();
  });

  it("shows a loading note while the fetch is in flight", () => {
    render(<BinaryImageDiff binary={undefined} status="modified" mime="image/png" srcOf={srcOf} />);
    expect(screen.getByText("Loading image…")).toBeInTheDocument();
  });
});
