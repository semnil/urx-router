import { defineConfig } from "vite";
import { resolve } from "node:path";

// Relative base so the built assets load inside the Tauri webview as well as a browser.
export default defineConfig(({ mode }) => ({
  base: "./",
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      // Two entries: the app, and the MIDI control window (a second OS window, so a
      // second document). The demo build has no MIDI at all — the whole feature is
      // desktop-only — so it would ship an orphan page to GitHub Pages.
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        ...(mode === "demo" || process.env.VITE_DEMO ? {} : { midi: resolve(import.meta.dirname, "midi.html") }),
      } as Record<string, string>,
    },
  },
}));
