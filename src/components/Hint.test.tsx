import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hint } from "@/components/Hint";

describe("Hint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes when the pointer leaves the trigger right after the delayed open", () => {
    render(
      <Hint tip="Uncommitted">
        <button type="button">mode</button>
      </Hint>,
    );
    const trigger = screen.getByRole("button", { name: "mode" });

    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(trigger.getAttribute("data-state")).toBe("delayed-open");

    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    expect(trigger.getAttribute("data-state")).toBe("closed");
  });

  it("stays closed when focus lands on the trigger without Tab, like a menu returning focus", () => {
    render(
      <Hint tip="Last commit">
        <button type="button">mode</button>
      </Hint>,
    );
    const trigger = screen.getByRole("button", { name: "mode" });

    fireEvent.pointerDown(document.body);
    act(() => trigger.focus());
    expect(trigger.getAttribute("data-state")).toBe("closed");

    act(() => trigger.blur());
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => trigger.focus());
    expect(trigger.getAttribute("data-state")).toBe("instant-open");
  });
});
