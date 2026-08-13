// @vitest-environment jsdom

// Persistence has two implementations behind one API: real paths and IPC in a
// Tauri window, and browser downloads/file inputs in the demo. Pin both sides,
// including cancellation and export failures, so they cannot drift into two
// different meanings for the same SaveResult/OpenResult contract.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  nativeOpenPath: vi.fn<(filter: { ext: string; label: string }) => Promise<string | null>>(),
  nativeReadBinary: vi.fn<(path: string) => Promise<Uint8Array>>(),
  nativeReadText: vi.fn<(path: string) => Promise<string>>(),
  nativeSavePath: vi.fn<(name: string, filter: { ext: string; label: string }) => Promise<string | null>>(),
  nativeWriteBinary: vi.fn<(path: string, bytes: Uint8Array) => Promise<void>>(),
  nativeWriteText: vi.fn<(path: string, text: string) => Promise<void>>(),
  pipeBytes: vi.fn(async (bytes: Uint8Array): Promise<Uint8Array> => bytes),
}));

vi.mock("./platform", () => ({
  isTauri: mocks.isTauri,
  nativeOpenPath: mocks.nativeOpenPath,
  nativeReadBinary: mocks.nativeReadBinary,
  nativeReadText: mocks.nativeReadText,
  nativeSavePath: mocks.nativeSavePath,
  nativeWriteBinary: mocks.nativeWriteBinary,
  nativeWriteText: mocks.nativeWriteText,
}));
vi.mock("./plan", () => ({ pipeBytes: mocks.pipeBytes }));

import {
  downloadText,
  exportSvgToPdf,
  exportSvgToPng,
  openBinaryDocument,
  openTextDocument,
  readBinaryByPath,
  readTextByPath,
  saveTextDocument,
} from "./storage";

const JSON_FILTER = { ext: "json", label: "Plan" };
const PNG_FILTER = { ext: "png", label: "PNG image" };
const PDF_FILTER = { ext: "pdf", label: "PDF document" };

interface RasterHarness {
  context: {
    fillStyle: string;
    fillRect: ReturnType<typeof vi.fn>;
    scale: ReturnType<typeof vi.fn>;
    drawImage: ReturnType<typeof vi.fn>;
    getImageData: ReturnType<typeof vi.fn>;
  };
  canvas: () => HTMLCanvasElement | null;
}

function installRaster(opts: { pngBlob?: Blob | null; imageError?: boolean; context?: boolean } = {}): RasterHarness {
  let renderedCanvas: HTMLCanvasElement | null = null;
  const context = {
    fillStyle: "",
    fillRect: vi.fn(),
    scale: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 128]) })),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    renderedCanvas = this;
    return opts.context === false ? null : (context as unknown as CanvasRenderingContext2D);
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback(
      opts.pngBlob === undefined ? (new Blob([Uint8Array.of(1, 2, 3)], { type: "image/png" }) as Blob) : opts.pngBlob,
    );
  });

  class TestImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => (opts.imageError ? this.onerror?.() : this.onload?.()));
    }
  }
  vi.stubGlobal("Image", TestImage);
  return { context, canvas: () => renderedCanvas };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isTauri.mockReturnValue(false);
  mocks.nativeOpenPath.mockResolvedValue(null);
  mocks.nativeReadBinary.mockResolvedValue(new Uint8Array());
  mocks.nativeReadText.mockResolvedValue("");
  mocks.nativeSavePath.mockResolvedValue(null);
  mocks.nativeWriteBinary.mockResolvedValue();
  mocks.nativeWriteText.mockResolvedValue();
  mocks.pipeBytes.mockImplementation(async (bytes) => bytes);
  document.body.replaceChildren();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:test") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

