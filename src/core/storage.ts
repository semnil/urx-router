// Persistence and image export. Under Tauri these use native save/open dialogs
// and real file paths; in a plain browser they fall back to <a download> and
// <input type=file>. PDF export is hand-built (a single FlateDecode image) so no
// runtime dependency is needed; deflate comes from the platform CompressionStream.

import {
  isTauri,
  nativeOpenPath,
  nativeReadText,
  nativeSavePath,
  nativeWriteBinary,
  nativeWriteText,
} from "./platform";
import type { FileFilter } from "./platform";

/** Outcome of a save: not saved means the user canceled the native dialog. */
export interface SaveResult {
  saved: boolean;
  /** Present only when a native dialog returned a real path (Tauri). */
  path?: string;
}

/** Outcome of an open: text plus, under Tauri, the real source path. */
export interface OpenResult {
  text: string;
  path?: string;
}

export function downloadText(filename: string, text: string, mime = "application/json"): void {
  const blob = new Blob([text], { type: mime });
  triggerDownload(blob, filename);
}

/** Save text to a native-chosen path (Tauri) or download it (browser). */
export async function saveTextDocument(defaultName: string, text: string, filter: FileFilter): Promise<SaveResult> {
  if (isTauri()) {
    const path = await nativeSavePath(defaultName, filter);
    if (!path) return { saved: false };
    await nativeWriteText(path, text);
    return { saved: true, path };
  }
  downloadText(defaultName, text);
  return { saved: true };
}

/** Open text from a native dialog (Tauri) or a file-input picker (browser). */
export async function openTextDocument(filter: FileFilter): Promise<OpenResult | null> {
  if (isTauri()) {
    const path = await nativeOpenPath(filter);
    if (!path) return null;
    return { text: await nativeReadText(path), path };
  }
  const text = await pickTextFile();
  return text == null ? null : { text };
}

/** Read a previously-used file by its path (Tauri only; used for recent plans). */
export function readTextByPath(path: string): Promise<string> {
  return nativeReadText(path);
}

async function saveBlob(defaultName: string, blob: Blob, filter: FileFilter): Promise<SaveResult> {
  if (isTauri()) {
    const path = await nativeSavePath(defaultName, filter);
    if (!path) return { saved: false };
    await nativeWriteBinary(path, new Uint8Array(await blob.arrayBuffer()));
    return { saved: true, path };
  }
  triggerDownload(blob, defaultName);
  return { saved: true };
}

export function pickTextFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.getElementById("file-input") as HTMLInputElement | null;
    if (!input) return resolve(null);
    const onChange = (): void => {
      input.removeEventListener("change", onChange);
      const file = input.files?.[0];
      input.value = "";
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.addEventListener("change", onChange);
    input.click();
  });
}

export interface ExportOptions {
  width: number;
  height: number;
  scale?: number;
}

export async function exportSvgToPng(
  svg: SVGSVGElement,
  filename: string,
  opts: ExportOptions,
  filter: FileFilter,
): Promise<SaveResult> {
  const canvas = await rasterizeSvg(svg, opts);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return { saved: false };
  return saveBlob(filename, blob, filter);
}

export async function exportSvgToPdf(
  svg: SVGSVGElement,
  filename: string,
  opts: ExportOptions,
  filter: FileFilter,
): Promise<SaveResult> {
  const canvas = await rasterizeSvg(svg, opts);
  const ctx = canvas.getContext("2d");
  if (!ctx) return { saved: false };
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const deflated = await deflate(dropAlpha(px.data));
  const blob = buildImagePdf(deflated, canvas.width, canvas.height, opts.width, opts.height);
  return saveBlob(filename, blob, filter);
}

/** Render an SVG element onto a canvas, filling the active canvas background. */
function rasterizeSvg(svg: SVGSVGElement, opts: ExportOptions): Promise<HTMLCanvasElement> {
  const { width, height } = opts;
  const scale = opts.scale ?? 2;
  const xml = new XMLSerializer().serializeToString(svg);
  const svgUrl = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = (): void => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext("2d");
      URL.revokeObjectURL(svgUrl);
      if (!ctx) return reject(new Error("no 2d context"));
      const bg = getComputedStyle(document.body).getPropertyValue("--canvas-bg").trim() || "#0f1115";
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      resolve(canvas);
    };
    img.onerror = (): void => {
      URL.revokeObjectURL(svgUrl);
      reject(new Error("svg rasterize failed"));
    };
    img.src = svgUrl;
  });
}

/** RGBA → packed RGB (the canvas is already composited over an opaque bg). */
function dropAlpha(rgba: Uint8ClampedArray): Uint8Array<ArrayBuffer> {
  const rgb = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return rgb;
}

/** zlib deflate via the platform CompressionStream (PDF FlateDecode format). */
async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

/** Minimal single-page PDF holding one full-bleed DeviceRGB image. */
function buildImagePdf(deflated: Uint8Array, pxW: number, pxH: number, ptW: number, ptH: number): Blob {
  const w = Math.round(ptW);
  const h = Math.round(ptH);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (s: string | Uint8Array): void => {
    const b = typeof s === "string" ? enc.encode(s) : s;
    parts.push(b);
    length += b.length;
  };
  const obj = (): void => {
    offsets.push(length);
  };

  push("%PDF-1.4\n");
  obj();
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  obj();
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  obj();
  push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
  );
  obj();
  push(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode ` +
      `/Length ${deflated.length} >>\nstream\n`,
  );
  push(deflated);
  push("\nendstream\nendobj\n");
  const content = enc.encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q\n`);
  obj();
  push(`5 0 obj\n<< /Length ${content.length} >>\nstream\n`);
  push(content);
  push("endstream\nendobj\n");

  const xrefAt = length;
  const size = offsets.length + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// --- localStorage JSON helpers ---------------------------------------------

/** Read a JSON value from localStorage, returning `fallback` on a miss or any
 *  parse / storage error (private mode, disabled storage). */
export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Write a JSON value to localStorage, ignoring quota / disabled-storage errors. */
export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota / disabled storage
  }
}

// --- recent plans (Tauri only: needs real file paths) ----------------------

export interface RecentEntry {
  path: string;
  name: string;
  modelId: string;
}

const RECENT_KEY = "urx-recent";
const RECENT_MAX = 8;

/** Final path segment, handling both POSIX and Windows separators. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function loadRecent(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list.filter(
      (e): e is RecentEntry =>
        !!e && typeof e.path === "string" && typeof e.name === "string" && typeof e.modelId === "string",
    );
  } catch {
    return [];
  }
}

/** Record a just-used path at the front, de-duplicated and capped. */
export function rememberRecent(entry: RecentEntry): RecentEntry[] {
  const next = [entry, ...loadRecent().filter((e) => e.path !== entry.path)].slice(0, RECENT_MAX);
  saveJson(RECENT_KEY, next);
  return next;
}
