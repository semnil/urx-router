// Drag & drop of a file onto the window, as a second way in beside File > Open.
//
// Two delivery paths, because the desktop shell intercepts drops before the
// webview sees them: under Tauri the drag events arrive from the shell and carry
// real paths (so a dropped plan can join the recent list, and a settings file can
// be read through the same command the menu uses), while a plain browser gets DOM
// drag events carrying File objects and no path at all. The DOM handlers are only
// registered outside Tauri, so a drop is never handled twice.
//
// Handlers register per extension rather than arriving as one fixed callback: a
// gate that settles after startup (the experimental settings-file import) then
// adds its extension when it is ready, instead of the caller having to publish a
// nullable slot for the drop target to test.

import { baseName, readBinaryByPath, readTextByPath } from "../core/storage";
import { isTauri, listenEvent } from "../core/platform";

/** A file handed over by a drop. `path` is present on desktop only. */
export interface DroppedFile {
  name: string;
  path?: string;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}

/** Why a drop was refused: an extension nothing is registered for, or more than
 *  one file at once (which file was meant to win is not ours to guess). */
export type DropRejection = "type" | "multiple";

export interface DropzoneOptions {
  /** Overlay caption for the extensions currently registered. Re-read on every
   *  drag, so it follows both the language and a late registration. */
  caption: (accepted: string[]) => string;
  onReject: (rejection: DropRejection, name: string, accepted: string[]) => void;
}

export interface Dropzone {
  /** Take dropped files with this (lowercase, no dot) extension. */
  register(ext: string, onDrop: (file: DroppedFile) => void | Promise<void>): void;
}

export function initDropzone(opts: DropzoneOptions): Dropzone {
  const scrim = document.getElementById("dropzone") as HTMLElement;
  const label = document.getElementById("dropzone-label") as HTMLElement;
  const handlers = new Map<string, (file: DroppedFile) => void | Promise<void>>();

  const show = (): void => {
    label.textContent = opts.caption([...handlers.keys()]);
    scrim.hidden = false;
  };
  const hide = (): void => void (scrim.hidden = true);

  const extensionOf = (name: string): string => {
    const dot = name.lastIndexOf(".");
    return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  };

  // One dropped file, matched to a handler before it is read: a file nothing is
  // registered for must say so rather than fail later as a parse error.
  const take = (names: string[], make: () => DroppedFile): void => {
    hide();
    if (names.length === 0) return;
    if (names.length > 1) return opts.onReject("multiple", baseName(names[0]), [...handlers.keys()]);
    const file = make();
    const handler = handlers.get(extensionOf(file.name));
    if (!handler) return opts.onReject("type", file.name, [...handlers.keys()]);
    void handler(file);
  };

  if (isTauri()) {
    // The shell's own drag events. Registration failures leave the app without
    // drag & drop but with the File menu intact, so they are reported rather than
    // allowed to abort startup.
    void Promise.all([
      listenEvent("tauri://drag-enter", show),
      listenEvent("tauri://drag-leave", hide),
      listenEvent<{ paths?: string[] }>("tauri://drag-drop", (payload) => {
        const paths = payload.paths ?? [];
        take(paths, () => {
          const path = paths[0];
          return {
            name: baseName(path),
            path,
            text: () => readTextByPath(path),
            bytes: () => readBinaryByPath(path),
          };
        });
      }),
    ]).catch((err) => console.warn("drag & drop unavailable:", err));
    return { register: (ext, onDrop) => void handlers.set(ext, onDrop) };
  }

  // Browser: dragenter/dragleave fire per element crossed, so nesting is counted
  // rather than treated as one enter and one leave.
  let depth = 0;
  const carriesFiles = (event: DragEvent): boolean => !!event.dataTransfer?.types.includes("Files");

  window.addEventListener("dragenter", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (depth++ === 0) show();
  });
  // Without preventDefault here the drop is never delivered — the browser treats
  // the window as a non-target and navigates to the file instead, discarding the
  // plan on the board. depth short-circuits the per-event dataTransfer read on the
  // common path (dragover fires continuously), while carriesFiles still covers a
  // drag whose dragenter never reached us.
  window.addEventListener("dragover", (event) => {
    if (depth > 0 || carriesFiles(event)) event.preventDefault();
  });
  window.addEventListener("dragleave", (event) => {
    if (!carriesFiles(event)) return;
    if (--depth <= 0) {
      depth = 0;
      hide();
    }
  });
  window.addEventListener("drop", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth = 0;
    const files = [...(event.dataTransfer?.files ?? [])];
    take(
      files.map((file) => file.name),
      () => ({
        name: files[0].name,
        text: () => files[0].text(),
        bytes: async () => new Uint8Array(await files[0].arrayBuffer()),
      }),
    );
  });
  return { register: (ext, onDrop) => void handlers.set(ext, onDrop) };
}