describe("text and binary documents", () => {
  it("writes and reads native paths, preserving cancellation", async () => {
    mocks.isTauri.mockReturnValue(true);
    await expect(saveTextDocument("plan.json", "{}", JSON_FILTER)).resolves.toEqual({ saved: false });
    expect(mocks.nativeWriteText).not.toHaveBeenCalled();

    mocks.nativeSavePath.mockResolvedValue("/plans/live.json");
    await expect(saveTextDocument("plan.json", '{"ok":true}', JSON_FILTER)).resolves.toEqual({
      saved: true,
      path: "/plans/live.json",
    });
    expect(mocks.nativeWriteText).toHaveBeenCalledWith("/plans/live.json", '{"ok":true}');

    await expect(openTextDocument(JSON_FILTER)).resolves.toBeNull();
    mocks.nativeOpenPath.mockResolvedValue("/plans/open.json");
    mocks.nativeReadText.mockResolvedValue("opened");
    await expect(openTextDocument(JSON_FILTER)).resolves.toEqual({ text: "opened", path: "/plans/open.json" });

    const raw = Uint8Array.of(3, 1, 4);
    mocks.nativeReadBinary.mockResolvedValue(raw);
    await expect(openBinaryDocument({ ext: "urxf", label: "Settings" })).resolves.toEqual({
      bytes: raw,
      path: "/plans/open.json",
    });
    await expect(readTextByPath("/recent.json")).resolves.toBe("opened");
    await expect(readBinaryByPath("/recent.urxf")).resolves.toEqual(raw);
    expect(mocks.nativeReadText).toHaveBeenLastCalledWith("/recent.json");
    expect(mocks.nativeReadBinary).toHaveBeenLastCalledWith("/recent.urxf");
  });

  it("downloads text in a browser and reports binary open as unavailable", async () => {
    const clicks: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.download });
    });

    downloadText("direct.json", '{"direct":true}');
    await expect(saveTextDocument("plan.json", "{}", JSON_FILTER)).resolves.toEqual({ saved: true });
    await expect(openBinaryDocument({ ext: "urxf", label: "Settings" })).resolves.toBeNull();
    expect(clicks).toEqual([
      { href: "blob:test", download: "direct.json" },
      { href: "blob:test", download: "plan.json" },
    ]);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("reads a browser-picked file and handles cancel, empty selection and missing input", async () => {
    const input = document.createElement("input");
    input.id = "file-input";
    input.type = "file";
    document.body.append(input);
    vi.spyOn(input, "click").mockImplementation(() => {});

    const picked = openTextDocument(JSON_FILTER);
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["picked"], "picked.json")] });
    input.dispatchEvent(new Event("change"));
    await expect(picked).resolves.toEqual({ text: "picked" });
    expect(input.value).toBe("");

    const canceled = openTextDocument(JSON_FILTER);
    input.dispatchEvent(new Event("cancel"));
    await expect(canceled).resolves.toBeNull();

    const empty = openTextDocument(JSON_FILTER);
    Object.defineProperty(input, "files", { configurable: true, value: [] });
    input.dispatchEvent(new Event("change"));
    await expect(empty).resolves.toBeNull();

    input.remove();
    await expect(openTextDocument(JSON_FILTER)).resolves.toBeNull();
  });

  // null means "no file was chosen". A read that FAILS has to be told apart from that,
  // or an unreadable file arrives at the caller as a dismissed picker: no status line,
  // no dialog, nothing at all. The native path already rejects the same failure.
  it("rejects a browser-picked file it could not read, rather than reporting a cancel", async () => {
    const input = document.createElement("input");
    input.id = "file-input";
    input.type = "file";
    document.body.append(input);
    vi.spyOn(input, "click").mockImplementation(() => {});
    // Fail the read itself: the reader errors instead of loading.
    vi.spyOn(FileReader.prototype, "readAsText").mockImplementation(function (this: FileReader) {
      queueMicrotask(() => this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>));
    });

    const failing = openTextDocument(JSON_FILTER);
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["x"], "x.json")] });
    input.dispatchEvent(new Event("change"));
    await expect(failing).rejects.toThrow();

    vi.mocked(FileReader.prototype.readAsText).mockRestore();
    input.remove();
  });
});

describe("SVG export", () => {
  it("rasterizes PNG at the requested scale and writes its bytes through the native path", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.nativeSavePath.mockResolvedValue("/exports/board.png");
    const png = {
      type: "image/png",
      arrayBuffer: async () => Uint8Array.of(7, 8, 9).buffer,
    } as Blob;
    const raster = installRaster({ pngBlob: png });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");

    await expect(
      exportSvgToPng(svg, "board.png", { width: 12.4, height: 8.6, scale: 3, background: "#123456" }, PNG_FILTER),
    ).resolves.toEqual({ saved: true, path: "/exports/board.png" });
    expect(raster.canvas()?.width).toBe(37);
    expect(raster.canvas()?.height).toBe(26);
    expect(raster.context.fillStyle).toBe("#123456");
    expect(raster.context.fillRect).toHaveBeenCalledWith(0, 0, 37, 26);
    expect(raster.context.scale).toHaveBeenCalledWith(3, 3);
    expect(mocks.nativeWriteBinary).toHaveBeenCalledWith("/exports/board.png", Uint8Array.of(7, 8, 9));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });

  it("builds a one-page RGB PDF and downloads it in the browser", async () => {
    const raster = installRaster();
    let downloaded: Blob | null = null;
    vi.mocked(URL.createObjectURL).mockImplementation((blob) => {
      downloaded = blob as Blob;
      return "blob:pdf";
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    document.body.style.setProperty("--canvas-bg", "#abcdef");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");

    await expect(exportSvgToPdf(svg, "board.pdf", { width: 12.4, height: 8.6, scale: 1 }, PDF_FILTER)).resolves.toEqual(
      {
        saved: true,
      },
    );
    expect(raster.context.fillStyle).toBe("#abcdef");
    expect(mocks.pipeBytes).toHaveBeenCalledWith(Uint8Array.of(10, 20, 30, 40, 50, 60), expect.any(CompressionStream));
    expect(downloaded).not.toBeNull();
    const pdfBlob = downloaded as unknown as Blob;
    expect(pdfBlob.type).toBe("application/pdf");
    const pdfText = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new TextDecoder().decode(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(pdfBlob);
    });
    expect(pdfText).toContain("%PDF-1.4");
    expect(pdfText).toContain("/MediaBox [0 0 12 9]");
    expect(pdfText).toContain("/Width 12 /Height 9");
    expect(pdfText).toContain("xref");
  });

  it("distinguishes image, canvas and PNG encoding failures from user cancellation", async () => {
    let raster = installRaster({ imageError: true });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    await expect(exportSvgToPng(svg, "bad.png", { width: 1, height: 1 }, PNG_FILTER)).rejects.toThrow(
      "svg rasterize failed",
    );

    vi.restoreAllMocks();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:test") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    raster = installRaster({ context: false });
    await expect(exportSvgToPdf(svg, "bad.pdf", { width: 1, height: 1 }, PDF_FILTER)).rejects.toThrow(
      "canvas-unavailable",
    );
    expect(raster.canvas()).not.toBeNull();

    vi.restoreAllMocks();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:test") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    installRaster({ pngBlob: null });
    await expect(exportSvgToPng(svg, "bad.png", { width: 1, height: 1 }, PNG_FILTER)).rejects.toThrow("png-encode");
  });
});
