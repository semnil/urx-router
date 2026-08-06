import { defineConfig } from "vite";
import { resolve } from "node:path";

// Relative base so the built assets load inside the Tauri webview as well as a browser.
export default defineConfig(({ mode }) => ({
  base: "./",
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // A build output is not a source. `dist` is already out of the watcher's reach —
    // Vite ignores build.outDir when emptyOutDir is on — but `dist-trace`, the trace
    // bundle the race harness serves, is written by a build that overrides outDir, so
    // the watcher never heard about it. Vite answers a changed .html file it has no
    // module for with a full page RELOAD, and a page load is what tears the device
    // session down (src-tauri/src/lib.rs on_page_load): running the race tier while
    // `pnpm tauri dev` was up ended the operator's live session under their hands.
    // Measured on an isolated dev server with an HMR client attached: two writes to
    // dist-trace/index.html, two `full-reload` messages; the same writes with this
    // ignore in place, none. Writes to dist/index.html produced none either way.
    watch: {
      ignored: ["**/dist-trace/**"],
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      // Two entries: the app, and the MIDI control window (a second OS window, so a
      // second document). The demo build has no MIDI at all — the whole feature is
      // desktop-only — so it would ship an orphan page to GitHub Pages.
      input: {
        main: resolve(__dirname, "index.html"),
        ...(mode === "demo" || process.env.VITE_DEMO ? {} : { midi: resolve(__dirname, "midi.html") }),
      } as Record<string, string>,
    },
  },
}));
