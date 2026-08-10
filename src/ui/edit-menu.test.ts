import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  listenEvent: vi.fn<(event: string, handler: (id: string) => void) => Promise<void>>(),
  setEditMenuLabels: vi.fn<(undo: string, redo: string) => Promise<void>>(),
  setEditMenuState: vi.fn<(canUndo: boolean, canRedo: boolean) => Promise<void>>(),
  onLangChange: vi.fn<(handler: () => void) => void>(),
}));

vi.mock("../core/platform", () => ({
  EDIT_MENU_EVENT: "menu://edit",
  EDIT_UNDO_ID: "edit-undo",
  isTauri: mocks.isTauri,
  listenEvent: mocks.listenEvent,
  setEditMenuLabels: mocks.setEditMenuLabels,
  setEditMenuState: mocks.setEditMenuState,
}));
vi.mock("../i18n", () => ({
  errorText: (error: unknown) => String(error),
  onLangChange: mocks.onLangChange,
  t: () => ({ appMenu: { undo: "Undo", redo: "Redo" } }),
}));

import { installEditMenu } from "./edit-menu";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isTauri.mockReturnValue(false);
  mocks.listenEvent.mockResolvedValue();
  mocks.setEditMenuLabels.mockResolvedValue();
  mocks.setEditMenuState.mockResolvedValue();
});

describe("installEditMenu", () => {
  it("is inert outside Tauri while retaining a callable pushState", () => {
    const menu = installEditMenu({ canUndo: () => true, canRedo: () => true, run: vi.fn() });
    menu.pushState();
    expect(mocks.listenEvent).not.toHaveBeenCalled();
    expect(mocks.setEditMenuLabels).not.toHaveBeenCalled();
    expect(mocks.setEditMenuState).not.toHaveBeenCalled();
    expect(mocks.onLangChange).toHaveBeenCalledOnce();
  });

  it("routes menu ids and reflects state and translated labels", () => {
    mocks.isTauri.mockReturnValue(true);
    let eventHandler: ((id: string) => void) | undefined;
    let langHandler: (() => void) | undefined;
    mocks.listenEvent.mockImplementation(async (_event, handler) => void (eventHandler = handler));
    mocks.onLangChange.mockImplementation((handler) => void (langHandler = handler));
    let canUndo = true;
    let canRedo = false;
    const run = vi.fn();

    const menu = installEditMenu({ canUndo: () => canUndo, canRedo: () => canRedo, run });
    expect(mocks.listenEvent).toHaveBeenCalledWith("menu://edit", expect.any(Function));
    expect(mocks.setEditMenuLabels).toHaveBeenCalledWith("Undo", "Redo");
    expect(mocks.setEditMenuState).toHaveBeenCalledWith(true, false);

    eventHandler?.("edit-undo");
    eventHandler?.("edit-redo");
    eventHandler?.("another-redo-id");
    expect(run.mock.calls.map(([direction]) => direction)).toEqual(["undo", "redo", "redo"]);

    canUndo = false;
    canRedo = true;
    menu.pushState();
    expect(mocks.setEditMenuState).toHaveBeenLastCalledWith(false, true);
    langHandler?.();
    expect(mocks.setEditMenuLabels).toHaveBeenCalledTimes(2);
  });

  it("logs shell update failures without interrupting editing", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.setEditMenuLabels.mockRejectedValue(new Error("labels unavailable"));
    mocks.setEditMenuState.mockRejectedValue(new Error("state unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const menu = installEditMenu({ canUndo: () => true, canRedo: () => false, run: vi.fn() });
    menu.pushState();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith("edit menu labels:", "Error: labels unavailable");
      expect(warn).toHaveBeenCalledWith("edit menu state:", "Error: state unavailable");
    });
  });
});
