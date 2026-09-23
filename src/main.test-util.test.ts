// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootApp, installAppGlobals, restoreAppGlobals } from "./main.test-util";

afterEach(restoreAppGlobals);

describe("the app boot fixture", () => {
  it("removes a boot's global listeners while preserving earlier listeners", async () => {
    const earlier = vi.fn();
    window.addEventListener("fixture-event", earlier);
    try {
      installAppGlobals();
      await bootApp({ tauri: false });
      const capture = vi.fn();
      const bubble = vi.fn();
      const handler = { handleEvent: vi.fn() };
      const options = { capture: true };
      window.addEventListener("fixture-event", capture, options);
      window.addEventListener("fixture-event", bubble);
      document.addEventListener("fixture-event", handler);
      options.capture = false;
      document.dispatchEvent(new Event("fixture-event", { bubbles: true }));
      expect([earlier.mock.calls.length, capture.mock.calls.length, bubble.mock.calls.length]).toEqual([1, 1, 1]);
      expect(handler.handleEvent).toHaveBeenCalledOnce();

      restoreAppGlobals();
      document.dispatchEvent(new Event("fixture-event", { bubbles: true }));
      expect(earlier).toHaveBeenCalledTimes(2);
      expect(capture).toHaveBeenCalledOnce();
      expect(bubble).toHaveBeenCalledOnce();
      expect(handler.handleEvent).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("fixture-event", earlier);
    }
  });

  it("retires the previous boot's history listeners before booting again", async () => {
    installAppGlobals();
    await bootApp({ tauri: false });
    const { PlanHistory: PreviousHistory } = await import("./ui/history");
    const previous = vi.spyOn(PreviousHistory.prototype, "handleKey");
    const boundary = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    try {
      boundary();
      expect(previous).toHaveBeenCalledOnce();
      previous.mockClear();

      await bootApp({ tauri: false });
      const { PlanHistory: CurrentHistory } = await import("./ui/history");
      const current = vi.spyOn(CurrentHistory.prototype, "handleKey");
      try {
        boundary();
        expect(current).toHaveBeenCalledOnce();
        expect(previous).not.toHaveBeenCalled();
        restoreAppGlobals();
        boundary();
        expect(current).toHaveBeenCalledOnce();
        expect(previous).not.toHaveBeenCalled();
      } finally {
        current.mockRestore();
      }
    } finally {
      previous.mockRestore();
    }
  });
});
