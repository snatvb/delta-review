import { Component, type ReactNode, type RefObject } from "react";
import { anchorScrollTopAfterReview, type FileScrollGeometry } from "./anchorScroll";

type Props = {
  paneRef: RefObject<HTMLDivElement | null>;
  files: readonly FileScrollGeometry[];
  viewedFiles: ReadonlySet<string>;
  headerH: number;
  gap: number;
  pad: number;
  onScrollTopChange: (top: number) => void;
  children: ReactNode;
};

// getSnapshotBeforeUpdate is React's pre-mutation DOM-read lifecycle. A layout
// effect is already too late to recover a scrollTop clamped by a shrinking canvas.
// This boundary adds no DOM and keeps that lifecycle out of the virtual renderer.
export class DiffScrollAnchor extends Component<Props, Record<string, never>, number | null> {
  getSnapshotBeforeUpdate(previous: Props): number | null {
    const { paneRef, files, viewedFiles, headerH, gap, pad } = this.props;
    const pane = paneRef.current;
    if (!pane || previous.files === files) {
      return null;
    }
    return anchorScrollTopAfterReview(pane.scrollTop, previous.files, files, viewedFiles, headerH, gap, pad);
  }

  componentDidUpdate(_previous: Props, _state: Record<string, never>, top: number | null) {
    const { paneRef, onScrollTopChange } = this.props;
    const pane = paneRef.current;
    if (!pane || top === null) {
      return;
    }
    pane.scrollTop = Math.min(top, Math.max(0, pane.scrollHeight - pane.clientHeight));
    // Always sync, even when the browser had already clamped to this position.
    // Waiting for the rAF-gated scroll event would paint the old, empty row window.
    onScrollTopChange(pane.scrollTop);
  }

  render() {
    return this.props.children;
  }
}
