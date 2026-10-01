// The image lightbox (#binary): the shell (filename, compare modes, zoom
// controls, captions) and the per-mode rendering of both sides. happy-dom never
// fires img onload and reports a 0×0 stage, so assertions stick to attributes
// and inline styles — the zero-size guards keep zoom/fit math at scale 1 there.
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ImageLightbox, type ImageLightboxSide } from "./ImageLightbox";

const oldSide: ImageLightboxSide = { side: "old", label: "Old", src: "blob://old/image/png", mime: "image/png", size: 45 };
const newSide: ImageLightboxSide = { side: "new", label: "New", src: "blob://new/image/png", mime: "image/png", size: 1536 };

describe("ImageLightbox", () => {
  it("shows the filename, per-side captions and both images by default", () => {
    render(<ImageLightbox path="assets/icons/logo.png" sides={[oldSide, newSide]} onClose={vi.fn()} />);
    expect(screen.getByText("logo.png")).toBeInTheDocument();
    expect(screen.getByText("Old 45 B")).toBeInTheDocument();
    expect(screen.getByText("New 1.5 KB")).toBeInTheDocument();
    expect(screen.getByTitle("Side by side")).toBeInTheDocument();
    expect(screen.getByTitle("Swipe compare")).toBeInTheDocument();
    expect(screen.getByAltText("Old version")).toHaveAttribute("src", "blob://old/image/png");
    expect(screen.getByAltText("New version")).toHaveAttribute("src", "blob://new/image/png");
  });

  it("offers no compare modes for a single side", () => {
    render(<ImageLightbox path="added.png" sides={[newSide]} onClose={vi.fn()} />);
    expect(screen.queryByTitle("Swipe compare")).toBeNull();
    expect(screen.getByAltText("New version")).toHaveAttribute("src", "blob://new/image/png");
  });

  it("closes via the Back button and Escape", () => {
    const onClose = vi.fn();
    render(<ImageLightbox path="logo.png" sides={[oldSide, newSide]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Back to the diff" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("clips the new side in swipe mode", () => {
    render(<ImageLightbox path="logo.png" sides={[oldSide, newSide]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Swipe"));
    expect(screen.getByAltText("New version").style.clipPath).toMatch(/^inset\(0 0 0 /);
    expect(screen.getByAltText("Old version").style.clipPath).toBe("");
  });

  it("difference-blends the new side", () => {
    render(<ImageLightbox path="logo.png" sides={[oldSide, newSide]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Diff"));
    expect(screen.getByAltText("New version").style.mixBlendMode).toBe("difference");
    expect(screen.getByAltText("Old version").style.mixBlendMode).toBe("");
  });

  it("steps the zoom readout from the buttons", () => {
    render(<ImageLightbox path="logo.png" sides={[oldSide, newSide]} onClose={vi.fn()} />);
    expect(screen.getByText("100%")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Zoom in"));
    expect(screen.getByText("125%")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Zoom out"));
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("disables zoom and explains itself when neither side is previewable", () => {
    render(
      <ImageLightbox
        path="logo.png"
        sides={[
          { ...oldSide, src: null },
          { ...newSide, src: null },
        ]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("No preview available")).toBeInTheDocument();
    expect(screen.getByTitle("Zoom in")).toBeDisabled();
    expect(screen.getByTitle("Zoom out")).toBeDisabled();
  });
});
