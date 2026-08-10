// @vitest-environment jsdom

// A desktop webview and a browser deliver file drops through unrelated APIs.
// Exercise both adapters, especially rejection before reading and the nested
// browser drag depth that keeps the overlay from flickering off between nodes.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  listenEvent: vi.fn<(event: string, handler: (payload: unknown) => void) => Promise<void>>(),
  readBinaryByPath: vi.fn<(path: string) => Promise<Uint8Array>>(),
  readTextByPath: vi.fn<(path: string) => Promise<string>>(),
}));

vi.mock("../core/platform", () => ({ isTauri: mocks.isTauri, listenEvent: mocks.listenEvent }));
vi.mock("../core/storage", () => ({
  baseName: (path: string) => path.split(/[\\/]/).pop() || path,
  readBinaryByPath: mocks.readBinaryByPath,
  readTextByPath: mocks.readTextByPath,
}));

import { initDropzone, type DroppedFile, type DropRejection } from "./dropzone";

function installDom(): { scrim: HTMLElement; label: HTMLElement } {
  document.body.innerHTML = `<div id="dropzone" hidden><span id="dropzone-label"></span></div>`;
  return {
    scrim: document.getElementById("dropzone") as HTMLElement,
    label: document.getElementById("dropzone-label") as HTMLElement,
  };
}

function dragEvent(
  type: string,
  files: Array<Pick<File, "name" | "text" | "arrayBuffer">>,
  carriesFiles = true,
): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: carriesFiles ? ["Files"] : ["text/plain"], files },
  });
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isTauri.mockReturnValue(false);
  mocks.listenEvent.mockResolvedValue();
  mocks.readBinaryByPath.mockResolvedValue(Uint8Array.of(1, 2));
  mocks.readTextByPath.mockResolvedValue("desktop text");
});

describe("browser drops", () => {
  it("tracks nested drags, matches extensions and rejects ambiguous files before reading", async () => {
    const { scrim, label } = installDom();
    const rejects: Array<[DropRejection, string, string[]]> = [];
    const accepted: Array<{ file: DroppedFile; text: string; bytes: Uint8Array }> = [];
    const zone = initDropzone({
      caption: (extensions) => `Accept: ${extensions.join(",")}`,
      onReject: (reason, name, extensions) => rejects.push([reason, name, extensions]),
    });
    zone.register("json", async (file) => {
      accepted.push({ file, text: await file.text(), bytes: await file.bytes() });
    });
    zone.register("urxf", vi.fn());

    const enter = dragEvent("dragenter", []);
    window.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(scrim.hidden).toBe(false);
    expect(label.textContent).toBe("Accept: json,urxf");

    window.dispatchEvent(dragEvent("dragenter", []));
    window.dispatchEvent(dragEvent("dragleave", []));
    expect(scrim.hidden).toBe(false);
    window.dispatchEvent(dragEvent("dragleave", []));
    expect(scrim.hidden).toBe(true);

    const ignored = dragEvent("dragenter", [], false);
    window.dispatchEvent(ignored);
    expect(ignored.defaultPrevented).toBe(false);
    const over = dragEvent("dragover", []);
    window.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);

    const plan = {
      name: "PLAN.JSON",
      text: vi.fn(async () => "browser text"),
      arrayBuffer: vi.fn(async () => Uint8Array.of(3, 4).buffer),
    };
    const drop = dragEvent("drop", [plan]);
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(accepted).toHaveLength(1));
    expect(accepted[0]).toMatchObject({
      file: { name: "PLAN.JSON" },
      text: "browser text",
      bytes: Uint8Array.of(3, 4),
    });
    expect(accepted[0].file.path).toBeUndefined();

    window.dispatchEvent(dragEvent("drop", [{ ...plan, name: "notes.txt" }]));
    window.dispatchEvent(
      dragEvent("drop", [
        { ...plan, name: "first.json" },
        { ...plan, name: "second.json" },
      ]),
    );
    window.dispatchEvent(dragEvent("drop", []));
    expect(rejects).toEqual([
      ["type", "notes.txt", ["json", "urxf"]],
      ["multiple", "first.json", ["json", "urxf"]],
    ]);
  });
});

describe("Tauri drops", () => {
  it("adapts shell paths to lazy text/binary readers", async () => {
    mocks.isTauri.mockReturnValue(true);
    const handlers = new Map<string, (payload: unknown) => void>();
    mocks.listenEvent.mockImplementation(async (event, handler) => void handlers.set(event, handler));
    const { scrim, label } = installDom();
    const rejects: Array<[DropRejection, string]> = [];
    const received: DroppedFile[] = [];
    const zone = initDropzone({
      caption: (extensions) => extensions.join(" / "),
      onReject: (reason, name) => rejects.push([reason, name]),
    });
    zone.register("json", (file) => void received.push(file));

    handlers.get("tauri://drag-enter")?.(undefined);
    expect(scrim.hidden).toBe(false);
    expect(label.textContent).toBe("json");
    handlers.get("tauri://drag-leave")?.(undefined);
    expect(scrim.hidden).toBe(true);

    handlers.get("tauri://drag-drop")?.({ paths: ["C:\\plans\\SET.JSON"] });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ name: "SET.JSON", path: "C:\\plans\\SET.JSON" });
    await expect(received[0].text()).resolves.toBe("desktop text");
    await expect(received[0].bytes()).resolves.toEqual(Uint8Array.of(1, 2));
    expect(mocks.readTextByPath).toHaveBeenCalledWith("C:\\plans\\SET.JSON");
    expect(mocks.readBinaryByPath).toHaveBeenCalledWith("C:\\plans\\SET.JSON");

    handlers.get("tauri://drag-drop")?.({ paths: ["/one.json", "/two.json"] });
    handlers.get("tauri://drag-drop")?.({});
    expect(rejects).toEqual([["multiple", "one.json"]]);
  });

  it("reports shell event registration failure without aborting startup", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.listenEvent.mockRejectedValue(new Error("plugin unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installDom();
    expect(() => initDropzone({ caption: () => "", onReject: vi.fn() })).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("drag & drop unavailable:", expect.any(Error)));
  });
});
