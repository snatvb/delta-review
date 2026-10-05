// The binary image compare card (#binary): which sides render per change status,
// the size captions, and the fallbacks when a side is missing or fails to load.
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BinaryImageDiff } from "./BinaryImageDiff";
import type { BinaryFileDiff, BlobSide } from "../types";

const both: BinaryFileDiff = { oldSize: 45, newSize: 1536 };
const srcOf = (side: BlobSide, mime: string) => `blob://${side}/${mime}`;

describe("BinaryImageDiff", () => {
  it("shows old and new side by side for a modified image, with sizes", () => {
    render(<BinaryImageDiff binary={both} status="modified" mime="image/png" load srcOf={srcOf} />);
    expect(screen.getByAltText("Old version")).toHaveAttribute("src", "blob://old/image/png");
    expect(screen.getByAltText("New version")).toHaveAttribute("src", "blob://new/image/png");
    expect(screen.getByText("45 B")).toBeInTheDocument();
    expect(screen.getByText("1.5 KB")).toBeInTheDocument();
  });

  it("shows only the new pane for an added image", () => {
    render(<BinaryImageDiff binary={both} status="added" mime="image/png" load srcOf={srcOf} />);
    expect(screen.queryByAltText("Old version")).toBeNull();
    expect(screen.getByAltText("New version")).toHaveAttribute("src", "blob://new/image/png");
  });

  it("shows only the old pane for a deleted image", () => {
    render(<BinaryImageDiff binary={both} status="deleted" mime="image/png" load srcOf={srcOf} />);
    expect(screen.getByAltText("Old version")).toBeInTheDocument();
    expect(screen.queryByAltText("New version")).toBeNull();
  });

  it("renders an image under the preview cap", () => {
    const big: BinaryFileDiff = { oldSize: null, newSize: 12 * 1024 * 1024 };
    render(<BinaryImageDiff binary={big} status="added" mime="image/png" load srcOf={srcOf} />);
    expect(screen.getByAltText("New version")).toBeInTheDocument();
    expect(screen.getByText("12 MB")).toBeInTheDocument();
  });

  it("explains a side over the preview cap instead of loading it", () => {
    const huge: BinaryFileDiff = { oldSize: null, newSize: 20 * 1024 * 1024 };
    render(<BinaryImageDiff binary={huge} status="added" mime="image/png" load srcOf={srcOf} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Too large to preview — 20 MB")).toBeInTheDocument();
  });

  it("explains a side whose image fails to load", () => {
    render(<BinaryImageDiff binary={both} status="added" mime="image/png" load srcOf={srcOf} />);
    fireEvent.error(screen.getByAltText("New version"));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Preview failed to load")).toBeInTheDocument();
  });

  it("fetches no pixels while the card is away from the viewport", () => {
    render(<BinaryImageDiff binary={both} status="modified" mime="image/png" load={false} srcOf={srcOf} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("1.5 KB")).toBeInTheDocument();
  });

  it("shows a loading note while the fetch is in flight", () => {
    render(<BinaryImageDiff binary={undefined} status="modified" mime="image/png" load srcOf={srcOf} />);
    expect(screen.getByText("Loading image…")).toBeInTheDocument();
  });

  // Point-comment pins (#point): positioned at fractions of the img's offset
  // box. happy-dom never lays out, so offsetLeft/Top/Width/Height stay 0 —
  // stub them to a known box and assert the pin lands at fraction × box.
  describe("pins", () => {
    function stubImgBox(w: number, h: number) {
      const props = ["offsetWidth", "offsetHeight", "offsetLeft", "offsetTop"] as const;
      const descs = props.map((p) => [p, Object.getOwnPropertyDescriptor(HTMLElement.prototype, p)] as const);
      for (const p of props) {
        Object.defineProperty(HTMLElement.prototype, p, {
          configurable: true,
          get: () => (p === "offsetWidth" ? w : p === "offsetHeight" ? h : p === "offsetLeft" ? 10 : 20),
        });
      }
      return () => {
        for (const [p, d] of descs) {
          Object.defineProperty(HTMLElement.prototype, p, d ?? { configurable: true, get: () => 0 });
        }
      };
    }

    it("renders a numbered pin on its side's image at the anchored fraction", () => {
      const restore = stubImgBox(200, 100);
      try {
        render(
          <BinaryImageDiff
            binary={both}
            status="modified"
            mime="image/png"
            load
            srcOf={srcOf}
            pins={[{ commentId: "p1", n: 2, side: "new", x: 0.25, y: 0.5, tone: "open", title: "blurry logo" }]}
          />,
        );
        const pin = screen.getByLabelText("Comment 2 — new image, x 25% y 50%");
        expect(pin).toHaveTextContent("2");
        // left = 10 + 0.25×200, top = 20 + 0.5×100
        expect(pin.style.left).toBe("60px");
        expect(pin.style.top).toBe("70px");
      } finally {
        restore();
      }
    });

    it("clicking a pin opens that comment instead of the plain lightbox", () => {
      const restore = stubImgBox(200, 100);
      const onOpenPin = vi.fn();
      try {
        render(
          <BinaryImageDiff
            binary={both}
            status="modified"
            mime="image/png"
            load
            srcOf={srcOf}
            pins={[{ commentId: "p1", n: 1, side: "old", x: 0.1, y: 0.9, tone: "open", title: "t" }]}
            onOpenPin={onOpenPin}
          />,
        );
        fireEvent.click(screen.getByLabelText("Comment 1 — old image, x 10% y 90%"));
        expect(onOpenPin).toHaveBeenCalledWith("p1");
      } finally {
        restore();
      }
    });
  });
});
