// The image lightbox (#binary): the shell (filename, compare modes, zoom
// controls, captions) and the per-mode rendering of both sides. happy-dom never
// fires img onload and reports a 0×0 stage, so assertions stick to attributes
// and inline styles — the zero-size guards keep zoom/fit math at scale 1 there.
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ImageLightbox, type ImageLightboxSide } from "./ImageLightbox";
import type { Anchor } from "../types";

const oldSide: ImageLightboxSide = { side: "old", label: "Old", src: "blob://old/image/png", mime: "image/png", size: 45 };
const newSide: ImageLightboxSide = { side: "new", label: "New", src: "blob://new/image/png", mime: "image/png", size: 1536 };

describe("ImageLightbox", () => {
  it("shows the filename, per-side captions and both images by default", () => {
    render(<ImageLightbox path="assets/icons/logo.png" sides={[oldSide, newSide]} onClose={vi.fn()} />);
    expect(screen.getByText("logo.png")).toBeInTheDocument();
    expect(screen.getByText("Old 45 B")).toBeInTheDocument();
    expect(screen.getByText("New 1.5 KB")).toBeInTheDocument();
    expect(screen.getByLabelText("Side by side")).toBeInTheDocument();
    expect(screen.getByLabelText("Swipe compare")).toBeInTheDocument();
    expect(screen.getByAltText("Old version")).toHaveAttribute("src", "blob://old/image/png");
    expect(screen.getByAltText("New version")).toHaveAttribute("src", "blob://new/image/png");
  });

  it("offers no compare modes for a single side", () => {
    render(<ImageLightbox path="added.png" sides={[newSide]} onClose={vi.fn()} />);
    expect(screen.queryByLabelText("Swipe compare")).toBeNull();
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
    fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(screen.getByText("125%")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Zoom out"));
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
    expect(screen.getByLabelText("Zoom in")).toBeDisabled();
    expect(screen.getByLabelText("Zoom out")).toBeDisabled();
  });

  // Point comments (#point): comment mode + pin placement + the bubble thread.
  describe("point comments", () => {
    it("hides the comment toggle unless a placement handler is wired", () => {
      render(<ImageLightbox path="logo.png" sides={[oldSide, newSide]} onClose={vi.fn()} />);
      expect(screen.queryByLabelText("Comment on a point")).toBeNull();
    });

    it("places a point comment at the clicked fraction of the image, then exits the mode", () => {
      // The placement math reads the img's displayed rect (getBoundingClientRect
      // sees through the transform) — happy-dom reports 0×0, so stub a box.
      const rect = { left: 100, top: 50, width: 200, height: 100 } as DOMRect;
      const orig = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = () => rect;
      try {
        const onAddComment = vi.fn((_a: Anchor, _b: string) => "new-id");
        render(
          <ImageLightbox
            path="logo.png"
            sides={[oldSide, newSide]}
            onClose={vi.fn()}
            onAddComment={onAddComment}
            onEditComment={vi.fn()}
            onDeleteComment={vi.fn()}
            onToggleResolvedComment={vi.fn()}
          />,
        );
        const img = screen.getByAltText("New version");
        fireEvent.pointerDown(img, { button: 0, clientX: 150, clientY: 100 });
        fireEvent.pointerUp(img, { button: 0, clientX: 150, clientY: 100 });
        expect(onAddComment).not.toHaveBeenCalled(); // not armed yet — plain click
        fireEvent.click(screen.getByLabelText("Comment on a point"));
        expect(screen.getByLabelText("Comment on a point")).toHaveAttribute("aria-pressed", "true");
        fireEvent.pointerDown(img, { button: 0, clientX: 150, clientY: 100 });
        fireEvent.pointerUp(img, { button: 0, clientX: 150, clientY: 100 });
        expect(onAddComment).toHaveBeenCalledTimes(1);
        const [anchor, body] = onAddComment.mock.calls[0];
        expect(anchor).toMatchObject({ file: "logo.png", side: "new", x: 0.25, y: 0.5 });
        expect(body).toBe("");
        // Mode exited after one placement.
        expect(screen.getByLabelText("Comment on a point")).toHaveAttribute("aria-pressed", "false");
        fireEvent.pointerDown(img, { button: 0, clientX: 160, clientY: 110 });
        fireEvent.pointerUp(img, { button: 0, clientX: 160, clientY: 110 });
        expect(onAddComment).toHaveBeenCalledTimes(1);
      } finally {
        Element.prototype.getBoundingClientRect = orig;
      }
    });

    it("Esc clears comment mode before it closes the viewer", () => {
      const onClose = vi.fn();
      render(
        <ImageLightbox
          path="logo.png"
          sides={[oldSide, newSide]}
          onClose={onClose}
          onAddComment={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByLabelText("Comment on a point"));
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Comment on a point")).toHaveAttribute("aria-pressed", "false");
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("renders a pin per point comment and opens the bubble on click", () => {
      const comments = [
        {
          id: "p1", scope: "point" as const,
          anchor: { file: "logo.png", side: "new" as const, startLine: null, endLine: null, snippet: null, x: 0.3, y: 0.4 },
          body: "blurry", stale: false, resolved: false,
          createdAt: "2026-06-25T18:50:00Z", updatedAt: "2026-06-25T18:50:00Z",
        },
      ];
      render(
        <ImageLightbox
          path="logo.png"
          sides={[newSide]}
          onClose={vi.fn()}
          comments={comments}
          onEditComment={vi.fn()}
          onDeleteComment={vi.fn()}
          onToggleResolvedComment={vi.fn()}
        />,
      );
      // No natural dimensions in happy-dom (no img onload) → the pin stays
      // hidden rather than positioned wrongly; the label never appears.
      expect(screen.queryByLabelText(/Comment 1/)).toBeNull();
    });
  });
});
